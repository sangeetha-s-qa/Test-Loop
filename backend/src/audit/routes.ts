import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { parseAllowedOrigin } from "../discovery/scope";
import { canWrite, conflict, forbidden, notFound, registerUuidParams, route } from "../http";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { enqueueAudit, auditJobId } from "./queue";
import { buildAuditConfiguration } from "./run";

export const auditRouter = Router();
registerUuidParams(auditRouter);

const startSchema = z.object({
  analyzers: z.array(z.enum(["ACCESSIBILITY", "PERFORMANCE", "SECURITY", "API"])).min(1).max(4),
  browser: z.enum(["chromium", "firefox", "webkit"]).optional(),
  maxPages: z.number().int().positive().max(200).optional(),
});

const viewportPresets: Record<string, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 1024, height: 768 },
  mobile: { width: 390, height: 844 },
};

/**
 * POST /api/v1/test-runs/:id/audits — sweep the run's discovered pages with the chosen analyzers.
 *
 * Gated on discovery having completed, for the same reason every other stage is gated on the one
 * before it: auditing a URL the crawler never reached would be auditing a guess.
 */
auditRouter.post("/test-runs/:id/audits", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canWrite(user.role)) return forbidden(response, "Starting an audit is not permitted for your role");

  const input = startSchema.parse(request.body ?? {});
  const testRun = await prisma.testRun.findFirst({
    where: { id: request.params.id, project: { organizationId: user.organizationId } },
    select: { id: true, projectId: true, configuration: true, discovery: { select: { status: true, pagesDiscovered: true } }, project: { select: { egressAllowlist: true } } },
  });
  if (!testRun) return notFound(response, "Test run not found");
  if (testRun.discovery?.status !== "COMPLETED") {
    return conflict(response, "DISCOVERY_NOT_COMPLETE", "Run discovery first. An audit covers the pages the crawl actually reached.");
  }

  const active = await prisma.auditRun.findFirst({ where: { testRunId: testRun.id, status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } });
  if (active) return conflict(response, "AUDIT_IN_PROGRESS", "An audit is already running for this test run");

  const settings = testRun.configuration as { browser?: string; viewport?: string; customViewport?: { width: number; height: number } };
  const browser = input.browser ?? (["chromium", "firefox", "webkit"].includes(settings.browser ?? "") ? settings.browser! : "chromium");
  const viewport = viewportPresets[settings.viewport ?? "desktop"] ?? settings.customViewport ?? viewportPresets.desktop;

  const auditRun = await prisma.auditRun.create({
    data: {
      testRunId: testRun.id,
      projectId: testRun.projectId,
      jobId: auditJobId(crypto.randomUUID()),
      configuration: buildAuditConfiguration(input.analyzers, testRun.project.egressAllowlist),
      browser,
      viewport,
      pagesRequested: Math.min(input.maxPages ?? testRun.discovery.pagesDiscovered, testRun.discovery.pagesDiscovered),
    },
  });

  await enqueueAudit({ auditRunId: auditRun.id, testRunId: testRun.id, projectId: testRun.projectId, organizationId: user.organizationId });
  return response.status(202).json({ data: auditRun });
}));

/** GET /api/v1/test-runs/:id/audits — audit runs for a test run, newest first. */
auditRouter.get("/test-runs/:id/audits", requireAuth, route(async (request: AuthRequest, response) => {
  const testRun = await prisma.testRun.findFirst({ where: { id: request.params.id, project: { organizationId: request.user!.organizationId } }, select: { id: true } });
  if (!testRun) return notFound(response, "Test run not found");
  const runs = await prisma.auditRun.findMany({ where: { testRunId: testRun.id }, orderBy: { createdAt: "desc" }, take: 20 });
  return response.json({ data: runs });
}));

/**
 * GET /api/v1/audits/:id — one audit run with its per-page results.
 *
 * Findings are capped per page audit. A single bad rule on a long page can produce hundreds, and a
 * response that grows without bound is its own outage.
 */
auditRouter.get("/audits/:id", requireAuth, route(async (request: AuthRequest, response) => {
  const auditRun = await prisma.auditRun.findFirst({
    where: { id: request.params.id, project: { organizationId: request.user!.organizationId } },
    include: {
      pageAudits: {
        orderBy: [{ analyzer: "asc" }, { url: "asc" }],
        include: {
          findings: { orderBy: { impact: "asc" }, take: 25 },
          samples: { orderBy: { metric: "asc" } },
          _count: { select: { findings: true } },
        },
      },
    },
  });
  if (!auditRun) return notFound(response, "Audit not found");
  return response.json({ data: auditRun });
}));

/** POST /api/v1/audits/:id/cancel — stops the sweep between pages; results already stored are kept. */
auditRouter.post("/audits/:id/cancel", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canWrite(user.role)) return forbidden(response, "Cancelling an audit is not permitted for your role");
  const { count } = await prisma.auditRun.updateMany({
    where: { id: request.params.id, project: { organizationId: user.organizationId }, status: { in: ["QUEUED", "RUNNING"] } },
    data: { status: "CANCELLED", completedAt: new Date() },
  });
  if (!count) return notFound(response, "No audit in progress for this id");
  return response.status(202).json({ data: { id: request.params.id, status: "CANCELLED" } });
}));

const allowlistSchema = z.object({ egressAllowlist: z.array(z.string().trim().min(1).max(300)).max(20) });

/**
 * PATCH /api/v1/projects/:id/egress-allowlist — extra origins reachable during a run.
 *
 * Entries are normalised to bare origins and re-validated here, so a path, a credential, or a
 * non-HTTP scheme cannot be stored. This only ever waives the *same-origin* rule; every SSRF check
 * still applies at request time, which is what stops an allowlist becoming a way to reach a private
 * or cloud-metadata address.
 */
auditRouter.patch("/projects/:id/egress-allowlist", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canWrite(user.role)) return forbidden(response, "Changing the egress allowlist is not permitted for your role");

  const input = allowlistSchema.parse(request.body ?? {});
  const rejected = input.egressAllowlist.filter(entry => parseAllowedOrigin(entry) === null);
  if (rejected.length) {
    return conflict(response, "INVALID_ORIGIN", `Not a valid http(s) origin: ${rejected.slice(0, 3).join(", ")}`);
  }
  const origins = [...new Set(input.egressAllowlist.map(entry => parseAllowedOrigin(entry)!))];

  const { count } = await prisma.project.updateMany({ where: { id: request.params.id, organizationId: user.organizationId }, data: { egressAllowlist: origins } });
  if (!count) return notFound(response, "Project not found");
  return response.json({ data: { id: request.params.id, egressAllowlist: origins } });
}));
