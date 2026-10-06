import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { checkProviderReady, createAIProvider } from "../ai/provider";
import { automationProgramSchema, locatorSchema } from "../automation/program";
import { createAutomationVersion } from "../automation/service";
import { validateProgram } from "../automation/validate";
import { prisma } from "../db";
import { canApprove, canWrite, conflict, fail, forbidden, notFound, route, registerUuidParams } from "../http";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { BugError, createBugFromExecution } from "./bugs";
import { analysisPromptVersion } from "./prompt";
import { enqueueAnalysis } from "./queue";

export const analysisRouter = Router();
// A malformed id must not reach Prisma's UUID cast and surface as a 500.
registerUuidParams(analysisRouter);

const orgExecution = (executionId: string, organizationId: string) => ({ id: executionId, project: { organizationId } });

/**
 * POST /api/v1/executions/:id/analysis — queue an AI reading of a failed execution.
 * Each request creates a NEW version; an earlier diagnosis is never overwritten.
 */
analysisRouter.post("/executions/:id/analysis", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canWrite(user.role)) return forbidden(response, "Requesting analysis is not permitted for your role");

  const execution = await prisma.testExecution.findFirst({ where: orgExecution(request.params.id, user.organizationId), select: { id: true, status: true } });
  if (!execution) return notFound(response, "Execution not found");
  if (!["FAILED", "TIMED_OUT", "ERRORED"].includes(execution.status)) return conflict(response, "EXECUTION_DID_NOT_FAIL", "Only a failed execution can be analysed");

  const ready = await checkProviderReady();
  if (!ready.ready) return fail(response, 503, ready.code, ready.detail);

  const active = await prisma.failureAnalysis.findFirst({ where: { executionId: execution.id, status: { in: ["QUEUED", "ANALYZING"] } } });
  if (active) return conflict(response, "ANALYSIS_IN_PROGRESS", "An analysis is already running for this execution");

  const provider = createAIProvider();
  const previous = await prisma.failureAnalysis.findFirst({ where: { executionId: execution.id }, orderBy: { version: "desc" }, select: { version: true } });
  const analysis = await prisma.failureAnalysis.create({
    data: { executionId: execution.id, version: (previous?.version ?? 0) + 1, provider: provider.name, model: provider.model, promptVersion: analysisPromptVersion, evidenceRefs: {} },
  });
  await enqueueAnalysis({ analysisId: analysis.id, executionId: execution.id, organizationId: user.organizationId, includeHealing: (request.body as { includeHealing?: boolean } | undefined)?.includeHealing !== false });
  return response.status(202).json({ data: analysis });
}));

/** GET /api/v1/executions/:id/analysis — every analysis version, newest first. */
analysisRouter.get("/executions/:id/analysis", requireAuth, route(async (request: AuthRequest, response) => {
  const execution = await prisma.testExecution.findFirst({ where: orgExecution(request.params.id, request.user!.organizationId), select: { id: true } });
  if (!execution) return notFound(response, "Execution not found");
  const analyses = await prisma.failureAnalysis.findMany({ where: { executionId: execution.id }, orderBy: { version: "desc" } });
  return response.json({ data: analyses });
}));

/** POST /api/v1/analysis/:id/cancel — durable cancellation the worker observes. */
analysisRouter.post("/analysis/:id/cancel", requireAuth, route(async (request: AuthRequest, response) => {
  if (!canWrite(request.user!.role)) return forbidden(response, "Cancellation is not permitted for your role");
  const result = await prisma.failureAnalysis.updateMany({
    where: { id: request.params.id, status: { in: ["QUEUED", "ANALYZING"] }, execution: { project: { organizationId: request.user!.organizationId } } },
    data: { cancelRequestedAt: new Date() },
  });
  if (!result.count) return notFound(response, "No active analysis found");
  return response.status(202).json({ data: { status: "CANCEL_REQUESTED" } });
}));

/* ------------------------------------------------------------------------------------------- */
/* Self-healing proposals                                                                       */
/* ------------------------------------------------------------------------------------------- */

/** GET /api/v1/automation-scripts/:id/healing-proposals — proposals awaiting review. */
analysisRouter.get("/automation-scripts/:id/healing-proposals", requireAuth, route(async (request: AuthRequest, response) => {
  const script = await prisma.automationScript.findFirst({ where: { id: request.params.id, project: { organizationId: request.user!.organizationId } }, select: { id: true } });
  if (!script) return notFound(response, "Automation script not found");
  const proposals = await prisma.healingProposal.findMany({ where: { scriptId: script.id }, orderBy: { createdAt: "desc" }, include: { automationVersion: { select: { id: true, version: true } } } });
  return response.json({ data: proposals });
}));

/** GET /api/v1/healing-proposals/:id — one proposal with its evidence and rejected candidates. */
analysisRouter.get("/healing-proposals/:id", requireAuth, route(async (request: AuthRequest, response) => {
  const proposal = await prisma.healingProposal.findFirst({
    where: { id: request.params.id, script: { project: { organizationId: request.user!.organizationId } } },
    include: { automationVersion: { select: { id: true, version: true, program: true, status: true } }, stepExecution: { select: { id: true, stepIndex: true, action: true, description: true, failureMessage: true, pageUrl: true } } },
  });
  if (!proposal) return notFound(response, "Healing proposal not found");
  return response.json({ data: proposal });
}));

/**
 * POST /api/v1/healing-proposals/:id/approve — apply the proposed locator.
 *
 * The result is a NEW DRAFT AutomationVersion. The approved version is left untouched, and the
 * new draft still needs its own approval before it can execute.
 */
