import { Worker } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config";
import { prisma } from "../db";
import { createAIProvider } from "../ai/provider";
import { estimateTokens } from "../ai/prompt";
import { generateValidated } from "../ai/structured";
import { AIProviderError } from "../ai/types";
import { automationPromptVersion, automationSystemPrompt, buildAutomationPrompt, type AutomationPromptElement, type AutomationPromptField } from "./prompt";
import { automationJsonSchema, automationProgramSchema } from "./program";
import { automationQueueName, type AutomationJobData } from "./queue";
import { createAutomationVersion, ensureAutomationScript, ensureLatestTestCaseVersion } from "./service";
import { validateProgram } from "./validate";

const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

/** Converts an absolute discovered URL to a path relative to the run's application URL. */
function toRelativePath(normalizedUrl: string, applicationUrl: string) {
  try {
    const target = new URL(normalizedUrl);
    const base = new URL(applicationUrl);
    return target.origin === base.origin ? `${target.pathname}${target.search}` : target.pathname;
  } catch {
    return "/";
  }
}

async function generateForTestCase(job: { data: AutomationJobData }, testCaseId: string, provider: ReturnType<typeof createAIProvider>) {
  const testCase = await prisma.testCase.findFirst({
    where: { id: testCaseId, status: "APPROVED", testRun: { id: job.data.testRunId, project: { id: job.data.projectId, organizationId: job.data.organizationId } } },
    include: { testRun: true },
  });
  // Re-checking tenancy inside the worker means a tampered job payload still cannot reach another org.
  if (!testCase) throw new Error("TEST_CASE_NOT_APPROVED_OR_NOT_FOUND");

  const discovery = await prisma.discoveryRun.findUnique({
    where: { testRunId: testCase.testRunId },
    include: { pages: { select: { id: true, normalizedUrl: true, title: true } }, elements: { select: { id: true, pageId: true, tagName: true, role: true, accessibleName: true, selectorCandidates: true } }, forms: { include: { fields: { select: { name: true, type: true, label: true, required: true, placeholder: true, selectorCandidates: true } } } } },
  });
  if (!discovery) throw new Error("DISCOVERY_NOT_FOUND");

  const applicationUrl = testCase.testRun.applicationUrl;
  const elements: AutomationPromptElement[] = discovery.elements.map(element => ({ id: element.id, pageId: element.pageId, tagName: element.tagName, role: element.role, accessibleName: element.accessibleName, selectorCandidates: element.selectorCandidates }));
  const forms = discovery.forms.map(form => ({ pageId: form.pageId, identifier: form.identifier, action: form.action, method: form.method, fields: form.fields as AutomationPromptField[] }));

  const { prompt, refs } = buildAutomationPrompt({
    applicationUrl,
    testCase: { testCaseId: testCase.testCaseId, title: testCase.title, description: testCase.description, module: testCase.module, preconditions: testCase.preconditions, testData: testCase.testData, steps: testCase.steps, expectedResult: testCase.expectedResult },
    pages: discovery.pages.map(page => ({ id: page.id, path: toRelativePath(page.normalizedUrl, applicationUrl), title: page.title })),
    elements,
    forms,
  });
  const maxOutputTokens = 1536;

  // Same diagnostics contract as test-case generation: every local model call is measurable, so a
  // slow stage can be attributed instead of guessed at.
  console.log(JSON.stringify({
    event: "automation-generation.request",
    testCaseId: testCase.testCaseId,
    model: `${provider.name}/${provider.model}`,
    sent: { pages: discovery.pages.length, forms: forms.length, elements: elements.length },
    promptChars: prompt.length,
    estimatedInputTokens: estimateTokens(prompt),
    maxOutputTokens,
  }));

  const startedAt = Date.now();
  const outcome = await generateValidated(
    provider,
    { system: automationSystemPrompt, jsonSchema: automationJsonSchema as unknown as Record<string, unknown>, maxOutputTokens, prompt },
    automationProgramSchema,
    2,
    info => console.log(JSON.stringify({ event: "automation-generation.repair", testCaseId: testCase.testCaseId, ...info })),
    // Policy rules are not expressible in the JSON Schema - Ollama accepts `prefixItems` and
    // `contains` but ignores them - so a program that decodes cleanly can still violate them.
    // Reporting the violations here spends a repair round fixing them rather than discarding a
    // generation that already cost minutes and failing the whole run.
    program => {
      const report = validateProgram(program);
      if (report.status !== "FAILED") return null;
      return report.issues.filter(issue => issue.severity === "ERROR").map(issue => `${issue.code}: ${issue.message}`).join("\n");
    },
  );

  const durationMs = Date.now() - startedAt;
  console.log(JSON.stringify({
    event: "automation-generation.response",
    testCaseId: testCase.testCaseId,
    durationMs,
    attempts: outcome.attempts,
    promptTokens: outcome.promptTokens,
    completionTokens: outcome.completionTokens,
    tokensPerSecond: outcome.completionTokens ? Number((outcome.completionTokens / (durationMs / 1000)).toFixed(2)) : null,
    steps: outcome.value.steps.length,
  }));

  // Resolve the short refs the model used back to real element ids. Anything it invented resolves
  // to null, so a stored program never carries a reference that points at nothing.
  const program = {
    ...outcome.value,
    steps: outcome.value.steps.map(step =>
      "locator" in step && step.locator
        ? { ...step, locator: { ...step.locator, sourceElementId: step.locator.sourceElementId ? (refs.elements.get(step.locator.sourceElementId) ?? null) : null } }
        : step,
    ),
  };

  const report = validateProgram(program);
  const testCaseVersion = await ensureLatestTestCaseVersion(testCase, "AI", null);
  const script = await ensureAutomationScript(testCase.id, testCase.testRun.projectId);

  return createAutomationVersion({
    scriptId: script.id,
    testCaseVersionId: testCaseVersion.id,
    program,
    applicationUrl,
    source: "AI",
    generationRunId: job.data.generationRunId,
    provider: provider.name,
    model: provider.model,
    promptVersion: automationPromptVersion,
    latencyMs: outcome.latencyMs,
    promptTokens: outcome.promptTokens,
    completionTokens: outcome.completionTokens,
    report,
  });
}

