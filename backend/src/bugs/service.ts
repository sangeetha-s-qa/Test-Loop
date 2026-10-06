import type { BugPriority, BugSeverity, BugStatus, Prisma } from "@prisma/client";
import { prisma } from "../db";
import { notify } from "../notifications/service";
import { checkTransition, statusLabels, transitionEffects, type Actor, type TransitionInput } from "./workflow";

/**
 * Bug changes. Every write records a BugEvent and the notifications it causes in the same
 * transaction, so the history and the bell can never disagree with the bug itself.
 */

export class BugActionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "BugActionError";
  }
}

type LoadedBug = NonNullable<Awaited<ReturnType<typeof loadBug>>>;

export async function loadBug(id: string, organizationId: string) {
  return prisma.bug.findFirst({ where: { id, project: { organizationId } }, select: { id: true, reference: true, title: true, status: true, assigneeId: true, reportedById: true, projectId: true, severity: true, priority: true, dueAt: true } });
}

/** An assignee must be a current, non-viewer member of the bug's workspace. */
async function assertAssignable(userId: string, organizationId: string) {
  const membership = await prisma.organizationMembership.findUnique({ where: { userId_organizationId: { userId, organizationId } }, select: { role: true } });
  if (!membership) throw new BugActionError("ASSIGNEE_NOT_MEMBER", "That person is not a member of this workspace.", 422);
  if (membership.role === "VIEWER") throw new BugActionError("ASSIGNEE_IS_VIEWER", "Viewers cannot be assigned bugs. Change their role first.", 422);
}

const label = (bug: { reference: string; title: string }) => `${bug.reference} · ${bug.title}`.slice(0, 200);

export async function transitionBug(bug: LoadedBug, actor: Actor & { organizationId: string }, input: TransitionInput) {
  const verdict = checkTransition(actor, bug, input);
  if (!verdict.ok) throw new BugActionError(verdict.code, verdict.message, verdict.status);
  if (input.to === "ASSIGNED" && input.assigneeId) await assertAssignable(input.assigneeId, actor.organizationId);
  if (input.to === "DUPLICATE") {
    if (input.duplicateOfId === bug.id) throw new BugActionError("SELF_DUPLICATE", "A bug cannot be a duplicate of itself.", 422);
    const target = await prisma.bug.findFirst({ where: { id: input.duplicateOfId!, projectId: bug.projectId }, select: { id: true } });
    if (!target) throw new BugActionError("DUPLICATE_TARGET_NOT_FOUND", "The duplicate target is not a bug in this project.", 422);
  }

  const now = new Date();
  const effects = transitionEffects(bug, input, now);
  const newAssignee = "assigneeId" in effects ? effects.assigneeId : bug.assigneeId;
  return prisma.$transaction(async tx => {
    // Guarded on the status we checked, so two people racing on the same bug cannot both win.
    const { count } = await tx.bug.updateMany({ where: { id: bug.id, status: bug.status }, data: { status: input.to, ...effects } });
    if (!count) throw new BugActionError("BUG_CHANGED", "Someone else just changed this bug. Reload and try again.", 409);
    const note = [input.resolution?.trim() && `Fix: ${input.resolution.trim()}`, input.note?.trim()].filter(Boolean).join("\n") || null;
    await tx.bugEvent.create({ data: { bugId: bug.id, actorId: actor.userId, type: "STATUS_CHANGED", fromValue: bug.status, toValue: input.to, note } });
    if (newAssignee !== bug.assigneeId) {
      await tx.bugEvent.create({ data: { bugId: bug.id, actorId: actor.userId, type: newAssignee ? "ASSIGNED" : "UNASSIGNED", fromValue: bug.assigneeId, toValue: newAssignee } });
      if (newAssignee) await notify(tx, { organizationId: actor.organizationId, actorId: actor.userId, recipients: [newAssignee], type: "BUG_ASSIGNED", bugId: bug.id, title: `Assigned to you: ${label(bug)}` });
    }
    // Who hears about a status change depends on whose turn it now is.
    const others = { organizationId: actor.organizationId, actorId: actor.userId, bugId: bug.id };
    if (input.to === "READY_FOR_RETEST") await notify(tx, { ...others, recipients: [bug.reportedById], type: "BUG_READY_FOR_RETEST", title: `Ready for retest: ${label(bug)}`, body: input.resolution ?? "" });
    else if (input.to === "REOPENED") await notify(tx, { ...others, recipients: [newAssignee, bug.reportedById], type: "BUG_REOPENED", title: `Reopened: ${label(bug)}`, body: input.note ?? "" });
    else if (input.to !== "ASSIGNED") await notify(tx, { ...others, recipients: [newAssignee, bug.reportedById], type: "BUG_STATUS_CHANGED", title: `${statusLabels[input.to]}: ${label(bug)}`, body: note ?? "" });
    return tx.bug.findUniqueOrThrow({ where: { id: bug.id } });
  });
}

