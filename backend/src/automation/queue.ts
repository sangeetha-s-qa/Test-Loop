import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config";

export const automationQueueName = "generate-automation";

const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

export const automationQueue = new Queue(automationQueueName, {
  connection,
  defaultJobOptions: { attempts: 2, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: 100, removeOnFail: 100 },
});

export type AutomationJobData = { generationRunId: string; testRunId: string; organizationId: string; projectId: string; testCaseIds: string[] };

/** Deterministic job id so a duplicate dispatch for the same run is collapsed by BullMQ. */
// BullMQ reserves ":" as its Redis key separator and rejects it in a custom job id.
export const automationJobId = (generationRunId: string) => `generate-automation-${generationRunId}`;

export function enqueueAutomationGeneration(data: AutomationJobData) {
  return automationQueue.add("generate-automation", data, { jobId: automationJobId(data.generationRunId) });
}
