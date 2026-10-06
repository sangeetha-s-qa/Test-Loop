import express, { Router, type Response } from "express";
import type { Prisma, TestRun } from "@prisma/client";
import { z } from "zod";
import { deleteObject, getObject, signArtifactToken, verifyArtifactToken } from "../artifacts/storage";
import { config } from "../config";
import { prisma } from "../db";
import { canWrite, conflict, fail, forbidden, notFound, route, registerUuidParams } from "../http";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { toCsv } from "../reporting/routes";
import { captureScreenshot, closeSession, getSession, launchSession, sessionCapability, SessionError } from "./browser-session";
import { blockedReasons, manualStatuses, type ManualStatus } from "./catalog";
import { EvidenceError, evidenceSelect, storeEvidence } from "./evidence";
import { generateManualCases } from "./generator";
import { buildManualReport } from "./report";
import { computeProgress, executedStatuses, runPhase, validateResult } from "./rules";

export const manualRouter = Router();
// A malformed id must not reach Prisma's UUID cast and surface as a 500.
registerUuidParams(manualRouter);

/* ------------------------------------------------------------------------------------------------
 * Shared lookups. Every query is scoped through project -> organization, so an id belonging to
 * another tenant is indistinguishable from one that does not exist.
 * ---------------------------------------------------------------------------------------------- */

type ManualSettings = { autoScreenshotOnFail: boolean };
const readSettings = (run: Pick<TestRun, "configuration">): ManualSettings => {
  const manual = (run.configuration as { manual?: Partial<ManualSettings> } | null)?.manual;
  // Off unless the tester switched it on: nothing is captured without their visible say-so.
  return { autoScreenshotOnFail: manual?.autoScreenshotOnFail === true };
};

const viewportPresets: Record<string, { width: number; height: number }> = { desktop: { width: 1440, height: 900 }, tablet: { width: 1024, height: 768 }, mobile: { width: 390, height: 844 } };

async function findRun(id: string, organizationId: string) {
  return prisma.testRun.findFirst({ where: { id, project: { organizationId } }, include: { project: { select: { id: true, name: true, organizationId: true } } } });
}

type LoadedRun = NonNullable<Awaited<ReturnType<typeof findRun>>>;

/** Resolves a manual run for the caller, writing the right error response when it cannot. */
async function loadManualRun(request: AuthRequest, response: Response, options: { write?: boolean } = {}): Promise<LoadedRun | null> {
  const user = request.user!;
  if (options.write && !canWrite(user.role)) {
    forbidden(response, "Your role cannot change manual test results");
    return null;
  }
  const run = await findRun(request.params.id, user.organizationId);
  if (!run) {
    notFound(response, "Test run not found");
    return null;
  }
  if (run.testingMethod !== "MANUAL") {
    conflict(response, "NOT_A_MANUAL_RUN", "This test run uses automated testing, not manual testing");
    return null;
  }
  if (options.write && run.status === "COMPLETED") {
    conflict(response, "RUN_COMPLETED", "This manual test run is completed and can no longer be changed");
    return null;
  }
  return run;
}

async function progressFor(testRunId: string) {
  const groups = await prisma.testCase.groupBy({ by: ["manualStatus"], where: { testRunId }, _count: { _all: true } });
  return computeProgress(Object.fromEntries(groups.map(group => [group.manualStatus, group._count._all])) as Partial<Record<ManualStatus, number>>);
}

const caseSelect = {
  id: true,
  testRunId: true,
  testCaseId: true,
  title: true,
  description: true,
  module: true,
  category: true,
  priority: true,
  severity: true,
  preconditions: true,
  testData: true,
  steps: true,
  expectedResult: true,
  postconditions: true,
  generationSource: true,
  manualStatus: true,
  actualResult: true,
  testerNotes: true,
  blockedReason: true,
  executedAt: true,
  updatedAt: true,
  createdAt: true,
  executedBy: { select: { id: true, name: true } },
  _count: { select: { manualEvidence: true } },
  bugs: { select: { id: true, reference: true, status: true, assignee: { select: { name: true } } }, take: 1 },
} as const;

