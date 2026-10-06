import { Worker } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config";
import { prisma } from "../db";
import { auditQueueName, type AuditJobData } from "./queue";
import { runAudit } from "./run";

const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

const worker = new Worker<AuditJobData>(
  auditQueueName,
  async job => {
    // Tenancy is re-checked here so a tampered or replayed job payload cannot audit another
    // organization's application.
    const auditRun = await prisma.auditRun.findFirst({
      where: { id: job.data.auditRunId, testRunId: job.data.testRunId, projectId: job.data.projectId, project: { organizationId: job.data.organizationId } },
      select: { id: true, status: true },
    });
    if (!auditRun) throw new Error("AUDIT_RUN_NOT_AUTHORIZED");
    if (auditRun.status === "CANCELLED") return;

    await runAudit(auditRun.id, job.data.organizationId);
  },
  { connection, concurrency: config.AUDIT_CONCURRENCY },
);

worker.on("failed", async (job, error) => {
  if (!job) return;
  console.error(JSON.stringify({ event: "audit.job.failed", auditRunId: job.data.auditRunId, attempts: job.attemptsMade, message: error.message }));
  // Only the final attempt writes a terminal state, so a retryable failure is not recorded as a
  // result the user would read as "the audit found nothing".
  if (job.attemptsMade < (job.opts.attempts ?? 1)) return;
  await prisma.auditRun
    .updateMany({ where: { id: job.data.auditRunId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "FAILED", error: error.message.slice(0, 500), completedAt: new Date() } })
    .catch(() => undefined);
});

console.log(JSON.stringify({ event: "worker.started", queue: auditQueueName, concurrency: config.AUDIT_CONCURRENCY }));
