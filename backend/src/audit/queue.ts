import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config";

export const auditQueueName = "page-audits";

const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

export const auditQueue = new Queue(auditQueueName, {
  connection,
  defaultJobOptions: {
    // One retry only, and only for a worker that died before recording anything. A page that
    // genuinely fails to load is recorded as ERRORED by the run itself, not retried.
    attempts: 2,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  },
});

export type AuditJobData = { auditRunId: string; testRunId: string; projectId: string; organizationId: string };

// BullMQ reserves ":" as its Redis key separator and rejects it in a custom job id.
export const auditJobId = (auditRunId: string) => `audit-${auditRunId}`;

export function enqueueAudit(data: AuditJobData) {
  return auditQueue.add("audit", data, { jobId: auditJobId(data.auditRunId) });
}