/**
 * Assigns or unassigns without the caller having to know the lifecycle: assigning a NEW or REOPENED
 * bug moves it to ASSIGNED, and clearing the assignee of an ASSIGNED bug moves it back to NEW.
 * Reassigning work already in progress keeps its status.
 */
export async function assignBug(bug: LoadedBug, actor: Actor & { organizationId: string }, assigneeId: string | null) {
  // A reopened bug usually keeps its developer, so assigning it - even to the same person - is what
  // hands it back to them; it must still move to ASSIGNED.
  if (["NEW", "REOPENED"].includes(bug.status) && assigneeId) return transitionBug(bug, actor, { to: "ASSIGNED", assigneeId });
  if (assigneeId === bug.assigneeId) return prisma.bug.findUniqueOrThrow({ where: { id: bug.id } });
  if (bug.status === "ASSIGNED" && !assigneeId) return transitionBug(bug, actor, { to: "NEW" });

  const reassignable: BugStatus[] = ["ASSIGNED", "IN_PROGRESS", "DEFERRED"];
  if (!reassignable.includes(bug.status)) throw new BugActionError("NOT_REASSIGNABLE", `A ${statusLabels[bug.status].toLowerCase()} bug cannot be reassigned. Reopen it first.`);
  if (actor.role === "VIEWER" || (actor.team === "DEVELOPER" && actor.role !== "OWNER" && actor.role !== "ADMIN")) throw new BugActionError("FORBIDDEN", "Only QA, product, or workspace admins can reassign bugs.", 403);
  if (!assigneeId) throw new BugActionError("ASSIGNEE_REQUIRED", "Work in progress needs an assignee. Move it back to New to unassign it.", 422);
  await assertAssignable(assigneeId, actor.organizationId);

  return prisma.$transaction(async tx => {
    const { count } = await tx.bug.updateMany({ where: { id: bug.id, assigneeId: bug.assigneeId, status: bug.status }, data: { assigneeId } });
    if (!count) throw new BugActionError("BUG_CHANGED", "Someone else just changed this bug. Reload and try again.", 409);
    await tx.bugEvent.create({ data: { bugId: bug.id, actorId: actor.userId, type: "ASSIGNED", fromValue: bug.assigneeId, toValue: assigneeId } });
    await notify(tx, { organizationId: actor.organizationId, actorId: actor.userId, recipients: [assigneeId], type: "BUG_ASSIGNED", bugId: bug.id, title: `Assigned to you: ${label(bug)}` });
    return tx.bug.findUniqueOrThrow({ where: { id: bug.id } });
  });
}

/** Triage fields. Developers may not change severity or priority; only QA, product, and managers triage. */
export async function updateTriage(bug: LoadedBug, actor: Actor & { organizationId: string }, input: { title?: string; description?: string; severity?: BugSeverity; priority?: BugPriority; dueAt?: Date | null }) {
  if (actor.role === "VIEWER") throw new BugActionError("FORBIDDEN", "Viewers cannot change bugs.", 403);
  const triaging = input.severity !== undefined || input.priority !== undefined || input.dueAt !== undefined;
  if (triaging && actor.team === "DEVELOPER" && actor.role !== "OWNER" && actor.role !== "ADMIN") throw new BugActionError("FORBIDDEN", "Severity, priority, and due date are set by QA, product, or workspace admins.", 403);

  const events: Prisma.BugEventCreateManyInput[] = [];
  if (input.severity && input.severity !== bug.severity) events.push({ bugId: bug.id, actorId: actor.userId, type: "SEVERITY_CHANGED", fromValue: bug.severity, toValue: input.severity });
  if (input.priority && input.priority !== bug.priority) events.push({ bugId: bug.id, actorId: actor.userId, type: "PRIORITY_CHANGED", fromValue: bug.priority, toValue: input.priority });
  if (input.dueAt !== undefined && (input.dueAt?.getTime() ?? null) !== (bug.dueAt?.getTime() ?? null)) events.push({ bugId: bug.id, actorId: actor.userId, type: "DUE_DATE_CHANGED", fromValue: bug.dueAt?.toISOString() ?? null, toValue: input.dueAt?.toISOString() ?? null });

  return prisma.$transaction(async tx => {
    const updated = await tx.bug.update({ where: { id: bug.id }, data: input });
    if (events.length) await tx.bugEvent.createMany({ data: events });
    // A priority or severity change on someone's bug is worth telling them about.
    if (events.some(event => event.type !== "DUE_DATE_CHANGED")) await notify(tx, { organizationId: actor.organizationId, actorId: actor.userId, recipients: [bug.assigneeId], type: "BUG_STATUS_CHANGED", bugId: bug.id, title: `Re-triaged: ${label(bug)}`, body: `Severity ${updated.severity}, priority ${updated.priority}` });
    return updated;
  });
}