const sendError = (response: Response, error: unknown) => {
  if (error instanceof SessionError || error instanceof EvidenceError) return fail(response, error.status, error.code, error.message);
  throw error;
};

/* ------------------------------------------------------------------------------------------------
 * Run
 * ---------------------------------------------------------------------------------------------- */

/** GET /api/v1/manual-runs/:id — run, live progress, settings, and testing-window state. */
manualRouter.get("/manual-runs/:id", requireAuth, route(async (request, response) => {
  const run = await loadManualRun(request, response);
  if (!run) return;
  const [progress, session, discovery, referenceCount] = await Promise.all([
    progressFor(run.id),
    getSession(run.id),
    prisma.discoveryRun.findUnique({ where: { testRunId: run.id }, select: { id: true, status: true, pagesDiscovered: true, formsDiscovered: true, linksDiscovered: true, failureMessage: true } }),
    prisma.manualEvidence.count({ where: { testRunId: run.id, testCaseId: null } }),
  ]);
  const { project, ...rest } = run;
  return response.json({
    data: {
      ...rest,
      project: { id: project.id, name: project.name },
      phase: runPhase(run.status),
      progress,
      settings: readSettings(run),
      discovery,
      referenceCount,
      session,
      browserCapability: sessionCapability(),
    },
  });
}));

const settingsSchema = z.object({ autoScreenshotOnFail: z.boolean() });

/** PATCH /api/v1/manual-runs/:id/settings — the visible "capture when marking Failed" switch. */
manualRouter.patch("/manual-runs/:id/settings", requireAuth, route(async (request, response) => {
  const run = await loadManualRun(request, response, { write: true });
  if (!run) return;
  const input = settingsSchema.parse(request.body ?? {});
  const configuration = { ...(run.configuration as Record<string, unknown>), manual: { ...readSettings(run), ...input } };
  await prisma.testRun.update({ where: { id: run.id }, data: { configuration: configuration as Prisma.InputJsonValue } });
  return response.json({ data: configuration.manual });
}));

/* ------------------------------------------------------------------------------------------------
 * Test cases
 * ---------------------------------------------------------------------------------------------- */

/**
 * POST /api/v1/manual-runs/:id/test-cases/generate — builds the manual suite.
 *
 * Uses discovery data when discovery has completed, and the URL, application type, testing types,
 * and requirements either way. Every generated case starts at NOT_RUN; nothing here records a
 * result. Refused once cases exist, so a second click can never duplicate or overwrite a suite a
 * tester has started working through.
 */
