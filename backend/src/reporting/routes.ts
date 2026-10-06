import { Router } from "express";
import { prisma } from "../db";
import { doneStatuses } from "../bugs/workflow";
import { notFound, route, registerUuidParams } from "../http";
import { requireAuth, type AuthRequest } from "../middleware/auth";

export const reportingRouter = Router();
// A malformed id must not reach Prisma's UUID cast and surface as a 500.
registerUuidParams(reportingRouter);

const terminal = ["PASSED", "FAILED", "TIMED_OUT", "CANCELLED", "ERRORED"] as const;

/** Escapes one CSV field. Values starting with a formula character are prefixed so a spreadsheet
 *  treats them as text rather than executing them. */
function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export const toCsv = (rows: Record<string, unknown>[], columns: string[]) => [columns.join(","), ...rows.map(row => columns.map(column => csvCell(row[column])).join(","))].join("\r\n");

/**
 * Aggregates real execution records for one project. Every number here is a database count; there
 * are no defaults or sample values, and an empty project reports zeros with a null pass rate
 * rather than a fabricated percentage.
 */
async function buildProjectReport(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } });
  if (!project) return null;

  const [testRuns, testCases, approvedTestCases, automationApproved, executions, bugsOpen, recentBatches] = await Promise.all([
    prisma.testRun.count({ where: { projectId } }),
    prisma.testCase.count({ where: { testRun: { projectId } } }),
    prisma.testCase.count({ where: { testRun: { projectId }, status: "APPROVED" } }),
    prisma.automationScript.count({ where: { projectId, approvedVersionId: { not: null } } }),
    prisma.testExecution.findMany({ where: { projectId, status: { in: [...terminal] } }, select: { status: true, durationMs: true, testCaseId: true, completedAt: true, testCase: { select: { title: true, testCaseId: true } } } }),
    prisma.bug.count({ where: { projectId, status: { notIn: [...doneStatuses] } } }),
    prisma.executionBatch.findMany({ where: { testRun: { projectId } }, orderBy: { createdAt: "desc" }, take: 10 }),
  ]);

  const count = (status: string) => executions.filter(execution => execution.status === status).length;
  const passed = count("PASSED");
  const failed = count("FAILED") + count("TIMED_OUT");
  const errored = count("ERRORED");
  const cancelled = count("CANCELLED");
  // Errored and cancelled runs are excluded from the denominator: they are not test verdicts.
  const decided = passed + failed;
  const durations = executions.map(execution => execution.durationMs).filter((value): value is number => typeof value === "number");

  const failuresByCase = new Map<string, { testCaseId: string; title: string; failures: number; lastFailureAt: string }>();
  for (const execution of executions) {
    if (execution.status !== "FAILED" && execution.status !== "TIMED_OUT") continue;
    const key = execution.testCaseId;
    const existing = failuresByCase.get(key);
    const at = execution.completedAt?.toISOString() ?? "";
    if (existing) {
      existing.failures += 1;
      if (at > existing.lastFailureAt) existing.lastFailureAt = at;
    } else {
      failuresByCase.set(key, { testCaseId: execution.testCase.testCaseId, title: execution.testCase.title, failures: 1, lastFailureAt: at });
    }
  }

  return {
    project,
    generatedAt: new Date().toISOString(),
    totals: { testRuns, testCases, approvedTestCases, automationApproved, executions: executions.length, passed, failed, errored, cancelled, bugsOpen },
    passRate: decided === 0 ? null : passed / decided,
    averageDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    recentBatches,
    topFailures: [...failuresByCase.values()].sort((left, right) => right.failures - left.failures).slice(0, 10),
  };
}

/** GET /api/v1/projects/:id/report — real aggregate statistics for a project. */
reportingRouter.get("/projects/:id/report", requireAuth, route(async (request: AuthRequest, response) => {
  const project = await prisma.project.findFirst({ where: { id: request.params.id, organizationId: request.user!.organizationId }, select: { id: true } });
  if (!project) return notFound(response, "Project not found");
  return response.json({ data: await buildProjectReport(project.id) });
}));

