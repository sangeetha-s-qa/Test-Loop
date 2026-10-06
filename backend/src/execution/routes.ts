import { Router } from "express";
import { z } from "zod";
import { getObject, signArtifactToken, verifyArtifactToken } from "../artifacts/storage";
import { config } from "../config";
import { prisma } from "../db";
import { canWrite, conflict, forbidden, notFound, route, registerUuidParams } from "../http";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { readEvents } from "./events";
import { enqueueExecution } from "./queue";

export const executionRouter = Router();
// A malformed id must not reach Prisma's UUID cast and surface as a 500.
registerUuidParams(executionRouter);

const viewportPresets: Record<string, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 1024, height: 768 },
  mobile: { width: 390, height: 844 },
};

const startSchema = z.object({
  testCaseIds: z.array(z.string().uuid()).max(500).optional(),
  browser: z.enum(["chromium", "firefox", "webkit"]).optional(),
  viewport: z.enum(["desktop", "tablet", "mobile"]).optional(),
});

/**
 * POST /api/v1/test-runs/:id/executions — run every approved automation version for the run.
 * Only APPROVED automation is executable, so an unreviewed script can never produce a result.
 */
executionRouter.post("/test-runs/:id/executions", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canWrite(user.role)) return forbidden(response, "Starting executions is not permitted for your role");

  const input = startSchema.parse(request.body ?? {});
  const testRun = await prisma.testRun.findFirst({ where: { id: request.params.id, project: { organizationId: user.organizationId } } });
  if (!testRun) return notFound(response, "Test run not found");

  const active = await prisma.executionBatch.findFirst({ where: { testRunId: testRun.id, status: { in: ["QUEUED", "RUNNING"] } } });
  if (active) return conflict(response, "EXECUTION_IN_PROGRESS", "An execution batch is already running for this test run");

  const scripts = await prisma.automationScript.findMany({
    where: { testCase: { testRunId: testRun.id, status: "APPROVED", ...(input.testCaseIds?.length ? { id: { in: input.testCaseIds } } : {}) }, approvedVersionId: { not: null } },
    select: { testCaseId: true, approvedVersionId: true, testCase: { select: { scenarioId: true } } },
  });
  if (!scripts.length) return conflict(response, "NO_APPROVED_AUTOMATION", "Approve at least one automation version before running executions");

  const settings = testRun.configuration as { browser?: string; viewport?: string; customViewport?: { width: number; height: number } };
  const browser = input.browser ?? (["chromium", "firefox", "webkit"].includes(settings.browser ?? "") ? settings.browser! : "chromium");
  const viewportName = input.viewport ?? settings.viewport ?? "desktop";
  const viewport = viewportPresets[viewportName] ?? settings.customViewport ?? viewportPresets.desktop;

  const batch = await prisma.executionBatch.create({
    data: {
      testRunId: testRun.id,
      browser,
      viewport,
      requestedCount: scripts.length,
      createdById: user.id,
      executions: {
        create: scripts.map(script => ({
          testRunId: testRun.id,
          projectId: testRun.projectId,
          testCaseId: script.testCaseId,
          scenarioId: script.testCase.scenarioId,
          automationVersionId: script.approvedVersionId!,
          browser,
          viewport,
          applicationUrl: testRun.applicationUrl,
        })),
      },
    },
    include: { executions: { select: { id: true } } },
  });

  for (const execution of batch.executions) {
    await enqueueExecution({ executionId: execution.id, batchId: batch.id, organizationId: user.organizationId, projectId: testRun.projectId });
  }
  return response.status(202).json({ data: { id: batch.id, status: batch.status, requestedCount: batch.requestedCount } });
}));

/** GET /api/v1/test-runs/:id/executions — batch history for a test run. */
executionRouter.get("/test-runs/:id/executions", requireAuth, route(async (request: AuthRequest, response) => {
  const testRun = await prisma.testRun.findFirst({ where: { id: request.params.id, project: { organizationId: request.user!.organizationId } }, select: { id: true } });
  if (!testRun) return notFound(response, "Test run not found");
  const batches = await prisma.executionBatch.findMany({ where: { testRunId: testRun.id }, orderBy: { createdAt: "desc" }, take: 50 });
  return response.json({ data: batches });
}));