manualRouter.post("/manual-runs/:id/test-cases/generate", requireAuth, route(async (request, response) => {
  const run = await loadManualRun(request, response, { write: true });
  if (!run) return;
  const existing = await prisma.testCase.count({ where: { testRunId: run.id } });
  if (existing) return conflict(response, "MANUAL_CASES_EXIST", "Test cases have already been generated for this run");

  const discovery = await prisma.discoveryRun.findUnique({
    where: { testRunId: run.id },
    include: {
      pages: { select: { id: true, normalizedUrl: true, title: true, depth: true }, orderBy: { depth: "asc" } },
      forms: { select: { pageId: true, identifier: true, method: true, fields: { select: { name: true, type: true, label: true, required: true, placeholder: true, autocomplete: true } } } },
      links: { select: { pageId: true, normalizedUrl: true, visibleText: true, sameOrigin: true } },
      endpoints: { select: { method: true, normalizedUrl: true, observedStatus: true } },
    },
  });
  if (discovery?.status === "DISCOVERING") return conflict(response, "DISCOVERY_IN_PROGRESS", "Wait for discovery to finish, or cancel it, before generating test cases");
  const discovered = discovery?.status === "COMPLETED" && discovery.pages.length ? discovery : null;
  const settings = run.configuration as { browser?: string };

  const generated = generateManualCases(
    {
      applicationUrl: run.applicationUrl,
      applicationType: run.applicationType,
      testingTypes: run.testingTypes as string[],
      requirements: run.requirements,
      browser: settings.browser ?? "chromium",
      discovery: discovered ? { pages: discovered.pages, forms: discovered.forms, links: discovered.links, endpoints: discovered.endpoints } : null,
    },
    config.MANUAL_MAX_TEST_CASES,
  );
  if (!generated.length) return conflict(response, "NOTHING_TO_GENERATE", "No test cases apply to the selected testing types. Add testing types or requirements.");

  // An AIGenerationRun row is the provenance record every TestCase points at. It names the rules
  // engine honestly as its provider, so nothing downstream mistakes these cases for model output.
  const created = await prisma.$transaction(async transaction => {
    const generation = await transaction.aIGenerationRun.create({
      data: {
        testRunId: run.id,
        status: "COMPLETED",
        provider: "testloop-manual-rules",
        model: "manual-generator",
        promptVersion: "manual-v1",
        inputSummary: { usedDiscovery: Boolean(discovered), pages: discovered?.pages.length ?? 0, forms: discovered?.forms.length ?? 0, links: discovered?.links.length ?? 0, endpoints: discovered?.endpoints.length ?? 0, testingTypes: run.testingTypes as string[], applicationType: run.applicationType },
        testCaseCount: generated.length,
        startedAt: new Date(),
        completedAt: new Date(),
      },
    });
    await transaction.testCase.createMany({
      data: generated.map(item => ({
        testRunId: run.id,
        generationRunId: generation.id,
        testCaseId: item.testCaseId,
        title: item.title,
        description: item.description,
        module: item.module,
        category: item.category,
        priority: item.priority,
        severity: item.severity,
        preconditions: item.preconditions,
        testData: item.testData,
        steps: item.steps,
        expectedResult: item.expectedResult,
        postconditions: item.postconditions,
        sourcePageId: item.sourcePageId,
        generationSource: "MANUAL_RULES",
      })),
    });
    await transaction.manualTestEvent.create({ data: { testRunId: run.id, userId: request.user!.id, type: "CASES_GENERATED", detail: { count: generated.length, usedDiscovery: Boolean(discovered) } } });
    return generation;
  });

  return response.status(201).json({ data: { generationRunId: created.id, count: generated.length, usedDiscovery: Boolean(discovered), progress: await progressFor(run.id) } });
}));

/** GET /api/v1/manual-runs/:id/test-cases — every case with its manual state and evidence count. */
manualRouter.get("/manual-runs/:id/test-cases", requireAuth, route(async (request, response) => {
  const run = await loadManualRun(request, response);
  if (!run) return;
  const cases = await prisma.testCase.findMany({ where: { testRunId: run.id }, select: caseSelect, orderBy: [{ createdAt: "asc" }, { testCaseId: "asc" }] });
  return response.json({ data: cases });
}));

const resultSchema = z
  .object({
    status: z.enum(manualStatuses).optional(),
    actualResult: z.string().max(10_000).optional(),
    testerNotes: z.string().max(10_000).optional(),
    blockedReason: z.enum(blockedReasons).nullable().optional(),
  })
  .strict()
  .refine(value => Object.keys(value).length > 0, "Nothing to update");

/**
 * PATCH /api/v1/manual-runs/:id/test-cases/:caseId — records a tester's result.
 *
 * Validation runs on the merged result (stored values plus this request), so a tester who wrote the
 * actual result earlier and now only sends `status: FAILED` is not told it is missing. A FAILED or
 * BLOCKED result without its required explanation is refused with 422 and field-level messages.
 */
