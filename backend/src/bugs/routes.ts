import { Router, type Response } from "express";
import type { BugStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { fail, notFound, route, registerUuidParams } from "../http";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { duplicateCandidates } from "../analysis/bugs";
import { BugActionError, assignBug, commentOnBug, loadBug, raiseManualBug, transitionBug, updateTriage } from "./service";
import { bugFilterSchema, bugWhere, priorities, severities } from "./filters";
import { allowedTransitions, bugStatuses, doneStatuses } from "./workflow";

export const bugsRouter = Router();
// A malformed id must not reach Prisma's UUID cast and surface as a 500.
registerUuidParams(bugsRouter);

const actorOf = (request: AuthRequest) => ({ userId: request.user!.id, role: request.user!.role, team: request.user!.team, organizationId: request.user!.organizationId });

const handled = (response: Response, error: unknown) => {
  if (error instanceof BugActionError) return fail(response, error.status, error.code, error.message);
  throw error;
};

const person = { select: { id: true, name: true, email: true } } as const;

/* ------------------------------------------------------------------------------------------------
 * List
 * ---------------------------------------------------------------------------------------------- */

/** GET /api/v1/bugs — the organization's bugs, filterable by status group, triage, assignee, and source. */
bugsRouter.get("/bugs", requireAuth, route(async (request, response) => {
  const where = bugWhere(bugFilterSchema.parse(request.query), request.user!);
  const bugs = await prisma.bug.findMany({
    where,
    select: {
      id: true, reference: true, title: true, severity: true, priority: true, status: true, source: true, occurrenceCount: true, dueAt: true, lastSeenAt: true, createdAt: true, updatedAt: true,
      project: { select: { id: true, name: true } },
      testCase: { select: { id: true, testCaseId: true, title: true } },
      assignee: person,
      reportedBy: person,
      _count: { select: { comments: true } },
    },
    // Most urgent first: priority, then severity, then most recently touched.
    orderBy: [{ priority: "asc" }, { severity: "asc" }, { updatedAt: "desc" }],
    take: 300,
  });
  return response.json({ data: bugs });
}));

/* ------------------------------------------------------------------------------------------------
 * Detail and changes
 * ---------------------------------------------------------------------------------------------- */

/** GET /api/v1/bugs/:id — the bug, its evidence, history, comments, and the moves the viewer may make. */
bugsRouter.get("/bugs/:id", requireAuth, route(async (request, response) => {
  const actor = actorOf(request);
  const bug = await prisma.bug.findFirst({
    where: { id: request.params.id, project: { organizationId: actor.organizationId } },
    include: {
      project: { select: { id: true, name: true } },
      testCase: { select: { id: true, testCaseId: true, title: true, category: true, testRunId: true } },
      testRun: { select: { id: true, applicationUrl: true, testingMethod: true } },
      analysis: true,
      execution: { select: { id: true, status: true, browser: true, failureCategory: true, failureMessage: true, completedAt: true, artifacts: { select: { id: true, type: true, fileName: true, byteSize: true, contentType: true, checksumSha256: true, stepResultId: true, createdAt: true } } } },
      duplicateOf: { select: { id: true, reference: true, title: true, status: true } },
      duplicates: { select: { id: true, reference: true, title: true } },
      assignee: person,
      reportedBy: person,
      comments: { orderBy: { createdAt: "asc" }, include: { author: { select: { id: true, name: true } } } },
      events: { orderBy: { createdAt: "asc" }, include: { actor: { select: { id: true, name: true } } } },
    },
  });
  if (!bug) return notFound(response, "Bug not found");
  // A manual bug's evidence is the screenshots the tester attached to the failed case.
  const manualEvidence = bug.source === "MANUAL" && bug.testCaseId
    ? await prisma.manualEvidence.findMany({ where: { testCaseId: bug.testCaseId }, select: { id: true, testRunId: true, testCaseId: true, kind: true, source: true, fileName: true, contentType: true, byteSize: true, pageUrl: true, createdAt: true, uploadedBy: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } })
    : [];
  // History names people by id; resolve them once so the timeline can show names.
  const ids = [...new Set(bug.events.flatMap(event => (event.type === "ASSIGNED" || event.type === "UNASSIGNED" ? [event.fromValue, event.toValue] : [])).filter((value): value is string => Boolean(value)))];
  const people = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  return response.json({
    data: {
      ...bug,
      manualEvidence,
      people: Object.fromEntries(people.map(item => [item.id, item.name])),
      allowedTransitions: allowedTransitions(actor, bug),
      duplicateCandidates: await duplicateCandidates(bug.id, bug.projectId),
    },
  });
}));

const triageSchema = z
  .object({
    title: z.string().trim().min(3).max(300).optional(),
    description: z.string().max(5000).optional(),
    severity: z.enum(severities).optional(),
    priority: z.enum(priorities).optional(),
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

/** PATCH /api/v1/bugs/:id — title, description, and triage (severity, priority, due date). */
bugsRouter.patch("/bugs/:id", requireAuth, route(async (request, response) => {
  const actor = actorOf(request);
  const input = triageSchema.parse(request.body ?? {});
  const bug = await loadBug(request.params.id, actor.organizationId);
  if (!bug) return notFound(response, "Bug not found");
  try {
    const { dueAt, ...rest } = input;
    return response.json({ data: await updateTriage(bug, actor, { ...rest, ...(dueAt === undefined ? {} : { dueAt: dueAt ? new Date(dueAt) : null }) }) });
  } catch (error) {
    return handled(response, error);
  }
}));

/** POST /api/v1/bugs/:id/assign — `{ assigneeId }`, or null to unassign. Moves NEW/REOPENED bugs to ASSIGNED. */
bugsRouter.post("/bugs/:id/assign", requireAuth, route(async (request, response) => {
  const actor = actorOf(request);
  const { assigneeId } = z.object({ assigneeId: z.string().uuid().nullable() }).parse(request.body ?? {});
  const bug = await loadBug(request.params.id, actor.organizationId);
  if (!bug) return notFound(response, "Bug not found");
  try {
    return response.json({ data: await assignBug(bug, actor, assigneeId) });
  } catch (error) {
    return handled(response, error);
  }
}));

const transitionSchema = z.object({
  to: z.enum(bugStatuses),
  note: z.string().max(2000).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  resolution: z.string().max(2000).optional(),
  duplicateOfId: z.string().uuid().optional(),
});

/** POST /api/v1/bugs/:id/transition — one step of the lifecycle, validated by `workflow.ts`. */
bugsRouter.post("/bugs/:id/transition", requireAuth, route(async (request, response) => {
  const actor = actorOf(request);
  const input = transitionSchema.parse(request.body ?? {});
  const bug = await loadBug(request.params.id, actor.organizationId);
  if (!bug) return notFound(response, "Bug not found");
  try {
    return response.json({ data: await transitionBug(bug, actor, { ...input, to: input.to as BugStatus }) });
  } catch (error) {
    return handled(response, error);
  }
}));

/** POST /api/v1/bugs/:id/comments */
bugsRouter.post("/bugs/:id/comments", requireAuth, route(async (request, response) => {
  const actor = actorOf(request);
  const { body } = z.object({ body: z.string().trim().min(1).max(5000) }).parse(request.body ?? {});
  const bug = await loadBug(request.params.id, actor.organizationId);
  if (!bug) return notFound(response, "Bug not found");
  try {
    return response.status(201).json({ data: await commentOnBug(bug, actor, body) });
  } catch (error) {
    return handled(response, error);
  }
}));

/* ------------------------------------------------------------------------------------------------
 * Raising bugs from manual testing
 * ---------------------------------------------------------------------------------------------- */

const raiseSchema = z.object({
  title: z.string().trim().min(3).max(300).optional(),
  severity: z.enum(severities).optional(),
  priority: z.enum(priorities).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
});

/** POST /api/v1/manual-runs/:id/test-cases/:caseId/bug — raise (or return the existing) bug for a failed case. */
bugsRouter.post("/manual-runs/:id/test-cases/:caseId/bug", requireAuth, route(async (request, response) => {
  const actor = actorOf(request);
  const input = raiseSchema.parse(request.body ?? {});
  const owned = await prisma.testCase.findFirst({ where: { id: request.params.caseId, testRunId: request.params.id, testRun: { project: { organizationId: actor.organizationId } } }, select: { id: true } });
  if (!owned) return notFound(response, "Test case not found");
  try {
    const result = await raiseManualBug({ testCaseId: owned.id, organizationId: actor.organizationId, actor, ...input });
    return response.status(result.created ? 201 : 200).json({ data: result.bug, created: result.created });
  } catch (error) {
    return handled(response, error);
  }
}));

/** POST /api/v1/manual-runs/:id/bugs — raise bugs for every failed case in the run that has none yet. */
bugsRouter.post("/manual-runs/:id/bugs", requireAuth, route(async (request, response) => {
  const actor = actorOf(request);
  const input = raiseSchema.omit({ title: true }).parse(request.body ?? {});
  const run = await prisma.testRun.findFirst({ where: { id: request.params.id, testingMethod: "MANUAL", project: { organizationId: actor.organizationId } }, select: { id: true } });
  if (!run) return notFound(response, "Manual test run not found");
  const failed = await prisma.testCase.findMany({ where: { testRunId: run.id, manualStatus: "FAILED", bugs: { none: {} } }, select: { id: true }, orderBy: { testCaseId: "asc" } });
  const created = [];
  try {
    // Sequential on purpose: each bug takes the next reference number in its project.
    for (const testCase of failed) created.push((await raiseManualBug({ testCaseId: testCase.id, organizationId: actor.organizationId, actor, ...input })).bug);
  } catch (error) {
    return handled(response, error);
  }
  return response.status(201).json({ data: created });
}));

/* ------------------------------------------------------------------------------------------------
 * People a bug can be assigned to
 * ---------------------------------------------------------------------------------------------- */

/** GET /api/v1/team/assignees — current non-viewer members, developers first, with their open-bug load. */
bugsRouter.get("/team/assignees", requireAuth, route(async (request, response) => {
  const organizationId = request.user!.organizationId;
  const members = await prisma.organizationMembership.findMany({ where: { organizationId, role: { not: "VIEWER" } }, include: { user: { select: { id: true, name: true, email: true } } } });
  const load = await prisma.bug.groupBy({ by: ["assigneeId"], where: { project: { organizationId }, assigneeId: { in: members.map(member => member.userId) }, status: { notIn: [...doneStatuses] } }, _count: { _all: true } });
  const openByUser = new Map(load.map(row => [row.assigneeId, row._count._all]));
  const order = ["DEVELOPER", "QA", "PRODUCT", "DESIGN", "OTHER"];
  return response.json({
    data: members
      .map(member => ({ id: member.user.id, name: member.user.name, email: member.user.email, team: member.team, role: member.role, openBugs: openByUser.get(member.userId) ?? 0 }))
      .sort((a, b) => order.indexOf(a.team) - order.indexOf(b.team) || a.name.localeCompare(b.name)),
  });
}));
