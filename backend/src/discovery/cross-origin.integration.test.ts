import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../server";
import { prisma } from "../db";
import { runDiscovery } from "./crawler";
import { cleanUpOrganization, databaseReachable, defaultAdvancedSettings, signUp, type Agent } from "../testing/harness";

/**
 * A page that pulls a subresource from another origin must still be crawlable.
 *
 * The route interceptor treated every blocked request as fatal, so a single cross-origin asset -
 * a CDN font, script, or image, which essentially every real website has - failed the whole
 * discovery run with CROSS_ORIGIN_BLOCKED. The crawler worked only against the bundled fixture,
 * which loads nothing externally. Blocking the request is correct; ending the crawl was not.
 */
describe("cross-origin subresources during discovery", () => {
  let user: Agent;
  let projectId: string;
  let testRunId: string;
  let site: http.Server;
  let cdn: http.Server;
  let siteUrl = "";

  beforeAll(async () => {
    if (!(await databaseReachable())) throw new Error("PostgreSQL is not reachable. Set DATABASE_URL in backend/.env before running integration tests.");

    // A second server on a different port is a genuinely different origin.
    cdn = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "image/svg+xml" });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>');
    });
    await new Promise<void>(resolve => cdn.listen(0, "127.0.0.1", resolve));
    const cdnUrl = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}/logo.svg`;

    site = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><html><head><title>Cross Origin Fixture</title></head><body><h1>Home</h1><img src="${cdnUrl}" alt="logo"><a href="/second">Second</a><button>Go</button></body></html>`);
    });
    await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;

    user = await signUp(app, "crossorigin");
    const project = await user.post("/api/v1/projects", { name: "Cross origin", description: "", applicationUrl: siteUrl }).expect(201);
    projectId = project.body.data.id;
    const run = await user
      .post("/api/v1/test-runs", { projectId, applicationUrl: siteUrl, requirements: "", testingTypes: ["Functional"], advancedSettings: defaultAdvancedSettings, authorizationConfirmed: true })
      .expect(201);
    testRunId = run.body.data.id;
  });

  afterAll(async () => {
    if (user) await cleanUpOrganization(user.organizationId);
    await new Promise<void>(resolve => site.close(() => resolve()));
    await new Promise<void>(resolve => cdn.close(() => resolve()));
  });

  it("crawls the page and blocks only the foreign asset", async () => {
    const discovery = await prisma.discoveryRun.findUniqueOrThrow({ where: { testRunId } });
    await runDiscovery(
      { discoveryRunId: discovery.id, testRunId, projectId, applicationUrl: siteUrl, browser: "chromium", viewport: { width: 1440, height: 900 }, maxPages: 4, maxDepth: 1, maxDurationSeconds: 60, maxRedirects: 5, maxResponseBytes: 5_000_000, allowLocalFixture: true },
      { updateProgress: async () => undefined } as never,
    );

    const settled = await prisma.discoveryRun.findUniqueOrThrow({ where: { id: discovery.id } });
    expect(settled.failureCode, `discovery failed with ${settled.failureCode}`).toBeNull();
    expect(settled.status).toBe("COMPLETED");
    expect(settled.pagesDiscovered).toBeGreaterThan(0);

    const pages = await prisma.discoveredPage.findMany({ where: { discoveryRunId: discovery.id } });
    expect(pages.some(page => page.title === "Cross Origin Fixture")).toBe(true);
  }, 120_000);
});

/**
 * Two links that redirect to the same destination are ordinary on real sites - canonical redirects
 * produce them constantly. The page row is keyed by the URL landed on while the queue dedupes on
 * the URL requested, so the second arrival used to violate a unique constraint and abort the crawl.
 * Wikipedia failed exactly this way after successfully reading its first page.
 */
