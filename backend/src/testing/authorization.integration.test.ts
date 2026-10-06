import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../server";
import { prisma } from "../db";
import { cleanUpOrganization, databaseReachable, defaultAdvancedSettings, signUp, type Agent } from "./harness";

/**
 * Tenant isolation. Every one of these would be a real data leak if it regressed, so they assert
 * against live rows rather than mocks: an id that belongs to another organization must be
 * indistinguishable from an id that does not exist.
 */
describe("authorization and tenant isolation", () => {
  let alice: Agent;
  let mallory: Agent;
  let projectId: string;
  let testRunId: string;
  let testCaseId: string;

  beforeAll(async () => {
    if (!(await databaseReachable())) throw new Error("PostgreSQL is not reachable. Set DATABASE_URL in backend/.env before running integration tests.");

    alice = await signUp(app, "alice");
    mallory = await signUp(app, "mallory");

    const project = await alice.post("/api/v1/projects", { name: "Alice app", description: "", applicationUrl: "http://127.0.0.1:4317/" }).expect(201);
    projectId = project.body.data.id;

    const run = await alice
      .post("/api/v1/test-runs", { projectId, applicationUrl: "http://127.0.0.1:4317/", requirements: "", testingTypes: ["Navigation"], advancedSettings: defaultAdvancedSettings, authorizationConfirmed: true })
      .expect(201);
    testRunId = run.body.data.id;

    // Seeded directly because AI generation is exercised by the pipeline test, not this one.
    const generation = await prisma.aIGenerationRun.create({ data: { testRunId, status: "COMPLETED", provider: "seed", model: "seed", promptVersion: "v1", inputSummary: {} } });
    const testCase = await prisma.testCase.create({
      data: { testRunId, generationRunId: generation.id, testCaseId: "TC-AUTH-001", title: "Seeded case", description: "d", module: "Auth", category: "FUNCTIONAL", priority: "MEDIUM", severity: "MEDIUM", preconditions: "none", testData: {}, steps: [{ step: 1, action: "Open", expectedResult: "Loads" }], expectedResult: "ok", postconditions: "none" },
    });
    testCaseId = testCase.id;
  });

  afterAll(async () => {
    await cleanUpOrganization(alice.organizationId);
    await cleanUpOrganization(mallory.organizationId);
    await prisma.$disconnect();
  });

  const readEndpoints = () => [
    `/api/v1/projects/${projectId}`,
    `/api/v1/test-runs/${testRunId}`,
    `/api/v1/test-runs/${testRunId}/discovery`,
    `/api/v1/test-runs/${testRunId}/test-cases`,
    `/api/v1/test-runs/${testRunId}/automation`,
    `/api/v1/test-runs/${testRunId}/automation/status`,
    `/api/v1/test-runs/${testRunId}/executions`,
    `/api/v1/test-cases/${testCaseId}`,
    `/api/v1/test-cases/${testCaseId}/versions`,
    `/api/v1/projects/${projectId}/report`,
    `/api/v1/projects/${projectId}/bugs`,
  ];

  it("rejects unauthenticated reads with 401", async () => {
    for (const path of [...readEndpoints(), "/api/v1/dashboard", "/api/v1/ai/status"]) {
      const response = await request(app).get(path);
      expect(response.status, `GET ${path}`).toBe(401);
      expect(response.body.error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("rejects unauthenticated writes with 401", async () => {
    const writes: [string, object][] = [
      ["/api/v1/projects", { name: "x", applicationUrl: "https://example.com" }],
      [`/api/v1/test-runs/${testRunId}/automation/generate`, {}],
      [`/api/v1/test-runs/${testRunId}/executions`, {}],
      [`/api/v1/test-cases/${testCaseId}/approve`, {}],
    ];
    for (const [path, body] of writes) {
      const response = await request(app).post(path).send(body);
      expect(response.status, `POST ${path}`).toBe(401);
    }
  });

  it("hides another organization's resources behind 404 on every read", async () => {
    for (const path of readEndpoints()) {
      const response = await mallory.get(path);
      expect(response.status, `GET ${path} as another tenant`).toBe(404);
    }
  });

  it("refuses to mutate another organization's resources", async () => {
    const attempts: [string, object][] = [
      [`/api/v1/test-cases/${testCaseId}/approve`, {}],
      [`/api/v1/test-cases/${testCaseId}/reject`, {}],
      [`/api/v1/test-runs/${testRunId}/automation/generate`, {}],
      [`/api/v1/test-runs/${testRunId}/executions`, {}],
      [`/api/v1/test-runs/${testRunId}/discovery/start`, {}],
      [`/api/v1/test-runs/${testRunId}/discovery/cancel`, {}],
    ];
    for (const [path, body] of attempts) {
      const response = await mallory.post(path, body);
      expect([403, 404], `POST ${path} as another tenant returned ${response.status}`).toContain(response.status);
    }
    // The resource must be genuinely unchanged, not merely reported as unchanged.
    const testCase = await prisma.testCase.findUnique({ where: { id: testCaseId } });
    expect(testCase?.status).toBe("DRAFT");
  });

  it("does not leak another organization's rows through list endpoints", async () => {
    const projects = await mallory.get("/api/v1/projects").expect(200);
    expect(projects.body.data.map((project: { id: string }) => project.id)).not.toContain(projectId);

    const runs = await mallory.get("/api/v1/test-runs").expect(200);
    expect(runs.body.data.map((run: { id: string }) => run.id)).not.toContain(testRunId);

    const dashboard = await mallory.get("/api/v1/dashboard").expect(200);
    expect(dashboard.body.data.projects).toBe(0);
    expect(dashboard.body.data.testRuns).toBe(0);
  });

  it("refuses to create a test run against another organization's project", async () => {
    const response = await mallory.post("/api/v1/test-runs", { projectId, applicationUrl: "http://127.0.0.1:4317/", requirements: "", testingTypes: ["Navigation"], advancedSettings: defaultAdvancedSettings, authorizationConfirmed: true });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("rejects a forged session cookie", async () => {
    const forged = Buffer.from(JSON.stringify({ userId: alice.userId, organizationId: alice.organizationId, expiresAt: Date.now() + 100_000 })).toString("base64url");
    const response = await request(app).get("/api/v1/auth/me").set("Cookie", `qa_session=${forged}.deadbeef`);
    expect(response.status).toBe(401);
  });

  it("keeps SSRF protection active on test run creation", async () => {
    // Loopback is deliberately permitted in this environment (DISCOVERY_ALLOW_LOCAL_FIXTURE), so
    // these are the ranges that must stay blocked whatever the fixture flag says.
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://192.168.1.1/", "http://[fd00::1]/", "http://[fe80::1]/", "ftp://example.com/"]) {
      const response = await alice.post("/api/v1/test-runs", { projectId, applicationUrl: url, requirements: "", testingTypes: ["Navigation"], advancedSettings: defaultAdvancedSettings, authorizationConfirmed: true });
      expect(response.status, `creating a run against ${url}`).toBeGreaterThanOrEqual(400);
    }
  });

  it("never returns a secret in an error response", async () => {
    const response = await request(app).get("/api/v1/projects/not-a-uuid");
    const body = JSON.stringify(response.body);
    for (const secret of ["postgresql://", "SESSION_SECRET", "passwordHash", process.env.SESSION_SECRET ?? "unset-secret"]) {
      expect(body).not.toContain(secret);
    }
  });

  /**
   * The organization-wide catalogue endpoints exist so the product navigation can reach resources
   * without knowing their parent. They are the easiest place to leak another tenant's rows by
   * accident, because unlike the nested routes there is no parent id to scope them.
   */
  describe("organization-wide catalogue endpoints", () => {
    const catalogues = [
      "/api/v1/test-cases",
      "/api/v1/ai-generations",
      "/api/v1/failure-analyses",
      "/api/v1/healing-proposals",
      "/api/v1/visual-comparisons",
      "/api/v1/bugs",
    ];

    it.each(catalogues)("%s returns only the caller's own organization", async path => {
      const mine = await alice.get(path).expect(200);
      const theirs = await mallory.get(path).expect(200);
      expect(Array.isArray(mine.body.data)).toBe(true);
      expect(Array.isArray(theirs.body.data)).toBe(true);
      // Mallory's organization was created empty, so nothing Alice owns may appear in it.
      expect(theirs.body.data).toHaveLength(0);
    });

    it("lists Alice's own test case in her catalogue", async () => {
      const mine = await alice.get("/api/v1/test-cases").expect(200);
      expect(mine.body.data.some((row: { id: string }) => row.id === testCaseId)).toBe(true);
    });

    it.each(catalogues)("%s requires authentication", async path => {
      await request(app).get(path).expect(401);
    });
  });


  /**
   * The credential rate limit must not cover session reads. It once covered the whole /auth prefix,
   * so a user navigating around the product - each page checks the session once - hit the login
   * budget and was silently signed out.
   */
  it("does not rate limit session checks the way it limits password attempts", async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await alice.get("/api/v1/auth/me");
      expect(response.status, `session check ${attempt + 1} was rejected`).toBe(200);
    }
  });

});
