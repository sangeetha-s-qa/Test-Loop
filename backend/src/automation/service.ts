import type { Prisma, TestCase, TestCaseVersionSource } from "@prisma/client";
import { prisma } from "../db";
import { assertionActions, type AutomationProgram } from "./program";
import { renderPlaywrightSpec } from "./renderer";
import { validateProgram, type ValidationReport } from "./validate";

type Transaction = Prisma.TransactionClient;

/**
 * Writes an immutable snapshot of a test case and advances its version counter.
 * Called on approval and on every user edit, so automation can always name the exact
 * test-case content it was generated from.
 */
export async function snapshotTestCase(tx: Transaction, testCase: TestCase, source: TestCaseVersionSource, createdById: string | null) {
  const version = testCase.currentVersion + 1;
  const snapshot = await tx.testCaseVersion.create({
    data: {
      testCaseId: testCase.id,
      version,
      title: testCase.title,
      description: testCase.description,
      module: testCase.module,
      category: testCase.category,
      priority: testCase.priority,
      severity: testCase.severity,
      preconditions: testCase.preconditions,
      testData: testCase.testData as Prisma.InputJsonValue,
      steps: testCase.steps as Prisma.InputJsonValue,
      expectedResult: testCase.expectedResult,
      postconditions: testCase.postconditions,
      source,
      createdById,
    },
  });
  await tx.testCase.update({ where: { id: testCase.id }, data: { currentVersion: version } });
  return snapshot;
}

/** Returns the newest snapshot, creating one first if the test case has never been versioned. */
export async function ensureLatestTestCaseVersion(testCase: TestCase, source: TestCaseVersionSource, createdById: string | null) {
  const existing = await prisma.testCaseVersion.findFirst({ where: { testCaseId: testCase.id }, orderBy: { version: "desc" } });
  if (existing) return existing;
  return prisma.$transaction(tx => snapshotTestCase(tx, testCase, source, createdById));
}

export async function ensureAutomationScript(testCaseId: string, projectId: string) {
  return prisma.automationScript.upsert({ where: { testCaseId }, update: {}, create: { testCaseId, projectId } });
}

export type AutomationVersionInput = {
  scriptId: string;
  testCaseVersionId: string;
  program: AutomationProgram;
  applicationUrl: string;
  source: "AI" | "USER_EDIT" | "HEALING";
  generationRunId?: string | null;
  healedFromVersionId?: string | null;
  provider?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  latencyMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  report?: ValidationReport;
};

/**
 * Creates the next immutable AutomationVersion. Always DRAFT: an approved version is only ever
 * produced by `approveAutomationVersion`, so generation and healing can never silently replace
 * what a reviewer approved.
 */
export async function createAutomationVersion(input: AutomationVersionInput) {
  const report = input.report ?? validateProgram(input.program);
  return prisma.$transaction(async tx => {
    // Serialize version numbering per script so two concurrent generations cannot collide.
    const script = await tx.automationScript.update({ where: { id: input.scriptId }, data: { latestVersion: { increment: 1 } } });
    return tx.automationVersion.create({
      data: {
        scriptId: script.id,
        version: script.latestVersion,
        testCaseVersionId: input.testCaseVersionId,
        generationRunId: input.generationRunId ?? null,
        program: input.program as unknown as Prisma.InputJsonValue,
        sourceCode: renderPlaywrightSpec(input.program, input.applicationUrl),
        programSchemaVersion: input.program.schemaVersion,
        status: "DRAFT",
        source: input.source,
        validationStatus: report.status,
        validationIssues: report.issues as unknown as Prisma.InputJsonValue,
        stepCount: input.program.steps.length,
        assertionCount: input.program.steps.filter(step => assertionActions.includes(step.action)).length,
        provider: input.provider ?? null,
        model: input.model ?? null,
        promptVersion: input.promptVersion ?? null,
        latencyMs: input.latencyMs ?? null,
        promptTokens: input.promptTokens ?? null,
        completionTokens: input.completionTokens ?? null,
        healedFromVersionId: input.healedFromVersionId ?? null,
      },
    });
  });
}

export class AutomationApprovalError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AutomationApprovalError";
  }
}

/**
 * Promotes a DRAFT version to APPROVED and marks the previously approved version SUPERSEDED.
 * A version that failed policy validation can never be approved, and history is never deleted.
 */
export async function approveAutomationVersion(versionId: string, approvedById: string) {
  return prisma.$transaction(async tx => {
    const version = await tx.automationVersion.findUnique({ where: { id: versionId }, include: { script: true } });
    if (!version) throw new AutomationApprovalError("NOT_FOUND", "Automation version not found");
    if (version.status !== "DRAFT") throw new AutomationApprovalError("NOT_APPROVABLE", `Only a DRAFT version can be approved; this version is ${version.status}`);
    if (version.validationStatus === "FAILED") throw new AutomationApprovalError("VALIDATION_FAILED", "This version failed policy validation and cannot be approved");

    const previousId = version.script.approvedVersionId;
    if (previousId && previousId !== version.id) {
      // Detach first: approvedVersionId is unique, so the new pointer cannot be set while the old one stands.
      await tx.automationScript.update({ where: { id: version.scriptId }, data: { approvedVersionId: null } });
      await tx.automationVersion.update({ where: { id: previousId }, data: { status: "SUPERSEDED" } });
    }
    const approved = await tx.automationVersion.update({ where: { id: version.id }, data: { status: "APPROVED", approvedAt: new Date(), approvedById } });
    await tx.automationScript.update({ where: { id: version.scriptId }, data: { approvedVersionId: approved.id } });
    return approved;
  });
}

export async function rejectAutomationVersion(versionId: string) {
  return prisma.$transaction(async tx => {
    const version = await tx.automationVersion.findUnique({ where: { id: versionId } });
    if (!version) throw new AutomationApprovalError("NOT_FOUND", "Automation version not found");
    if (version.status !== "DRAFT") throw new AutomationApprovalError("NOT_REJECTABLE", `Only a DRAFT version can be rejected; this version is ${version.status}`);
    return tx.automationVersion.update({ where: { id: version.id }, data: { status: "REJECTED" } });
  });
}
