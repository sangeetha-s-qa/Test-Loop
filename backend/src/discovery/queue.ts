import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config";

export const discoveryQueueName = "discovery";
// BullMQ reserves ":" as its Redis key separator and rejects it in a custom job id.
export const discoveryJobId = (testRunId: string) => `discovery-${testRunId}`;
export function createDiscoveryQueue() {
  const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
  return new Queue(discoveryQueueName, { connection, defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: 100, removeOnFail: 100 } });
}

export const discoveryQueue = createDiscoveryQueue();

export type DiscoveryJobData = { discoveryRunId: string; testRunId: string; projectId: string; applicationUrl: string; browser: "chromium" | "firefox" | "webkit"; viewport: { width: number; height: number }; maxPages: number; maxDepth: number; maxDurationSeconds: number; maxRedirects: number; maxResponseBytes: number; allowLocalFixture?: boolean };

export function enqueueDiscovery(data: DiscoveryJobData) {
  return discoveryQueue.add("crawl", data, { jobId: discoveryJobId(data.testRunId) });
}