manualRouter.patch("/manual-runs/:id/test-cases/:caseId", requireAuth, route(async (request, response) => {
  const run = await loadManualRun(request, response, { write: true });
  if (!run) return;
  const input = resultSchema.parse(request.body ?? {});
  const current = await prisma.testCase.findFirst({ where: { id: request.params.caseId, testRunId: run.id } });
  if (!current) return notFound(response, "Test case not found");

  const status = input.status ?? current.manualStatus;
  const merged = {
    status,
    actualResult: input.actualResult ?? current.actualResult,
    testerNotes: input.testerNotes ?? current.testerNotes,
    // A blocked reason only means something while the case is blocked.
    blockedReason: status === "BLOCKED" ? (input.blockedReason === undefined ? current.blockedReason : input.blockedReason) : null,
  };
  const errors = validateResult(merged);
  if (errors.length) return response.status(422).json({ error: { code: "RESULT_INCOMPLETE", message: errors[0].message, details: errors } });

  const statusChanged = status !== current.manualStatus;
  const executed = executedStatuses.includes(status);
  const now = new Date();
  const user = request.user!;

  const updated = await prisma.$transaction(async transaction => {
    const row = await transaction.testCase.update({
      where: { id: current.id },
      data: {
        manualStatus: status,
        actualResult: merged.actualResult,
        testerNotes: merged.testerNotes,
        blockedReason: merged.blockedReason,
        // The verdict's timestamp and author move only when the verdict itself changes.
        ...(statusChanged ? (executed ? { executedAt: now, executedById: user.id } : { executedAt: null, executedById: null }) : {}),
      },
      select: caseSelect,
    });
    await transaction.manualTestEvent.create({
      data: statusChanged
        ? { testRunId: run.id, testCaseId: current.id, userId: user.id, type: "STATUS_CHANGED", fromStatus: current.manualStatus, toStatus: status, detail: merged.blockedReason ? { blockedReason: merged.blockedReason } : {} }
        : { testRunId: run.id, testCaseId: current.id, userId: user.id, type: "RESULT_UPDATED", detail: { fields: Object.keys(input).filter(key => key !== "status") } },
    });
    // The first recorded activity is when the run started.
    if (status !== "NOT_RUN") await transaction.testRun.updateMany({ where: { id: run.id, status: "QUEUED" }, data: { status: "RUNNING", startedAt: now } });
    return row;
  });

  // Automatic capture on Failed, only with the run's visible setting on and a window actually open.
  // A capture problem is reported back but never undoes the result the tester just recorded.
  let autoCapture: { attempted: boolean; captured: boolean; reason: string | null; evidence?: unknown } = { attempted: false, captured: false, reason: null };
  if (statusChanged && status === "FAILED" && readSettings(run).autoScreenshotOnFail) {
    const session = await getSession(run.id);
    if (session?.status !== "ACTIVE") autoCapture = { attempted: false, captured: false, reason: "No testing window is open, so nothing was captured automatically." };
    else {
      try {
        const shot = await captureScreenshot(run.id);
        const evidence = await storeEvidence({ organizationId: user.organizationId, projectId: run.projectId, testRunId: run.id, testCaseId: current.id, userId: user.id, source: "AUTO_ON_FAIL", body: shot.body, pageUrl: shot.pageUrl });
        autoCapture = { attempted: true, captured: true, reason: null, evidence };
      } catch (error) {
        autoCapture = { attempted: true, captured: false, reason: error instanceof Error ? error.message : "Capture failed" };
      }
    }
  }

  const testCase = autoCapture.captured ? await prisma.testCase.findUnique({ where: { id: current.id }, select: caseSelect }) : updated;
  return response.json({ data: { testCase, progress: await progressFor(run.id), runStatus: status !== "NOT_RUN" && run.status === "QUEUED" ? "RUNNING" : run.status, autoCapture } });
}));

/* ------------------------------------------------------------------------------------------------
 * Evidence
 * ---------------------------------------------------------------------------------------------- */

/** Raw body parser for uploads only. The rest of the API keeps its 1 MB JSON limit. */
const rawUpload = express.raw({ type: () => true, limit: Math.max(config.MANUAL_EVIDENCE_MAX_IMAGE_BYTES, config.MANUAL_EVIDENCE_MAX_VIDEO_BYTES) + 1 });

const uploadedName = (request: AuthRequest) => {
  const header = request.headers["x-file-name"];
  if (typeof header !== "string") return undefined;
  try {
    return decodeURIComponent(header);
  } catch {
    return undefined;
  }
};

async function findCase(runId: string, caseId: string) {
  return prisma.testCase.findFirst({ where: { id: caseId, testRunId: runId }, select: { id: true } });
}

