import { config } from "../config";
import { prisma } from "../db";
import { enqueueExecution } from "../execution/queue";
import { computeDivergences, cellKey, type CellOutcome, type TestCaseOutcomes } from "./divergence";

/**
 * Matrix replay: the same approved automation, run across a grid of browsers and viewports.
 *
 * This engine authors nothing and generates nothing. Each cell is an ordinary `ExecutionBatch`, so
 * artifacts, step results, failure analysis and healing all apply to a matrix run without a line of
 * new code - and a difference between two cells is evidence about the application rather than about
 * two different tests.
 */

export const viewportPresets: Record<string, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 1024, height: 768 },
  mobile: { width: 390, height: 844 },
};

export type MatrixRequest = {
  testRunId: string;
  organizationId: string;
  userId: string;
  browsers: string[];
  viewports: string[];
  testCaseIds?: string[];
};

export class MatrixError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Creates the grid and queues every cell.
 *
 * All cells are created in one transaction: a partially-built matrix would compare a complete cell
 * against one that was never going to run, and report the difference as a browser bug.
 */
export async function createMatrixRun(request: MatrixRequest) {
  const testRun = await prisma.testRun.findFirst({
    where: { id: request.testRunId, project: { organizationId: request.organizationId } },
    select: { id: true, projectId: true, applicationUrl: true },
  });
  if (!testRun) throw new MatrixError("NOT_FOUND", "Test run not found");

  const active = await prisma.matrixRun.findFirst({ where: { testRunId: testRun.id, status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } });
  if (active) throw new MatrixError("MATRIX_IN_PROGRESS", "A matrix replay is already running for this test run");

  const cellCount = request.browsers.length * request.viewports.length;
  if (cellCount > config.MATRIX_MAX_CELLS) {
    throw new MatrixError("MATRIX_TOO_LARGE", `${request.browsers.length} browsers x ${request.viewports.length} viewports is ${cellCount} full runs of the suite; the maximum is ${config.MATRIX_MAX_CELLS}.`);
  }

  // Only APPROVED automation is executable anywhere in this product, and a matrix is no exception.
  const scripts = await prisma.automationScript.findMany({
    where: {
      testCase: { testRunId: testRun.id, status: "APPROVED", ...(request.testCaseIds?.length ? { id: { in: request.testCaseIds } } : {}) },
      approvedVersionId: { not: null },
    },
    select: { testCaseId: true, approvedVersionId: true, testCase: { select: { scenarioId: true } } },
  });
  if (!scripts.length) throw new MatrixError("NO_APPROVED_AUTOMATION", "Approve at least one automation version before replaying it across browsers");

  const baselineKey = cellKey(request.browsers[0], request.viewports[0]);

  const matrixRun = await prisma.$transaction(async tx => {
    const created = await tx.matrixRun.create({
      data: {
        testRunId: testRun.id,
        projectId: testRun.projectId,
        baselineKey,
        cellsRequested: cellCount,
        testCaseCount: scripts.length,
      },
    });

    for (const browser of request.browsers) {
      for (const viewportName of request.viewports) {
        const viewport = viewportPresets[viewportName] ?? viewportPresets.desktop;
        const batch = await tx.executionBatch.create({
          data: {
            testRunId: testRun.id,
            browser,
            viewport,
            requestedCount: scripts.length,
            createdById: request.userId,
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
        await tx.matrixCell.create({ data: { matrixRunId: created.id, batchId: batch.id, browser, viewportName, viewport } });
      }
    }
    return created;
  });

  // Enqueued after the transaction commits. Queuing inside it risks a worker picking up an
  // execution whose row is not visible yet.
  const executions = await prisma.testExecution.findMany({
    where: { batch: { matrixCell: { matrixRunId: matrixRun.id } } },
    select: { id: true, batchId: true, projectId: true },
  });
  for (const execution of executions) {
    await enqueueExecution({ executionId: execution.id, batchId: execution.batchId, organizationId: request.organizationId, projectId: execution.projectId });
  }

  await prisma.matrixRun.update({ where: { id: matrixRun.id }, data: { status: "RUNNING", startedAt: new Date() } });
  return { ...matrixRun, status: "RUNNING" as const };
}

/** Gathers one row per test case, with its outcome in every cell. */
async function readOutcomes(matrixRunId: string) {
  const cells = await prisma.matrixCell.findMany({
    where: { matrixRunId },
    orderBy: [{ browser: "asc" }, { viewportName: "asc" }],
    include: { batch: { select: { id: true, status: true, passedCount: true, failedCount: true, erroredCount: true, skippedCount: true, requestedCount: true, durationMs: true } } },
  });
  const byBatch = new Map(cells.map(cell => [cell.batchId, cell]));

  const executions = await prisma.testExecution.findMany({
    where: { batchId: { in: cells.map(cell => cell.batchId) } },
    select: { batchId: true, status: true, failureCategory: true, failureMessage: true, testCase: { select: { id: true, testCaseId: true, title: true } } },
  });

  const cases = new Map<string, TestCaseOutcomes>();
  for (const execution of executions) {
    const cell = byBatch.get(execution.batchId);
    if (!cell) continue;
    const entry = cases.get(execution.testCase.id) ?? { testCaseId: execution.testCase.id, reference: execution.testCase.testCaseId, title: execution.testCase.title, outcomes: [] as CellOutcome[] };
    entry.outcomes.push({
      browser: cell.browser,
      viewportName: cell.viewportName,
      status: execution.status,
      failureCategory: execution.failureCategory,
      // Bounded: a failure message is untrusted text that came off the page.
      failureMessage: execution.failureMessage ? execution.failureMessage.slice(0, 300) : null,
    });
    cases.set(execution.testCase.id, entry);
  }
  return { cells, cases: [...cases.values()] };
}

/**
 * Recomputes a matrix from its cells. Called whenever one of its batches settles.
 *
 * Divergences are derived from the executions rather than stored, because a terminal execution is
 * immutable - recomputing always gives the same answer, and a stored copy could only ever disagree
 * with its own source.
 */
export async function refreshMatrixForBatch(batchId: string) {
  const cell = await prisma.matrixCell.findUnique({ where: { batchId }, select: { matrixRunId: true } });
  if (!cell) return;

  const { cells, cases } = await readOutcomes(cell.matrixRunId);
  const settledStatuses = ["COMPLETED", "FAILED", "CANCELLED"];
  const cellsCompleted = cells.filter(entry => settledStatuses.includes(entry.batch.status)).length;
  const matrixRun = await prisma.matrixRun.findUnique({ where: { id: cell.matrixRunId }, select: { baselineKey: true, status: true, startedAt: true } });
  if (!matrixRun) return;

  const divergences = computeDivergences(cases, matrixRun.baselineKey);
  const settled = cellsCompleted === cells.length && cells.length > 0;

  await prisma.matrixRun.updateMany({
    where: { id: cell.matrixRunId, status: { notIn: ["CANCELLED"] } },
    data: {
      cellsCompleted,
      divergenceCount: divergences.length,
      ...(settled
        ? {
            status: cells.every(entry => entry.batch.status === "FAILED") ? "FAILED" : "COMPLETED",
            completedAt: new Date(),
          }
        : {}),
    },
  });
}

/** The matrix as the UI needs it: the grid, the per-cell totals, and the rows that disagree. */
export async function readMatrixRun(matrixRunId: string, organizationId: string) {
  const matrixRun = await prisma.matrixRun.findFirst({ where: { id: matrixRunId, project: { organizationId } } });
  if (!matrixRun) return null;
  const { cells, cases } = await readOutcomes(matrixRun.id);
  return {
    ...matrixRun,
    cells: cells.map(cell => ({ id: cell.id, browser: cell.browser, viewportName: cell.viewportName, batchId: cell.batchId, batch: cell.batch })),
    divergences: computeDivergences(cases, matrixRun.baselineKey),
    consistentCount: cases.length - computeDivergences(cases, matrixRun.baselineKey).length,
    testCasesCompared: cases.length,
  };
}
