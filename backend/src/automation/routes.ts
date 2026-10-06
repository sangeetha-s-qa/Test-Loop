import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { checkProviderReady, createAIProvider } from "../ai/provider";
import { canApprove, canWrite, conflict, fail, forbidden, notFound, route, registerUuidParams } from "../http";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { automationPromptVersion } from "./prompt";
import { enqueueAutomationGeneration } from "./queue";
import { AutomationApprovalError, approveAutomationVersion, createAutomationVersion, ensureAutomationScript, ensureLatestTestCaseVersion, rejectAutomationVersion, snapshotTestCase } from "./service";
import { parseAndValidateProgram } from "./validate";

export const automationRouter = Router();
// A malformed id must not reach Prisma's UUID cast and surface as a 500.
registerUuidParams(automationRouter);

const activeStatuses = ["QUEUED", "GENERATING", "VALIDATING"] as const;

/** Every lookup is scoped through project -> organization, so a guessed id resolves to 404. */
const orgScopedTestRun = (testRunId: string, organizationId: string) => ({ id: testRunId, project: { organizationId } });
const orgScopedVersion = (versionId: string, organizationId: string) => ({ id: versionId, script: { project: { organizationId } } });

const generateSchema = z.object({ testCaseIds: z.array(z.string().uuid()).max(200).optional() });

/** POST /api/v1/test-runs/:id/automation/generate — queue automation for approved test cases. */
automationRouter.post("/test-runs/:id/automation/generate", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canWrite(user.role)) return forbidden(response, "Automation generation is not permitted for your role");

  const input = generateSchema.parse(request.body ?? {});
  const testRun = await prisma.testRun.findFirst({ where: orgScopedTestRun(request.params.id, user.organizationId), include: { discovery: { select: { status: true } } } });
  if (!testRun) return notFound(response, "Test run not found");
  if (testRun.discovery?.status !== "COMPLETED") return conflict(response, "DISCOVERY_NOT_COMPLETED", "Complete website discovery before generating automation");

  const approved = await prisma.testCase.findMany({
    where: { testRunId: testRun.id, status: "APPROVED", ...(input.testCaseIds?.length ? { id: { in: input.testCaseIds } } : {}) },
    select: { id: true },
  });
  if (!approved.length) return conflict(response, "NO_APPROVED_TEST_CASES", "Approve at least one test case before generating automation");

  const ready = await checkProviderReady();
  if (!ready.ready) return fail(response, 503, ready.code, ready.detail);

  const active = await prisma.automationGenerationRun.findFirst({ where: { testRunId: testRun.id, status: { in: [...activeStatuses] } } });
  if (active) return conflict(response, "AUTOMATION_GENERATION_IN_PROGRESS", "Automation generation is already running for this test run");

  const provider = createAIProvider();
  const run = await prisma.automationGenerationRun.create({
    data: { testRunId: testRun.id, status: "QUEUED", provider: provider.name, model: provider.model, promptVersion: automationPromptVersion, requestedCount: approved.length },
  });
  await enqueueAutomationGeneration({ generationRunId: run.id, testRunId: testRun.id, organizationId: user.organizationId, projectId: testRun.projectId, testCaseIds: approved.map(item => item.id) });
  return response.status(202).json({ data: run });
}));

/** GET /api/v1/test-runs/:id/automation/status — latest generation run for the test run. */
automationRouter.get("/test-runs/:id/automation/status", requireAuth, route(async (request: AuthRequest, response) => {
  const testRun = await prisma.testRun.findFirst({ where: orgScopedTestRun(request.params.id, request.user!.organizationId), select: { id: true } });
  if (!testRun) return notFound(response, "Test run not found");
  const run = await prisma.automationGenerationRun.findFirst({ where: { testRunId: testRun.id }, orderBy: { createdAt: "desc" } });
  return response.json({ data: run });
}));

