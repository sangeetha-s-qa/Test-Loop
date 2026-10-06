import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ManualActionReason as PrismaManualActionReason } from "@prisma/client";
import { app } from "../server";
import { config } from "../config";
import { prisma } from "../db";
import { manualActionReasons } from "../automation/program";
import { awaitManualAction, expireOverdueManualActions } from "../execution/manual-action";
import { cleanUpOrganization, databaseReachable, defaultAdvancedSettings, signUp, waitFor, type Agent } from "./harness";

/**
 * Human-in-the-loop: a run that reaches an OTP, a CAPTCHA, or a payment confirmation suspends and
 * asks a person instead of failing.
 *
 * The properties worth protecting are all about what must *not* happen: the row must not be able to
 * carry the code the person typed, two people must not both be able to answer, a resolve must not
 * overwrite an expiry the worker already recorded, and an unanswered wait must not be reported as a
 * defect in the application under test.
 */
describe("manual actions", () => {
  let user: Agent;
  let projectId: string;
  let testRunId: string;
  let executionId: string;
  let batchId: string;

  beforeAll(async () => {
    if (!(await databaseReachable())) throw new Error("PostgreSQL is not reachable. Set DATABASE_URL in backend/.env before running integration tests.");
    user = await signUp(app, "pauser");

    const project = await user.post("/api/v1/projects", { name: "Manual actions", description: "", applicationUrl: "http://127.0.0.1:4317/" }).expect(201);
    projectId = project.body.data.id;
    const run = await user
      .post("/api/v1/test-runs", { projectId, applicationUrl: "http://127.0.0.1:4317/", requirements: "", testingTypes: ["Functional"], advancedSettings: defaultAdvancedSettings, authorizationConfirmed: true })
      .expect(201);
    testRunId = run.body.data.id;

    // The chain an execution needs. Seeded directly: this suite is about the pause, not about
    // whether the generator can produce a program.
    const generationRun = await prisma.aIGenerationRun.create({ data: { testRunId, status: "COMPLETED", provider: "seed", model: "seed", promptVersion: "v5", inputSummary: {} } });
    const caseFields = {
      title: "Checkout with SMS verification",
      description: "Reaches the OTP step",
      module: "Checkout",
      category: "Functional",
      priority: "HIGH",
      severity: "MAJOR",
      preconditions: "A cart with one item",
      testData: {},
      steps: [{ step: 1, action: "Open checkout", expectedResult: "The form is shown" }],
      expectedResult: "The order is placed",
      postconditions: "An order exists",
    };
    const testCase = await prisma.testCase.create({ data: { testRunId, generationRunId: generationRun.id, testCaseId: "TC-0001", status: "APPROVED", currentVersion: 1, ...caseFields } });
    const testCaseVersion = await prisma.testCaseVersion.create({ data: { testCaseId: testCase.id, version: 1, ...caseFields } });
    const script = await prisma.automationScript.create({ data: { testCaseId: testCase.id, projectId, latestVersion: 1 } });
    const program = {
      schemaVersion: "v1",
      name: "Checkout with SMS verification",
      steps: [
        { action: "goto", path: "/", description: "Open the application" },
        { action: "pauseForUser", reason: "OTP", prompt: "Complete the SMS verification in your own browser.", description: "Wait for the person" },
        { action: "expectVisible", locator: { strategy: "role", value: "heading", name: "Fixture Home" }, description: "The order confirmation is visible" },
      ],
    };
    const version = await prisma.automationVersion.create({
      data: { scriptId: script.id, version: 1, testCaseVersionId: testCaseVersion.id, program, sourceCode: "// seeded", status: "APPROVED", validationStatus: "PASSED", validationIssues: [], stepCount: 3, assertionCount: 1 },
    });
    const batch = await prisma.executionBatch.create({ data: { testRunId, browser: "chromium", viewport: { width: 1440, height: 900 }, requestedCount: 1, createdById: user.userId } });
    batchId = batch.id;
    const execution = await prisma.testExecution.create({
      data: { batchId: batch.id, testRunId, projectId, testCaseId: testCase.id, automationVersionId: version.id, browser: "chromium", viewport: { width: 1440, height: 900 }, applicationUrl: "http://127.0.0.1:4317/", status: "RUNNING" },
    });
    executionId = execution.id;
  });

  afterAll(async () => {
    if (user) await cleanUpOrganization(user.organizationId);
  });

  const clearActions = () => prisma.manualAction.deleteMany({ where: { testRunId } });

  const seedPending = (overrides: { deadlineAt?: Date; stepIndex?: number } = {}) =>
    prisma.manualAction.create({
      data: {
        executionId,
        testRunId,
        projectId,
        stepIndex: overrides.stepIndex ?? 1,
        reason: "OTP",
        prompt: "Complete the SMS verification in your own browser.",
        deadlineAt: overrides.deadlineAt ?? new Date(Date.now() + 60_000),
      },
    });

  it("keeps the database reason set identical to the program's", () => {
    // Two sources of truth would drift, and a step the Zod schema accepts but the column rejects
    // would fail at the worst possible moment: mid-run, with a browser open and a person waiting.
    expect([...manualActionReasons].sort()).toEqual(Object.values(PrismaManualActionReason).sort());
  });

  it("exposes a pending action on the run and hides it from another organization", async () => {
    const action = await seedPending();
    const mine = await user.get(`/api/v1/test-runs/${testRunId}/manual-actions`).expect(200);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0]).toMatchObject({ id: action.id, reason: "OTP", status: "PENDING" });

    const outsider = await signUp(app, "pause-outsider");
    await outsider.get(`/api/v1/test-runs/${testRunId}/manual-actions`).expect(404);
    await outsider.get(`/api/v1/manual-actions/${action.id}`).expect(404);
    await outsider.post(`/api/v1/manual-actions/${action.id}/resolve`).expect(404);
    const after = await prisma.manualAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(after.status).toBe("PENDING");
    await cleanUpOrganization(outsider.organizationId);
    await clearActions();
  });

  it("resolves a pending action and records who answered, but never what they typed", async () => {
    const action = await seedPending();
    const response = await user.post(`/api/v1/manual-actions/${action.id}/resolve`).send({ code: "123456", otp: "123456" }).expect(200);
    expect(response.body.data.status).toBe("RESOLVED");

    const row = await prisma.manualAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(row.resolvedById).toBe(user.userId);
    expect(row.resolvedAt).not.toBeNull();
    // The body carried an OTP. There is no column for it, so it went nowhere - the safety property
    // is structural rather than a matter of remembering to strip the field.
    expect(JSON.stringify(row)).not.toContain("123456");
    await clearActions();
  });

  it("lets only the first of two simultaneous answers win", async () => {
    const action = await seedPending();
    const [first, second] = await Promise.all([
      user.post(`/api/v1/manual-actions/${action.id}/resolve`),
      user.post(`/api/v1/manual-actions/${action.id}/abort`),
    ]);
    const codes = [first.status, second.status].sort();
    expect(codes).toEqual([200, 409]);
    const row = await prisma.manualAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(["RESOLVED", "ABORTED"]).toContain(row.status);
    await clearActions();
  });

  it("refuses to resolve an action whose deadline has already passed", async () => {
    const action = await seedPending({ deadlineAt: new Date(Date.now() - 1000) });
    const response = await user.post(`/api/v1/manual-actions/${action.id}/resolve`).expect(409);
    expect(response.body.error.code).toBe("MANUAL_ACTION_EXPIRED");
    await clearActions();
  });

  it("extends a deadline up to the configured limit and then refuses", async () => {
    const action = await seedPending();
    for (let attempt = 0; attempt < config.MANUAL_ACTION_MAX_EXTENSIONS; attempt += 1) {
      await user.post(`/api/v1/manual-actions/${action.id}/extend`).expect(200);
    }
    const refused = await user.post(`/api/v1/manual-actions/${action.id}/extend`).expect(409);
    expect(refused.body.error.code).toBe("MANUAL_ACTION_EXTENSION_LIMIT");
    await clearActions();
  });

  it("sweeps a pause whose worker died, so it stops consuming the concurrency budget", async () => {
    await seedPending({ deadlineAt: new Date(Date.now() - 5000) });
    expect(await expireOverdueManualActions()).toBeGreaterThanOrEqual(1);
    const rows = await prisma.manualAction.findMany({ where: { testRunId } });
    expect(rows.every(row => row.status === "EXPIRED")).toBe(true);
    await clearActions();
  });

  it("suspends the run, releases it when a person answers, and returns how long it waited", async () => {
    await prisma.testRun.update({ where: { id: testRunId }, data: { status: "RUNNING" } });
    const pending = awaitManualAction({
      executionId,
      batchId,
      testRunId,
      projectId,
      organizationId: user.organizationId,
      stepIndex: 1,
      reason: "OTP",
      prompt: "Complete the SMS verification in your own browser.",
      pageUrl: "http://127.0.0.1:4317/checkout",
    });

    const action = await waitFor("the pause to be recorded", () => prisma.manualAction.findFirst({ where: { testRunId, status: "PENDING" } }), 15_000, 200);
    // While waiting, neither the execution nor the run claims to be running.
    const suspended = await prisma.testExecution.findUniqueOrThrow({ where: { id: executionId } });
    expect(suspended.status).toBe("WAITING_FOR_USER");
    expect((await prisma.testRun.findUniqueOrThrow({ where: { id: testRunId } })).status).toBe("WAITING_FOR_USER");

    await user.post(`/api/v1/manual-actions/${action.id}/resolve`).expect(200);
    const { pausedMs } = await pending;
    expect(pausedMs).toBeGreaterThan(0);

    expect((await prisma.testExecution.findUniqueOrThrow({ where: { id: executionId } })).status).toBe("RUNNING");
    expect((await prisma.testRun.findUniqueOrThrow({ where: { id: testRunId } })).status).toBe("RUNNING");
    const events = await prisma.executionEvent.findMany({ where: { batchId }, select: { type: true } });
    expect(events.map(event => event.type)).toContain("execution.manual_action_required");
    await clearActions();
  });

  it("gives up with MANUAL_ACTION_EXPIRED, which is not a verdict about the application", async () => {
    await prisma.testRun.update({ where: { id: testRunId }, data: { status: "RUNNING" } });
    const pending = awaitManualAction({
      executionId,
      batchId,
      testRunId,
      projectId,
      organizationId: user.organizationId,
      stepIndex: 2,
      reason: "CAPTCHA",
      prompt: "Solve the challenge shown on the checkout page.",
      pageUrl: "http://127.0.0.1:4317/checkout",
    });

    const action = await waitFor("the pause to be recorded", () => prisma.manualAction.findFirst({ where: { testRunId, status: "PENDING" } }), 15_000, 200);
    // Pull the deadline into the past rather than waiting ten real minutes for it.
    await prisma.manualAction.update({ where: { id: action.id }, data: { deadlineAt: new Date(Date.now() - 1000) } });

    await expect(pending).rejects.toMatchObject({ category: "MANUAL_ACTION_EXPIRED" });
    expect((await prisma.manualAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe("EXPIRED");
    expect((await prisma.testRun.findUniqueOrThrow({ where: { id: testRunId } })).status).toBe("RUNNING");
    await clearActions();
  });

  describe("screenshot annotations", () => {
    let artifactId: string;
    let checksumBefore: string;

    beforeAll(async () => {
      const artifact = await prisma.executionArtifact.create({
        data: {
          executionId,
          type: "SCREENSHOT",
          storageKey: `seed/${crypto.randomUUID()}.png`,
          fileName: "failure.png",
          contentType: "image/png",
          byteSize: 1234,
          checksumSha256: "a".repeat(64),
        },
      });
      artifactId = artifact.id;
      checksumBefore = artifact.checksumSha256;
    });

    it("stores a region without touching the image it describes", async () => {
      const created = await user
        .post(`/api/v1/artifacts/${artifactId}/annotations`, { x: 0.1, y: 0.2, width: 0.3, height: 0.1, label: "Email validation accepts an invalid format", colour: "ROSE" })
        .expect(201);
      expect(created.body.data.shape).toBe("RECTANGLE");

      // The whole point of storing a vector rather than painting the pixels: the evidence still
      // matches the checksum it was stored with, so it remains verifiable.
      const artifact = await prisma.executionArtifact.findUniqueOrThrow({ where: { id: artifactId } });
      expect(artifact.checksumSha256).toBe(checksumBefore);
      expect(artifact.byteSize).toBe(1234);

      await user.delete(`/api/v1/annotations/${created.body.data.id}`).expect(204);
      const after = await prisma.executionArtifact.findUniqueOrThrow({ where: { id: artifactId } });
      expect(after.checksumSha256).toBe(checksumBefore);
    });

    it("rejects a region that extends past the edge of the image", async () => {
      const response = await user.post(`/api/v1/artifacts/${artifactId}/annotations`, { x: 0.8, y: 0.1, width: 0.5, height: 0.1, label: "Off the edge" }).expect(409);
      expect(response.body.error.code).toBe("ANNOTATION_OUT_OF_BOUNDS");
    });

    it("refuses to annotate something that is not an image", async () => {
      const trace = await prisma.executionArtifact.create({
        data: { executionId, type: "TRACE", storageKey: `seed/${crypto.randomUUID()}.zip`, fileName: "trace.zip", contentType: "application/zip", byteSize: 10, checksumSha256: "b".repeat(64) },
      });
      const response = await user.post(`/api/v1/artifacts/${trace.id}/annotations`, { x: 0, y: 0, width: 0.2, height: 0.2, label: "nope" }).expect(409);
      expect(response.body.error.code).toBe("ARTIFACT_NOT_ANNOTATABLE");
    });

    it("hides annotations on another organization's evidence", async () => {
      const created = await user.post(`/api/v1/artifacts/${artifactId}/annotations`, { x: 0.1, y: 0.1, width: 0.2, height: 0.2, label: "Mine" }).expect(201);
      const outsider = await signUp(app, "annotation-outsider");
      await outsider.get(`/api/v1/artifacts/${artifactId}/annotations`).expect(404);
      await outsider.post(`/api/v1/artifacts/${artifactId}/annotations`, { x: 0, y: 0, width: 0.1, height: 0.1, label: "Theirs" }).expect(404);
      await outsider.delete(`/api/v1/annotations/${created.body.data.id}`).expect(404);
      expect(await prisma.annotation.count({ where: { id: created.body.data.id } })).toBe(1);
      await cleanUpOrganization(outsider.organizationId);
      await user.delete(`/api/v1/annotations/${created.body.data.id}`).expect(204);
    });

    it("will not link a region to another organization's bug", async () => {
      const outsider = await signUp(app, "annotation-bug-outsider");
      const foreignProject = await outsider.post("/api/v1/projects", { name: "Foreign", description: "", applicationUrl: "http://127.0.0.1:4317/" }).expect(201);
      const foreignBug = await prisma.bug.create({
        data: { projectId: foreignProject.body.data.id, reference: "BUG-X1", title: "Foreign", description: "", severity: "MEDIUM", expectedBehavior: "", actualBehavior: "", stepsToReproduce: [], fingerprint: `seed-${crypto.randomUUID()}` },
      });
      // Otherwise an annotation becomes a way to learn that another tenant's bug id exists.
      await user.post(`/api/v1/artifacts/${artifactId}/annotations`, { x: 0, y: 0, width: 0.1, height: 0.1, label: "Cross tenant", bugId: foreignBug.id }).expect(404);
      await cleanUpOrganization(outsider.organizationId);
    });
  });

  it("refuses a new pause once the organization is at its concurrency ceiling", async () => {
    // Each paused run holds a browser. Without this ceiling one user starves the worker pool.
    for (let index = 0; index < config.MANUAL_ACTION_MAX_CONCURRENT; index += 1) {
      await seedPending({ stepIndex: 10 + index });
    }
    await expect(
      awaitManualAction({
        executionId,
        batchId,
        testRunId,
        projectId,
        organizationId: user.organizationId,
        stepIndex: 99,
        reason: "OTP",
        prompt: "Complete the SMS verification in your own browser.",
        pageUrl: "http://127.0.0.1:4317/checkout",
      }),
    ).rejects.toMatchObject({ category: "POLICY_VIOLATION" });
    await clearActions();
  });
});
