import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config";

export const analysisQueueName = "analyze-failures";

const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

export const analysisQueue = new Queue(analysisQueueName, {
  connection,
  defaultJobOptions: { attempts: 2, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: 100, removeOnFail: 100 },
});

export type AnalysisJobData = { analysisId: string; executionId: string; organizationId: string; includeHealing: boolean };

// BullMQ reserves ":" as its Redis key separator and rejects it in a custom job id.
export const analysisJobId = (analysisId: string) => `analyze-${analysisId}`;

export function enqueueAnalysis(data: AnalysisJobData) {
  return analysisQueue.add("analyze", data, { jobId: analysisJobId(data.analysisId) });
}
