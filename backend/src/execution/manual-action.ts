import type { ManualActionReason } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../db";
import { recordEvent } from "./events";
import { StepFailure } from "./runner";

/**
 * Suspends an execution on a `pauseForUser` step and waits for a person.
 *
 * The worker holds no socket a browser could call back on, so the exchange goes through the
 * database: the worker writes a `ManualAction` row and re-reads it; the API writes the answer.
 * That also makes the wait survive a worker restart mid-pause - the row, not process memory, is
 * the system of record.
 *
 * Nothing the person types passes through here. They act in their own browser, and this module
 * only ever learns *that* they finished.
 */

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export type ManualActionRequest = {
  executionId: string;
  batchId: string;
  testRunId: string;
  projectId: string;
  organizationId: string;
  stepIndex: number;
  reason: ManualActionReason;
  prompt: string;
  pageUrl: string;
};

/**
 * Blocks until the action is resolved, and returns how long that took.
 *
 * The caller must add the returned duration to its own execution deadline. A person cannot be held
 * to the per-execution time limit, and charging them for it would time the run out the instant
 * they came back.
 */
export async function awaitManualAction(request: ManualActionRequest): Promise<{ pausedMs: number }> {
  const startedAt = Date.now();

  // Counted before the row is created so an organization at its ceiling is refused rather than
  // becoming the reason the ceiling is exceeded. POLICY_VIOLATION because it is a quota decision:
  // it is never retried, and a retry would only hit the same ceiling again.
  const waiting = await prisma.manualAction.count({ where: { status: "PENDING", project: { organizationId: request.organizationId } } });
  if (waiting >= config.MANUAL_ACTION_MAX_CONCURRENT) {
    throw new StepFailure(
      "POLICY_VIOLATION",
      `This test needs a person, but ${waiting} runs in this organization are already waiting for one (limit ${config.MANUAL_ACTION_MAX_CONCURRENT}). Resolve one of those first.`,
    );
  }

  const action = await prisma.manualAction.create({
    data: {
      executionId: request.executionId,
      testRunId: request.testRunId,
      projectId: request.projectId,
      stepIndex: request.stepIndex,
      reason: request.reason,
      prompt: request.prompt,
      pageUrl: request.pageUrl.slice(0, 2000),
      deadlineAt: new Date(startedAt + config.MANUAL_ACTION_TIMEOUT_SECONDS * 1000),
    },
  });

  await prisma.testExecution.update({ where: { id: request.executionId }, data: { status: "WAITING_FOR_USER" } });
  // updateMany with an explicit source status so a run that has already finished or been cancelled
  // elsewhere is never dragged back into WAITING_FOR_USER.
  await prisma.testRun.updateMany({ where: { id: request.testRunId, status: "RUNNING" }, data: { status: "WAITING_FOR_USER" } });
  await recordEvent(
    request.batchId,
    "execution.manual_action_required",
    { executionId: request.executionId, manualActionId: action.id, stepIndex: request.stepIndex, reason: request.reason, prompt: request.prompt },
    request.executionId,
  );

  try {
    for (;;) {
      await sleep(config.MANUAL_ACTION_POLL_INTERVAL_MS);

      // A cancelled batch must free the browser immediately rather than sitting out the deadline.
      const batch = await prisma.executionBatch.findUnique({ where: { id: request.batchId }, select: { cancelRequestedAt: true } });
      if (batch?.cancelRequestedAt) {
        await prisma.manualAction.updateMany({ where: { id: action.id, status: "PENDING" }, data: { status: "ABORTED" } });
        throw new StepFailure("CANCELLED", "Cancelled by request while waiting for a person");
      }

      const current = await prisma.manualAction.findUnique({ where: { id: action.id }, select: { status: true, deadlineAt: true } });
      if (!current) throw new StepFailure("MANUAL_ACTION_ABORTED", "The manual action record disappeared while the run was waiting for it");
      if (current.status === "RESOLVED") return { pausedMs: Date.now() - startedAt };
      if (current.status === "ABORTED") throw new StepFailure("MANUAL_ACTION_ABORTED", `Nobody completed the required action (${request.reason}); it was abandoned`);
      if (current.status === "EXPIRED") throw new StepFailure("MANUAL_ACTION_EXPIRED", `Nobody completed the required action (${request.reason}) before the deadline`);

      // Re-read rather than captured, so extending the deadline through the API takes effect here.
      if (Date.now() > current.deadlineAt.getTime()) {
        await prisma.manualAction.updateMany({ where: { id: action.id, status: "PENDING" }, data: { status: "EXPIRED" } });
        throw new StepFailure(
          "MANUAL_ACTION_EXPIRED",
          `Nobody completed the required action (${request.reason}) within ${config.MANUAL_ACTION_TIMEOUT_SECONDS}s. This is not a defect in the application under test.`,
        );
      }
    }
  } finally {
    // Whatever happened, this execution is no longer waiting, and the run only stays in
    // WAITING_FOR_USER while some *other* execution in it still is.
    await prisma.testExecution.updateMany({ where: { id: request.executionId, status: "WAITING_FOR_USER" }, data: { status: "RUNNING" } });
    const stillWaiting = await prisma.manualAction.count({ where: { testRunId: request.testRunId, status: "PENDING", NOT: { id: action.id } } });
    if (stillWaiting === 0) {
      await prisma.testRun.updateMany({ where: { id: request.testRunId, status: "WAITING_FOR_USER" }, data: { status: "RUNNING" } });
    }
    await recordEvent(request.batchId, "execution.manual_action_finished", { executionId: request.executionId, manualActionId: action.id }, request.executionId);
  }
}

/**
 * Marks pauses whose deadline has passed.
 *
 * The worker expires its own pause the moment it notices, so this exists for the rows a worker
 * cannot reach any more - one that was killed mid-pause leaves a PENDING row that would otherwise
 * sit in the queue forever and keep consuming the organization's concurrency budget.
 */
export async function expireOverdueManualActions(now = new Date()): Promise<number> {
  const { count } = await prisma.manualAction.updateMany({ where: { status: "PENDING", deadlineAt: { lt: now } }, data: { status: "EXPIRED" } });
  return count;
}