/** GET /api/v1/manual-runs/:id/test-cases/:caseId/evidence */
manualRouter.get("/manual-runs/:id/test-cases/:caseId/evidence", requireAuth, route(async (request, response) => {
  const run = await loadManualRun(request, response);
  if (!run) return;
  if (!(await findCase(run.id, request.params.caseId))) return notFound(response, "Test case not found");
  const evidence = await prisma.manualEvidence.findMany({ where: { testRunId: run.id, testCaseId: request.params.caseId }, select: evidenceSelect, orderBy: { createdAt: "asc" } });
  return response.json({ data: evidence });
}));

/** POST /api/v1/manual-runs/:id/test-cases/:caseId/evidence — upload a screenshot or video (raw body). */
manualRouter.post("/manual-runs/:id/test-cases/:caseId/evidence", requireAuth, rawUpload, route(async (request, response) => {
  const run = await loadManualRun(request, response, { write: true });
  if (!run) return;
  if (!(await findCase(run.id, request.params.caseId))) return notFound(response, "Test case not found");
  const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  try {
    const evidence = await storeEvidence({ organizationId: request.user!.organizationId, projectId: run.projectId, testRunId: run.id, testCaseId: request.params.caseId, userId: request.user!.id, source: "UPLOAD", body, fileName: uploadedName(request) });
    return response.status(201).json({ data: evidence });
  } catch (error) {
    return sendError(response, error);
  }
}));

/** POST /api/v1/manual-runs/:id/test-cases/:caseId/evidence/capture — screenshot of the testing window. */
manualRouter.post("/manual-runs/:id/test-cases/:caseId/evidence/capture", requireAuth, route(async (request, response) => {
  const run = await loadManualRun(request, response, { write: true });
  if (!run) return;
  if (!(await findCase(run.id, request.params.caseId))) return notFound(response, "Test case not found");
  try {
    const shot = await captureScreenshot(run.id);
    const evidence = await storeEvidence({ organizationId: request.user!.organizationId, projectId: run.projectId, testRunId: run.id, testCaseId: request.params.caseId, userId: request.user!.id, source: "BROWSER_CAPTURE", body: shot.body, pageUrl: shot.pageUrl });
    return response.status(201).json({ data: evidence });
  } catch (error) {
    return sendError(response, error);
  }
}));

/** GET/POST /api/v1/manual-runs/:id/references — run-level reference material (screenshots, mock-ups). */
manualRouter.get("/manual-runs/:id/references", requireAuth, route(async (request, response) => {
  const run = await loadManualRun(request, response);
  if (!run) return;
  const evidence = await prisma.manualEvidence.findMany({ where: { testRunId: run.id, testCaseId: null }, select: evidenceSelect, orderBy: { createdAt: "asc" } });
  return response.json({ data: evidence });
}));

manualRouter.post("/manual-runs/:id/references", requireAuth, rawUpload, route(async (request, response) => {
  const run = await loadManualRun(request, response, { write: true });
  if (!run) return;
  const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  try {
    const evidence = await storeEvidence({ organizationId: request.user!.organizationId, projectId: run.projectId, testRunId: run.id, testCaseId: null, userId: request.user!.id, source: "UPLOAD", body, fileName: uploadedName(request) });
    return response.status(201).json({ data: evidence });
  } catch (error) {
    return sendError(response, error);
  }
}));

/** Token scope prefix, so a manual-evidence token can never be replayed against /artifacts and vice versa. */
const evidenceTokenSubject = (id: string) => `manual-evidence:${id}`;

/** GET /api/v1/manual-evidence/:id/url — mints a short-lived signed URL after the tenancy check. */
manualRouter.get("/manual-evidence/:id/url", requireAuth, route(async (request, response) => {
  const evidence = await prisma.manualEvidence.findFirst({ where: { id: request.params.id, project: { organizationId: request.user!.organizationId } }, select: { id: true, fileName: true, contentType: true, byteSize: true } });
  if (!evidence) return notFound(response, "Evidence not found");
  const token = signArtifactToken(evidenceTokenSubject(evidence.id), request.user!.organizationId);
  return response.json({ data: { ...evidence, url: `/api/v1/manual-evidence/${evidence.id}/download?token=${token}`, expiresInSeconds: 300 } });
}));