/** POST /api/v1/test-runs/:id/automation/cancel — durable cancellation request. */
automationRouter.post("/test-runs/:id/automation/cancel", requireAuth, route(async (request: AuthRequest, response) => {
  if (!canWrite(request.user!.role)) return forbidden(response, "Cancellation is not permitted for your role");
  const result = await prisma.automationGenerationRun.updateMany({
    where: { testRun: orgScopedTestRun(request.params.id, request.user!.organizationId), status: { in: [...activeStatuses] } },
    data: { cancelRequestedAt: new Date() },
  });
  if (!result.count) return notFound(response, "No active automation generation found");
  return response.status(202).json({ data: { status: "CANCEL_REQUESTED" } });
}));

/** GET /api/v1/test-runs/:id/automation — automation scripts for every test case in the run. */
automationRouter.get("/test-runs/:id/automation", requireAuth, route(async (request: AuthRequest, response) => {
  const testRun = await prisma.testRun.findFirst({ where: orgScopedTestRun(request.params.id, request.user!.organizationId), select: { id: true } });
  if (!testRun) return notFound(response, "Test run not found");
  const scripts = await prisma.automationScript.findMany({
    where: { testCase: { testRunId: testRun.id } },
    include: {
      testCase: { select: { id: true, testCaseId: true, title: true, module: true, priority: true, status: true } },
      approvedVersion: { select: { id: true, version: true, status: true, validationStatus: true, stepCount: true, assertionCount: true } },
      versions: { select: { id: true, version: true, status: true, source: true, validationStatus: true, stepCount: true, assertionCount: true, createdAt: true }, orderBy: { version: "desc" }, take: 10 },
    },
    orderBy: { updatedAt: "desc" },
  });
  return response.json({ data: scripts });
}));

/** GET /api/v1/test-cases/:id/automation — the script and version history for one test case. */
automationRouter.get("/test-cases/:id/automation", requireAuth, route(async (request: AuthRequest, response) => {
  const script = await prisma.automationScript.findFirst({
    where: { testCaseId: request.params.id, project: { organizationId: request.user!.organizationId } },
    include: {
      testCase: { select: { id: true, testCaseId: true, title: true, status: true, testRunId: true } },
      versions: { orderBy: { version: "desc" } },
    },
  });
  if (!script) return notFound(response, "Automation has not been generated for this test case");
  return response.json({ data: script });
}));

/** GET /api/v1/automation-versions/:id — a single immutable version, including its rendered spec. */
automationRouter.get("/automation-versions/:id", requireAuth, route(async (request: AuthRequest, response) => {
  const version = await prisma.automationVersion.findFirst({
    where: orgScopedVersion(request.params.id, request.user!.organizationId),
    include: { script: { select: { id: true, testCaseId: true, approvedVersionId: true } }, testCaseVersion: { select: { id: true, version: true, title: true, steps: true, expectedResult: true } } },
  });
  if (!version) return notFound(response, "Automation version not found");
  return response.json({ data: version });
}));

automationRouter.post("/automation-versions/:id/approve", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canApprove(user.role)) return forbidden(response, "Approving automation is not permitted for your role");
  const exists = await prisma.automationVersion.findFirst({ where: orgScopedVersion(request.params.id, user.organizationId), select: { id: true } });
  if (!exists) return notFound(response, "Automation version not found");
  try {
    return response.json({ data: await approveAutomationVersion(exists.id, user.id) });
  } catch (error) {
    if (error instanceof AutomationApprovalError) return conflict(response, error.code, error.message);
    throw error;
  }
}));

automationRouter.post("/automation-versions/:id/reject", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canApprove(user.role)) return forbidden(response, "Rejecting automation is not permitted for your role");
  const exists = await prisma.automationVersion.findFirst({ where: orgScopedVersion(request.params.id, user.organizationId), select: { id: true } });
  if (!exists) return notFound(response, "Automation version not found");
  try {
    return response.json({ data: await rejectAutomationVersion(exists.id) });
  } catch (error) {
    if (error instanceof AutomationApprovalError) return conflict(response, error.code, error.message);
    throw error;
  }
}));

/**
 * POST /api/v1/automation-versions/:id/revise — reviewable editing.
 * The edit is validated and stored as a NEW draft version; the version being revised is untouched.
 */
