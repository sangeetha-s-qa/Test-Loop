import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../server";
import { prisma } from "../db";
import { runDiscovery } from "../discovery/crawler";
import { runExecution, refreshBatch } from "../execution/execute";
import { createFixtureServer } from "../fixture/server";
import { cleanUpOrganization, databaseReachable, defaultAdvancedSettings, signUp, waitFor, type Agent } from "./harness";

/**
 * The full pipeline against a real browser and a real database.
 *
 * Discovery and execution are invoked directly rather than through BullMQ so the test does not
 * depend on a separately started worker process; the code being exercised is the exact same
 * function the worker calls, and every assertion reads back persisted rows.
 */
describe("end-to-end pipeline", () => {
  const fixture = createFixtureServer(4321);
  const fixtureUrl = "http://127.0.0.1:4321/";
  let agent: Agent;
  let projectId: string;
  let testRunId: string;

  beforeAll(async () => {
    if (!(await databaseReachable())) throw new Error("PostgreSQL is not reachable. Set DATABASE_URL in backend/.env before running integration tests.");
    await fixture.start();
    agent = await signUp(app, "pipeline");

    const project = await agent.post("/api/v1/projects", { name: "Fixture app", description: "Local fixture", applicationUrl: fixtureUrl }).expect(201);
    projectId = project.body.data.id;

    const run = await agent
      .post("/api/v1/test-runs", { projectId, applicationUrl: fixtureUrl, requirements: "Verify navigation and the contact form.", testingTypes: ["Functional Testing", "Navigation"], advancedSettings: defaultAdvancedSettings, authorizationConfirmed: true })
      .expect(201);
    testRunId = run.body.data.id;
  }, 120_000);

  afterAll(async () => {
    await cleanUpOrganization(agent.organizationId);
    await fixture.stop();
    await prisma.$disconnect();
  });

  let testCaseId: string;
  let automationVersionId: string;

  it("crawls the fixture with a real browser and persists the application map", async () => {
    const discovery = await prisma.discoveryRun.findUniqueOrThrow({ where: { testRunId } });
    await runDiscovery(
      { discoveryRunId: discovery.id, testRunId, projectId, applicationUrl: fixtureUrl, browser: "chromium", viewport: { width: 1440, height: 900 }, maxPages: 8, maxDepth: 2, maxDurationSeconds: 60, maxRedirects: 5, maxResponseBytes: 5_000_000, allowLocalFixture: true },
      { updateProgress: async () => undefined } as never,
    );

    const result = await prisma.discoveryRun.findUniqueOrThrow({ where: { id: discovery.id } });
    expect(result.status).toBe("COMPLETED");
    expect(result.pagesDiscovered).toBeGreaterThan(1);
    expect(result.formsDiscovered).toBeGreaterThan(0);

    const map = await agent.get(`/api/v1/test-runs/${testRunId}/discovery/map`).expect(200);
    expect(map.body.data.pages.length).toBe(result.pagesDiscovered);
    // The crawler must have followed real links, not just recorded the entry page.
    expect(map.body.data.pages.some((page: { normalizedUrl: string }) => page.normalizedUrl.includes("/form"))).toBe(true);
  }, 120_000);

  it("blocks automation generation until a test case is approved", async () => {
    const response = await agent.post(`/api/v1/test-runs/${testRunId}/automation/generate`, {});
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("NO_APPROVED_TEST_CASES");
  });

  it("writes an immutable version when a test case is approved", async () => {
    const generation = await prisma.aIGenerationRun.create({ data: { testRunId, status: "COMPLETED", provider: "seed", model: "seed", promptVersion: "v1", inputSummary: {} } });
    const created = await prisma.testCase.create({
      data: {
        testRunId,
        generationRunId: generation.id,
        testCaseId: "TC-FORM-001",
        title: "Contact form accepts a message",
        description: "Submitting the contact form shows a confirmation.",
        module: "Contact",
        category: "FUNCTIONAL",
        priority: "HIGH",
        severity: "HIGH",
        preconditions: "The contact page is reachable.",
        testData: { name: "Ada" },
        steps: [
          { step: 1, action: "Open the contact form", expectedResult: "The form is displayed" },
          { step: 2, action: "Enter a name and submit", expectedResult: "A confirmation is shown" },
        ],
        expectedResult: "A confirmation message is displayed.",
        postconditions: "None",
      },
    });
    testCaseId = created.id;

    const approved = await agent.post(`/api/v1/test-cases/${testCaseId}/approve`).expect(200);
    expect(approved.body.data.status).toBe("APPROVED");
    expect(approved.body.data.currentVersion).toBe(1);

    const versions = await agent.get(`/api/v1/test-cases/${testCaseId}/versions`).expect(200);
    expect(versions.body.data).toHaveLength(1);
    expect(versions.body.data[0].title).toBe("Contact form accepts a message");
  });

  it("rejects an automation program that violates policy, without storing it", async () => {
    const before = await prisma.automationVersion.count();
    const response = await agent.post(`/api/v1/test-cases/${testCaseId}/automation/manual`, {
      program: { name: "Escapes the origin", steps: [{ action: "goto", path: "https://example.com/", description: "Leave the app" }, { action: "expectTitle", value: "Example", match: "contains", description: "check" }] },
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("AUTOMATION_PROGRAM_INVALID");
    expect(response.body.data.validation.issues.some((issue: { code: string }) => issue.code === "PATH_ABSOLUTE_URL")).toBe(true);
    expect(await prisma.automationVersion.count()).toBe(before);
  });

  it("stores a valid automation program as a draft version", async () => {
    const response = await agent
      .post(`/api/v1/test-cases/${testCaseId}/automation/manual`, {
        program: {
          name: "Contact form accepts a message",
          steps: [
            { action: "goto", path: "/form", description: "Open the contact form", testCaseStep: 1 },
            { action: "fill", locator: { strategy: "label", value: "Name" }, value: "Ada", description: "Enter a name", testCaseStep: 2 },
            { action: "screenshot", name: "form-filled", description: "Capture the completed form" },
            { action: "click", locator: { strategy: "role", value: "button", name: "Send" }, description: "Submit the form", testCaseStep: 2 },
            { action: "expectText", locator: { strategy: "testId", value: "result" }, value: "we received your message", match: "contains", description: "A confirmation is shown", testCaseStep: 2 },
          ],
        },
      })
      .expect(201);

    automationVersionId = response.body.data.id;
    expect(response.body.data.status).toBe("DRAFT");
    expect(response.body.data.validationStatus).toBe("PASSED");
    expect(response.body.data.assertionCount).toBe(1);
    // The rendered spec exists for review but is never what executes.
    expect(response.body.data.sourceCode).toContain("page.getByRole('button', { name: 'Send' })");
  });

  it("refuses to execute automation that has not been approved", async () => {
    const response = await agent.post(`/api/v1/test-runs/${testRunId}/executions`, {});
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("NO_APPROVED_AUTOMATION");
  });

  it("approves the automation version and points the script at it", async () => {
    const approved = await agent.post(`/api/v1/automation-versions/${automationVersionId}/approve`).expect(200);
    expect(approved.body.data.status).toBe("APPROVED");

    const script = await prisma.automationScript.findUniqueOrThrow({ where: { testCaseId } });
    expect(script.approvedVersionId).toBe(automationVersionId);
  });

  it("runs the automation in a real browser and records a genuine pass", async () => {
    const started = await agent.post(`/api/v1/test-runs/${testRunId}/executions`, { browser: "chromium" }).expect(202);
    const batchId = started.body.data.id;

    const execution = await prisma.testExecution.findFirstOrThrow({ where: { batchId } });
    const outcome = await runExecution(execution.id, agent.organizationId);
    await refreshBatch(batchId);

    expect(outcome.status).toBe("PASSED");

    const detail = await agent.get(`/api/v1/executions/${execution.id}`).expect(200);
    expect(detail.body.data.status).toBe("PASSED");
    expect(detail.body.data.passedSteps).toBe(5);
    expect(detail.body.data.totalSteps).toBe(5);
    expect(detail.body.data.failureMessage).toBeNull();
    expect(detail.body.data.steps.every((step: { status: string }) => step.status === "PASSED")).toBe(true);
    // A real browser version must have been recorded; a fabricated result would not have one.
    expect(detail.body.data.browserVersion).toMatch(/\d+\./);

    const screenshots = detail.body.data.artifacts.filter((artifact: { type: string }) => artifact.type === "SCREENSHOT");
    // A passing execution must still leave visual evidence. Screenshots were previously captured
    // only on an explicit screenshot step or on failure, so a clean run produced none at all -
    // nothing to show a reviewer, and nothing to seed a visual baseline from.
    expect(screenshots.length).toBeGreaterThan(0);
    expect(screenshots.some((artifact: { fileName: string }) => artifact.fileName.startsWith("final"))).toBe(true);
    expect(screenshots[0].byteSize).toBeGreaterThan(0);
    expect(screenshots[0].checksumSha256).toMatch(/^[0-9a-f]{64}$/);

    const batch = await agent.get(`/api/v1/execution-batches/${batchId}`).expect(200);
    expect(batch.body.data.passedCount).toBe(1);
    expect(batch.body.data.failedCount).toBe(0);
    expect(batch.body.data.status).toBe("COMPLETED");
  }, 180_000);

  it("serves an artifact only through a valid signed token", async () => {
    const execution = await prisma.testExecution.findFirstOrThrow({ where: { testRunId }, orderBy: { createdAt: "desc" } });
    const artifact = await prisma.executionArtifact.findFirstOrThrow({ where: { executionId: execution.id, type: "SCREENSHOT" } });

    const signed = await agent.get(`/api/v1/artifacts/${artifact.id}/url`).expect(200);
    expect(signed.body.data.url).toContain("token=");

    const path = signed.body.data.url as string;
    const download = await agent.get(path).expect(200);
    expect(download.headers["content-type"]).toContain("image/png");
    expect(download.body.length).toBe(artifact.byteSize);
    // The frontend is a different origin, so helmet's default same-origin resource policy would
    // make the browser refuse to render this screenshot in an <img>. Access is already gated by the
    // signed token above; without this header the artifact viewer shows a broken image.
    expect(download.headers["cross-origin-resource-policy"]).toBe("cross-origin");

    // A tampered token must not work, and neither must no token at all.
    await agent.get(`/api/v1/artifacts/${artifact.id}/download?token=forged.token`).expect(404);
    await agent.get(`/api/v1/artifacts/${artifact.id}/download`).expect(404);
  }, 60_000);

  it("records a real failure, with evidence, when an assertion does not hold", async () => {
    const failing = await agent
      .post(`/api/v1/test-cases/${testCaseId}/automation/manual`, {
        program: {
          name: "Deliberately wrong expectation",
          steps: [
            { action: "goto", path: "/form", description: "Open the contact form" },
            { action: "expectText", locator: { strategy: "testId", value: "not-present" }, value: "nothing", match: "contains", description: "Assert against an element that does not exist" },
          ],
        },
      })
      .expect(201);
    await agent.post(`/api/v1/automation-versions/${failing.body.data.id}/approve`).expect(200);

    const started = await agent.post(`/api/v1/test-runs/${testRunId}/executions`, { browser: "chromium" }).expect(202);
    const batchId = started.body.data.id;
    const execution = await prisma.testExecution.findFirstOrThrow({ where: { batchId } });
    const outcome = await runExecution(execution.id, agent.organizationId);
    await refreshBatch(batchId);

    expect(outcome.status).toBe("FAILED");
    expect(outcome.failureCategory).toBe("LOCATOR_NOT_FOUND");

    const detail = await agent.get(`/api/v1/executions/${execution.id}`).expect(200);
    expect(detail.body.data.failedStepIndex).toBe(1);
    const failedStep = detail.body.data.steps.find((step: { status: string }) => step.status === "FAILED");
    expect(failedStep.failureMessage).toBeTruthy();
    expect(failedStep.pageUrl).toContain("/form");
    // A failure screenshot is captured automatically so a reviewer can see the page state.
    expect(detail.body.data.artifacts.some((artifact: { fileName: string }) => artifact.fileName.startsWith("failure-step-"))).toBe(true);

    const stored = await prisma.testStepResult.findFirstOrThrow({ where: { executionId: execution.id, status: "FAILED" } });
    const evidence = stored.domEvidence as { candidates?: unknown[] };
    expect(Array.isArray(evidence.candidates)).toBe(true);
    expect(evidence.candidates!.length).toBeGreaterThan(0);
  }, 180_000);

  it("creates a bug from the failure and stays idempotent on a repeat", async () => {
    const execution = await prisma.testExecution.findFirstOrThrow({ where: { testRunId, status: "FAILED" }, orderBy: { createdAt: "desc" } });

    const first = await agent.post(`/api/v1/executions/${execution.id}/bugs`, {}).expect(201);
    expect(first.body.created).toBe(true);
    expect(first.body.data.occurrenceCount).toBe(1);

    const second = await agent.post(`/api/v1/executions/${execution.id}/bugs`, {}).expect(200);
    expect(second.body.created).toBe(false);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.occurrenceCount).toBe(2);

    expect(await prisma.bug.count({ where: { projectId } })).toBe(1);
  }, 60_000);

  it("refuses to create a bug from a passing execution", async () => {
    const passing = await prisma.testExecution.findFirstOrThrow({ where: { testRunId, status: "PASSED" } });
    const response = await agent.post(`/api/v1/executions/${passing.id}/bugs`, {});
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("EXECUTION_DID_NOT_FAIL");
  });

  it("supersedes the previous approved version instead of deleting it", async () => {
    const versions = await prisma.automationVersion.findMany({ where: { script: { testCaseId } }, orderBy: { version: "asc" } });
    expect(versions).toHaveLength(2);
    expect(versions[0].status).toBe("SUPERSEDED");
    expect(versions[1].status).toBe("APPROVED");
    // History is intact: the superseded version still has its full program and rendered source.
    expect(versions[0].sourceCode.length).toBeGreaterThan(0);
  });

  it("reports real aggregate numbers and exports them", async () => {
    const report = await agent.get(`/api/v1/projects/${projectId}/report`).expect(200);
    expect(report.body.data.totals.executions).toBe(2);
    expect(report.body.data.totals.passed).toBe(1);
    expect(report.body.data.totals.failed).toBe(1);
    expect(report.body.data.passRate).toBeCloseTo(0.5);
    expect(report.body.data.totals.bugsOpen).toBe(1);

    const batch = await prisma.executionBatch.findFirstOrThrow({ where: { testRunId }, orderBy: { createdAt: "desc" } });
    const csv = await agent.get(`/api/v1/execution-batches/${batch.id}/report?format=csv`).expect(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text.split("\r\n")[0]).toContain("testCaseId");
    expect(csv.text).toContain("TC-FORM-001");
  }, 60_000);

  it("returns artifacts on a bug in the shape the viewer renders", async () => {
    // The bug detail endpoint projected a narrower artifact than the shared viewer consumes, so
    // opening a bug that had evidence crashed the page on a missing checksum.
    const execution = await prisma.testExecution.findFirstOrThrow({ where: { testRunId, status: "FAILED" }, orderBy: { createdAt: "desc" } });
    const bug = await agent.post(`/api/v1/executions/${execution.id}/bugs`, {});
    expect([200, 201]).toContain(bug.status);
    const detail = await agent.get(`/api/v1/bugs/${bug.body.data.id}`).expect(200);
    for (const artifact of detail.body.data.execution?.artifacts ?? []) {
      expect(artifact.checksumSha256, `artifact ${artifact.fileName} has no checksum`).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.contentType).toBeTruthy();
    }
  });

  it("compares a screenshot to a baseline and never auto-approves one", async () => {
    const execution = await prisma.testExecution.findFirstOrThrow({ where: { testRunId, status: "PASSED" } });
    const screenshot = await prisma.executionArtifact.findFirstOrThrow({ where: { executionId: execution.id, type: "SCREENSHOT" } });

    // With no approved baseline the result is NEW_BASELINE_REQUIRED, not a silent pass.
    const first = await agent.post(`/api/v1/executions/${execution.id}/visual-comparisons`, { screenshotArtifactId: screenshot.id, name: "form" }).expect(201);
    expect(first.body.data.status).toBe("NEW_BASELINE_REQUIRED");
    const baseline = await prisma.visualBaseline.findFirstOrThrow({ where: { testCaseId: execution.testCaseId, name: "form" } });
    expect(baseline.approvedVersionId).toBeNull();

    const approved = await agent.post(`/api/v1/visual-comparisons/${first.body.data.id}/approve`).expect(201);
    expect(approved.body.data.version).toBe(1);

    // The same image against its own baseline must match exactly.
    const second = await agent.post(`/api/v1/executions/${execution.id}/visual-comparisons`, { screenshotArtifactId: screenshot.id, name: "form" }).expect(201);
    expect(second.body.data.status).toBe("MATCHED");
    expect(second.body.data.diffPixelCount).toBe(0);
    expect(second.body.data.diffArtifactId).toBeNull();

    // A matched comparison has nothing to approve, so approval is refused.
    const refused = await agent.post(`/api/v1/visual-comparisons/${second.body.data.id}/approve`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("NOTHING_TO_APPROVE");

    // Baseline identity is scoped by name, so a different name is a different baseline.
    const other = await agent.post(`/api/v1/executions/${execution.id}/visual-comparisons`, { screenshotArtifactId: screenshot.id, name: "home" }).expect(201);
    expect(other.body.data.status).toBe("NEW_BASELINE_REQUIRED");

    const baselines = await agent.get(`/api/v1/test-cases/${execution.testCaseId}/visual-baselines`).expect(200);
    expect(baselines.body.data).toHaveLength(2);
    // History is intact: version 1 still exists and still points at the artifact it approved.
    const formBaseline = baselines.body.data.find((entry: { name: string }) => entry.name === "form");
    expect(formBaseline.versions).toHaveLength(1);
    expect(formBaseline.versions[0].artifact.id).toBe(screenshot.id);
  }, 60_000);

  it("cancels a queued batch and records it as cancelled, not failed", async () => {
    const started = await agent.post(`/api/v1/test-runs/${testRunId}/executions`, { browser: "chromium" }).expect(202);
    const batchId = started.body.data.id;

    await agent.post(`/api/v1/execution-batches/${batchId}/cancel`).expect(202);
    const cancelled = await waitFor("the batch to record a cancellation", async () => {
      const batch = await prisma.executionBatch.findUnique({ where: { id: batchId } });
      return batch?.cancelRequestedAt ? batch : null;
    }, 10_000);
    expect(cancelled.cancelRequestedAt).not.toBeNull();

    const executions = await prisma.testExecution.findMany({ where: { batchId } });
    expect(executions.every(execution => execution.status === "CANCELLED")).toBe(true);
    expect(executions.every(execution => execution.failureCategory === "CANCELLED")).toBe(true);

    // A cancelled run must never be counted as a pass or a failure.
    await refreshBatch(batchId);
    const batch = await prisma.executionBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.passedCount).toBe(0);
    expect(batch.failedCount).toBe(0);
    expect(batch.status).toBe("CANCELLED");
  }, 60_000);
});
