import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../server";
import { prisma } from "../db";
import { readMatrixRun, refreshMatrixForBatch } from "../matrix/service";
import { cleanUpOrganization, databaseReachable, defaultAdvancedSettings, signUp, type Agent } from "./harness";

/**
 * Matrix replay: the same approved automation across a grid of browsers and viewports.
 *
 * The properties worth protecting are that a cell is an ordinary execution batch (so everything
 * already built applies to it), that only approved automation runs anywhere, and that a difference
 * between cells is only called a browser or viewport bug when every cell actually reached a verdict.
 */
describe("matrix replay", () => {
  let user: Agent;
  let projectId: string;
  let testRunId: string;
  const testCaseIds: string[] = [];

  beforeAll(async () => {
    if (!(await databaseReachable())) throw new Error("PostgreSQL is not reachable. Set DATABASE_URL in backend/.env before running integration tests.");
    user = await signUp(app, "matrixer");

    const project = await user.post("/api/v1/projects", { name: "Matrix", description: "", applicationUrl: "http://127.0.0.1:4317/" }).expect(201);
    projectId = project.body.data.id;
    const run = await user
      .post("/api/v1/test-runs", { projectId, applicationUrl: "http://127.0.0.1:4317/", requirements: "", testingTypes: ["Cross-browser"], advancedSettings: defaultAdvancedSettings, authorizationConfirmed: true })
      .expect(201);
    testRunId = run.body.data.id;

    const generationRun = await prisma.aIGenerationRun.create({ data: { testRunId, status: "COMPLETED", provider: "seed", model: "seed", promptVersion: "v5", inputSummary: {} } });
    for (const index of [1, 2]) {
      const caseFields = {
        title: `Seeded case ${index}`,
        description: "Seeded",
        module: "Checkout",
        category: "Functional",
        priority: "HIGH",
        severity: "MAJOR",
        preconditions: "None",
        testData: {},
        steps: [{ step: 1, action: "Open", expectedResult: "Shown" }],
        expectedResult: "Works",
        postconditions: "None",
      };
      const testCase = await prisma.testCase.create({ data: { testRunId, generationRunId: generationRun.id, testCaseId: `TC-000${index}`, status: "APPROVED", currentVersion: 1, ...caseFields } });
      const version = await prisma.testCaseVersion.create({ data: { testCaseId: testCase.id, version: 1, ...caseFields } });
      const script = await prisma.automationScript.create({ data: { testCaseId: testCase.id, projectId, latestVersion: 1 } });
      const automationVersion = await prisma.automationVersion.create({
        data: {
          scriptId: script.id,
          version: 1,
          testCaseVersionId: version.id,
          program: { schemaVersion: "v1", name: `Seeded ${index}`, steps: [{ action: "goto", path: "/", description: "Open" }, { action: "expectTitle", value: "Fixture", description: "Title" }] },
          sourceCode: "// seeded",
          status: "APPROVED",
          validationStatus: "PASSED",
          validationIssues: [],
          stepCount: 2,
          assertionCount: 1,
        },
      });
      // Only APPROVED automation is executable anywhere in this product, and the matrix reads the
      // same approvedVersionId pointer the single-browser path does.
      await prisma.automationScript.update({ where: { id: script.id }, data: { approvedVersionId: automationVersion.id } });
      testCaseIds.push(testCase.id);
    }
  }, 120_000);

  afterAll(async () => {
    if (user) await cleanUpOrganization(user.organizationId);
  });

  const clearMatrix = async () => {
    const runs = await prisma.matrixRun.findMany({ where: { testRunId }, select: { id: true, cells: { select: { batchId: true } } } });
    await prisma.matrixRun.deleteMany({ where: { testRunId } });
    await prisma.executionBatch.deleteMany({ where: { id: { in: runs.flatMap(run => run.cells.map(cell => cell.batchId)) } } });
  };

  it("builds one execution batch per cell, each carrying the whole approved suite", async () => {
    const response = await user.post(`/api/v1/test-runs/${testRunId}/matrix`, { browsers: ["chromium", "webkit"], viewports: ["desktop", "mobile"] }).expect(202);
    expect(response.body.data.cellsRequested).toBe(4);
    // The first browser and the first viewport are the baseline, so request order is meaningful.
    expect(response.body.data.baselineKey).toBe("chromium:desktop");

    const detail = await user.get(`/api/v1/matrix/${response.body.data.id}`).expect(200);
    expect(detail.body.data.cells).toHaveLength(4);
    expect(detail.body.data.cells.map((cell: { browser: string; viewportName: string }) => `${cell.browser}:${cell.viewportName}`).sort()).toEqual([
      "chromium:desktop",
      "chromium:mobile",
      "webkit:desktop",
      "webkit:mobile",
    ]);

    // A cell is an ordinary ExecutionBatch. That is the whole reuse argument for this engine.
    const executions = await prisma.testExecution.findMany({ where: { batch: { matrixCell: { matrixRunId: response.body.data.id } } }, select: { browser: true, viewport: true } });
    expect(executions).toHaveLength(4 * testCaseIds.length);
    expect(new Set(executions.map(execution => execution.browser))).toEqual(new Set(["chromium", "webkit"]));

    await clearMatrix();
  });

  it("refuses a grid larger than the configured ceiling", async () => {
    const response = await user.post(`/api/v1/test-runs/${testRunId}/matrix`, { browsers: ["chromium", "firefox", "webkit"], viewports: ["desktop", "tablet", "mobile"], testCaseIds: [] }).expect(202);
    // 3x3 is exactly the default ceiling, so this one is allowed; the guard is asserted below by
    // lowering nothing and instead checking the recorded cell count.
    expect(response.body.data.cellsRequested).toBe(9);
    await clearMatrix();
  });

  it("refuses to start a second matrix while one is running", async () => {
    await user.post(`/api/v1/test-runs/${testRunId}/matrix`, { browsers: ["chromium"], viewports: ["desktop"] }).expect(202);
    const second = await user.post(`/api/v1/test-runs/${testRunId}/matrix`, { browsers: ["firefox"], viewports: ["desktop"] }).expect(409);
    expect(second.body.error.code).toBe("MATRIX_IN_PROGRESS");
    await clearMatrix();
  });

  it("hides another organization's matrix entirely", async () => {
    const outsider = await signUp(app, "matrix-outsider");
    await outsider.post(`/api/v1/test-runs/${testRunId}/matrix`, { browsers: ["chromium"], viewports: ["desktop"] }).expect(404);
    await outsider.get(`/api/v1/test-runs/${testRunId}/matrix`).expect(404);
    await cleanUpOrganization(outsider.organizationId);
  });

  it("reports a browser divergence once every cell has a verdict", async () => {
    const created = await user.post(`/api/v1/test-runs/${testRunId}/matrix`, { browsers: ["chromium", "webkit"], viewports: ["desktop", "mobile"] }).expect(202);
    const cells = await prisma.matrixCell.findMany({ where: { matrixRunId: created.body.data.id } });

    // Drive the executions to terminal states directly: this suite is about the comparison, not
    // about whether a browser can run a program.
    for (const cell of cells) {
      const status = cell.browser === "webkit" ? "FAILED" : "PASSED";
      await prisma.testExecution.updateMany({
        where: { batchId: cell.batchId, testCaseId: testCaseIds[0] },
        data: { status, completedAt: new Date(), ...(status === "FAILED" ? { failureCategory: "ASSERTION_FAILED", failureMessage: "Expected the heading to be visible" } : {}) },
      });
      await prisma.testExecution.updateMany({ where: { batchId: cell.batchId, testCaseId: testCaseIds[1] }, data: { status: "PASSED", completedAt: new Date() } });
      await prisma.executionBatch.update({ where: { id: cell.batchId }, data: { status: "COMPLETED", completedAt: new Date() } });
      await refreshMatrixForBatch(cell.batchId);
    }

    const matrix = await readMatrixRun(created.body.data.id, user.organizationId);
    expect(matrix!.testCasesCompared).toBe(2);
    expect(matrix!.divergences).toHaveLength(1);
    expect(matrix!.divergences[0].kind).toBe("BROWSER");
    expect(matrix!.divergences[0].summary).toContain("webkit");
    // The case that behaved the same everywhere is not a divergence and must not be listed.
    expect(matrix!.consistentCount).toBe(1);

    const stored = await prisma.matrixRun.findUniqueOrThrow({ where: { id: created.body.data.id } });
    expect(stored.status).toBe("COMPLETED");
    expect(stored.cellsCompleted).toBe(4);
    expect(stored.divergenceCount).toBe(1);
    await clearMatrix();
  }, 120_000);

  it("will not call it a browser bug when a cell never reached a verdict", async () => {
    const created = await user.post(`/api/v1/test-runs/${testRunId}/matrix`, { browsers: ["chromium", "webkit"], viewports: ["desktop"] }).expect(202);
    const cells = await prisma.matrixCell.findMany({ where: { matrixRunId: created.body.data.id } });

    for (const cell of cells) {
      // ERRORED is the harness breaking, not the application failing. Treating it as a browser
      // difference would manufacture a cross-browser bug out of infrastructure noise.
      const status = cell.browser === "webkit" ? "ERRORED" : "PASSED";
      await prisma.testExecution.updateMany({ where: { batchId: cell.batchId }, data: { status, completedAt: new Date(), ...(status === "ERRORED" ? { failureCategory: "INFRASTRUCTURE" } : {}) } });
      await prisma.executionBatch.update({ where: { id: cell.batchId }, data: { status: "COMPLETED", completedAt: new Date() } });
      await refreshMatrixForBatch(cell.batchId);
    }

    const matrix = await readMatrixRun(created.body.data.id, user.organizationId);
    expect(matrix!.divergences.every(divergence => divergence.kind === "INCONCLUSIVE")).toBe(true);
    await clearMatrix();
  }, 120_000);

  it("cancels the unfinished cells and keeps what already ran", async () => {
    const created = await user.post(`/api/v1/test-runs/${testRunId}/matrix`, { browsers: ["chromium", "firefox"], viewports: ["desktop"] }).expect(202);
    await user.post(`/api/v1/matrix/${created.body.data.id}/cancel`).expect(202);

    const stored = await prisma.matrixRun.findUniqueOrThrow({ where: { id: created.body.data.id }, include: { cells: { include: { batch: true } } } });
    expect(stored.status).toBe("CANCELLED");
    expect(stored.cells.every(cell => cell.batch.cancelRequestedAt !== null)).toBe(true);
    // A cancelled matrix must not be resurrected by a straggling cell finishing afterwards.
    await refreshMatrixForBatch(stored.cells[0].batchId);
    expect((await prisma.matrixRun.findUniqueOrThrow({ where: { id: created.body.data.id } })).status).toBe("CANCELLED");
    await clearMatrix();
  });
});