analysisRouter.post("/healing-proposals/:id/approve", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canApprove(user.role)) return forbidden(response, "Approving healing proposals is not permitted for your role");

  const proposal = await prisma.healingProposal.findFirst({
    where: { id: request.params.id, script: { project: { organizationId: user.organizationId } } },
    include: { automationVersion: { include: { script: { include: { testCase: { include: { testRun: { select: { applicationUrl: true } } } } } } } } },
  });
  if (!proposal) return notFound(response, "Healing proposal not found");
  if (proposal.status !== "PROPOSED") return conflict(response, "NOT_APPROVABLE", `Only a PROPOSED healing proposal can be approved; this one is ${proposal.status}`);

  const program = automationProgramSchema.safeParse(proposal.automationVersion.program);
  if (!program.success) return conflict(response, "SOURCE_PROGRAM_INVALID", "The automation version this proposal targets is no longer valid");
  const replacement = locatorSchema.safeParse(proposal.proposedLocator);
  if (!replacement.success) return conflict(response, "PROPOSED_LOCATOR_INVALID", "The proposed locator is not valid");

  const target = program.data.steps[proposal.stepIndex];
  if (!target || !("locator" in target)) return conflict(response, "STEP_NO_LONGER_MATCHES", "The targeted step no longer uses a locator");

  // Only the locator on one step changes. Actions, values, and assertions are copied verbatim,
  // so healing can never quietly weaken what the test checks.
  const healed = { ...program.data, steps: program.data.steps.map((step, index) => (index === proposal.stepIndex ? { ...step, locator: replacement.data } : step)) };
  const report = validateProgram(healed);
  if (report.status === "FAILED") return response.status(422).json({ error: { code: "HEALED_PROGRAM_INVALID", message: "The healed program failed policy validation" }, data: { validation: report } });

  const created = await createAutomationVersion({
    scriptId: proposal.scriptId,
    testCaseVersionId: proposal.automationVersion.testCaseVersionId,
    program: healed,
    applicationUrl: proposal.automationVersion.script.testCase.testRun.applicationUrl,
    source: "HEALING",
    healedFromVersionId: proposal.automationVersionId,
    provider: proposal.provider,
    model: proposal.model,
    report,
  });
  await prisma.healingProposal.update({ where: { id: proposal.id }, data: { status: "APPROVED", resultingVersionId: created.id, reviewedById: user.id, reviewedAt: new Date() } });
  return response.status(201).json({ data: { proposal: { id: proposal.id, status: "APPROVED" }, automationVersion: created } });
}));

analysisRouter.post("/healing-proposals/:id/reject", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canApprove(user.role)) return forbidden(response, "Rejecting healing proposals is not permitted for your role");
  const result = await prisma.healingProposal.updateMany({
    where: { id: request.params.id, status: "PROPOSED", script: { project: { organizationId: user.organizationId } } },
    data: { status: "REJECTED", reviewedById: user.id, reviewedAt: new Date() },
  });
  if (!result.count) return notFound(response, "Proposed healing proposal not found");
  return response.json({ data: { id: request.params.id, status: "REJECTED" } });
}));

/* ------------------------------------------------------------------------------------------- */
/* Bugs                                                                                          */
/* ------------------------------------------------------------------------------------------- */

const createBugSchema = z.object({
  title: z.string().trim().min(5).max(300).optional(),
  description: z.string().trim().max(5000).optional(),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).optional(),
  analysisId: z.string().uuid().optional(),
});

/** POST /api/v1/executions/:id/bugs — idempotent bug creation from a failed execution. */
analysisRouter.post("/executions/:id/bugs", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canWrite(user.role)) return forbidden(response, "Creating bugs is not permitted for your role");
  const input = createBugSchema.parse(request.body ?? {});
  try {
    const result = await createBugFromExecution({ executionId: request.params.id, organizationId: user.organizationId, reportedById: user.id, ...input });
    // 200 rather than 201 on a repeat: nothing new was created.
    return response.status(result.created ? 201 : 200).json({ data: result.bug, created: result.created });
  } catch (error) {
    if (error instanceof BugError) return error.code === "NOT_FOUND" ? notFound(response, error.message) : conflict(response, error.code, error.message);
    throw error;
  }
}));

/** GET /api/v1/projects/:id/bugs — filterable bug list for a project. */
analysisRouter.get("/projects/:id/bugs", requireAuth, route(async (request: AuthRequest, response) => {
  const project = await prisma.project.findFirst({ where: { id: request.params.id, organizationId: request.user!.organizationId }, select: { id: true } });
  if (!project) return notFound(response, "Project not found");
  const status = typeof request.query.status === "string" ? request.query.status : undefined;
  const severity = typeof request.query.severity === "string" ? request.query.severity : undefined;
  const search = typeof request.query.search === "string" ? request.query.search.slice(0, 200) : undefined;
  const bugs = await prisma.bug.findMany({
    where: {
      projectId: project.id,
      ...(status && status !== "ALL" ? { status: status as Prisma.EnumBugStatusFilter["equals"] } : {}),
      ...(severity && severity !== "ALL" ? { severity: severity as Prisma.EnumBugSeverityFilter["equals"] } : {}),
      ...(search ? { OR: [{ title: { contains: search, mode: "insensitive" } }, { reference: { contains: search, mode: "insensitive" } }] } : {}),
    },
    include: { testCase: { select: { id: true, testCaseId: true, title: true } } },
    orderBy: { lastSeenAt: "desc" },
    take: 200,
  });
  return response.json({ data: bugs });
}));

// Bug detail, editing, assignment, and the status workflow live in src/bugs/routes.ts.
