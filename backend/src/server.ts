import crypto from "node:crypto";
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import { ZodError } from "zod";
import { prisma } from "./db";
import { config } from "./config";
import { registerUuidParams } from "./http";
import { canManageProjects, requireAuth, type AuthRequest } from "./middleware/auth";
import { environmentSchema, projectSchema, testRunSchema } from "./validation";
import { discoveryJobId, enqueueDiscovery } from "./discovery/queue";
import { assertSafeUrl } from "./discovery/scope";
import { enqueueAIGeneration } from "./ai/queue";
import { checkProviderReady, createAIProvider } from "./ai/provider";
import { promptVersion } from "./ai/prompt";
import { automationRouter } from "./automation/routes";
import { snapshotTestCase } from "./automation/service";
import { executionRouter } from "./execution/routes";
import { analysisRouter } from "./analysis/routes";
import { visualRouter } from "./visual/routes";
import { reportingRouter } from "./reporting/routes";
import { auditRouter } from "./audit/routes";
import { matrixRouter } from "./matrix/routes";
import { authRouter } from "./auth/routes";
import { bugsRouter } from "./bugs/routes";
import { teamRouter } from "./team/routes";
import { manualRouter } from "./manual/routes";
import { closeAllSessions, reconcileOrphanedSessions } from "./manual/browser-session";