export async function commentOnBug(bug: LoadedBug, actor: Actor & { organizationId: string }, body: string) {
  if (actor.role === "VIEWER") throw new BugActionError("FORBIDDEN", "Viewers cannot comment on bugs.", 403);
  return prisma.$transaction(async tx => {
    const comment = await tx.bugComment.create({ data: { bugId: bug.id, authorId: actor.userId, body }, include: { author: { select: { id: true, name: true } } } });
    await tx.bugEvent.create({ data: { bugId: bug.id, actorId: actor.userId, type: "COMMENTED" } });
    const earlier = await tx.bugComment.findMany({ where: { bugId: bug.id }, select: { authorId: true }, distinct: ["authorId"] });
    await notify(tx, { organizationId: actor.organizationId, actorId: actor.userId, recipients: [bug.assigneeId, bug.reportedById, ...earlier.map(item => item.authorId)], type: "BUG_COMMENTED", bugId: bug.id, title: `New comment on ${label(bug)}`, body: body.slice(0, 300) });
    return comment;
  });
}

const severityFromPriority: Record<string, BugSeverity> = { CRITICAL: "CRITICAL", HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW" };

/**
 * Raises a bug from a FAILED manual test case. One bug per case: raising again returns the
 * existing one rather than a duplicate. The tester's actual result and notes become the bug's
 * actual behaviour, and the case's screenshots stay attached through the case itself.
 */
export async function raiseManualBug(input: { testCaseId: string; organizationId: string; actor: Actor; title?: string; severity?: BugSeverity; priority?: BugPriority; assigneeId?: string | null }) {
  const testCase = await prisma.testCase.findFirst({
    where: { id: input.testCaseId, testRun: { testingMethod: "MANUAL", project: { organizationId: input.organizationId } } },
    include: { testRun: { select: { id: true, projectId: true, applicationUrl: true, configuration: true } } },
  });
  if (!testCase) throw new BugActionError("NOT_FOUND", "Test case not found", 404);
  if (testCase.manualStatus !== "FAILED") throw new BugActionError("CASE_NOT_FAILED", "A bug can only be raised from a test case marked Failed.", 409);
  if (input.actor.role === "VIEWER") throw new BugActionError("FORBIDDEN", "Viewers cannot raise bugs.", 403);
  if (input.assigneeId) await assertAssignable(input.assigneeId, input.organizationId);

  const fingerprint = `manual:${testCase.id}`;
  const existing = await prisma.bug.findUnique({ where: { projectId_fingerprint: { projectId: testCase.testRun.projectId, fingerprint } } });
  if (existing) return { bug: existing, created: false };

  const steps = (testCase.steps as { step: number; action: string; expectedResult?: string }[]).map(step => ({ step: step.step, action: step.action, description: step.expectedResult ?? "", status: "" }));
  const settings = testCase.testRun.configuration as { browser?: string; viewport?: string };
  return prisma.$transaction(async tx => {
    const count = await tx.bug.count({ where: { projectId: testCase.testRun.projectId } });
    const bug = await tx.bug.create({
      data: {
        projectId: testCase.testRun.projectId,
        testCaseId: testCase.id,
        testRunId: testCase.testRun.id,
        source: "MANUAL",
        reference: `BUG-${String(count + 1).padStart(4, "0")}`,
        title: (input.title?.trim() || `${testCase.title} - failed`).slice(0, 300),
        description: [testCase.testerNotes, `Found while executing ${testCase.testCaseId} (${testCase.category}) on ${testCase.testRun.applicationUrl}${settings.browser ? ` in ${settings.browser}${settings.viewport ? ` · ${settings.viewport}` : ""}` : ""}.`, testCase.preconditions ? `Preconditions: ${testCase.preconditions}` : ""].filter(Boolean).join("\n\n").slice(0, 5000),
        stepsToReproduce: steps as unknown as Prisma.InputJsonValue,
        expectedBehavior: testCase.expectedResult.slice(0, 2000),
        actualBehavior: testCase.actualResult.slice(0, 2000),
        severity: input.severity ?? severityFromPriority[testCase.priority] ?? "MEDIUM",
        priority: input.priority ?? "P3",
        fingerprint,
        reportedById: input.actor.userId,
        status: input.assigneeId ? "ASSIGNED" : "NEW",
        assigneeId: input.assigneeId ?? null,
      },
    });
    await tx.bugEvent.create({ data: { bugId: bug.id, actorId: input.actor.userId, type: "CREATED", toValue: bug.status, note: `Raised from manual test case ${testCase.testCaseId}` } });
    if (bug.assigneeId) {
      await tx.bugEvent.create({ data: { bugId: bug.id, actorId: input.actor.userId, type: "ASSIGNED", toValue: bug.assigneeId } });
      await notify(tx, { organizationId: input.organizationId, actorId: input.actor.userId, recipients: [bug.assigneeId], type: "BUG_ASSIGNED", bugId: bug.id, title: `Assigned to you: ${label(bug)}`, body: `Severity ${bug.severity}, priority ${bug.priority}` });
    }
    return { bug, created: true };
  });
}