/** GET /api/v1/manual-evidence/:id/download — serves bytes for a valid, unexpired, tenant-matched token. */
manualRouter.get("/manual-evidence/:id/download", route(async (request, response) => {
  const claim = verifyArtifactToken(typeof request.query.token === "string" ? request.query.token : "");
  if (!claim || claim.artifactId !== evidenceTokenSubject(request.params.id)) return notFound(response, "Evidence not found");
  const evidence = await prisma.manualEvidence.findFirst({ where: { id: request.params.id, project: { organizationId: claim.organizationId } }, select: { storageKey: true, fileName: true, contentType: true } });
  if (!evidence) return notFound(response, "Evidence not found");
  try {
    const body = await getObject(evidence.storageKey);
    response.setHeader("content-type", evidence.contentType);
    response.setHeader("content-disposition", `inline; filename="${evidence.fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
    response.setHeader("cache-control", "private, max-age=60");
    response.setHeader("x-content-type-options", "nosniff");
    // Same reasoning as execution artifacts: the token already gated access, and the frontend is a
    // different origin that must be allowed to render the image.
    response.setHeader("cross-origin-resource-policy", "cross-origin");
    return response.send(body);
  } catch {
    return notFound(response, "Evidence bytes are no longer available");
  }
}));

/** DELETE /api/v1/manual-evidence/:id — removes evidence while its run is still open. */
manualRouter.delete("/manual-evidence/:id", requireAuth, route(async (request, response) => {
  const user = request.user!;
  if (!canWrite(user.role)) return forbidden(response, "Your role cannot remove evidence");
  const evidence = await prisma.manualEvidence.findFirst({ where: { id: request.params.id, project: { organizationId: user.organizationId } }, include: { testRun: { select: { status: true } } } });
  if (!evidence) return notFound(response, "Evidence not found");
  // Once a run is completed its report is a record; evidence behind it must not disappear.
  if (evidence.testRun.status === "COMPLETED") return conflict(response, "RUN_COMPLETED", "Evidence on a completed run cannot be removed");
  await prisma.$transaction([
    prisma.manualEvidence.delete({ where: { id: evidence.id } }),
    prisma.manualTestEvent.create({ data: { testRunId: evidence.testRunId, testCaseId: evidence.testCaseId, userId: user.id, type: "EVIDENCE_REMOVED", detail: { evidenceId: evidence.id, fileName: evidence.fileName } } }),
  ]);
  await deleteObject(evidence.storageKey).catch(() => undefined);
  return response.status(204).send();
}));

/* ------------------------------------------------------------------------------------------------
 * Testing window
 * ---------------------------------------------------------------------------------------------- */

manualRouter.get("/manual-runs/:id/session", requireAuth, route(async (request, response) => {
  const run = await loadManualRun(request, response);
  if (!run) return;
  return response.json({ data: { capability: sessionCapability(), session: await getSession(run.id) } });
}));

/** POST /api/v1/manual-runs/:id/session — opens a real browser window on the target application. */
manualRouter.post("/manual-runs/:id/session", requireAuth, route(async (request, response) => {
  const run = await loadManualRun(request, response, { write: true });
  if (!run) return;
  const settings = run.configuration as { browser?: string; viewport?: string; customViewport?: { width: number; height: number } };
  const browser = ["chromium", "firefox", "webkit"].includes(settings.browser ?? "") ? settings.browser! : "chromium";
  const viewport = settings.viewport === "custom" && settings.customViewport ? settings.customViewport : (viewportPresets[settings.viewport ?? "desktop"] ?? viewportPresets.desktop);
  try {
    const session = await launchSession({ testRunId: run.id, projectId: run.projectId, userId: request.user!.id, browser, targetUrl: run.applicationUrl, viewport });
    await prisma.manualTestEvent.create({ data: { testRunId: run.id, userId: request.user!.id, type: "SESSION_STARTED", detail: { sessionId: session.id, browser } } });
    return response.status(201).json({ data: session });
  } catch (error) {
    return sendError(response, error);
  }
}));

/** DELETE /api/v1/manual-runs/:id/session — closes the testing window. */
manualRouter.delete("/manual-runs/:id/session", requireAuth, route(async (request, response) => {
  const user = request.user!;
  if (!canWrite(user.role)) return forbidden(response, "Your role cannot close the testing window");
  const run = await loadManualRun(request, response);
  if (!run) return;
  const closed = await closeSession(run.id);
  if (!closed) return notFound(response, "No testing window is open for this run");
  await prisma.manualTestEvent.create({ data: { testRunId: run.id, userId: user.id, type: "SESSION_CLOSED", detail: {} } });
  return response.json({ data: await getSession(run.id) });
}));

/* ------------------------------------------------------------------------------------------------
 * Completion and report
 * ---------------------------------------------------------------------------------------------- */

const completeSchema = z.object({ acknowledgeNotRun: z.boolean().default(false) });

/**
 * POST /api/v1/manual-runs/:id/complete
 *
 * Refused with NOT_RUN_REMAINING while cases are unexecuted, unless the tester explicitly
 * acknowledges them. Completing never changes a case's status: unexecuted cases stay NOT_RUN in the
 * report, which is the truth.
 */
manualRouter.post("/manual-runs/:id/complete", requireAuth, route(async (request, response) => {
  const run = await loadManualRun(request, response, { write: true });
  if (!run) return;
  const input = completeSchema.parse(request.body ?? {});
  const progress = await progressFor(run.id);
  if (!progress.total) return conflict(response, "NO_TEST_CASES", "Generate test cases before completing the run");
  const remaining = progress.notRun + progress.inProgress;
  if (remaining && !input.acknowledgeNotRun) {
    return response.status(409).json({ error: { code: "NOT_RUN_REMAINING", message: `You still have ${remaining} test case${remaining === 1 ? "" : "s"} that ${remaining === 1 ? "has" : "have"} not been executed.`, details: progress } });
  }
  const now = new Date();
  const { count } = await prisma.testRun.updateMany({ where: { id: run.id, status: { not: "COMPLETED" } }, data: { status: "COMPLETED", completedAt: now, completedById: request.user!.id, startedAt: run.startedAt ?? now } });
  if (!count) return conflict(response, "RUN_COMPLETED", "This manual test run is already completed");
  await prisma.manualTestEvent.create({ data: { testRunId: run.id, userId: request.user!.id, type: "RUN_COMPLETED", detail: { ...progress, acknowledgedNotRun: remaining } } });
  // The run is over, so its testing window is too.
  await closeSession(run.id, "RUN_COMPLETED");
  return response.json({ data: { status: "COMPLETED", completedAt: now, progress } });
}));

/** GET /api/v1/manual-runs/:id/report — JSON, or `?format=csv` for a spreadsheet of every case. */
manualRouter.get("/manual-runs/:id/report", requireAuth, route(async (request, response) => {
  const run = await loadManualRun(request, response);
  if (!run) return;
  const report = await buildManualReport(run.id);
  if (!report) return notFound(response, "Test run not found");
  if (request.query.format === "csv") {
    const cases = await prisma.testCase.findMany({ where: { testRunId: run.id }, orderBy: { testCaseId: "asc" }, select: { testCaseId: true, title: true, category: true, priority: true, manualStatus: true, expectedResult: true, actualResult: true, testerNotes: true, blockedReason: true, executedAt: true, executedBy: { select: { name: true } }, _count: { select: { manualEvidence: true } } } });
    const rows = cases.map(item => ({ id: item.testCaseId, title: item.title, testingType: item.category, priority: item.priority, status: item.manualStatus, expectedResult: item.expectedResult, actualResult: item.actualResult, notes: item.testerNotes, blockedReason: item.blockedReason ?? "", executedAt: item.executedAt?.toISOString() ?? "", executedBy: item.executedBy?.name ?? "", evidenceCount: item._count.manualEvidence }));
    response.setHeader("content-type", "text/csv; charset=utf-8");
    response.setHeader("content-disposition", `attachment; filename="manual-run-${run.id.slice(0, 8)}.csv"`);
    return response.send(toCsv(rows, ["id", "title", "testingType", "priority", "status", "expectedResult", "actualResult", "notes", "blockedReason", "executedAt", "executedBy", "evidenceCount"]));
  }
  return response.json({ data: report });
}));