/** GET /api/v1/dashboard — organization-wide counters for the dashboard, all from real rows. */
reportingRouter.get("/dashboard", requireAuth, route(async (request: AuthRequest, response) => {
  const organizationId = request.user!.organizationId;
  const scope = { project: { organizationId } };

  const [projects, testRuns, testCases, executions, bugsOpen, recentRuns, recentBatches] = await Promise.all([
    prisma.project.count({ where: { organizationId } }),
    prisma.testRun.count({ where: scope }),
    prisma.testCase.count({ where: { testRun: scope } }),
    prisma.testExecution.groupBy({ by: ["status"], where: { project: { organizationId } }, _count: { _all: true } }),
    prisma.bug.count({ where: { project: { organizationId }, status: { notIn: [...doneStatuses] } } }),
    prisma.testRun.findMany({ where: scope, include: { project: { select: { id: true, name: true } }, discovery: { select: { status: true, pagesDiscovered: true } } }, orderBy: { createdAt: "desc" }, take: 8 }),
    prisma.executionBatch.findMany({ where: { testRun: scope }, include: { testRun: { select: { id: true, project: { select: { name: true } } } } }, orderBy: { createdAt: "desc" }, take: 8 }),
  ]);

  /**
   * Everything below is derived from real execution rows. Where there is not enough history to
   * compute a comparison the value is null, and the interface says so rather than showing a
   * fabricated percentage.
   */
  const now = Date.now();
  const WINDOW_DAYS = 14;
  const windowStart = new Date(now - WINDOW_DAYS * 86_400_000);
  const priorStart = new Date(now - 2 * 7 * 86_400_000);
  const currentStart = new Date(now - 7 * 86_400_000);

  const settled = await prisma.testExecution.findMany({
    where: { project: { organizationId }, completedAt: { not: null, gte: priorStart } },
    select: { status: true, completedAt: true, batch: { select: { testRun: { select: { testingTypes: true } } } } },
    orderBy: { completedAt: "asc" },
    take: 5000,
  });

  const inWindow = (from: Date, to?: Date) =>
    settled.filter(row => row.completedAt! >= from && (to ? row.completedAt! < to : true));

  const tally = (rows: typeof settled) => ({
    total: rows.length,
    passed: rows.filter(row => row.status === "PASSED").length,
    failed: rows.filter(row => row.status === "FAILED" || row.status === "TIMED_OUT").length,
    errored: rows.filter(row => row.status === "ERRORED").length,
  });

  const currentWeek = tally(inWindow(currentStart));
  const priorWeek = tally(inWindow(priorStart, currentStart));

  /** A percentage change is only meaningful against a non-empty prior window. */
  const change = (current: number, prior: number) => (prior === 0 ? null : (current - prior) / prior);
  const trend = {
    comparedTo: "previous 7 days",
    hasBaseline: priorWeek.total > 0,
    total: change(currentWeek.total, priorWeek.total),
    passed: change(currentWeek.passed, priorWeek.passed),
    failed: change(currentWeek.failed, priorWeek.failed),
    errored: change(currentWeek.errored, priorWeek.errored),
  };

  // One bucket per day for the last two weeks, so the chart has a stable x-axis even on quiet days.
  const buckets = new Map<string, { date: string; passed: number; failed: number; errored: number }>();
  for (let index = WINDOW_DAYS - 1; index >= 0; index -= 1) {
    const date = new Date(now - index * 86_400_000).toISOString().slice(0, 10);
    buckets.set(date, { date, passed: 0, failed: 0, errored: 0 });
  }
  for (const row of settled) {
    if (row.completedAt! < windowStart) continue;
    const bucket = buckets.get(row.completedAt!.toISOString().slice(0, 10));
    if (!bucket) continue;
    if (row.status === "PASSED") bucket.passed += 1;
    else if (row.status === "FAILED" || row.status === "TIMED_OUT") bucket.failed += 1;
    else if (row.status === "ERRORED") bucket.errored += 1;
  }
  const series = [...buckets.values()];

  /**
   * Executions attributed to the testing types their run was configured with. A run tagged with
   * several types contributes to each, so these counts overlap by design and are not a partition
   * of the total - the interface labels them accordingly.
   */
  const typeTally = new Map<string, { type: string; passed: number; failed: number; total: number }>();
  for (const row of settled) {
    // testingTypes is a Json column, so it is narrowed rather than trusted to be an array.
    const types = row.batch?.testRun?.testingTypes;
    if (!Array.isArray(types)) continue;
    for (const raw of types) {
      if (typeof raw !== "string") continue;
      const type = raw.slice(0, 80);
      const entry = typeTally.get(type) ?? { type, passed: 0, failed: 0, total: 0 };
      entry.total += 1;
      if (row.status === "PASSED") entry.passed += 1;
      else if (row.status === "FAILED" || row.status === "TIMED_OUT") entry.failed += 1;
      typeTally.set(type, entry);
    }
  }
  const testingTypes = [...typeTally.values()].sort((left, right) => right.total - left.total).slice(0, 8);

  const byStatus = Object.fromEntries(executions.map(row => [row.status, row._count._all]));
  const passed = byStatus.PASSED ?? 0;
  const failed = (byStatus.FAILED ?? 0) + (byStatus.TIMED_OUT ?? 0);
  const decided = passed + failed;

  return response.json({
    data: {
      projects,
      testRuns,
      testCases,
      executions: Object.values(byStatus).reduce((sum, value) => sum + value, 0),
      passed,
      failed,
      errored: byStatus.ERRORED ?? 0,
      cancelled: byStatus.CANCELLED ?? 0,
      running: (byStatus.RUNNING ?? 0) + (byStatus.QUEUED ?? 0) + (byStatus.PROVISIONING ?? 0) + (byStatus.COLLECTING_ARTIFACTS ?? 0),
      bugsOpen,
      // null, not 0, when nothing has been decided yet. A 0% pass rate would be a lie.
      passRate: decided === 0 ? null : passed / decided,
      recentRuns,
      recentBatches,
      trend,
      series,
      testingTypes,
    },
  });
}));

