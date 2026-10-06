import { Worker } from "bullmq";
import IORedis from "ioredis";
import type { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../db";
import { buildGenerationJsonSchema, buildGenerationPrompt, generationSystemPrompt, promptVersion, schemaVersion } from "./prompt";
import { createAIProvider } from "./provider";
import { generateValidated } from "./structured";
import { aiQueueName, type AIGenerationJobData } from "./queue";
import { AIProviderError, generationOutputSchema } from "./types";

const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

const worker = new Worker<AIGenerationJobData>(
  aiQueueName,
  async job => {
    const run = await prisma.aIGenerationRun.findUnique({ where: { id: job.data.generationRunId }, include: { testRun: true } });
    if (!run) throw new Error("GENERATION_NOT_FOUND");
    if (run.status === "COMPLETED" || run.status === "CANCELLED") return;
    if (run.cancelRequestedAt) {
      await prisma.aIGenerationRun.update({ where: { id: run.id }, data: { status: "CANCELLED", completedAt: new Date() } });
      return;
    }

    const discovery = await prisma.discoveryRun.findUnique({ where: { testRunId: run.testRunId }, include: { pages: true, links: true, forms: { include: { fields: true } }, elements: true } });
    if (!discovery || discovery.status !== "COMPLETED" || !discovery.pages.length) throw new Error("DISCOVERY_NOT_COMPLETED");

    const provider = createAIProvider();
    await prisma.aIGenerationRun.update({ where: { id: run.id }, data: { status: "ANALYZING", provider: provider.name, model: provider.model, promptVersion, startedAt: new Date() } });

    const { prompt, refs, stats, maxTestCases } = buildGenerationPrompt(run.testRun, discovery);
    const maxOutputTokens = 3072;

    // Diagnostics before the call: this is what makes a slow generation diagnosable instead of
    // looking like a hang.
    console.log(JSON.stringify({
      event: "ai-generation.request",
      generationRunId: run.id,
      model: `${provider.name}/${provider.model}`,
      discovered: { pages: discovery.pages.length, forms: discovery.forms.length, elements: discovery.elements.length, links: discovery.links.length },
      sent: { pages: stats.pages, forms: stats.forms, elements: stats.elements, navLinks: stats.navLinks },
      promptChars: stats.promptChars,
      estimatedInputTokens: stats.estimatedInputTokens,
      maxOutputTokens,
      maxTestCases,
    }));

    const startedAt = Date.now();
    const outcome = await generateValidated(
      provider,
      { system: generationSystemPrompt, prompt, jsonSchema: buildGenerationJsonSchema(maxTestCases) as unknown as Record<string, unknown>, maxOutputTokens },
      generationOutputSchema,
      2,
      info => console.log(JSON.stringify({ event: "ai-generation.repair", generationRunId: run.id, ...info })),
    );
    const output = outcome.value;

    const durationMs = Date.now() - startedAt;
    const stepCount = output.testCases.reduce((sum, testCase) => sum + testCase.steps.length, 0);
    console.log(JSON.stringify({
      event: "ai-generation.response",
      generationRunId: run.id,
      durationMs,
      attempts: outcome.attempts,
      promptTokens: outcome.promptTokens,
      completionTokens: outcome.completionTokens,
      tokensPerSecond: outcome.completionTokens ? Number((outcome.completionTokens / (durationMs / 1000)).toFixed(2)) : null,
      scenarios: output.scenarios.length,
      testCases: output.testCases.length,
      steps: stepCount,
    }));

    // The model references pages and elements by short prompt ref. Resolving through the ref map
    // means an invented ref becomes null rather than a dangling foreign key.
    const keepPage = (value: string | null | undefined) => (value ? (refs.pages.get(value) ?? null) : null);
    const keepElement = (value: string | null | undefined) => (value ? (refs.elements.get(value) ?? null) : null);

    /**
     * Cancellation is re-checked after the model call, not only before it.
     *
     * The guard at the top of this job runs in milliseconds; the generation that follows takes
     * minutes on a local model. A cancellation arriving in that window used to be overwritten the
     * moment the model returned - the run went CANCELLED, then back to GENERATING, then COMPLETED,
     * and the test cases the user cancelled were persisted anyway. Reading the row again here means
     * a cancellation that arrived at any point during generation is honoured, and the generated
     * output is discarded rather than stored.
     */
    const current = await prisma.aIGenerationRun.findUnique({ where: { id: run.id }, select: { status: true, cancelRequestedAt: true } });
    if (!current || current.status === "CANCELLED" || current.cancelRequestedAt) {
      console.log(JSON.stringify({ event: "ai-generation.cancelled", generationRunId: run.id, discardedScenarios: output.scenarios.length, discardedTestCases: output.testCases.length }));
      await prisma.aIGenerationRun.updateMany({ where: { id: run.id, status: { not: "COMPLETED" } }, data: { status: "CANCELLED", completedAt: new Date() } });
      return;
    }

    await prisma.aIGenerationRun.update({
      where: { id: run.id },
      data: {
        status: "GENERATING",
        scenarioCount: output.scenarios.length,
        testCaseCount: output.testCases.length,
        inputSummary: { pages: discovery.pages.length, forms: discovery.forms.length, elements: discovery.elements.length, promptChars: stats.promptChars, estimatedInputTokens: stats.estimatedInputTokens, promptVersion, schemaVersion, attempts: outcome.attempts, latencyMs: outcome.latencyMs, promptTokens: outcome.promptTokens, completionTokens: outcome.completionTokens, providerRequestId: outcome.providerRequestId },
      },
    });

    const uniqueCases = [...new Map(output.testCases.slice(0, maxTestCases).map(testCase => [`${testCase.title.toLowerCase()}|${testCase.category}|${testCase.sourcePageId ?? ""}`, testCase])).values()];
    // A second run for the same test run must not collide with ids already stored.
    const existingIds = new Set((await prisma.testCase.findMany({ where: { testRunId: run.testRunId }, select: { testCaseId: true } })).map(item => item.testCaseId));

    await prisma.$transaction(async transaction => {
      for (const scenario of output.scenarios) {
        await transaction.testScenario.create({
          data: { testRunId: run.testRunId, generationRunId: run.id, title: scenario.title, description: scenario.description, module: scenario.module, category: scenario.category, priority: scenario.priority, risk: scenario.risk, sourcePageId: keepPage(scenario.sourcePageId), generationMetadata: { promptVersion, schemaVersion } as Prisma.InputJsonValue },
        });
      }
      for (const testCase of uniqueCases) {
        let testCaseId = testCase.testCaseId;
        for (let suffix = 2; existingIds.has(testCaseId); suffix += 1) testCaseId = `${testCase.testCaseId}-${suffix}`;
        existingIds.add(testCaseId);
        await transaction.testCase.create({
          data: { testRunId: run.testRunId, generationRunId: run.id, testCaseId, title: testCase.title, description: testCase.description, module: testCase.module, category: testCase.category, priority: testCase.priority, severity: testCase.severity, preconditions: testCase.preconditions, testData: testCase.testData as Prisma.InputJsonValue, steps: testCase.steps as unknown as Prisma.InputJsonValue, expectedResult: testCase.expectedResult, postconditions: testCase.postconditions, sourcePageId: keepPage(testCase.sourcePageId), sourceElementId: keepElement(testCase.sourceElementId), generationSource: "AI" },
        });
      }
    });

    // Guarded so a cancellation that landed during persistence still wins.
    await prisma.aIGenerationRun.updateMany({ where: { id: run.id, status: { notIn: ["CANCELLED"] } }, data: { status: "COMPLETED", testCaseCount: uniqueCases.length, completedAt: new Date() } });
    await job.updateProgress({ scenarios: output.scenarios.length, testCases: uniqueCases.length });
  },
  { connection, concurrency: 1 },
);

worker.on("failed", (job, error) => {
  if (!job) return;
  const code = error instanceof AIProviderError ? error.code : error.message;
  void prisma.aIGenerationRun
    .updateMany({ where: { id: job.data.generationRunId, status: { notIn: ["CANCELLED", "COMPLETED"] } }, data: { status: "FAILED", error: code.slice(0, 500), completedAt: new Date() } })
    .catch(() => undefined);
  console.error(JSON.stringify({ event: "ai-generation.failed", generationRunId: job.data.generationRunId, code }));
});

const shutdown = async () => {
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("AI generation worker listening");