automationRouter.post("/automation-versions/:id/revise", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canWrite(user.role)) return forbidden(response, "Editing automation is not permitted for your role");
  const base = await prisma.automationVersion.findFirst({
    where: orgScopedVersion(request.params.id, user.organizationId),
    include: { script: { include: { testCase: { include: { testRun: { select: { applicationUrl: true } } } } } } },
  });
  if (!base) return notFound(response, "Automation version not found");

  const { program, report } = parseAndValidateProgram((request.body as { program?: unknown } | undefined)?.program);
  if (!program || report.status === "FAILED") return response.status(422).json({ error: { code: "AUTOMATION_PROGRAM_INVALID", message: "The edited program failed validation" }, data: { validation: report } });

  const created = await createAutomationVersion({
    scriptId: base.scriptId,
    testCaseVersionId: base.testCaseVersionId,
    program,
    applicationUrl: base.script.testCase.testRun.applicationUrl,
    source: "USER_EDIT",
    report,
  });
  return response.status(201).json({ data: created });
}));

/**
 * POST /api/v1/test-cases/:id/automation/manual — author a program without the AI provider.
 * Keeps the platform fully usable when no model is available.
 */
automationRouter.post("/test-cases/:id/automation/manual", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canWrite(user.role)) return forbidden(response, "Authoring automation is not permitted for your role");
  const testCase = await prisma.testCase.findFirst({ where: { id: request.params.id, testRun: { project: { organizationId: user.organizationId } } }, include: { testRun: { select: { applicationUrl: true, projectId: true } } } });
  if (!testCase) return notFound(response, "Test case not found");
  if (testCase.status !== "APPROVED") return conflict(response, "TEST_CASE_NOT_APPROVED", "Approve the test case before creating automation for it");

  const { program, report } = parseAndValidateProgram((request.body as { program?: unknown } | undefined)?.program);
  // A policy failure is rejected outright rather than stored as a draft that can never be approved.
  if (!program || report.status === "FAILED") return response.status(422).json({ error: { code: "AUTOMATION_PROGRAM_INVALID", message: "The submitted program failed validation" }, data: { validation: report } });

  const testCaseVersion = await ensureLatestTestCaseVersion(testCase, "USER_EDIT", user.id);
  const script = await ensureAutomationScript(testCase.id, testCase.testRun.projectId);
  const created = await createAutomationVersion({ scriptId: script.id, testCaseVersionId: testCaseVersion.id, program, applicationUrl: testCase.testRun.applicationUrl, source: "USER_EDIT", report });
  return response.status(201).json({ data: created });
}));

/** POST /api/v1/automation/validate — dry-run the policy validator without storing anything. */
automationRouter.post("/automation/validate", requireAuth, route(async (request: AuthRequest, response) => {
  const { program, report } = parseAndValidateProgram((request.body as { program?: unknown } | undefined)?.program);
  return response.json({ data: { valid: program !== null && report.status !== "FAILED", validation: report } });
}));

/** GET /api/v1/test-cases/:id/versions — immutable test case history. */
automationRouter.get("/test-cases/:id/versions", requireAuth, route(async (request: AuthRequest, response) => {
  const testCase = await prisma.testCase.findFirst({ where: { id: request.params.id, testRun: { project: { organizationId: request.user!.organizationId } } }, select: { id: true } });
  if (!testCase) return notFound(response, "Test case not found");
  const versions = await prisma.testCaseVersion.findMany({ where: { testCaseId: testCase.id }, orderBy: { version: "desc" } });
  return response.json({ data: versions });
}));

/** POST /api/v1/test-cases/:id/versions — snapshot the current content on demand. */
automationRouter.post("/test-cases/:id/versions", requireAuth, route(async (request: AuthRequest, response) => {
  const user = request.user!;
  if (!canWrite(user.role)) return forbidden(response, "Versioning test cases is not permitted for your role");
  const testCase = await prisma.testCase.findFirst({ where: { id: request.params.id, testRun: { project: { organizationId: user.organizationId } } } });
  if (!testCase) return notFound(response, "Test case not found");
  const created = await prisma.$transaction(tx => snapshotTestCase(tx, testCase, "USER_EDIT", user.id));
  return response.status(201).json({ data: created });
}));
