import { Worker } from "bullmq";
import IORedis from "ioredis";
import { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../db";
import { createAIProvider } from "../ai/provider";
import { estimateTokens } from "../ai/prompt";
import { generateValidated } from "../ai/structured";
import { AIProviderError } from "../ai/types";
import { locatorSchema, type AutomationLocator } from "../automation/program";
import { getObject } from "../artifacts/storage";
import { rankHealingCandidates, type DomCandidate } from "./healing";
import {
  analysisJsonSchema,
  analysisOutputSchema,
  analysisPromptVersion,
  analysisSystemPrompt,
  buildAnalysisPrompt,
  buildHealingPrompt,
  healingJsonSchema,
  healingOutputSchema,
  healingPromptVersion,
  healingSystemPrompt,
  type AnalysisEvidence,
} from "./prompt";
import { analysisQueueName, type AnalysisJobData } from "./queue";

const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

/** Console entries were written as an artifact by the runner; read them back for evidence. */
async function readConsoleErrors(executionId: string) {
  const artifact = await prisma.executionArtifact.findFirst({ where: { executionId, type: "CONSOLE_LOG" }, select: { storageKey: true } });
  if (!artifact) return [];
  try {
    const parsed = JSON.parse((await getObject(artifact.storageKey)).toString()) as { type: string; text: string }[];
    return Array.isArray(parsed) ? parsed.filter(entry => entry.type === "error").slice(0, 30) : [];
  } catch {
    return [];
  }
}

/**
 * Produces a healing proposal for a locator failure. It only ever writes a PROPOSED row; creating
 * a new AutomationVersion requires explicit approval through the API.
 */
async function proposeHealing(executionId: string, provider: ReturnType<typeof createAIProvider>) {
  const step = await prisma.testStepResult.findFirst({
    where: { executionId, status: "FAILED", failureCategory: { in: ["LOCATOR_NOT_FOUND", "LOCATOR_AMBIGUOUS"] } },
    include: { execution: { select: { automationVersionId: true, automationVersion: { select: { scriptId: true } } } } },
  });
  if (!step?.locator) return null;

  const parsedLocator = locatorSchema.safeParse(step.locator);
  if (!parsedLocator.success) return null;
  const failedLocator: AutomationLocator = parsedLocator.data;
  const domCandidates = ((step.domEvidence as { candidates?: DomCandidate[] } | null)?.candidates ?? []) as DomCandidate[];
  if (!domCandidates.length) return null;

  const prompt = buildHealingPrompt({ step: { action: step.action, description: step.description }, failedLocator, failureMessage: step.failureMessage, pageUrl: step.pageUrl, domCandidates });
  const maxOutputTokens = 1024;
  console.log(JSON.stringify({ event: "healing.request", executionId, model: `${provider.name}/${provider.model}`, domCandidates: domCandidates.length, promptChars: prompt.length, estimatedInputTokens: estimateTokens(prompt), maxOutputTokens }));

  const startedAt = Date.now();
  const outcome = await generateValidated(
    provider,
    { system: healingSystemPrompt, jsonSchema: healingJsonSchema as unknown as Record<string, unknown>, maxOutputTokens, prompt },
    healingOutputSchema,
    2,
    info => console.log(JSON.stringify({ event: "healing.repair", executionId, ...info })),
  );
  const healingDurationMs = Date.now() - startedAt;
  console.log(JSON.stringify({ event: "healing.response", executionId, durationMs: healingDurationMs, attempts: outcome.attempts, promptTokens: outcome.promptTokens, completionTokens: outcome.completionTokens, tokensPerSecond: outcome.completionTokens ? Number((outcome.completionTokens / (healingDurationMs / 1000)).toFixed(2)) : null, candidates: outcome.value.candidates.length }));

  // Uniqueness is judged against the captured DOM, not against the model's confidence.
  const ranked = rankHealingCandidates(outcome.value, domCandidates, failedLocator);
  if (!ranked.accepted.length) {
    console.log(JSON.stringify({ event: "healing.no_viable_candidate", executionId, rejected: ranked.rejected.map(entry => entry.reason) }));
    return null;
  }

  const best = ranked.accepted[0];
  return prisma.healingProposal.create({
    data: {
      scriptId: step.execution.automationVersion.scriptId,
      automationVersionId: step.execution.automationVersionId,
      stepExecutionId: step.id,
      stepIndex: step.stepIndex,
      failedLocator: failedLocator as unknown as Prisma.InputJsonValue,
      proposedLocator: { strategy: best.strategy, value: best.value, ...(best.name ? { name: best.name } : {}) } as Prisma.InputJsonValue,
      candidates: ranked as unknown as Prisma.InputJsonValue,
      confidence: best.confidence,
      rationale: best.rationale.slice(0, 500),
      evidence: { promptVersion: healingPromptVersion, pageUrl: step.pageUrl, failureMessage: step.failureMessage, candidateCount: domCandidates.length, rejected: ranked.rejected } as Prisma.InputJsonValue,
      provider: provider.name,
      model: provider.model,
    },
  });
}

const worker = new Worker<AnalysisJobData>(
  analysisQueueName,
  async job => {
    const analysis = await prisma.failureAnalysis.findUnique({ where: { id: job.data.analysisId } });
    if (!analysis) throw new Error("ANALYSIS_NOT_FOUND");
    if (analysis.status === "COMPLETED" || analysis.status === "CANCELLED") return;
    if (analysis.cancelRequestedAt) {
      await prisma.failureAnalysis.update({ where: { id: analysis.id }, data: { status: "CANCELLED", completedAt: new Date() } });
      return;
    }

    // Tenancy re-check inside the worker.
    const execution = await prisma.testExecution.findFirst({
      where: { id: job.data.executionId, project: { organizationId: job.data.organizationId } },
      include: { testCase: { select: { title: true, description: true, expectedResult: true } }, steps: { orderBy: { stepIndex: "asc" } } },
    });
    if (!execution) throw new Error("EXECUTION_NOT_AUTHORIZED");
    // Analysing a passing test would invent a problem that does not exist.
    if (!["FAILED", "TIMED_OUT", "ERRORED"].includes(execution.status)) throw new Error("EXECUTION_DID_NOT_FAIL");

    const provider = createAIProvider();
    await prisma.failureAnalysis.update({ where: { id: analysis.id }, data: { status: "ANALYZING", provider: provider.name, model: provider.model, promptVersion: analysisPromptVersion, startedAt: new Date() } });

    const failedStep = execution.steps.find(step => step.status === "FAILED") ?? null;
    const evidence: AnalysisEvidence = {
      testCase: execution.testCase,
      execution: { browser: execution.browser, status: execution.status, failureCategory: execution.failureCategory, failureMessage: execution.failureMessage, durationMs: execution.durationMs },
      failedStep: failedStep ? { stepIndex: failedStep.stepIndex, action: failedStep.action, description: failedStep.description, locator: failedStep.locator, pageUrl: failedStep.pageUrl, failureMessage: failedStep.failureMessage } : null,
      precedingSteps: execution.steps.filter(step => step.status === "PASSED").slice(-8).map(step => ({ stepIndex: step.stepIndex, action: step.action, description: step.description, status: step.status })),
      domCandidates: (failedStep?.domEvidence as { candidates?: unknown } | null)?.candidates ?? [],
      consoleErrors: await readConsoleErrors(execution.id),
    };

    const analysisPrompt = buildAnalysisPrompt(evidence);
    const analysisMaxOutputTokens = 1024;
    console.log(JSON.stringify({
      event: "analysis.request",
      analysisId: analysis.id,
      model: `${provider.name}/${provider.model}`,
      sent: { precedingSteps: evidence.precedingSteps.length, domCandidates: Array.isArray(evidence.domCandidates) ? evidence.domCandidates.length : 0, consoleErrors: evidence.consoleErrors.length },
      promptChars: analysisPrompt.length,
      estimatedInputTokens: estimateTokens(analysisPrompt),
      maxOutputTokens: analysisMaxOutputTokens,
    }));

    const analysisStartedAt = Date.now();
    const outcome = await generateValidated(
      provider,
      { system: analysisSystemPrompt, jsonSchema: analysisJsonSchema as unknown as Record<string, unknown>, prompt: analysisPrompt, maxOutputTokens: analysisMaxOutputTokens },
      analysisOutputSchema,
      2,
      info => console.log(JSON.stringify({ event: "analysis.repair", analysisId: analysis.id, ...info })),
    );
    const analysisDurationMs = Date.now() - analysisStartedAt;
    console.log(JSON.stringify({ event: "analysis.response", analysisId: analysis.id, durationMs: analysisDurationMs, attempts: outcome.attempts, promptTokens: outcome.promptTokens, completionTokens: outcome.completionTokens, tokensPerSecond: outcome.completionTokens ? Number((outcome.completionTokens / (analysisDurationMs / 1000)).toFixed(2)) : null, category: outcome.value.category }));

    await prisma.failureAnalysis.update({
      where: { id: analysis.id },
      data: {
        status: "COMPLETED",
        category: outcome.value.category,
        summary: outcome.value.summary,
        likelyCause: outcome.value.likelyCause,
        recommendedAction: outcome.value.recommendedAction,
        confidence: outcome.value.confidence,
        evidenceRefs: { stepResultIds: execution.steps.map(step => step.id), failedStepId: failedStep?.id ?? null, consoleErrorCount: evidence.consoleErrors.length } as Prisma.InputJsonValue,
        rawOutput: outcome.value as unknown as Prisma.InputJsonValue,
        latencyMs: outcome.latencyMs,
        promptTokens: outcome.promptTokens,
        completionTokens: outcome.completionTokens,
        completedAt: new Date(),
      },
    });

    if (job.data.includeHealing) {
      // A healing failure must not fail the analysis that already succeeded.
      await proposeHealing(execution.id, provider).catch(error => {
        console.error(JSON.stringify({ event: "healing.failed", executionId: execution.id, message: error instanceof Error ? error.message : "unknown" }));
      });
    }
  },
  { connection, concurrency: 1 },
);

worker.on("failed", (job, error) => {
  if (!job) return;
  const code = error instanceof AIProviderError ? error.code : error.message;
  void prisma.failureAnalysis
    .updateMany({ where: { id: job.data.analysisId, status: { notIn: ["COMPLETED", "CANCELLED"] } }, data: { status: "FAILED", error: code.slice(0, 500), completedAt: new Date() } })
    .catch(() => undefined);
  console.error(JSON.stringify({ event: "analysis.failed", analysisId: job.data.analysisId, code }));
});

const shutdown = async () => {
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Failure analysis worker listening");
