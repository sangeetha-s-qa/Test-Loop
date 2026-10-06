import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config";

export const executionQueueName = "execute-tests";

const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

export const executionQueue = new Queue(executionQueueName, {
  connection,
  defaultJobOptions: {
    // The worker classifies failures itself and only re-queues infrastructure problems, so the
    // queue-level retry exists purely for a worker that died before it could record anything.
    attempts: 2,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: 200,
    removeOnFail: 200,
  },
});

export type ExecutionJobData = { executionId: string; batchId: string; organizationId: string; projectId: string };

// BullMQ reserves ":" as its Redis key separator and rejects it in a custom job id.
export const executionJobId = (executionId: string) => `execute-${executionId}`;

export function enqueueExecution(data: ExecutionJobData) {
  return executionQueue.add("execute", data, { jobId: executionJobId(data.executionId) });
}
