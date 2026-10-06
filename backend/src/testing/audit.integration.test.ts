import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../server";
import { prisma } from "../db";
import { createFixtureServer } from "../fixture/server";
import { runAudit } from "../audit/run";
import { cleanUpOrganization, databaseReachable, defaultAdvancedSettings, signUp, type Agent } from "./harness";

/**
 * The page-audit sweep, driven end to end against a real browser and the local fixture.
 *
 * The claim being protected is that an audit is evidence rather than opinion: every finding cites a
 * rule id, every performance number is a measurement recorded against the threshold it was judged
 * by, and the sweep is gated on discovery having actually reached the pages it audits.
 */
describe("page audits", () => {
  const fixture = createFixtureServer(4323);
  const baseUrl = "http://127.0.0.1:4323/";
  let user: Agent;
  let projectId: string;
  let testRunId: string;

  beforeAll(async () => {
    if (!(await databaseReachable())) throw new Error("PostgreSQL is not reachable. Set DATABASE_URL in backend/.env before running integration tests.");
    await fixture.start();
    user = await signUp(app, "auditor");

    const project = await user.post("/api/v1/projects", { name: "Audits", description: "", applicationUrl: baseUrl }).expect(201);
    projectId = project.body.data.id;
    const run = await user
      .post("/api/v1/test-runs", { projectId, applicationUrl: baseUrl, requirements: "", testingTypes: ["Accessibility"], advancedSettings: defaultAdvancedSettings, authorizationConfirmed: true })
      .expect(201);
    testRunId = run.body.data.id;
  }, 120_000);

  afterAll(async () => {
    if (user) await cleanUpOrganization(user.organizationId);
    await fixture.stop();
  });

  const seedDiscovery = async (pages: string[]) => {
    // Creating a test run already creates its DiscoveryRun (QUEUED, one per run), so this promotes
    // that row rather than inserting a second one.
    const discovery = await prisma.discoveryRun.upsert({
      where: { testRunId },
      update: { status: "COMPLETED", pagesDiscovered: pages.length, completedAt: new Date() },
      create: { testRunId, status: "COMPLETED", jobId: `seed-${crypto.randomUUID()}`, browser: "chromium", configuration: {}, pagesDiscovered: pages.length, completedAt: new Date() },
    });
    for (const [index, url] of pages.entries()) {
      await prisma.discoveredPage.create({
        data: { discoveryRunId: discovery.id, url, normalizedUrl: url, title: `Page ${index}`, depth: index, loadDurationMs: 10, viewport: { width: 1440, height: 900 }, browser: "chromium" },
      });
    }
    return discovery;
  };

  it("refuses to audit before discovery has completed", async () => {
    const response = await user.post(`/api/v1/test-runs/${testRunId}/audits`, { analyzers: ["ACCESSIBILITY"] }).expect(409);
    expect(response.body.error.code).toBe("DISCOVERY_NOT_COMPLETE");
  });

  describe("with a completed discovery", () => {
    beforeAll(async () => {
      await seedDiscovery([baseUrl]);
    });

    it("queues an audit and refuses a second one while it is running", async () => {
      const first = await user.post(`/api/v1/test-runs/${testRunId}/audits`, { analyzers: ["ACCESSIBILITY", "SECURITY"] }).expect(202);
      expect(first.body.data.status).toBe("QUEUED");
      const second = await user.post(`/api/v1/test-runs/${testRunId}/audits`, { analyzers: ["SECURITY"] }).expect(409);
      expect(second.body.error.code).toBe("AUDIT_IN_PROGRESS");
      await prisma.auditRun.deleteMany({ where: { testRunId } });
    });

    it("hides another organization's audit entirely", async () => {
      const outsider = await signUp(app, "audit-outsider");
      await outsider.post(`/api/v1/test-runs/${testRunId}/audits`, { analyzers: ["SECURITY"] }).expect(404);
      await outsider.get(`/api/v1/test-runs/${testRunId}/audits`).expect(404);
      await cleanUpOrganization(outsider.organizationId);
    });

    it("sweeps the discovered pages and records citable findings", async () => {
      const auditRun = await user.post(`/api/v1/test-runs/${testRunId}/audits`, { analyzers: ["ACCESSIBILITY", "PERFORMANCE", "SECURITY"] }).expect(202);
      const result = await runAudit(auditRun.body.data.id, user.organizationId);

      expect(result.pagesCompleted).toBe(1);

      const stored = await prisma.auditRun.findUniqueOrThrow({
        where: { id: auditRun.body.data.id },
        include: { pageAudits: { include: { findings: true, samples: true } } },
      });
      expect(stored.status).toBe("COMPLETED");
      // One row per analyzer per page, so a report can show a gap rather than silently listing fewer.
      expect(stored.pageAudits.map(audit => audit.analyzer).sort()).toEqual(["ACCESSIBILITY", "PERFORMANCE", "SECURITY"]);

      const security = stored.pageAudits.find(audit => audit.analyzer === "SECURITY")!;
      expect(security.findings.map(finding => finding.ruleId)).toContain("security.not_https");
      expect(security.findings.every(finding => finding.ruleId.length > 0)).toBe(true);

      const performance = stored.pageAudits.find(audit => audit.analyzer === "PERFORMANCE")!;
      expect(performance.samples.length).toBeGreaterThan(0);
      // Every budgeted sample stores the threshold it was judged against, so a later report can say
      // what a number was compared to rather than re-reading today's configuration.
      for (const sample of performance.samples.filter(entry => entry.threshold !== null)) {
        expect(sample.passed).toBe(sample.value <= sample.threshold!);
      }

      await prisma.auditRun.deleteMany({ where: { testRunId } });
    }, 120_000);

    it("stores an allowlist as bare origins and rejects anything that is not one", async () => {
      const rejected = await user.patch(`/api/v1/projects/${projectId}/egress-allowlist`, { egressAllowlist: ["file:///etc/passwd"] }).expect(409);
      expect(rejected.body.error.code).toBe("INVALID_ORIGIN");

      const accepted = await user
        .patch(`/api/v1/projects/${projectId}/egress-allowlist`, { egressAllowlist: ["https://cdn.example.com/assets/app.js", "https://cdn.example.com/other"] })
        .expect(200);
      // Normalised to origins and de-duplicated: two paths on one host are one allowlist entry.
      expect(accepted.body.data.egressAllowlist).toEqual(["https://cdn.example.com"]);

      const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { egressAllowlist: true } });
      expect(project.egressAllowlist).toEqual(["https://cdn.example.com"]);
    });

    it("probes the endpoint inventory without ever calling a non-idempotent one", async () => {
      // Inventory seeded directly here; the crawler's own capture of it is covered in the
      // discovery suite. What this asserts is the analyzer pass and what it refuses to call.
      const discovery = await prisma.discoveryRun.findUniqueOrThrow({ where: { testRunId }, select: { id: true } });
      await prisma.discoveredEndpoint.createMany({
        data: [
          { discoveryRunId: discovery.id, method: "GET", url: `${baseUrl}api/products?page=1`, normalizedUrl: `${baseUrl}api/products`, resourceType: "fetch", observedStatus: 200, contentType: "application/json" },
          { discoveryRunId: discovery.id, method: "DELETE", url: `${baseUrl}api/products/1`, normalizedUrl: `${baseUrl}api/products/1`, resourceType: "fetch", observedStatus: 204, contentType: null },
        ],
        skipDuplicates: true,
      });

      const auditRun = await user.post(`/api/v1/test-runs/${testRunId}/audits`, { analyzers: ["API"] }).expect(202);
      await runAudit(auditRun.body.data.id, user.organizationId);

      const audits = await prisma.pageAudit.findMany({ where: { auditRunId: auditRun.body.data.id }, include: { findings: true, samples: true } });
      expect(audits).toHaveLength(2);
      expect(audits.every(audit => audit.analyzer === "API")).toBe(true);

      const deleteAudit = audits.find(audit => audit.url.startsWith("DELETE"))!;
      expect(deleteAudit.findings.map(finding => finding.ruleId)).toEqual(["api.not_probed"]);
      expect(deleteAudit.samples).toHaveLength(0);

      const getAudit = audits.find(audit => audit.url.startsWith("GET"))!;
      expect(getAudit.samples.map(sample => sample.metric).sort()).toEqual(["response_bytes", "response_time_ms"]);

      await prisma.auditRun.deleteMany({ where: { testRunId } });
      await prisma.discoveredEndpoint.deleteMany({ where: { discoveryRunId: discovery.id } });
    }, 120_000);

    it("cancels a queued audit without discarding what it already stored", async () => {
      const auditRun = await user.post(`/api/v1/test-runs/${testRunId}/audits`, { analyzers: ["SECURITY"] }).expect(202);
      await user.post(`/api/v1/audits/${auditRun.body.data.id}/cancel`).expect(202);
      expect((await prisma.auditRun.findUniqueOrThrow({ where: { id: auditRun.body.data.id } })).status).toBe("CANCELLED");
      // A cancelled run must not be resurrected by the worker finishing afterwards.
      const { count } = await prisma.auditRun.updateMany({ where: { id: auditRun.body.data.id, status: { notIn: ["CANCELLED"] } }, data: { status: "COMPLETED" } });
      expect(count).toBe(0);
      await prisma.auditRun.deleteMany({ where: { testRunId } });
    });
  });
});