/** GET /api/v1/test-runs — organization-wide test run list with pipeline counters. */
reportingRouter.get("/test-runs/summary/list", requireAuth, route(async (request: AuthRequest, response) => {
  const runs = await prisma.testRun.findMany({
    where: { project: { organizationId: request.user!.organizationId } },
    include: {
      project: { select: { id: true, name: true } },
      discovery: { select: { status: true, pagesDiscovered: true } },
      _count: { select: { testCases: true, executionBatches: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return response.json({ data: runs });
}));

/**
 * GET /api/v1/execution-batches/:id/report — a batch report as JSON or CSV.
 * `?format=csv` returns a downloadable file built from the same rows as the JSON view.
 */
reportingRouter.get("/execution-batches/:id/report", requireAuth, route(async (request: AuthRequest, response) => {
  const batch = await prisma.executionBatch.findFirst({
    where: { id: request.params.id, testRun: { project: { organizationId: request.user!.organizationId } } },
    include: {
      testRun: { select: { id: true, applicationUrl: true, project: { select: { id: true, name: true } } } },
      executions: {
        orderBy: { createdAt: "asc" },
        include: { testCase: { select: { testCaseId: true, title: true, module: true, priority: true, severity: true } }, steps: { orderBy: { stepIndex: "asc" }, select: { stepIndex: true, action: true, description: true, status: true, durationMs: true, failureMessage: true } }, artifacts: { select: { id: true, type: true, fileName: true, byteSize: true } } },
      },
    },
  });
  if (!batch) return notFound(response, "Execution batch not found");

  const rows = batch.executions.map(execution => ({
    testCaseId: execution.testCase.testCaseId,
    title: execution.testCase.title,
    module: execution.testCase.module,
    priority: execution.testCase.priority,
    severity: execution.testCase.severity,
    status: execution.status,
    browser: execution.browser,
    durationMs: execution.durationMs ?? "",
    totalSteps: execution.totalSteps,
    passedSteps: execution.passedSteps,
    failedStep: execution.failedStepIndex === null ? "" : execution.failedStepIndex + 1,
    failureCategory: execution.failureCategory ?? "",
    failureMessage: execution.failureMessage ?? "",
    consoleErrors: execution.consoleErrorCount,
    artifacts: execution.artifacts.length,
    startedAt: execution.startedAt?.toISOString() ?? "",
    completedAt: execution.completedAt?.toISOString() ?? "",
  }));

  if (request.query.format === "csv") {
    const columns = Object.keys(rows[0] ?? { testCaseId: "", title: "", status: "" });
    response.setHeader("content-type", "text/csv; charset=utf-8");
    response.setHeader("content-disposition", `attachment; filename="execution-batch-${batch.id.slice(0, 8)}.csv"`);
    return response.send(toCsv(rows, columns));
  }

  const report = {
    batch: { id: batch.id, status: batch.status, browser: batch.browser, viewport: batch.viewport, requestedCount: batch.requestedCount, passedCount: batch.passedCount, failedCount: batch.failedCount, erroredCount: batch.erroredCount, skippedCount: batch.skippedCount, durationMs: batch.durationMs, startedAt: batch.startedAt, completedAt: batch.completedAt },
    project: batch.testRun.project,
    applicationUrl: batch.testRun.applicationUrl,
    generatedAt: new Date().toISOString(),
    passRate: batch.passedCount + batch.failedCount === 0 ? null : batch.passedCount / (batch.passedCount + batch.failedCount),
    executions: batch.executions.map(execution => ({ id: execution.id, testCase: execution.testCase, status: execution.status, durationMs: execution.durationMs, failureCategory: execution.failureCategory, failureMessage: execution.failureMessage, steps: execution.steps, artifacts: execution.artifacts })),
  };

  if (request.query.format === "json-file") {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("content-disposition", `attachment; filename="execution-batch-${batch.id.slice(0, 8)}.json"`);
    return response.send(JSON.stringify(report, null, 2));
  }
  return response.json({ data: report });
}));

/** GET /api/v1/projects/:id/bugs/export — bug list as CSV. */
reportingRouter.get("/projects/:id/bugs/export", requireAuth, route(async (request: AuthRequest, response) => {
  const project = await prisma.project.findFirst({ where: { id: request.params.id, organizationId: request.user!.organizationId }, select: { id: true, name: true } });
  if (!project) return notFound(response, "Project not found");
  const bugs = await prisma.bug.findMany({ where: { projectId: project.id }, include: { testCase: { select: { testCaseId: true } } }, orderBy: { createdAt: "asc" } });
  const rows = bugs.map(bug => ({
    reference: bug.reference,
    title: bug.title,
    severity: bug.severity,
    status: bug.status,
    testCase: bug.testCase?.testCaseId ?? "",
    occurrences: bug.occurrenceCount,
    expectedBehavior: bug.expectedBehavior,
    actualBehavior: bug.actualBehavior,
    createdAt: bug.createdAt.toISOString(),
    lastSeenAt: bug.lastSeenAt.toISOString(),
  }));
  response.setHeader("content-type", "text/csv; charset=utf-8");
  response.setHeader("content-disposition", `attachment; filename="bugs-${project.id.slice(0, 8)}.csv"`);
  return response.send(toCsv(rows, ["reference", "title", "severity", "status", "testCase", "occurrences", "expectedBehavior", "actualBehavior", "createdAt", "lastSeenAt"]));
}));

/** GET /api/v1/test-runs/:id/test-cases/export — approved and draft test cases as CSV. */
reportingRouter.get("/test-runs/:id/test-cases/export", requireAuth, route(async (request: AuthRequest, response) => {
  const testRun = await prisma.testRun.findFirst({ where: { id: request.params.id, project: { organizationId: request.user!.organizationId } }, select: { id: true } });
  if (!testRun) return notFound(response, "Test run not found");
  const cases = await prisma.testCase.findMany({ where: { testRunId: testRun.id }, orderBy: { createdAt: "asc" } });
  const rows = cases.map(testCase => ({
    testCaseId: testCase.testCaseId,
    title: testCase.title,
    module: testCase.module,
    category: testCase.category,
    priority: testCase.priority,
    severity: testCase.severity,
    status: testCase.status,
    preconditions: testCase.preconditions,
    steps: (testCase.steps as { step: number; action: string; expectedResult: string }[]).map(step => `${step.step}. ${step.action} -> ${step.expectedResult}`).join(" | "),
    expectedResult: testCase.expectedResult,
  }));
  response.setHeader("content-type", "text/csv; charset=utf-8");
  response.setHeader("content-disposition", `attachment; filename="test-cases-${testRun.id.slice(0, 8)}.csv"`);
  return response.send(toCsv(rows, ["testCaseId", "title", "module", "category", "priority", "severity", "status", "preconditions", "steps", "expectedResult"]));
}));

/* ---------------------------------------------------------------------------------------------- *
 * Organization-wide catalogue views.
 *
 * Every resource below already existed, reachable only through its parent test run. The product
 * navigation needs to reach them across the whole organization, so these are read-only listings
 * over the same rows with the same tenancy scope - no new state, no new writes.
 * ---------------------------------------------------------------------------------------------- */

const LIST_LIMIT = 200;

/** GET /api/v1/test-cases — every generated case in the organization. */
reportingRouter.get("/test-cases", requireAuth, route(async (request: AuthRequest, response) => {
  const status = typeof request.query.status === "string" && request.query.status !== "ALL" ? request.query.status : undefined;
  const testCases = await prisma.testCase.findMany({
    where: {
      testRun: { project: { organizationId: request.user!.organizationId } },
      ...(status ? { status: status as "DRAFT" | "APPROVED" | "REJECTED" } : {}),
    },
    select: {
      id: true, testCaseId: true, title: true, module: true, category: true, priority: true, severity: true,
      status: true, generationSource: true, modifiedByUser: true, createdAt: true,
      testRun: { select: { id: true, applicationUrl: true, project: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: LIST_LIMIT,
  });
  return response.json({ data: testCases });
}));

/** GET /api/v1/ai-generations — AI test-case generation runs, newest first. */
reportingRouter.get("/ai-generations", requireAuth, route(async (request: AuthRequest, response) => {
  const runs = await prisma.aIGenerationRun.findMany({
    where: { testRun: { project: { organizationId: request.user!.organizationId } } },
    select: {
      id: true, status: true, provider: true, model: true, promptVersion: true, scenarioCount: true,
      testCaseCount: true, error: true, startedAt: true, completedAt: true, createdAt: true,
      testRun: { select: { id: true, applicationUrl: true, project: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: LIST_LIMIT,
  });
  return response.json({ data: runs });
}));

/** GET /api/v1/failure-analyses — AI failure analyses across the organization. */
reportingRouter.get("/failure-analyses", requireAuth, route(async (request: AuthRequest, response) => {
  const analyses = await prisma.failureAnalysis.findMany({
    where: { execution: { project: { organizationId: request.user!.organizationId } } },
    select: {
      id: true, status: true, provider: true, model: true, category: true, summary: true, likelyCause: true,
      recommendedAction: true, confidence: true, error: true, createdAt: true, completedAt: true,
      execution: {
        select: {
          id: true, status: true, failureCategory: true, failureMessage: true,
          testCase: { select: { id: true, testCaseId: true, title: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: LIST_LIMIT,
  });
  return response.json({ data: analyses });
}));

/** GET /api/v1/healing-proposals — self-healing locator proposals awaiting review. */
reportingRouter.get("/healing-proposals", requireAuth, route(async (request: AuthRequest, response) => {
  const proposals = await prisma.healingProposal.findMany({
    where: { script: { project: { organizationId: request.user!.organizationId } } },
    select: {
      id: true, status: true, stepIndex: true, failedLocator: true, proposedLocator: true, confidence: true,
      rationale: true, provider: true, model: true, createdAt: true,
      automationVersion: { select: { id: true, version: true } },
      script: { select: { id: true, testCase: { select: { id: true, testCaseId: true, title: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: LIST_LIMIT,
  });
  return response.json({ data: proposals });
}));

/** GET /api/v1/visual-comparisons — visual regression results across the organization. */
reportingRouter.get("/visual-comparisons", requireAuth, route(async (request: AuthRequest, response) => {
  const comparisons = await prisma.visualComparison.findMany({
    where: { execution: { project: { organizationId: request.user!.organizationId } } },
    select: {
      id: true, status: true, threshold: true, diffPixelCount: true, totalPixelCount: true, diffRatio: true,
      dimensionsMatch: true, baselineArtifactId: true, currentArtifactId: true, diffArtifactId: true, createdAt: true,
      baseline: { select: { id: true, name: true, browser: true, viewportWidth: true, viewportHeight: true, environment: true } },
      execution: { select: { id: true, testCase: { select: { id: true, testCaseId: true, title: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: LIST_LIMIT,
  });
  return response.json({ data: comparisons });
}));

// GET /api/v1/bugs (the organization-wide, filterable bug list) lives in src/bugs/routes.ts.
