import crypto from "node:crypto";
import type { BugSeverity, Prisma } from "@prisma/client";
import { prisma } from "../db";
import { doneStatuses } from "../bugs/workflow";

/**
 * A stable signature for "the same defect".
 *
 * The failure message is normalised first: ids, numbers, quoted values, and timestamps are
 * replaced with placeholders so two runs of the same broken thing produce the same fingerprint
 * while two genuinely different failures do not.
 */
export function failureFingerprint(input: { testCaseId: string; failureCategory: string | null; failedStepIndex: number | null; failureMessage: string | null }) {
  const normalized = (input.failureMessage ?? "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, "<timestamp>")
    .replace(/\b\d+(\.\d+)?(ms|s)\b/g, "<duration>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  return crypto.createHash("sha256").update([input.testCaseId, input.failureCategory ?? "", input.failedStepIndex ?? "", normalized].join("|")).digest("hex").slice(0, 32);
}

const severityByCategory: Record<string, BugSeverity> = {
  ASSERTION_FAILED: "HIGH",
  NAVIGATION_FAILED: "CRITICAL",
  LOCATOR_NOT_FOUND: "MEDIUM",
  LOCATOR_AMBIGUOUS: "LOW",
  TIMEOUT: "MEDIUM",
  CONSOLE_ERROR: "LOW",
  POLICY_VIOLATION: "HIGH",
  INFRASTRUCTURE: "LOW",
  UNKNOWN: "MEDIUM",
};

export type CreateBugInput = {
  executionId: string;
  organizationId: string;
  reportedById: string;
  title?: string;
  description?: string;
  severity?: BugSeverity;
  analysisId?: string | null;
};

export class BugError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "BugError";
  }
}

/**
 * Creates a bug from a failed execution, or records another occurrence of the existing bug with
 * the same fingerprint. Calling this twice for the same failure never produces two bugs.
 */
export async function createBugFromExecution(input: CreateBugInput) {
  const execution = await prisma.testExecution.findFirst({
    where: { id: input.executionId, project: { organizationId: input.organizationId } },
    include: { testCase: { select: { id: true, testCaseId: true, title: true, steps: true, expectedResult: true } }, steps: { orderBy: { stepIndex: "asc" } } },
  });
  if (!execution) throw new BugError("NOT_FOUND", "Execution not found");
  if (!["FAILED", "TIMED_OUT", "ERRORED"].includes(execution.status)) throw new BugError("EXECUTION_DID_NOT_FAIL", "A bug can only be created from a failed execution");

  const fingerprint = failureFingerprint({ testCaseId: execution.testCaseId, failureCategory: execution.failureCategory, failedStepIndex: execution.failedStepIndex, failureMessage: execution.failureMessage });

  const existing = await prisma.bug.findUnique({ where: { projectId_fingerprint: { projectId: execution.projectId, fingerprint } } });
  if (existing) {
    const updated = await prisma.bug.update({ where: { id: existing.id }, data: { occurrenceCount: { increment: 1 }, lastSeenAt: new Date() } });
    return { bug: updated, created: false };
  }

  const failedStep = execution.steps.find(step => step.status === "FAILED");
  const severity = input.severity ?? severityByCategory[execution.failureCategory ?? "UNKNOWN"] ?? "MEDIUM";

  return prisma.$transaction(async tx => {
    // A per-project sequence keeps references human-readable and unique.
    const count = await tx.bug.count({ where: { projectId: execution.projectId } });
    const bug = await tx.bug.create({
      data: {
        projectId: execution.projectId,
        testCaseId: execution.testCaseId,
        executionId: execution.id,
        analysisId: input.analysisId ?? null,
        reference: `BUG-${String(count + 1).padStart(4, "0")}`,
        title: (input.title ?? `${execution.testCase.title} failed at step ${(execution.failedStepIndex ?? 0) + 1}`).slice(0, 300),
        description: (input.description ?? execution.failureMessage ?? "The execution failed without a recorded message.").slice(0, 5000),
        stepsToReproduce: execution.steps.map(step => ({ step: step.stepIndex + 1, action: step.action, description: step.description, status: step.status })) as unknown as Prisma.InputJsonValue,
        expectedBehavior: execution.testCase.expectedResult.slice(0, 2000),
        actualBehavior: (failedStep?.failureMessage ?? execution.failureMessage ?? "No failure detail was recorded.").slice(0, 2000),
        severity,
        fingerprint,
        reportedById: input.reportedById,
      },
    });
    await tx.bugEvent.create({ data: { bugId: bug.id, actorId: input.reportedById, type: "CREATED", toValue: bug.status, note: "Raised from a failed automated execution" } });
    return { bug, created: true };
  });
}

/** Other open bugs on the same test case, offered to a reviewer as possible duplicates. */
export async function duplicateCandidates(bugId: string, projectId: string) {
  const bug = await prisma.bug.findUnique({ where: { id: bugId }, select: { testCaseId: true, severity: true } });
  if (!bug?.testCaseId) return [];
  return prisma.bug.findMany({
    where: { projectId, testCaseId: bug.testCaseId, id: { not: bugId }, status: { notIn: [...doneStatuses] } },
    select: { id: true, reference: true, title: true, status: true, severity: true, occurrenceCount: true, lastSeenAt: true },
    orderBy: { lastSeenAt: "desc" },
    take: 10,
  });
}
