import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config";

export const aiQueueName = "ai-generation";
const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
export const aiQueue = new Queue(aiQueueName, { connection, defaultJobOptions: { attempts: 2, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: 100, removeOnFail: 100 } });
export type AIGenerationJobData = { generationRunId: string; testRunId: string };
// BullMQ reserves ":" as its Redis key separator and rejects it in a custom job id.
export const aiJobId = (generationRunId: string) => `ai-generation-${generationRunId}`;
export function enqueueAIGeneration(data: AIGenerationJobData) { return aiQueue.add("generate-test-cases", data, { jobId: aiJobId(data.generationRunId) }); }