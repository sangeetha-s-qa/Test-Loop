import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../server";
import { prisma } from "../db";
import { createFixtureServer } from "../fixture/server";
import { runDiscovery } from "./crawler";
import { cleanUpOrganization, databaseReachable, defaultAdvancedSettings, signUp, type Agent } from "../testing/harness";

/**
 * Endpoint inventory, built by watching the application call itself.
 *
 * The crawler must record what the page requested and must never request anything of its own. That
 * is what makes an inventory safe to build against a site nobody has agreed to have poked: it is a
 * transcript, not a probe.
 */
describe("endpoint inventory", () => {
  const fixture = createFixtureServer(4327);
  const baseUrl = "http://127.0.0.1:4327/";
  let user: Agent;
  let projectId: string;
  let testRunId: string;

  beforeAll(async () => {
    if (!(await databaseReachable())) throw new Error("PostgreSQL is not reachable. Set DATABASE_URL in backend/.env before running integration tests.");
    await fixture.start();
    user = await signUp(app, "endpoints");
    const project = await user.post("/api/v1/projects", { name: "Endpoints", description: "", applicationUrl: baseUrl }).expect(201);
    projectId = project.body.data.id;
    const run = await user
      .post("/api/v1/test-runs", { projectId, applicationUrl: baseUrl, requirements: "", testingTypes: ["API"], advancedSettings: defaultAdvancedSettings, authorizationConfirmed: true })
      .expect(201);
    testRunId = run.body.data.id;
  }, 120_000);

  afterAll(async () => {
    if (user) await cleanUpOrganization(user.organizationId);
    await fixture.stop();
  });

  it("records the XHR the application made, keyed by path rather than by query", async () => {
    const discovery = await prisma.discoveryRun.findUniqueOrThrow({ where: { testRunId } });
    await runDiscovery(
      { discoveryRunId: discovery.id, testRunId, projectId, applicationUrl: baseUrl, browser: "chromium", viewport: { width: 1440, height: 900 }, maxPages: 8, maxDepth: 2, maxDurationSeconds: 60, maxRedirects: 5, maxResponseBytes: 5_000_000, allowLocalFixture: true },
      { updateProgress: async () => undefined } as never,
    );

    const settled = await prisma.discoveryRun.findUniqueOrThrow({ where: { id: discovery.id } });
    expect(settled.failureCode, `discovery failed with ${settled.failureCode}`).toBeNull();
    expect(settled.status).toBe("COMPLETED");

    const endpoints = await prisma.discoveredEndpoint.findMany({ where: { discoveryRunId: discovery.id } });
    const products = endpoints.find(endpoint => endpoint.normalizedUrl.endsWith("/api/products"));
    expect(products, `expected /api/products in ${JSON.stringify(endpoints.map(endpoint => endpoint.normalizedUrl))}`).toBeDefined();
    expect(products!.method).toBe("GET");
    expect(products!.observedStatus).toBe(200);
    expect(products!.contentType).toContain("application/json");
    // The query is dropped for identity but a concrete URL is kept, so a probe has something real
    // to replay and a paginated list is one endpoint rather than one row per page number.
    expect(products!.normalizedUrl).not.toContain("?");
    expect(products!.url).toContain("page=1");
    expect(settled.endpointsDiscovered).toBeGreaterThan(0);
  }, 180_000);

  it("records only traffic the page itself generated", async () => {
    // Every row must correspond to something the application requested. A document navigation is
    // not an endpoint, and nothing here may originate from the crawler.
    const discovery = await prisma.discoveryRun.findUniqueOrThrow({ where: { testRunId } });
    const endpoints = await prisma.discoveredEndpoint.findMany({ where: { discoveryRunId: discovery.id } });
    expect(endpoints.length).toBeGreaterThan(0);
    expect(endpoints.every(endpoint => endpoint.resourceType === "xhr" || endpoint.resourceType === "fetch")).toBe(true);
    expect(endpoints.every(endpoint => endpoint.normalizedUrl.startsWith(baseUrl.replace(/\/$/, "")))).toBe(true);
    // The crawler never submits a form, so no write method can appear from crawling alone.
    expect(endpoints.some(endpoint => ["POST", "PUT", "PATCH", "DELETE"].includes(endpoint.method))).toBe(false);
  });
});
