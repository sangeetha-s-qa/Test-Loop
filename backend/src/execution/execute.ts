import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Prisma, type ArtifactType, type FailureCategory } from "@prisma/client";
import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from "playwright";
import { automationProgramSchema, type AutomationLocator, type AutomationStep } from "../automation/program";
import { validateProgram } from "../automation/validate";
import { artifactContentTypes, buildStorageKey, putObject } from "../artifacts/storage";
import { config } from "../config";
import { prisma } from "../db";
import { assertSafeUrl } from "../discovery/scope";
import { recordEvent } from "./events";
import { awaitManualAction } from "./manual-action";
import { refreshMatrixForBatch } from "../matrix/service";
import { captureLocatorEvidence, classifyError, executeStep } from "./runner";

const browserTypes: Record<string, BrowserType> = { chromium, firefox, webkit };

type ConsoleEntry = { type: string; text: string; at: string };
type NetworkEntry = { method: string; url: string; status: number | null; failure: string | null; at: string };

/** Strips anything that looks like a credential before console or network evidence is stored. */
const redact = (value: string) =>
  value
    .replace(/\b(sk|pk)-[A-Za-z0-9]{16,}\b/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{20,}/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/([?&](?:token|key|secret|password|access_token)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 2000);

export type ExecutionOutcome = { status: "PASSED" | "FAILED" | "TIMED_OUT" | "CANCELLED" | "ERRORED"; failureCategory: FailureCategory | null; failureMessage: string | null };

/**
 * Runs one automation version in a real browser and records exactly what happened.
 *
 * Nothing here can report PASSED without every step having actually run and succeeded: the status
 * is derived at the end from `failure`, which is only null when the loop completed.
 */
export async function runExecution(executionId: string, organizationId: string): Promise<ExecutionOutcome> {
  const execution = await prisma.testExecution.findUnique({
    where: { id: executionId },
    include: { automationVersion: true, batch: { select: { id: true, cancelRequestedAt: true } }, testRun: { select: { configuration: true } } },
  });
  if (!execution) throw new Error("EXECUTION_NOT_FOUND");

  // A duplicate delivery of the same job must not re-run a finished execution.
  if (!["QUEUED", "PROVISIONING"].includes(execution.status)) {
    return { status: execution.status as ExecutionOutcome["status"], failureCategory: execution.failureCategory, failureMessage: execution.failureMessage };
  }

  const parsed = automationProgramSchema.safeParse(execution.automationVersion.program);
  if (!parsed.success) return finish(execution.id, execution.batchId, { status: "ERRORED", failureCategory: "POLICY_VIOLATION", failureMessage: "The stored automation program is not valid" }, 0, 0);

  // Re-validating at execution time means a version that predates a policy change cannot run.
  const report = validateProgram(parsed.data);
  if (report.status === "FAILED") {
    return finish(execution.id, execution.batchId, { status: "ERRORED", failureCategory: "POLICY_VIOLATION", failureMessage: `Policy validation failed: ${report.issues.filter(issue => issue.severity === "ERROR").map(issue => issue.code).join(", ")}` }, 0, 0);
  }
  const steps = parsed.data.steps;

  await prisma.testExecution.update({ where: { id: execution.id }, data: { status: "PROVISIONING", startedAt: new Date(), totalSteps: steps.length } });
  await recordEvent(execution.batchId, "execution.provisioning", { executionId: execution.id, totalSteps: steps.length }, execution.id);

  // The runner never trusts the stored URL: SSRF checks run again before a browser is launched.
  let baseUrl: string;
  try {
    baseUrl = await assertSafeUrl(execution.applicationUrl, undefined, { allowLocalFixture: config.EXECUTION_ALLOW_LOCAL_FIXTURE });
  } catch {
    return finish(execution.id, execution.batchId, { status: "ERRORED", failureCategory: "POLICY_VIOLATION", failureMessage: "The application URL is not an allowed destination" }, 0, steps.length);
  }

  const viewport = execution.viewport as { width: number; height: number };
  // Evidence capture is opt-in per test run; video and trace are expensive and the user chose.
  const settings = execution.testRun.configuration as { recordVideo?: boolean; captureTrace?: boolean; captureScreenshots?: boolean; networkLogging?: boolean };
  const recordVideo = settings.recordVideo === true;
  const captureTrace = settings.captureTrace !== false;
  const captureScreenshots = settings.captureScreenshots !== false;
  const recordHar = settings.networkLogging !== false;
  const browserType = browserTypes[execution.browser] ?? chromium;
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `qa-exec-${execution.id.slice(0, 8)}-`));
  // Mutable because a `pauseForUser` step pushes it out by however long the person took. The
  // per-execution limit is a budget for the browser, not for the human it is waiting on.
  let deadline = Date.now() + config.EXECUTION_MAX_DURATION_SECONDS * 1000;

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let passedSteps = 0;
  let failedStepIndex: number | null = null;
  let failure: { category: FailureCategory; message: string } | null = null;
  const consoleEntries: ConsoleEntry[] = [];
  const networkEntries: NetworkEntry[] = [];
  const screenshots: { name: string; body: Buffer; stepIndex: number | null }[] = [];

  try {
    try {
      browser = await browserType.launch({ headless: true });
    } catch (error) {
      return finish(execution.id, execution.batchId, { status: "ERRORED", failureCategory: "INFRASTRUCTURE", failureMessage: classifyError(error).message.slice(0, 500) }, 0, steps.length);
    }

    // A fresh context per execution: no shared storage state, cookies, or credentials.
    context = await browser.newContext({
      viewport,
      ignoreHTTPSErrors: false,
      ...(recordVideo ? { recordVideo: { dir: path.join(workDir, "video"), size: viewport } } : {}),
      ...(recordHar ? { recordHar: { path: path.join(workDir, "network.har"), content: "omit" as const } } : {}),
    });
    if (captureTrace) await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    page = await context.newPage();
    page.setDefaultTimeout(config.EXECUTION_STEP_TIMEOUT_MS);

    page.on("console", message => {
      if (message.type() === "error" || message.type() === "warning") consoleEntries.push({ type: message.type(), text: redact(message.text()), at: new Date().toISOString() });
    });
    page.on("requestfailed", request => networkEntries.push({ method: request.method(), url: redact(request.url()), status: null, failure: request.failure()?.errorText ?? "failed", at: new Date().toISOString() }));
    page.on("response", response => {
      if (response.status() >= 400) networkEntries.push({ method: response.request().method(), url: redact(response.url()), status: response.status(), failure: null, at: new Date().toISOString() });
    });

    // Same-origin enforcement at the network layer, not just at the step layer.
    await page.route("**/*", async route => {
      try {
        await assertSafeUrl(route.request().url(), baseUrl, { allowLocalFixture: config.EXECUTION_ALLOW_LOCAL_FIXTURE });
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });

    await prisma.testExecution.update({ where: { id: execution.id }, data: { status: "RUNNING", browserVersion: browser.version() } });
    await recordEvent(execution.batchId, "execution.running", { executionId: execution.id }, execution.id);

    const stepRows = await prisma.$transaction(
      steps.map((step, stepIndex) =>
        prisma.testStepResult.create({
          data: { executionId: execution.id, stepIndex, action: step.action, description: step.description, locator: ("locator" in step && step.locator ? (step.locator as unknown as Prisma.InputJsonValue) : Prisma.JsonNull), status: "PENDING" },
        }),
      ),
    );

    for (const [stepIndex, step] of steps.entries()) {
      const cancelled = await prisma.executionBatch.findUnique({ where: { id: execution.batchId }, select: { cancelRequestedAt: true } });
      if (cancelled?.cancelRequestedAt) {
        failure = { category: "CANCELLED", message: "Cancelled by request" };
        failedStepIndex = stepIndex;
        break;
      }
      if (Date.now() > deadline) {
        failure = { category: "TIMEOUT", message: `Execution exceeded the ${config.EXECUTION_MAX_DURATION_SECONDS}s limit` };
        failedStepIndex = stepIndex;
        break;
      }

      const row = stepRows[stepIndex];
      const startedAt = new Date();
      await prisma.testStepResult.update({ where: { id: row.id }, data: { status: "RUNNING", startedAt } });

      try {
        await executeStep(step, {
          page,
          baseUrl,
          timeoutMs: Math.max(1000, Math.min(config.EXECUTION_STEP_TIMEOUT_MS, deadline - Date.now())),
          captureScreenshot: async name => {
            const body = await page!.screenshot({ fullPage: true });
            screenshots.push({ name, body, stepIndex });
          },
          requestManualAction: async ({ reason, prompt }) => {
            const { pausedMs } = await awaitManualAction({
              executionId: execution.id,
              batchId: execution.batchId,
              testRunId: execution.testRunId,
              projectId: execution.projectId,
              organizationId,
              stepIndex,
              reason,
              prompt,
              pageUrl: page!.url(),
            });
            deadline += pausedMs;
          },
        });
        passedSteps += 1;
        await prisma.testStepResult.update({ where: { id: row.id }, data: { status: "PASSED", completedAt: new Date(), durationMs: Date.now() - startedAt.getTime(), pageUrl: page.url().slice(0, 2000) } });
      } catch (error) {
        const classified = classifyError(error);
        failedStepIndex = stepIndex;
        const locator = "locator" in step ? ((step as Extract<AutomationStep, { locator: AutomationLocator }>).locator ?? null) : null;
        const evidence = (await captureLocatorEvidence(page, locator).catch(() => ({}))) as { matchCount?: number | null };

        // Playwright reports a web-first assertion against a missing element with the same prose
        // as any other assertion failure, so the message alone cannot tell the two apart. The
        // match count is the deterministic answer, and it decides whether healing is offered.
        if (locator && evidence.matchCount === 0 && classified.category === "ASSERTION_FAILED") classified.category = "LOCATOR_NOT_FOUND";
        else if (locator && typeof evidence.matchCount === "number" && evidence.matchCount > 1 && classified.category === "ASSERTION_FAILED") classified.category = "LOCATOR_AMBIGUOUS";
        failure = classified;
        // A screenshot of the failure is the single most useful artifact, so capture it before cleanup.
        const failureShot = await page.screenshot({ fullPage: true }).catch(() => null);
        if (failureShot) screenshots.push({ name: `failure-step-${stepIndex + 1}`, body: failureShot, stepIndex });
        await prisma.testStepResult.update({
          where: { id: row.id },
          data: { status: "FAILED", completedAt: new Date(), durationMs: Date.now() - startedAt.getTime(), failureCategory: classified.category, failureMessage: redact(classified.message), pageUrl: page.url().slice(0, 2000), domEvidence: evidence as Prisma.InputJsonValue },
        });
        await prisma.testStepResult.updateMany({ where: { executionId: execution.id, stepIndex: { gt: stepIndex } }, data: { status: "SKIPPED" } });
        break;
      }
      await recordEvent(execution.batchId, "execution.step", { executionId: execution.id, stepIndex, action: step.action, status: "PASSED" }, execution.id);
    }

    // A run that captures screenshots only when something breaks leaves a passing test with no
    // visual evidence at all - and nothing for a visual baseline to be seeded from. A failure already
    // captures its own shot above, so this covers the run that finished cleanly.
    if (captureScreenshots && failure === null) {
      const finalShot = await page.screenshot({ fullPage: true }).catch(() => null);
      if (finalShot) screenshots.push({ name: "final", body: finalShot, stepIndex: null });
    }

    await prisma.testExecution.update({ where: { id: execution.id }, data: { status: "COLLECTING_ARTIFACTS" } });
    await recordEvent(execution.batchId, "execution.collecting_artifacts", { executionId: execution.id }, execution.id);

    // Tracing, video, and HAR are only written when the context closes, so artifacts are
    // collected after the context is shut down but before the browser is discarded.
    const tracePath = captureTrace ? path.join(workDir, "trace.zip") : null;
    if (tracePath) await context.tracing.stop({ path: tracePath }).catch(() => undefined);
    const videoPath = recordVideo ? await page.video()?.path().catch(() => undefined) : undefined;
    await context.close();
    context = undefined;

    await storeArtifacts(execution.id, organizationId, execution.projectId, {
      screenshots,
      tracePath,
      videoPath: videoPath ?? null,
      harPath: recordHar ? path.join(workDir, "network.har") : null,
      consoleEntries,
      networkEntries,
    });
  } catch (error) {
    // Anything that escapes the step loop is platform trouble, not a product defect.
    if (!failure) failure = { category: "INFRASTRUCTURE", message: classifyError(error).message };
  } finally {
    // Browser and temporary files are released even when the run blew up mid-way.
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  // An unanswered manual action is ERRORED, not FAILED. FAILED is a claim about the application
  // under test, and a run that nobody unblocked never got far enough to make one. The category is
  // kept distinct from INFRASTRUCTURE so it is not retried - retrying would just wait again.
  const manualActionUnanswered = failure?.category === "MANUAL_ACTION_EXPIRED" || failure?.category === "MANUAL_ACTION_ABORTED";
  const status: ExecutionOutcome["status"] = !failure
    ? "PASSED"
    : failure.category === "CANCELLED"
      ? "CANCELLED"
      : failure.category === "TIMEOUT"
        ? "TIMED_OUT"
        : failure.category === "INFRASTRUCTURE" || manualActionUnanswered
          ? "ERRORED"
          : "FAILED";
  return finish(
    execution.id,
    execution.batchId,
    { status, failureCategory: failure?.category ?? null, failureMessage: failure ? redact(failure.message).slice(0, 1000) : null },
    passedSteps,
    steps.length,
    failedStepIndex,
    consoleEntries.filter(entry => entry.type === "error").length,
    networkEntries.length,
  );
}

async function storeArtifacts(
  executionId: string,
  organizationId: string,
  projectId: string,
  data: { screenshots: { name: string; body: Buffer; stepIndex: number | null }[]; tracePath: string | null; videoPath: string | null; harPath: string | null; consoleEntries: ConsoleEntry[]; networkEntries: NetworkEntry[] },
) {
  const stepRows = await prisma.testStepResult.findMany({ where: { executionId }, select: { id: true, stepIndex: true } });
  const stepIdByIndex = new Map(stepRows.map(row => [row.stepIndex, row.id]));

  const save = async (type: ArtifactType, fileName: string, body: Buffer, stepResultId: string | null = null) => {
    const storageKey = buildStorageKey({ organizationId, projectId, executionId, type, fileName });
    const stored = await putObject(storageKey, body);
    await prisma.executionArtifact.create({
      data: { executionId, stepResultId, type, storageKey: stored.storageKey, fileName, contentType: artifactContentTypes[type] ?? "application/octet-stream", byteSize: stored.byteSize, checksumSha256: stored.checksumSha256 },
    });
  };

  for (const shot of data.screenshots) {
    await save("SCREENSHOT", `${shot.name}.png`, shot.body, shot.stepIndex === null ? null : (stepIdByIndex.get(shot.stepIndex) ?? null)).catch(() => undefined);
  }
  for (const [type, filePath, fileName] of [["TRACE", data.tracePath, "trace.zip"], ["VIDEO", data.videoPath, "video.webm"], ["HAR", data.harPath, "network.har"]] as const) {
    if (!filePath) continue;
    const body = await fs.readFile(filePath).catch(() => null);
    // Only record an artifact that actually exists; a missing file must not become a dead link.
    if (body?.length) await save(type, fileName, body).catch(() => undefined);
  }
  if (data.consoleEntries.length) await save("CONSOLE_LOG", "console.json", Buffer.from(JSON.stringify(data.consoleEntries, null, 2))).catch(() => undefined);
  if (data.networkEntries.length) await save("NETWORK_LOG", "network.json", Buffer.from(JSON.stringify(data.networkEntries, null, 2))).catch(() => undefined);
}

async function finish(
  executionId: string,
  batchId: string,
  outcome: ExecutionOutcome,
  passedSteps: number,
  totalSteps: number,
  failedStepIndex: number | null = null,
  consoleErrorCount = 0,
  networkFailureCount = 0,
): Promise<ExecutionOutcome> {
  const completedAt = new Date();
  const updated = await prisma.testExecution.update({
    where: { id: executionId },
    data: { status: outcome.status, failureCategory: outcome.failureCategory, failureMessage: outcome.failureMessage, passedSteps, totalSteps, failedStepIndex, consoleErrorCount, networkFailureCount, completedAt },
  });
  await prisma.testExecution.update({ where: { id: executionId }, data: { durationMs: updated.startedAt ? completedAt.getTime() - updated.startedAt.getTime() : null } });
  await recordEvent(batchId, "execution.finished", { executionId, status: outcome.status, failureCategory: outcome.failureCategory, passedSteps, totalSteps }, executionId);
  return outcome;
}

/** Recomputes batch counters from the execution rows. Counters are never incremented by hand. */
export async function refreshBatch(batchId: string) {
  // A batch that is a matrix cell also has to roll up into its matrix. Hooked here rather than in
  // the worker because every path that settles a batch - success, failure, cancellation - already
  // funnels through this function.
  const rollUpMatrix = () => refreshMatrixForBatch(batchId).catch(() => undefined);
  const executions = await prisma.testExecution.findMany({ where: { batchId }, select: { status: true, durationMs: true } });
  const count = (status: string) => executions.filter(execution => execution.status === status).length;
  const settled = executions.every(execution => ["PASSED", "FAILED", "TIMED_OUT", "CANCELLED", "ERRORED"].includes(execution.status));
  const batch = await prisma.executionBatch.findUnique({ where: { id: batchId }, select: { startedAt: true, cancelRequestedAt: true } });
  const updated = await prisma.executionBatch.update({
    where: { id: batchId },
    data: {
      passedCount: count("PASSED"),
      failedCount: count("FAILED") + count("TIMED_OUT"),
      skippedCount: count("CANCELLED"),
      erroredCount: count("ERRORED"),
      ...(settled
        ? {
            status: batch?.cancelRequestedAt ? "CANCELLED" : count("ERRORED") === executions.length && executions.length > 0 ? "FAILED" : "COMPLETED",
            completedAt: new Date(),
            durationMs: batch?.startedAt ? Date.now() - batch.startedAt.getTime() : null,
          }
        : {}),
    },
  });
  await rollUpMatrix();
  return updated;
}

/** Deterministic id for an artifact filename that must not collide across steps. */
export const artifactFileName = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
