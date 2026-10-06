import { Worker } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config";
import { discoveryQueueName, type DiscoveryJobData } from "./queue";
import { runDiscovery } from "./crawler";

const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
const worker = new Worker<DiscoveryJobData>(discoveryQueueName, job => runDiscovery(job.data, job), { connection, concurrency: 2 });
worker.on("completed", job => console.log(JSON.stringify({ event: "discovery.completed", discoveryRunId: job.data.discoveryRunId })));
worker.on("failed", (job, error) => console.error(JSON.stringify({ event: "discovery.failed", discoveryRunId: job?.data.discoveryRunId, message: error.message })));
console.log("Discovery worker listening");