/** GET /api/v1/execution-batches/:id — batch summary with per-execution results. */
executionRouter.get("/execution-batches/:id", requireAuth, route(async (request: AuthRequest, response) => {
  const batch = await prisma.executionBatch.findFirst({
    where: { id: request.params.id, testRun: { project: { organizationId: request.user!.organizationId } } },
    include: {
      testRun: { select: { id: true, applicationUrl: true, project: { select: { id: true, name: true } } } },
      executions: {
        orderBy: { createdAt: "asc" },
        select: { id: true, status: true, attempt: true, browser: true, durationMs: true, totalSteps: true, passedSteps: true, failedStepIndex: true, failureCategory: true, failureMessage: true, startedAt: true, completedAt: true, consoleErrorCount: true, networkFailureCount: true, testCase: { select: { id: true, testCaseId: true, title: true, module: true, priority: true, severity: true } }, _count: { select: { artifacts: true } } },
      },
    },
  });
  if (!batch) return notFound(response, "Execution batch not found");
  return response.json({ data: batch });
}));

/** POST /api/v1/execution-batches/:id/cancel — durable cancellation the runner observes per step. */
executionRouter.post("/execution-batches/:id/cancel", requireAuth, route(async (request: AuthRequest, response) => {
  if (!canWrite(request.user!.role)) return forbidden(response, "Cancellation is not permitted for your role");
  const result = await prisma.executionBatch.updateMany({
    where: { id: request.params.id, status: { in: ["QUEUED", "RUNNING"] }, testRun: { project: { organizationId: request.user!.organizationId } } },
    data: { cancelRequestedAt: new Date() },
  });
  if (!result.count) return notFound(response, "No active execution batch found");
  // Executions that have not started yet are terminated immediately; a running one stops at its
  // next step boundary so the browser is closed cleanly.
  await prisma.testExecution.updateMany({ where: { batchId: request.params.id, status: "QUEUED" }, data: { status: "CANCELLED", failureCategory: "CANCELLED", failureMessage: "Cancelled before the execution started", completedAt: new Date() } });
  return response.status(202).json({ data: { status: "CANCEL_REQUESTED" } });
}));

/** GET /api/v1/executions/:id — one execution with every step result and artifact reference. */
executionRouter.get("/executions/:id", requireAuth, route(async (request: AuthRequest, response) => {
  const execution = await prisma.testExecution.findFirst({
    where: { id: request.params.id, project: { organizationId: request.user!.organizationId } },
    include: {
      testCase: { select: { id: true, testCaseId: true, title: true, module: true, description: true, expectedResult: true } },
      automationVersion: { select: { id: true, version: true, sourceCode: true, program: true } },
      steps: { orderBy: { stepIndex: "asc" } },
      artifacts: { select: { id: true, type: true, fileName: true, contentType: true, byteSize: true, checksumSha256: true, stepResultId: true, createdAt: true }, orderBy: { createdAt: "asc" } },
      batch: { select: { id: true, testRunId: true } },
    },
  });
  if (!execution) return notFound(response, "Execution not found");
  return response.json({ data: execution });
}));

/**
 * GET /api/v1/artifacts/:id/url — mints a short-lived download token.
 * Authorization is enforced here, not at download time, so tokens cannot be forged sideways.
 */
executionRouter.get("/artifacts/:id/url", requireAuth, route(async (request: AuthRequest, response) => {
  const artifact = await prisma.executionArtifact.findFirst({
    where: { id: request.params.id, execution: { project: { organizationId: request.user!.organizationId } } },
    select: { id: true, fileName: true, contentType: true, byteSize: true },
  });
  if (!artifact) return notFound(response, "Artifact not found");
  const token = signArtifactToken(artifact.id, request.user!.organizationId);
  return response.json({ data: { ...artifact, url: `/api/v1/artifacts/${artifact.id}/download?token=${token}`, expiresInSeconds: 300 } });
}));

