import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { PNG } from "pngjs";
import { app } from "../server";
import { prisma } from "../db";
import { createSession } from "../middleware/auth";
import { runDiscovery } from "../discovery/crawler";
import { createFixtureServer } from "../fixture/server";
import { closeAllSessions, liveSessionCount, livePagesForTest } from "../manual/browser-session";
import { cleanUpOrganization, databaseReachable, defaultAdvancedSettings, signUp, waitFor, type Agent } from "./harness";

/**
 * Manual testing against a real database, a real browser, and the local fixture application.
 * Nothing is stubbed: generated cases, results, evidence bytes, sessions, and the report are all
 * read back from what was actually persisted.
 */

const pngBytes = (width = 4, height = 3, red = 200) => {
  const image = new PNG({ width, height });
  for (let index = 0; index < image.data.length; index += 4) image.data.set([red, 40, 90, 255], index);
  return PNG.sync.write(image);
};

describe("manual testing workflow", () => {
  const fixture = createFixtureServer(4323);
  const fixtureUrl = "http://127.0.0.1:4323/";
  let alice: Agent;
  let mallory: Agent;
  let viewerCookie: string;
  let projectId: string;
  let runId: string;
  let automatedRunId: string;
  let cases: { id: string; testCaseId: string; title: string; manualStatus: string }[];

  const manualRun = (overrides: Record<string, unknown> = {}) => ({
    projectId,
    applicationUrl: fixtureUrl,
    requirements: "A visitor can send a message through the contact form.",
    testingTypes: ["Functional", "Smoke", "Accessibility", "Security"],
    advancedSettings: defaultAdvancedSettings,
    authorizationConfirmed: true,
    testingMethod: "MANUAL",
    applicationType: "BUSINESS_CORPORATE",
    ...overrides,
  });

  beforeAll(async () => {
    if (!(await databaseReachable())) throw new Error("PostgreSQL is not reachable. Set DATABASE_URL in backend/.env before running integration tests.");
    await fixture.start();
    alice = await signUp(app, "manual-alice");
    mallory = await signUp(app, "manual-mallory");

    // A read-only member of Alice's organization.
    const viewer = await prisma.user.create({ data: { email: `manual-viewer-${Date.now()}@integration.test`, name: "Viewer", passwordHash: "x", memberships: { create: { organizationId: alice.organizationId, role: "VIEWER" } } } });
    viewerCookie = `qa_session=${createSession(viewer.id, alice.organizationId)}`;

    const project = await alice.post("/api/v1/projects", { name: "Manual fixture", description: "", applicationUrl: fixtureUrl }).expect(201);
    projectId = project.body.data.id;
  });

  afterAll(async () => {
    await closeAllSessions("TEST_TEARDOWN");
    await fixture.stop();
    const viewerIds = (await prisma.organizationMembership.findMany({ where: { organizationId: alice.organizationId, role: "VIEWER" }, select: { userId: true } })).map(row => row.userId);
    await cleanUpOrganization(alice.organizationId);
    await cleanUpOrganization(mallory.organizationId);
    await prisma.user.deleteMany({ where: { id: { in: [...viewerIds, alice.userId, mallory.userId] } } });
    await prisma.$disconnect();
  });

  /* ---------------------------------------------------------------- creation */

  it("creates a manual run and persists the method and application type", async () => {
    const created = await alice.post("/api/v1/test-runs", manualRun()).expect(201);
    runId = created.body.data.id;
    expect(created.body.data.testingMethod).toBe("MANUAL");

    const stored = await prisma.testRun.findUniqueOrThrow({ where: { id: runId } });
    expect(stored).toMatchObject({ testingMethod: "MANUAL", applicationType: "BUSINESS_CORPORATE", createdById: alice.userId, status: "QUEUED" });

    const manual = await alice.get(`/api/v1/manual-runs/${runId}`).expect(200);
    expect(manual.body.data).toMatchObject({ phase: "NOT_STARTED", progress: { total: 0, percentComplete: 0, passRate: null }, settings: { autoScreenshotOnFail: false } });
  });

  it("still creates automated runs exactly as before when no method is sent", async () => {
    // Exactly the body the automated wizard has always sent: no testingMethod, no applicationType.
    const legacy: Record<string, unknown> = manualRun({ testingTypes: ["Functional Testing", "Navigation"] });
    delete legacy.testingMethod;
    delete legacy.applicationType;
    const created = await alice.post("/api/v1/test-runs", legacy).expect(201);
    automatedRunId = created.body.data.id;
    expect(created.body.data.testingMethod).toBe("AUTOMATED");
    expect(created.body.data.discovery.status).toBe("QUEUED");
    const response = await alice.get(`/api/v1/manual-runs/${automatedRunId}`).expect(409);
    expect(response.body.error.code).toBe("NOT_A_MANUAL_RUN");
  });

  it("rejects testing types outside the manual vocabulary and unknown application types", async () => {
    const badType = await alice.post("/api/v1/test-runs", manualRun({ testingTypes: ["Functional", "Telepathy"] })).expect(400);
    expect(JSON.stringify(badType.body.error.details)).toContain("Telepathy");
    await alice.post("/api/v1/test-runs", manualRun({ applicationType: "SPACESHIP" })).expect(400);
  });

  /* ---------------------------------------------------------------- generation */

  it("generates NOT_RUN cases from real discovery data and refuses to generate twice", async () => {
    const discovery = await prisma.discoveryRun.findUniqueOrThrow({ where: { testRunId: runId } });
    await runDiscovery(
      { discoveryRunId: discovery.id, testRunId: runId, projectId, applicationUrl: fixtureUrl, browser: "chromium", viewport: { width: 1440, height: 900 }, maxPages: 8, maxDepth: 2, maxDurationSeconds: 60, maxRedirects: 5, maxResponseBytes: 5_000_000, allowLocalFixture: true },
      { updateProgress: async () => undefined } as never,
    );
    expect((await prisma.discoveryRun.findUniqueOrThrow({ where: { id: discovery.id } })).status).toBe("COMPLETED");

    const generated = await alice.post(`/api/v1/manual-runs/${runId}/test-cases/generate`).expect(201);
    expect(generated.body.data.usedDiscovery).toBe(true);
    expect(generated.body.data.count).toBeGreaterThan(10);

    const list = await alice.get(`/api/v1/manual-runs/${runId}/test-cases`).expect(200);
    cases = list.body.data;
    expect(cases.length).toBe(generated.body.data.count);
    expect(cases.every(item => item.manualStatus === "NOT_RUN")).toBe(true);
    const titles = cases.map(item => item.title);
    // Both fixture forms were discovered and turned into concrete cases.
    expect(titles).toContain("Sign in with an invalid password is rejected");
    expect(titles.some(title => title.includes("invalid email format"))).toBe(true);
    expect(titles.some(title => title.startsWith("Requirement: A visitor can send a message"))).toBe(true);

    const provenance = await prisma.aIGenerationRun.findFirstOrThrow({ where: { testRunId: runId } });
    expect(provenance.provider).toBe("testloop-manual-rules");

    const again = await alice.post(`/api/v1/manual-runs/${runId}/test-cases/generate`).expect(409);
    expect(again.body.error.code).toBe("MANUAL_CASES_EXIST");
  });

  /* ---------------------------------------------------------------- results */

  it("records a PASSED result, starts the run, and updates progress immediately", async () => {
    const target = cases[0];
    const response = await alice.patch(`/api/v1/manual-runs/${runId}/test-cases/${target.id}`, { status: "PASSED", actualResult: "Page loaded with navigation", testerNotes: "Checked in Chromium" }).expect(200);
    expect(response.body.data.testCase).toMatchObject({ manualStatus: "PASSED", actualResult: "Page loaded with navigation", executedBy: { id: alice.userId } });
    expect(response.body.data.progress).toMatchObject({ total: cases.length, passed: 1, notRun: cases.length - 1, executed: 1 });
    expect(response.body.data.runStatus).toBe("RUNNING");

    const run = await prisma.testRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("RUNNING");
    expect(run.startedAt).not.toBeNull();
  });

  it("refuses a FAILED result without an actual result and failure notes", async () => {
    const target = cases[1];
    const response = await alice.patch(`/api/v1/manual-runs/${runId}/test-cases/${target.id}`, { status: "FAILED" }).expect(422);
    expect(response.body.error.code).toBe("RESULT_INCOMPLETE");
    expect(response.body.error.message).toBe("Please provide the actual result before marking this test as Failed.");
    expect(response.body.error.details.map((item: { field: string }) => item.field)).toEqual(["actualResult", "testerNotes"]);
    expect((await prisma.testCase.findUniqueOrThrow({ where: { id: target.id } })).manualStatus).toBe("NOT_RUN");
  });

  it("validates the merged result, so text saved earlier counts", async () => {
    const target = cases[1];
    await alice.patch(`/api/v1/manual-runs/${runId}/test-cases/${target.id}`, { actualResult: "No error shown; user was signed in" }).expect(200);
    await alice.patch(`/api/v1/manual-runs/${runId}/test-cases/${target.id}`, { testerNotes: "Invalid password accepted" }).expect(200);
    const response = await alice.patch(`/api/v1/manual-runs/${runId}/test-cases/${target.id}`, { status: "FAILED" }).expect(200);
    expect(response.body.data.testCase.manualStatus).toBe("FAILED");
    expect(response.body.data.progress).toMatchObject({ passed: 1, failed: 1 });
    // The setting is off, so nothing was captured behind the tester's back.
    expect(response.body.data.autoCapture).toMatchObject({ attempted: false, captured: false });
    expect(await prisma.manualEvidence.count({ where: { testCaseId: target.id } })).toBe(0);
  });

  it("requires a reason for BLOCKED and clears it when the case is un-blocked", async () => {
    const target = cases[2];
    await alice.patch(`/api/v1/manual-runs/${runId}/test-cases/${target.id}`, { status: "BLOCKED" }).expect(422);
    await alice.patch(`/api/v1/manual-runs/${runId}/test-cases/${target.id}`, { status: "BLOCKED", blockedReason: "CREDENTIAL_UNAVAILABLE", testerNotes: "No admin account on staging" }).expect(200);
    expect(await prisma.testCase.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ manualStatus: "BLOCKED", blockedReason: "CREDENTIAL_UNAVAILABLE" });

    await alice.patch(`/api/v1/manual-runs/${runId}/test-cases/${target.id}`, { status: "IN_PROGRESS" }).expect(200);
    expect(await prisma.testCase.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ manualStatus: "IN_PROGRESS", blockedReason: null, executedAt: null });
    await alice.patch(`/api/v1/manual-runs/${runId}/test-cases/${target.id}`, { status: "BLOCKED", blockedReason: "ENVIRONMENT_UNAVAILABLE" }).expect(200);
  });

  it("rejects unknown fields and statuses", async () => {
    await alice.patch(`/api/v1/manual-runs/${runId}/test-cases/${cases[3].id}`, { status: "SKIPPED" }).expect(400);
    await alice.patch(`/api/v1/manual-runs/${runId}/test-cases/${cases[3].id}`, { manualStatus: "PASSED" }).expect(400);
    await alice.patch(`/api/v1/manual-runs/${runId}/test-cases/${cases[3].id}`, {}).expect(400);
  });

  it("preserves every result across a fresh read (refresh persistence)", async () => {
    const run = await alice.get(`/api/v1/manual-runs/${runId}`).expect(200);
    expect(run.body.data.phase).toBe("IN_PROGRESS");
    expect(run.body.data.progress).toMatchObject({ passed: 1, failed: 1, blocked: 1, executed: 3, notRun: cases.length - 3 });
    const list = await alice.get(`/api/v1/manual-runs/${runId}/test-cases`).expect(200);
    const failed = list.body.data.find((item: { id: string }) => item.id === cases[1].id);
    expect(failed).toMatchObject({ manualStatus: "FAILED", actualResult: "No error shown; user was signed in", testerNotes: "Invalid password accepted" });
  });

  /* ---------------------------------------------------------------- evidence */

  let uploadedId: string;

  it("stores uploaded screenshots durably and serves the same bytes through a signed URL", async () => {
    const target = cases[1];
    const first = pngBytes(4, 3, 10);
    const upload = await request(app).post(`/api/v1/manual-runs/${runId}/test-cases/${target.id}/evidence`).set("Cookie", alice.cookie).set("content-type", "image/png").set("x-file-name", "login%20bug.png").send(first).expect(201);
    uploadedId = upload.body.data.id;
    expect(upload.body.data).toMatchObject({ kind: "SCREENSHOT", source: "UPLOAD", contentType: "image/png", fileName: "login bug.png", byteSize: first.length, testCaseId: target.id });

    await request(app).post(`/api/v1/manual-runs/${runId}/test-cases/${target.id}/evidence`).set("Cookie", alice.cookie).set("content-type", "image/png").send(pngBytes(5, 5, 99)).expect(201);
    const list = await alice.get(`/api/v1/manual-runs/${runId}/test-cases/${target.id}/evidence`).expect(200);
    expect(list.body.data).toHaveLength(2);

    const row = await prisma.manualEvidence.findUniqueOrThrow({ where: { id: uploadedId } });
    expect(row).toMatchObject({ testRunId: runId, projectId, testCaseId: target.id, uploadedById: alice.userId });
    expect(row.storageKey).toContain(`/manual/${runId}/${target.id}/`);

    const signed = await alice.get(`/api/v1/manual-evidence/${uploadedId}/url`).expect(200);
    const download = await request(app).get(signed.body.data.url).buffer(true).parse((response, done) => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk as Buffer));
      response.on("end", () => done(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(download.headers["content-type"]).toBe("image/png");
    expect(Buffer.compare(download.body as Buffer, first)).toBe(0);
  });

  it("rejects non-media uploads whatever they claim to be, and empty bodies", async () => {
    const fake = await request(app).post(`/api/v1/manual-runs/${runId}/test-cases/${cases[1].id}/evidence`).set("Cookie", alice.cookie).set("content-type", "image/png").send(Buffer.from("<html><script>alert(1)</script></html>")).expect(415);
    expect(fake.body.error.code).toBe("EVIDENCE_TYPE_UNSUPPORTED");
    await request(app).post(`/api/v1/manual-runs/${runId}/test-cases/${cases[1].id}/evidence`).set("Cookie", alice.cookie).set("content-type", "image/png").send(Buffer.alloc(0)).expect(400);
  });

  it("refuses a forged or cross-scoped download token", async () => {
    await request(app).get(`/api/v1/manual-evidence/${uploadedId}/download?token=forged.token`).expect(404);
    // An execution-artifact token for the same id must not open manual evidence.
    const { signArtifactToken } = await import("../artifacts/storage");
    await request(app).get(`/api/v1/manual-evidence/${uploadedId}/download?token=${signArtifactToken(uploadedId, alice.organizationId)}`).expect(404);
  });

  /* ---------------------------------------------------------------- testing window */

  it("launches a real browser session, captures what it shows, and auto-captures on Failed only when enabled", async () => {
    const launched = await alice.post(`/api/v1/manual-runs/${runId}/session`).expect(201);
    expect(launched.body.data).toMatchObject({ status: "ACTIVE", browser: "chromium", targetUrl: fixtureUrl, lastError: null });
    expect(launched.body.data.currentUrl).toBe(fixtureUrl);
    expect(liveSessionCount()).toBe(1);
    const duplicate = await alice.post(`/api/v1/manual-runs/${runId}/session`).expect(409);
    expect(duplicate.body.error.code).toBe("SESSION_ALREADY_OPEN");

    const target = cases[4];
    const capture = await alice.post(`/api/v1/manual-runs/${runId}/test-cases/${target.id}/evidence/capture`).expect(201);
    expect(capture.body.data).toMatchObject({ source: "BROWSER_CAPTURE", contentType: "image/png", pageUrl: fixtureUrl });
    expect(capture.body.data.byteSize).toBeGreaterThan(1000);

    await alice.patch(`/api/v1/manual-runs/${runId}/settings`, { autoScreenshotOnFail: true }).expect(200);
    const failed = await alice.patch(`/api/v1/manual-runs/${runId}/test-cases/${target.id}`, { status: "FAILED", actualResult: "Heading missing", testerNotes: "Layout broken" }).expect(200);
    expect(failed.body.data.autoCapture).toMatchObject({ attempted: true, captured: true });
    expect(failed.body.data.testCase._count.manualEvidence).toBe(2);
    expect(await prisma.manualEvidence.count({ where: { testCaseId: target.id, source: "AUTO_ON_FAIL" } })).toBe(1);

    const closed = await alice.delete(`/api/v1/manual-runs/${runId}/session`).expect(200);
    expect(closed.body.data).toMatchObject({ status: "CLOSED", endReason: "CLOSED_BY_TESTER" });
    expect(liveSessionCount()).toBe(0);
    const noWindow = await alice.post(`/api/v1/manual-runs/${runId}/test-cases/${target.id}/evidence/capture`).expect(409);
    expect(noWindow.body.error.code).toBe("SESSION_NOT_ACTIVE");
  });

  it("detects the tester closing the window and releases the browser", async () => {
    await alice.post(`/api/v1/manual-runs/${runId}/session`).expect(201);
    await Promise.all(livePagesForTest(runId).map(page => page.close()));
    const session = await waitFor("window-closed session", async () => {
      const row = await prisma.manualBrowserSession.findFirst({ where: { testRunId: runId }, orderBy: { startedAt: "desc" } });
      return row?.status === "CLOSED" ? row : null;
    }, 20_000, 200);
    expect(session.endReason).toBe("WINDOW_CLOSED");
    expect(liveSessionCount()).toBe(0);
  });

  it("keeps the window open and reports why when the application cannot be reached", async () => {
    const created = await alice.post("/api/v1/test-runs", manualRun({ applicationUrl: "http://127.0.0.1:4399/" })).expect(201);
    const launched = await alice.post(`/api/v1/manual-runs/${created.body.data.id}/session`).expect(201);
    expect(launched.body.data.status).toBe("ACTIVE");
    expect(launched.body.data.lastError).toMatch(/^Could not load the application/);
    await alice.delete(`/api/v1/manual-runs/${created.body.data.id}/session`).expect(200);
  });

  it("never reports a window as open when this process does not hold it", async () => {
    const created = await alice.post("/api/v1/test-runs", manualRun()).expect(201);
    await prisma.manualBrowserSession.create({ data: { testRunId: created.body.data.id, projectId, browser: "chromium", targetUrl: fixtureUrl, status: "ACTIVE" } });
    const state = await alice.get(`/api/v1/manual-runs/${created.body.data.id}/session`).expect(200);
    expect(state.body.data.session).toMatchObject({ status: "CLOSED", endReason: "CONTROL_PLANE_RESTARTED" });
  });

  /* ---------------------------------------------------------------- authorization */

  it("hides every manual resource from another organization", async () => {
    const evidence = await prisma.manualEvidence.findFirstOrThrow({ where: { testRunId: runId } });
    const reads = [
      `/api/v1/manual-runs/${runId}`,
      `/api/v1/manual-runs/${runId}/test-cases`,
      `/api/v1/manual-runs/${runId}/test-cases/${cases[1].id}/evidence`,
      `/api/v1/manual-runs/${runId}/references`,
      `/api/v1/manual-runs/${runId}/session`,
      `/api/v1/manual-runs/${runId}/report`,
      `/api/v1/manual-evidence/${evidence.id}/url`,
    ];
    for (const path of reads) expect((await mallory.get(path)).status, `GET ${path}`).toBe(404);
    expect((await mallory.patch(`/api/v1/manual-runs/${runId}/test-cases/${cases[5].id}`, { status: "PASSED" })).status).toBe(404);
    expect((await mallory.post(`/api/v1/manual-runs/${runId}/session`)).status).toBe(404);
    expect((await mallory.post(`/api/v1/manual-runs/${runId}/complete`, { acknowledgeNotRun: true })).status).toBe(404);
    expect((await mallory.delete(`/api/v1/manual-evidence/${evidence.id}`)).status).toBe(404);
    expect((await request(app).post(`/api/v1/manual-runs/${runId}/test-cases/${cases[5].id}/evidence`).set("Cookie", mallory.cookie).set("content-type", "image/png").send(pngBytes())).status).toBe(404);
    // A case id from Alice's run cannot be addressed through a run Mallory owns either.
    const mine = await mallory.post("/api/v1/projects", { name: "Mallory app", description: "", applicationUrl: fixtureUrl }).expect(201);
    const malloryRun = await mallory.post("/api/v1/test-runs", { ...manualRun(), projectId: mine.body.data.id }).expect(201);
    expect((await mallory.patch(`/api/v1/manual-runs/${malloryRun.body.data.id}/test-cases/${cases[5].id}`, { status: "PASSED" })).status).toBe(404);
    expect(await prisma.testCase.findUniqueOrThrow({ where: { id: cases[5].id } })).toMatchObject({ manualStatus: "NOT_RUN" });
    expect(await prisma.manualEvidence.count({ where: { id: evidence.id } })).toBe(1);
  });

  it("requires authentication, blocks writes for viewers, and answers malformed ids with 404", async () => {
    expect((await request(app).get(`/api/v1/manual-runs/${runId}`)).status).toBe(401);
    expect((await request(app).patch(`/api/v1/manual-runs/${runId}/test-cases/${cases[5].id}`).send({ status: "PASSED" })).status).toBe(401);
    const asViewer = (method: "get" | "patch" | "post", path: string) => request(app)[method](path).set("Cookie", viewerCookie);
    expect((await asViewer("get", `/api/v1/manual-runs/${runId}/test-cases`)).status).toBe(200);
    expect((await asViewer("patch", `/api/v1/manual-runs/${runId}/test-cases/${cases[5].id}`).send({ status: "PASSED" })).status).toBe(403);
    expect((await asViewer("post", `/api/v1/manual-runs/${runId}/session`)).status).toBe(403);
    expect((await asViewer("post", `/api/v1/manual-runs/${runId}/complete`).send({ acknowledgeNotRun: true })).status).toBe(403);
    expect((await alice.get(`/api/v1/manual-runs/not-a-uuid`)).status).toBe(404);
    expect((await alice.patch(`/api/v1/manual-runs/${runId}/test-cases/not-a-uuid`, { status: "PASSED" })).status).toBe(404);
  });

  /* ---------------------------------------------------------------- completion and report */

  it("refuses to complete with unexecuted cases unless acknowledged, and never changes their status", async () => {
    const blocked = await alice.post(`/api/v1/manual-runs/${runId}/complete`, {}).expect(409);
    expect(blocked.body.error.code).toBe("NOT_RUN_REMAINING");
    expect(blocked.body.error.message).toMatch(/^You still have \d+ test cases that have not been executed\.$/);
    const notRunBefore = await prisma.testCase.count({ where: { testRunId: runId, manualStatus: "NOT_RUN" } });

    await alice.post(`/api/v1/manual-runs/${runId}/session`).expect(201);
    const completed = await alice.post(`/api/v1/manual-runs/${runId}/complete`, { acknowledgeNotRun: true }).expect(200);
    expect(completed.body.data.status).toBe("COMPLETED");
    // Completing the run closed its testing window.
    expect(liveSessionCount()).toBe(0);
    expect((await prisma.manualBrowserSession.findFirstOrThrow({ where: { testRunId: runId }, orderBy: { startedAt: "desc" } })).endReason).toBe("RUN_COMPLETED");

    const run = await prisma.testRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({ status: "COMPLETED", completedById: alice.userId });
    expect(run.completedAt).not.toBeNull();
    expect(await prisma.testCase.count({ where: { testRunId: runId, manualStatus: "NOT_RUN" } })).toBe(notRunBefore);
    expect(await prisma.testCase.count({ where: { testRunId: runId, manualStatus: "PASSED" } })).toBe(1);
  });

  it("locks a completed run", async () => {
    const update = await alice.patch(`/api/v1/manual-runs/${runId}/test-cases/${cases[5].id}`, { status: "PASSED" }).expect(409);
    expect(update.body.error.code).toBe("RUN_COMPLETED");
    await alice.post(`/api/v1/manual-runs/${runId}/complete`, { acknowledgeNotRun: true }).expect(409);
    await alice.delete(`/api/v1/manual-evidence/${uploadedId}`).expect(409);
  });

  it("produces a report built from the recorded results, evidence, and timeline", async () => {
    const response = await alice.get(`/api/v1/manual-runs/${runId}/report`).expect(200);
    const report = response.body.data;
    expect(report.final).toBe(true);
    expect(report.run).toMatchObject({ testingMethod: "MANUAL", applicationType: "BUSINESS_CORPORATE", applicationTypeLabel: "Business / Corporate", browser: "chromium", project: { name: "Manual fixture" } });
    expect(report.run.testers).toContain("manual-alice tester");
    expect(report.summary).toMatchObject({ total: cases.length, passed: 1, failed: 2, blocked: 1, passRate: 33.3 });
    expect(report.byType.reduce((sum: number, row: { total: number }) => sum + row.total, 0)).toBe(cases.length);

    const loginFailure = report.failed.find((item: { id: string }) => item.id === cases[1].id);
    expect(loginFailure).toMatchObject({ actualResult: "No error shown; user was signed in", testerNotes: "Invalid password accepted" });
    expect(loginFailure.evidence).toHaveLength(2);
    expect(report.blocked[0]).toMatchObject({ blockedReason: "ENVIRONMENT_UNAVAILABLE" });

    const types = report.timeline.map((event: { type: string }) => event.type);
    for (const type of ["CASES_GENERATED", "STATUS_CHANGED", "EVIDENCE_ADDED", "SESSION_STARTED", "RUN_COMPLETED"]) expect(types).toContain(type);

    const csv = await alice.get(`/api/v1/manual-runs/${runId}/report?format=csv`).expect(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    const lines = csv.text.split("\r\n");
    expect(lines[0]).toBe("id,title,testingType,priority,status,expectedResult,actualResult,notes,blockedReason,executedAt,executedBy,evidenceCount");
    expect(lines).toHaveLength(cases.length + 1);
  });

  it("leaves the automated run untouched by everything above", async () => {
    const run = await prisma.testRun.findUniqueOrThrow({ where: { id: automatedRunId }, include: { discovery: true } });
    expect(run).toMatchObject({ testingMethod: "AUTOMATED", status: "QUEUED" });
    expect(run.discovery?.status).toBe("QUEUED");
    expect(await prisma.manualTestEvent.count({ where: { testRunId: automatedRunId } })).toBe(0);
  });
});