const app = express();
// A malformed id must not reach Prisma's UUID cast and surface as a 500.
registerUuidParams(app);
app.use(helmet());
app.use(cors({ origin: config.FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => { if (error) response.status(400).json({ error: { code: "INVALID_REQUEST", message: "Invalid request" } }); else next(); });

app.get("/health", (_request, response) => response.json({ status: "ok", service: "testloop-control-plane" }));

/** Reports whether the configured AI provider is actually usable, without revealing endpoints or keys. */
app.get("/api/v1/ai/status", requireAuth, async (_request: AuthRequest, response) => {
  const provider = config.AI_PROVIDER ?? null;
  const ready = await checkProviderReady();
  response.json({ data: ready.ready ? { provider, model: config.AI_MODEL ?? null, ready: true } : { provider, model: config.AI_MODEL ?? null, ready: false, code: ready.code, detail: ready.detail } });
});

// Sign-up, sign-in, email codes, and password reset live in their own router.
app.use("/api/v1", authRouter);

app.get("/api/v1/projects", requireAuth, async (request: AuthRequest, response) => { const projects = await prisma.project.findMany({ where: { organizationId: request.user!.organizationId }, include: { environments: true }, orderBy: { createdAt: "desc" } }); response.json({ data: projects }); });
app.post("/api/v1/projects", requireAuth, async (request: AuthRequest, response) => { if (!canManageProjects(request.user!.role)) return response.status(403).json({ error: { code: "FORBIDDEN", message: "Project creation is not permitted" } }); const input = projectSchema.parse(request.body); const project = await prisma.project.create({ data: { ...input, organizationId: request.user!.organizationId } }); response.status(201).json({ data: project }); });
app.get("/api/v1/projects/:id", requireAuth, async (request: AuthRequest, response) => { const project = await prisma.project.findFirst({ where: { id: request.params.id, organizationId: request.user!.organizationId }, include: { environments: true } }); if (!project) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Project not found" } }); response.json({ data: project }); });
app.patch("/api/v1/projects/:id", requireAuth, async (request: AuthRequest, response) => { if (!canManageProjects(request.user!.role)) return response.status(403).json({ error: { code: "FORBIDDEN", message: "Project editing is not permitted" } }); const input = projectSchema.partial().parse(request.body); const project = await prisma.project.updateMany({ where: { id: request.params.id, organizationId: request.user!.organizationId }, data: input }); if (!project.count) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Project not found" } }); response.json({ data: { id: request.params.id, ...input } }); });
app.delete("/api/v1/projects/:id", requireAuth, async (request: AuthRequest, response) => { if (!canManageProjects(request.user!.role)) return response.status(403).json({ error: { code: "FORBIDDEN", message: "Project deletion is not permitted" } }); const result = await prisma.project.deleteMany({ where: { id: request.params.id, organizationId: request.user!.organizationId } }); if (!result.count) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Project not found" } }); response.status(204).send(); });
app.get("/api/v1/projects/:projectId/environments", requireAuth, async (request: AuthRequest, response) => { const owned = await prisma.project.findFirst({ where: { id: request.params.projectId, organizationId: request.user!.organizationId }, select: { id: true } }); if (!owned) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Project not found" } }); const environments = await prisma.environment.findMany({ where: { projectId: request.params.projectId, project: { organizationId: request.user!.organizationId } } }); response.json({ data: environments }); });
app.post("/api/v1/projects/:projectId/environments", requireAuth, async (request: AuthRequest, response) => { if (!canManageProjects(request.user!.role)) return response.status(403).json({ error: { code: "FORBIDDEN", message: "Environment changes are not permitted" } }); const input = environmentSchema.parse(request.body); const project = await prisma.project.findFirst({ where: { id: request.params.projectId, organizationId: request.user!.organizationId } }); if (!project) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Project not found" } }); const environment = await prisma.environment.create({ data: { ...input, projectId: project.id } }); response.status(201).json({ data: environment }); });

app.post("/api/v1/test-runs", requireAuth, async (request: AuthRequest, response) => { const input = testRunSchema.parse(request.body); const project = await prisma.project.findFirst({ where: { id: input.projectId, organizationId: request.user!.organizationId } }); if (!project) return response.status(404).json({ error: { code: "PROJECT_NOT_FOUND", message: "Project not found" } }); await assertSafeUrl(input.applicationUrl, undefined, { allowLocalFixture: config.DISCOVERY_ALLOW_LOCAL_FIXTURE }); const testRun = await prisma.testRun.create({ data: { projectId: project.id, applicationUrl: input.applicationUrl, requirements: input.requirements, testingTypes: input.testingTypes, configuration: input.advancedSettings, authorizationConfirmed: input.authorizationConfirmed, testingMethod: input.testingMethod, applicationType: input.applicationType ?? null, createdById: request.user!.id, discovery: { create: { jobId: crypto.randomUUID(), browser: input.advancedSettings.browser, configuration: input.advancedSettings } } }, include: { project: { select: { id: true, name: true } }, discovery: true } }); await prisma.discoveryRun.update({ where: { id: testRun.discovery!.id }, data: { jobId: discoveryJobId(testRun.id) } }); response.status(201).json({ data: testRun }); });
app.post("/api/v1/test-runs/:id/discovery/start", requireAuth, async (request: AuthRequest, response) => { const testRun = await prisma.testRun.findFirst({ where: { id: request.params.id, project: { organizationId: request.user!.organizationId } }, include: { project: true, discovery: true } }); if (!testRun?.discovery) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Test run or discovery not found" } }); if (testRun.discovery.status !== "QUEUED") return response.status(409).json({ error: { code: "DISCOVERY_NOT_STARTABLE", message: "Discovery is no longer queued" } }); const settings = testRun.configuration as { browser: "chromium" | "firefox" | "webkit"; viewport: string; customViewport?: { width: number; height: number }; maxPages: number }; const viewport = settings.viewport === "custom" && settings.customViewport ? settings.customViewport : settings.viewport === "mobile" ? { width: 390, height: 844 } : settings.viewport === "tablet" ? { width: 1024, height: 768 } : { width: 1440, height: 900 }; await enqueueDiscovery({ discoveryRunId: testRun.discovery.id, testRunId: testRun.id, projectId: testRun.projectId, applicationUrl: testRun.applicationUrl, browser: settings.browser, viewport, maxPages: settings.maxPages, maxDepth: config.DISCOVERY_MAX_DEPTH, maxDurationSeconds: config.DISCOVERY_MAX_DURATION_SECONDS, maxRedirects: config.DISCOVERY_MAX_REDIRECTS, maxResponseBytes: config.DISCOVERY_MAX_RESPONSE_BYTES, allowLocalFixture: config.DISCOVERY_ALLOW_LOCAL_FIXTURE }); response.status(202).json({ data: { id: testRun.discovery.id, status: "QUEUED", jobId: testRun.discovery.jobId } }); });
app.get("/api/v1/test-runs/:id", requireAuth, async (request: AuthRequest, response: express.Response) => { const testRun = await prisma.testRun.findFirst({ where: { id: request.params.id, project: { organizationId: request.user!.organizationId } }, include: { project: { select: { id: true, name: true } }, discovery: true } }); if (!testRun) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Test run not found" } }); response.json({ data: testRun }); });
app.get("/api/v1/test-runs/:id/discovery", requireAuth, async (request: AuthRequest, response) => { const discovery = await prisma.discoveryRun.findFirst({ where: { testRunId: request.params.id, testRun: { project: { organizationId: request.user!.organizationId } } } }); if (!discovery) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Discovery not found" } }); response.json({ data: discovery }); });
app.get("/api/v1/test-runs/:id/discovery/pages", requireAuth, async (request: AuthRequest, response) => { const run = await prisma.testRun.findFirst({ where: { id: request.params.id, project: { organizationId: request.user!.organizationId } }, select: { id: true } }); if (!run) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Test run not found" } }); const pages = await prisma.discoveredPage.findMany({ where: { discoveryRun: { testRunId: request.params.id, testRun: { project: { organizationId: request.user!.organizationId } } } }, orderBy: { createdAt: "asc" } }); response.json({ data: pages }); });
app.get("/api/v1/test-runs/:id/discovery/forms", requireAuth, async (request: AuthRequest, response) => { const run = await prisma.testRun.findFirst({ where: { id: request.params.id, project: { organizationId: request.user!.organizationId } }, select: { id: true } }); if (!run) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Test run not found" } }); const forms = await prisma.discoveredForm.findMany({ where: { discoveryRun: { testRunId: request.params.id, testRun: { project: { organizationId: request.user!.organizationId } } } }, include: { fields: true }, orderBy: { createdAt: "asc" } }); response.json({ data: forms }); });
app.get("/api/v1/test-runs/:id/discovery/elements", requireAuth, async (request: AuthRequest, response) => { const run = await prisma.testRun.findFirst({ where: { id: request.params.id, project: { organizationId: request.user!.organizationId } }, select: { id: true } }); if (!run) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Test run not found" } }); const elements = await prisma.discoveredElement.findMany({ where: { discoveryRun: { testRunId: request.params.id, testRun: { project: { organizationId: request.user!.organizationId } } } }, orderBy: { createdAt: "asc" } }); response.json({ data: elements }); });
app.get("/api/v1/test-runs/:id/discovery/map", requireAuth, async (request: AuthRequest, response) => { const discovery = await prisma.discoveryRun.findFirst({ where: { testRunId: request.params.id, testRun: { project: { organizationId: request.user!.organizationId } } }, include: { pages: { select: { id: true, normalizedUrl: true, title: true, depth: true, parentUrl: true } }, links: { select: { pageId: true, normalizedUrl: true, visibleText: true, sameOrigin: true } } } }); if (!discovery) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Discovery not found" } }); const pages = discovery.pages.map(page => ({ ...page, children: discovery.pages.filter(child => child.parentUrl === page.normalizedUrl).map(child => child.id), outgoingLinks: discovery.links.filter(link => link.pageId === page.id) })); response.json({ data: { discoveryRunId: discovery.id, status: discovery.status, root: discovery.pages.find(page => page.depth === 0)?.id ?? null, pages } }); });
app.post("/api/v1/test-runs/:id/discovery/cancel", requireAuth, async (request: AuthRequest, response) => { const discovery = await prisma.discoveryRun.updateMany({ where: { testRunId: request.params.id, status: { in: ["QUEUED", "DISCOVERING"] }, testRun: { project: { organizationId: request.user!.organizationId } } }, data: { status: "CANCELLED", cancelRequestedAt: new Date(), completedAt: new Date() } }); if (!discovery.count) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Active discovery not found" } }); response.status(202).json({ data: { status: "CANCELLED" } }); });
app.post("/api/v1/test-runs/:id/ai-analysis", requireAuth, async (request: AuthRequest, response) => { const run = await prisma.testRun.findFirst({ where: { id: request.params.id, project: { organizationId: request.user!.organizationId } }, include: { discovery: { include: { pages: true } } } }); if (!run) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Test run not found" } }); if (!run.discovery || run.discovery.status !== "COMPLETED" || !run.discovery.pages.length) return response.status(409).json({ error: { code: "DISCOVERY_NOT_COMPLETED", message: "Complete website discovery before generating test cases" } }); const ready = await checkProviderReady(); if (!ready.ready) return response.status(503).json({ error: { code: ready.code, message: ready.detail } }); const active = await prisma.aIGenerationRun.findFirst({ where: { testRunId: run.id, status: { in: ["QUEUED", "ANALYZING", "GENERATING"] } } }); if (active) return response.status(409).json({ error: { code: "GENERATION_IN_PROGRESS", message: "AI generation is already running" } }); const provider = createAIProvider(); const generation = await prisma.aIGenerationRun.create({ data: { testRunId: run.id, status: "QUEUED", provider: provider.name, model: provider.model, promptVersion, inputSummary: { pages: run.discovery.pages.length } } }); await enqueueAIGeneration({ generationRunId: generation.id, testRunId: run.id }); response.status(202).json({ data: generation }); });
app.post("/api/v1/test-runs/:id/test-generation", requireAuth, async (request: AuthRequest, response: express.Response) => { request.url = `/api/v1/test-runs/${request.params.id}/ai-analysis`; return response.status(307).redirect(`/api/v1/test-runs/${request.params.id}/ai-analysis`); });
app.get("/api/v1/test-runs/:id/ai-status", requireAuth, async (request: AuthRequest, response) => { const run = await prisma.testRun.findFirst({ where: { id: request.params.id, project: { organizationId: request.user!.organizationId } }, select: { id: true } }); if (!run) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Test run not found" } }); const generation = await prisma.aIGenerationRun.findFirst({ where: { testRunId: request.params.id, testRun: { project: { organizationId: request.user!.organizationId } } }, orderBy: { createdAt: "desc" } }); response.json({ data: generation }); });
app.get("/api/v1/test-runs/:id/scenarios", requireAuth, async (request: AuthRequest, response) => { const run = await prisma.testRun.findFirst({ where: { id: request.params.id, project: { organizationId: request.user!.organizationId } }, select: { id: true } }); if (!run) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Test run not found" } }); const scenarios = await prisma.testScenario.findMany({ where: { testRunId: request.params.id, testRun: { project: { organizationId: request.user!.organizationId } } }, orderBy: { createdAt: "asc" } }); response.json({ data: scenarios }); });
app.get("/api/v1/test-runs/:id/test-cases", requireAuth, async (request: AuthRequest, response) => { const run = await prisma.testRun.findFirst({ where: { id: request.params.id, project: { organizationId: request.user!.organizationId } }, select: { id: true } }); if (!run) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Test run not found" } }); const cases = await prisma.testCase.findMany({ where: { testRunId: request.params.id, testRun: { project: { organizationId: request.user!.organizationId } } }, orderBy: { createdAt: "asc" } }); response.json({ data: cases }); });
app.get("/api/v1/test-cases/:id", requireAuth, async (request: AuthRequest, response) => { const testCase = await prisma.testCase.findFirst({ where: { id: request.params.id, testRun: { project: { organizationId: request.user!.organizationId } } } }); if (!testCase) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Test case not found" } }); response.json({ data: testCase }); });
app.patch("/api/v1/test-cases/:id", requireAuth, async (request: AuthRequest, response) => { const input = request.body as Record<string, unknown>; const allowed = ["title", "description", "preconditions", "testData", "steps", "expectedResult", "postconditions", "priority", "severity", "category"]; const data = Object.fromEntries(Object.entries(input).filter(([key]) => allowed.includes(key))); const testCase = await prisma.testCase.updateMany({ where: { id: request.params.id, testRun: { project: { organizationId: request.user!.organizationId } } }, data: { ...data, modifiedByUser: true } }); if (!testCase.count) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Test case not found" } }); response.json({ data: { id: request.params.id, ...data, modifiedByUser: true } }); });
// Approval writes an immutable TestCaseVersion in the same transaction, so automation generated
// later always names the exact content that was approved.
app.post("/api/v1/test-cases/:id/approve", requireAuth, async (request: AuthRequest, response) => { const user = request.user!; const testCase = await prisma.testCase.findFirst({ where: { id: request.params.id, status: "DRAFT", testRun: { project: { organizationId: user.organizationId } } } }); if (!testCase) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Draft test case not found" } }); const result = await prisma.$transaction(async transaction => { const version = await snapshotTestCase(transaction, testCase, "AI", user.id); return transaction.testCase.update({ where: { id: testCase.id }, data: { status: "APPROVED" }, select: { id: true, status: true, currentVersion: true } }).then(updated => ({ ...updated, versionId: version.id })); }); response.json({ data: result }); });
app.post("/api/v1/test-cases/:id/reject", requireAuth, async (request: AuthRequest, response) => { const result = await prisma.testCase.updateMany({ where: { id: request.params.id, status: "DRAFT", testRun: { project: { organizationId: request.user!.organizationId } } }, data: { status: "REJECTED" } }); if (!result.count) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Draft test case not found" } }); response.json({ data: { id: request.params.id, status: "REJECTED" } }); });
app.post("/api/v1/test-cases/:id/regenerate", requireAuth, async (request: AuthRequest, response: express.Response) => { const testCase = await prisma.testCase.findFirst({ where: { id: request.params.id, testRun: { project: { organizationId: request.user!.organizationId } } } }); if (!testCase) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Test case not found" } }); return response.status(307).redirect(`/api/v1/test-runs/${testCase.testRunId}/ai-analysis`); });
app.post("/api/v1/test-runs/:id/regenerate", requireAuth, async (request: AuthRequest, response: express.Response) => response.status(307).redirect(`/api/v1/test-runs/${request.params.id}/ai-analysis`));
app.post("/api/v1/test-runs/:id/ai-generation/cancel", requireAuth, async (request: AuthRequest, response) => { const result = await prisma.aIGenerationRun.updateMany({ where: { testRunId: request.params.id, status: { in: ["QUEUED", "ANALYZING", "GENERATING"] }, testRun: { project: { organizationId: request.user!.organizationId } } }, data: { status: "CANCELLED", cancelRequestedAt: new Date(), completedAt: new Date() } }); if (!result.count) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Active generation not found" } }); response.status(202).json({ data: { status: "CANCELLED" } }); });
app.get("/api/v1/test-runs", requireAuth, async (request: AuthRequest, response) => { const testRuns = await prisma.testRun.findMany({ where: { project: { organizationId: request.user!.organizationId } }, include: { project: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" }, take: 20 }); response.json({ data: testRuns }); });
app.get("/api/v1/projects/:projectId/test-runs", requireAuth, async (request: AuthRequest, response) => { const owned = await prisma.project.findFirst({ where: { id: request.params.projectId, organizationId: request.user!.organizationId }, select: { id: true } }); if (!owned) return response.status(404).json({ error: { code: "NOT_FOUND", message: "Project not found" } }); const testRuns = await prisma.testRun.findMany({ where: { projectId: request.params.projectId, project: { organizationId: request.user!.organizationId } }, orderBy: { createdAt: "desc" } }); response.json({ data: testRuns }); });
// Phase 5+ routes live in their own routers; controllers stay free of business logic.
app.use("/api/v1", automationRouter);
app.use("/api/v1", executionRouter);
app.use("/api/v1", analysisRouter);
app.use("/api/v1", visualRouter);
app.use("/api/v1", reportingRouter);
app.use("/api/v1", auditRouter);
app.use("/api/v1", matrixRouter);
app.use("/api/v1", manualRouter);
app.use("/api/v1", bugsRouter);
app.use("/api/v1", teamRouter);

// An unmatched API path would otherwise fall through to Express's default handler, which answers
// with an HTML error page. Every client of this API parses JSON, so it must get the same envelope
// for "no such route" as for every other failure.
app.use("/api/v1", (_request: express.Request, response: express.Response) => {
  response.status(404).json({ error: { code: "NOT_FOUND", message: "Resource not found" } });
});

// Terminal error handler. Zod issues become 400 with field paths; everything else is opaque so
// no stack trace, connection string, or provider detail can reach a client.
app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
  if (response.headersSent) return next(error);
  if (error instanceof ZodError) return response.status(400).json({ error: { code: "VALIDATION_FAILED", message: "The request body is invalid", details: error.issues.slice(0, 20).map(issue => ({ path: issue.path.join("."), message: issue.message })) } });
  console.error(JSON.stringify({ event: "request.failed", message: error instanceof Error ? error.message : "unknown" }));
  response.status(500).json({ error: { code: "REQUEST_FAILED", message: "The request could not be completed" } });
});

export { app };

if (require.main === module) {
  // A testing window opened before a restart is gone; its row must say so before anyone reads it.
  void reconcileOrphanedSessions().catch(() => undefined);
  const server = app.listen(config.PORT, () => console.log(`Control plane listening on http://localhost:${config.PORT}`));
  // Manual-testing windows are real browser processes owned by this one. Closing them on shutdown is
  // what keeps a restart (including every `tsx watch` reload) from leaving orphaned browsers behind.
  const shutdown = () => {
    void closeAllSessions().finally(() => {
      server.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}