/** GET /api/v1/artifacts/:id/download — serves bytes for a valid, unexpired, tenant-matched token. */
executionRouter.get("/artifacts/:id/download", route(async (request: AuthRequest, response) => {
  const token = typeof request.query.token === "string" ? request.query.token : "";
  const claim = verifyArtifactToken(token);
  if (!claim || claim.artifactId !== request.params.id) return notFound(response, "Artifact not found");
  const artifact = await prisma.executionArtifact.findFirst({
    where: { id: claim.artifactId, execution: { project: { organizationId: claim.organizationId } } },
    select: { storageKey: true, fileName: true, contentType: true },
  });
  if (!artifact) return notFound(response, "Artifact not found");
  try {
    const body = await getObject(artifact.storageKey);
    response.setHeader("content-type", artifact.contentType);
    response.setHeader("content-disposition", `attachment; filename="${artifact.fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
    response.setHeader("cache-control", "private, max-age=60");
    // The frontend is a different origin to the API, and helmet's default
    // `Cross-Origin-Resource-Policy: same-origin` makes the browser refuse to render this in an
    // <img> or <video> - a screenshot appeared as a broken image with only
    // ERR_BLOCKED_BY_RESPONSE.NotSameOrigin in the console. Relaxing it here is safe precisely
    // because the bytes are already gated: reaching this line required a valid, unexpired,
    // tenant-matched HMAC token, and the header grants no ability to read the response, only to
    // display it. It is set on this response alone, never globally.
    response.setHeader("cross-origin-resource-policy", "cross-origin");
    return response.send(body);
  } catch {
    return notFound(response, "Artifact bytes are no longer available");
  }
}));

/**
 * GET /api/v1/execution-batches/:id/events — reconnectable progress.
 * `?after=<sequence>` replays persisted events, so a dropped connection loses nothing.
 */
executionRouter.get("/execution-batches/:id/events", requireAuth, route(async (request: AuthRequest, response) => {
  const batch = await prisma.executionBatch.findFirst({ where: { id: request.params.id, testRun: { project: { organizationId: request.user!.organizationId } } }, select: { id: true } });
  if (!batch) return notFound(response, "Execution batch not found");
  const after = Number(request.query.after ?? 0);
  const events = await readEvents(batch.id, Number.isFinite(after) ? after : 0);
  return response.json({ data: events, cursor: events.at(-1)?.sequence ?? after });
}));

/** GET /api/v1/execution-batches/:id/stream — SSE built on the same persisted events. */
executionRouter.get("/execution-batches/:id/stream", requireAuth, route(async (request: AuthRequest, response) => {
  const batch = await prisma.executionBatch.findFirst({ where: { id: request.params.id, testRun: { project: { organizationId: request.user!.organizationId } } }, select: { id: true } });
  if (!batch) return notFound(response, "Execution batch not found");

  response.setHeader("content-type", "text/event-stream");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.flushHeaders();

  // `Last-Event-ID` is the standard reconnect header; the query parameter is the manual fallback.
  let cursor = Number(request.header("last-event-id") ?? request.query.after ?? 0);
  if (!Number.isFinite(cursor)) cursor = 0;
  let closed = false;
  request.on("close", () => { closed = true; });

  while (!closed) {
    const events = await readEvents(batch.id, cursor);
    for (const event of events) {
      cursor = event.sequence;
      response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
    }
    const current = await prisma.executionBatch.findUnique({ where: { id: batch.id }, select: { status: true } });
    if (current && ["COMPLETED", "FAILED", "CANCELLED"].includes(current.status)) {
      response.write(`event: batch.settled\ndata: ${JSON.stringify({ status: current.status })}\n\n`);
      break;
    }
    // A comment line keeps proxies from closing an idle connection.
    response.write(": keep-alive\n\n");
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  response.end();
}));

/* --------------------------------------------------------------- manual actions (human-in-the-loop) */

const manualActionSelect = {
  id: true,
  executionId: true,
  testRunId: true,
  stepIndex: true,
  reason: true,
  prompt: true,
  status: true,
  pageUrl: true,
  deadlineAt: true,
  extensionCount: true,
  resolvedAt: true,
  createdAt: true,
  execution: { select: { id: true, browser: true, testCase: { select: { id: true, testCaseId: true, title: true } } } },
} as const;

/**
 * GET /api/v1/test-runs/:id/manual-actions — every pause on a run, newest first.
 * The run monitor polls this to decide whether to show the "waiting for you" banner.
 */
executionRouter.get("/test-runs/:id/manual-actions", requireAuth, route(async (request: AuthRequest, response) => {
  const testRun = await prisma.testRun.findFirst({ where: { id: request.params.id, project: { organizationId: request.user!.organizationId } }, select: { id: true } });
  if (!testRun) return notFound(response, "Test run not found");
  const actions = await prisma.manualAction.findMany({ where: { testRunId: testRun.id }, select: manualActionSelect, orderBy: { createdAt: "desc" }, take: 50 });
  return response.json({ data: actions });
}));

/** GET /api/v1/manual-actions/:id — one pause, for the dialog the person answers. */
executionRouter.get("/manual-actions/:id", requireAuth, route(async (request: AuthRequest, response) => {
  const action = await prisma.manualAction.findFirst({
    where: { id: request.params.id, project: { organizationId: request.user!.organizationId } },
    select: manualActionSelect,
  });
  if (!action) return notFound(response, "Manual action not found");
  return response.json({ data: action });
}));

/**
 * Settles a pending pause. Every transition goes through this one helper so the PENDING check and
 * the write happen in a single conditional update - two people hitting Resume at once must not
 * both succeed, and a resolve must never overwrite an expiry the worker has already recorded.
 */
async function settleManualAction(
  request: AuthRequest,
  response: Parameters<Parameters<typeof route>[0]>[1],
  next: "RESOLVED" | "ABORTED",
  verb: string,
) {
  const user = request.user!;
  if (!canWrite(user.role)) return forbidden(response, `${verb} a manual action is not permitted for your role`);

  const action = await prisma.manualAction.findFirst({ where: { id: request.params.id, project: { organizationId: user.organizationId } }, select: { id: true, status: true, deadlineAt: true } });
  if (!action) return notFound(response, "Manual action not found");
  if (action.status !== "PENDING") return conflict(response, "MANUAL_ACTION_SETTLED", `This action is already ${action.status.toLowerCase()}.`);
  if (next === "RESOLVED" && action.deadlineAt.getTime() < Date.now()) {
    return conflict(response, "MANUAL_ACTION_EXPIRED", "The waiting period ended before this was confirmed. Start the run again.");
  }

  const { count } = await prisma.manualAction.updateMany({
    where: { id: action.id, status: "PENDING" },
    data: { status: next, resolvedAt: new Date(), resolvedById: user.id },
  });
  if (!count) return conflict(response, "MANUAL_ACTION_SETTLED", "Someone else answered this first.");

  const updated = await prisma.manualAction.findUnique({ where: { id: action.id }, select: manualActionSelect });
  return response.json({ data: updated });
}

/**
 * POST /api/v1/manual-actions/:id/resolve — the person confirms they completed the action.
 *
 * The request body is empty by design. Whatever they typed went into their own browser; there is
 * no field here for a code, so none can be logged, stored, or put in a report.
 */
executionRouter.post("/manual-actions/:id/resolve", requireAuth, route((request: AuthRequest, response) => settleManualAction(request, response, "RESOLVED", "Resolving")));

/** POST /api/v1/manual-actions/:id/abort — the person gives up; the execution stops. */
executionRouter.post("/manual-actions/:id/abort", requireAuth, route((request: AuthRequest, response) => settleManualAction(request, response, "ABORTED", "Abandoning")));

/**
 * POST /api/v1/manual-actions/:id/extend — pushes the deadline out.
 *
 * Bounded by MANUAL_ACTION_MAX_EXTENSIONS, because an unbounded extension is just a browser held
 * open forever against the organization's concurrency budget.
 */
executionRouter.post("/manual-actions/:id/extend", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canWrite(user.role)) return forbidden(response, "Extending a manual action is not permitted for your role");

  const action = await prisma.manualAction.findFirst({ where: { id: request.params.id, project: { organizationId: user.organizationId } }, select: { id: true, status: true, extensionCount: true } });
  if (!action) return notFound(response, "Manual action not found");
  if (action.status !== "PENDING") return conflict(response, "MANUAL_ACTION_SETTLED", `This action is already ${action.status.toLowerCase()}.`);
  if (action.extensionCount >= config.MANUAL_ACTION_MAX_EXTENSIONS) {
    return conflict(response, "MANUAL_ACTION_EXTENSION_LIMIT", `This run has already been extended ${action.extensionCount} times, which is the maximum.`);
  }

  const { count } = await prisma.manualAction.updateMany({
    where: { id: action.id, status: "PENDING", extensionCount: action.extensionCount },
    data: { deadlineAt: new Date(Date.now() + config.MANUAL_ACTION_TIMEOUT_SECONDS * 1000), extensionCount: { increment: 1 } },
  });
  if (!count) return conflict(response, "MANUAL_ACTION_SETTLED", "The action changed while the extension was being applied.");

  const updated = await prisma.manualAction.findUnique({ where: { id: action.id }, select: manualActionSelect });
  return response.json({ data: updated });
}));

/* --------------------------------------------------------------- screenshot annotations */

/**
 * Regions drawn over a screenshot to mark what is wrong with it.
 *
 * Coordinates are fractions of the image's own width and height, so a box stays correct at any
 * rendered size, and the image itself is never modified: the original artifact keeps the checksum
 * it was stored with, and "never destroy the evidence" holds because there is no code path that
 * could. Flattening for an export renders these on a copy.
 */
const annotationSelect = { id: true, artifactId: true, bugId: true, shape: true, x: true, y: true, width: true, height: true, label: true, colour: true, createdAt: true } as const;

const annotationBody = z.object({
  shape: z.enum(["RECTANGLE", "ARROW", "HIGHLIGHT"]).default("RECTANGLE"),
  // Bounded to the image. A region outside it could not be drawn and would only ever be a bug in
  // whatever produced it.
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0.001).max(1),
  height: z.number().min(0.001).max(1),
  label: z.string().trim().min(1).max(200),
  colour: z.enum(["ROSE", "AMBER", "VIOLET", "EMERALD"]).default("ROSE"),
  bugId: z.string().uuid().nullish(),
});

/** Image artifacts only: a box over a video or a trace file would mean nothing. */
const annotatableTypes = ["SCREENSHOT", "VISUAL_DIFF"] as const;

async function findArtifactForUser(artifactId: string, organizationId: string) {
  return prisma.executionArtifact.findFirst({
    where: { id: artifactId, execution: { project: { organizationId } } },
    select: { id: true, type: true, execution: { select: { projectId: true } } },
  });
}

/** GET /api/v1/artifacts/:id/annotations */
executionRouter.get("/artifacts/:id/annotations", requireAuth, route(async (request: AuthRequest, response) => {
  const artifact = await findArtifactForUser(request.params.id, request.user!.organizationId);
  if (!artifact) return notFound(response, "Artifact not found");
  const annotations = await prisma.annotation.findMany({ where: { artifactId: artifact.id }, select: annotationSelect, orderBy: { createdAt: "asc" } });
  return response.json({ data: annotations });
}));

/** POST /api/v1/artifacts/:id/annotations — adds a region. The image is not touched. */
executionRouter.post("/artifacts/:id/annotations", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canWrite(user.role)) return forbidden(response, "Annotating evidence is not permitted for your role");

  const artifact = await findArtifactForUser(request.params.id, user.organizationId);
  if (!artifact) return notFound(response, "Artifact not found");
  if (!annotatableTypes.includes(artifact.type as (typeof annotatableTypes)[number])) {
    return conflict(response, "ARTIFACT_NOT_ANNOTATABLE", `A ${artifact.type.toLowerCase().replace(/_/g, " ")} cannot carry a drawn region. Annotate a screenshot instead.`);
  }

  const input = annotationBody.parse(request.body ?? {});
  if (input.x + input.width > 1.0001 || input.y + input.height > 1.0001) {
    return conflict(response, "ANNOTATION_OUT_OF_BOUNDS", "The region extends past the edge of the image.");
  }
  // A bug referenced here must belong to the same organization, or an annotation would become a
  // way to discover that another tenant's bug id exists.
  if (input.bugId) {
    const bug = await prisma.bug.findFirst({ where: { id: input.bugId, project: { organizationId: user.organizationId } }, select: { id: true } });
    if (!bug) return notFound(response, "Bug not found");
  }

  const created = await prisma.annotation.create({
    data: { artifactId: artifact.id, shape: input.shape, x: input.x, y: input.y, width: input.width, height: input.height, label: input.label, colour: input.colour, bugId: input.bugId ?? null, createdById: user.id },
    select: annotationSelect,
  });
  return response.status(201).json({ data: created });
}));

/** PATCH /api/v1/annotations/:id — move, resize, or relabel. */
executionRouter.patch("/annotations/:id", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canWrite(user.role)) return forbidden(response, "Annotating evidence is not permitted for your role");

  const existing = await prisma.annotation.findFirst({ where: { id: request.params.id, artifact: { execution: { project: { organizationId: user.organizationId } } } }, select: { id: true } });
  if (!existing) return notFound(response, "Annotation not found");

  const input = annotationBody.partial().parse(request.body ?? {});
  const updated = await prisma.annotation.update({ where: { id: existing.id }, data: { ...input, bugId: input.bugId ?? undefined }, select: annotationSelect });
  return response.json({ data: updated });
}));

/**
 * DELETE /api/v1/annotations/:id — removes the region only.
 *
 * The screenshot is untouched by construction: this deletes a row, and the bytes were never
 * modified in the first place.
 */
executionRouter.delete("/annotations/:id", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canWrite(user.role)) return forbidden(response, "Annotating evidence is not permitted for your role");
  const { count } = await prisma.annotation.deleteMany({ where: { id: request.params.id, artifact: { execution: { project: { organizationId: user.organizationId } } } } });
  if (!count) return notFound(response, "Annotation not found");
  return response.status(204).end();
}));