describe("converging redirects during discovery", () => {
  let user: Agent;
  let projectId: string;
  let testRunId: string;
  let site: http.Server;
  let siteUrl = "";

  beforeAll(async () => {
    if (!(await databaseReachable())) throw new Error("PostgreSQL is not reachable.");
    site = http.createServer((request, response) => {
      // /one and /two both redirect to /canonical, so the crawl reaches it twice.
      if (request.url === "/one" || request.url === "/two") {
        response.writeHead(302, { location: "/canonical" });
        return response.end();
      }
      if (request.url === "/canonical") {
        response.writeHead(200, { "content-type": "text/html" });
        return response.end("<!doctype html><html><head><title>Canonical</title></head><body><h1>Canonical</h1></body></html>");
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<!doctype html><html><head><title>Redirect Fixture</title></head><body><a href="/one">One</a><a href="/two">Two</a></body></html>');
    });
    await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;

    user = await signUp(app, "redirects");
    const project = await user.post("/api/v1/projects", { name: "Redirects", description: "", applicationUrl: siteUrl }).expect(201);
    projectId = project.body.data.id;
    const run = await user
      .post("/api/v1/test-runs", { projectId, applicationUrl: siteUrl, requirements: "", testingTypes: ["Functional"], advancedSettings: defaultAdvancedSettings, authorizationConfirmed: true })
      .expect(201);
    testRunId = run.body.data.id;
  });

  afterAll(async () => {
    if (user) await cleanUpOrganization(user.organizationId);
    await new Promise<void>(resolve => site.close(() => resolve()));
  });

  it("completes when two links redirect to the same page", async () => {
    const discovery = await prisma.discoveryRun.findUniqueOrThrow({ where: { testRunId } });
    await runDiscovery(
      { discoveryRunId: discovery.id, testRunId, projectId, applicationUrl: siteUrl, browser: "chromium", viewport: { width: 1440, height: 900 }, maxPages: 6, maxDepth: 2, maxDurationSeconds: 60, maxRedirects: 5, maxResponseBytes: 5_000_000, allowLocalFixture: true },
      { updateProgress: async () => undefined } as never,
    );

    const settled = await prisma.discoveryRun.findUniqueOrThrow({ where: { id: discovery.id } });
    expect(settled.failureCode, `discovery failed with ${settled.failureCode}: ${settled.failureMessage}`).toBeNull();
    expect(settled.status).toBe("COMPLETED");

    const pages = await prisma.discoveredPage.findMany({ where: { discoveryRunId: discovery.id } });
    // The destination is recorded once, not twice.
    expect(pages.filter(page => page.normalizedUrl.endsWith("/canonical"))).toHaveLength(1);
  }, 120_000);

  it("records a curated failure message, never an internal path", async () => {
    // Driven through the real worker path: an unroutable host fails the crawl for real.
    const project = await user.post("/api/v1/projects", { name: "Unreachable", description: "", applicationUrl: "http://127.0.0.1:9/" }).expect(201);
    const run = await user
      .post("/api/v1/test-runs", { projectId: project.body.data.id, applicationUrl: "http://127.0.0.1:9/", requirements: "", testingTypes: ["Functional"], advancedSettings: defaultAdvancedSettings, authorizationConfirmed: true })
      .expect(201);
    const discovery = await prisma.discoveryRun.findUniqueOrThrow({ where: { testRunId: run.body.data.id } });
    await runDiscovery(
      { discoveryRunId: discovery.id, testRunId: run.body.data.id, projectId: project.body.data.id, applicationUrl: "http://127.0.0.1:9/", browser: "chromium", viewport: { width: 1440, height: 900 }, maxPages: 2, maxDepth: 0, maxDurationSeconds: 20, maxRedirects: 5, maxResponseBytes: 5_000_000, allowLocalFixture: true },
      { updateProgress: async () => undefined } as never,
    ).catch(() => undefined);

    const settled = await prisma.discoveryRun.findUniqueOrThrow({ where: { id: discovery.id } });
    expect(settled.status).toBe("FAILED");
    expect(settled.failureMessage).toBeTruthy();
    expect(settled.failureMessage).not.toMatch(/[A-Za-z]:\|node_modules|prisma\.|\.js:\d+/);
  }, 120_000);
});