const worker = new Worker<AutomationJobData>(
  automationQueueName,
  async job => {
    const run = await prisma.automationGenerationRun.findUnique({ where: { id: job.data.generationRunId } });
    if (!run) throw new Error("AUTOMATION_RUN_NOT_FOUND");
    if (run.status === "COMPLETED" || run.status === "CANCELLED") return;
    if (run.cancelRequestedAt) {
      await prisma.automationGenerationRun.update({ where: { id: run.id }, data: { status: "CANCELLED", completedAt: new Date() } });
      return;
    }

    const provider = createAIProvider();
    await prisma.automationGenerationRun.update({ where: { id: run.id }, data: { status: "GENERATING", provider: provider.name, model: provider.model, startedAt: new Date() } });

    let generated = 0;
    let failed = 0;
    const failures: string[] = [];

    for (const testCaseId of job.data.testCaseIds) {
      const current = await prisma.automationGenerationRun.findUnique({ where: { id: run.id }, select: { cancelRequestedAt: true } });
      if (current?.cancelRequestedAt) {
        await prisma.automationGenerationRun.update({ where: { id: run.id }, data: { status: "CANCELLED", generatedCount: generated, failedCount: failed, completedAt: new Date() } });
        return;
      }
      try {
        await generateForTestCase(job, testCaseId, provider);
        generated += 1;
      } catch (error) {
        failed += 1;
        const code = error instanceof AIProviderError ? error.code : error instanceof Error ? error.message : "AUTOMATION_GENERATION_FAILED";
        failures.push(`${testCaseId}: ${code}`);
        console.error(JSON.stringify({ event: "automation.testcase.failed", generationRunId: run.id, testCaseId, code }));
      }
      await prisma.automationGenerationRun.update({ where: { id: run.id }, data: { generatedCount: generated, failedCount: failed } });
      await job.updateProgress({ generated, failed, total: job.data.testCaseIds.length });
    }

    await prisma.automationGenerationRun.update({
      where: { id: run.id },
      data: {
        // A run that produced nothing at all is a failure, not a success with zero results.
        status: generated === 0 && failed > 0 ? "FAILED" : "COMPLETED",
        generatedCount: generated,
        failedCount: failed,
        error: failures.length ? failures.join("; ").slice(0, 500) : null,
        completedAt: new Date(),
      },
    });
  },
  { connection, concurrency: 1 },
);

worker.on("failed", (job, error) => {
  if (!job) return;
  const code = error instanceof AIProviderError ? error.code : error.message;
  void prisma.automationGenerationRun
    .updateMany({ where: { id: job.data.generationRunId, status: { notIn: ["CANCELLED", "COMPLETED"] } }, data: { status: "FAILED", error: code.slice(0, 500), completedAt: new Date() } })
    .catch(() => undefined);
  console.error(JSON.stringify({ event: "automation.generation.failed", generationRunId: job.data.generationRunId, code }));
});

const shutdown = async () => {
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Automation generation worker listening");
