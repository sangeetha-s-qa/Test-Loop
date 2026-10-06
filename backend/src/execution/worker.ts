import { Worker } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config";
import { prisma } from "../db";
import { recordEvent } from "./events";
import { refreshBatch, runExecution } from "./execute";
import { expireOverdueManualActions } from "./manual-action";
import { executionQueueName, type ExecutionJobData } from "./queue";

const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

/**
 * Sweeps pauses whose worker died mid-wait.
 *
 * A live worker expires its own pause the moment it notices, so this only ever catches rows nobody
 * is polling any more. Without it those rows stay PENDING forever and keep consuming the
 * organization's MANUAL_ACTION_MAX_CONCURRENT budget - three orphans would block human-in-the-loop
 * for the whole organization with nothing to recover it.
 *
 * The write is a conditional updateMany, so several worker processes running this concurrently is
 * harmless rather than something needing a lock. `unref` keeps it from holding the process open.
 */
const sweepTimer = setInterval(() => {
  void expireOverdueManualActions()
    .then(count => {
      if (count > 0) console.warn(JSON.stringify({ event: "manual_action.swept", count }));
    })
    .catch(error => console.error(JSON.stringify({ event: "manual_action.sweep_failed", message: error instanceof Error ? error.message : String(error) })));
}, config.MANUAL_ACTION_SWEEP_INTERVAL_MS);
sweepTimer.unref();

const worker = new Worker<ExecutionJobData>(
  executionQueueName,
  async job => {
    // Tenancy is re-checked here so a tampered or replayed job payload cannot execute against
    // another organization's project.
    const execution = await prisma.testExecution.findFirst({
      where: { id: job.data.executionId, batchId: job.data.batchId, projectId: job.data.projectId, project: { organizationId: job.data.organizationId } },
      select: { id: true, batchId: true },
    });
    if (!execution) throw new Error("EXECUTION_NOT_AUTHORIZED");

    await prisma.executionBatch.updateMany({ where: { id: execution.batchId, startedAt: null }, data: { status: "RUNNING", startedAt: new Date() } });
    try {
      await runExecution(execution.id, job.data.organizationId);
    } finally {
      // The batch must reflect reality even if this execution threw.
      await refreshBatch(execution.batchId).catch(() => undefined);
    }
  },
  { connection, concurrency: config.EXECUTION_CONCURRENCY },
);

worker.on("failed", async (job, error) => {
  if (!job) return;
  console.error(JSON.stringify({ event: "execution.job.failed", executionId: job.data.executionId, attempts: job.attemptsMade, message: error.message }));
  // Only the final attempt writes a terminal state, so a retryable infrastructure failure is
  // not recorded as a result the user would mistake for a real test outcome.
  if (job.attemptsMade < (job.opts.attempts ?? 1)) return;
  await prisma.testExecution
    .updateMany({ where: { id: job.data.executionId, status: { in: ["QUEUED", "PROVISIONING", "RUNNING", "COLLECTING_ARTIFACTS"] } }, data: { status: "ERRORED", failureCategory: "INFRASTRUCTURE", failureMessage: error.message.slice(0, 500), completedAt: new Date() } })
    .catch(() => undefined);
  await recordEvent(job.data.batchId, "execution.errored", { executionId: job.data.executionId, message: "The execution worker failed" }, job.data.executionId).catch(() => undefined);
  await refreshBatch(job.data.batchId).catch(() => undefined);
});

const shutdown = async () => {
  // Closing the worker lets an in-flight execution finish its cleanup before the process exits.
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`Execution worker listening (concurrency ${config.EXECUTION_CONCURRENCY})`);
