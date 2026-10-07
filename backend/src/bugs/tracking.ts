import { Router } from "express";
import type { BugStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { route } from "../http";
import { requireAuth } from "../middleware/auth";
import { bugFilterSchema, bugWhere } from "./filters";
import { computeMetrics } from "./metrics";
import { allowedTransitions } from "./workflow";

/**
 * The board and the tracking dashboard - read-only views over the same bugs as the list. Every move
 * made from the board goes through POST /bugs/:id/transition, so the workflow rules are enforced in
 * exactly one place.
 *
 * Mounted before the bugs router: its `/bugs/:id` route validates the id as a UUID, and would answer
 * `/bugs/board` with 404 if it were matched first.
 */
export const trackingRouter = Router();

/** Columns, left to right, and the statuses each one shows. */
export const boardColumns: { key: string; label: string; statuses: BugStatus[] }[] = [
  { key: "NEW", label: "New", statuses: ["NEW"] },
  { key: "ASSIGNED", label: "Assigned", statuses: ["ASSIGNED", "REOPENED"] },
  { key: "IN_PROGRESS", label: "In progress", statuses: ["IN_PROGRESS"] },
  { key: "FIXED", label: "Fixed", statuses: ["FIXED"] },
  { key: "READY_FOR_RETEST", label: "Ready for retest", statuses: ["READY_FOR_RETEST"] },
  { key: "DONE", label: "Done", statuses: ["VERIFIED", "CLOSED"] },
  { key: "PARKED", label: "Parked", statuses: ["DEFERRED", "REJECTED", "DUPLICATE"] },
];
const finishedColumns = new Set(["DONE", "PARKED"]);

const boardSchema = bugFilterSchema.omit({ status: true }).extend({
  /** Finished and parked bugs stay on the board this long after their last change, then drop off. */
  doneDays: z.coerce.number().int().min(1).max(365).default(14),
});

const cardSelect = {
  id: true, reference: true, title: true, status: true, severity: true, priority: true, source: true, dueAt: true, createdAt: true, updatedAt: true, reopenCount: true, assigneeId: true, reportedById: true,
  project: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true } },
  _count: { select: { comments: true } },
} as const;

/** GET /api/v1/bugs/board — bugs grouped into workflow columns, each carrying the moves the viewer may make. */
trackingRouter.get("/bugs/board", requireAuth, route(async (request, response) => {
  const user = request.user!;
  const { doneDays, ...filters } = boardSchema.parse(request.query);
  const base = bugWhere({ ...filters, status: "ALL" }, user);
  const recent = new Date(Date.now() - doneDays * 86_400_000);
  const where: Prisma.BugWhereInput = {
    AND: [base, { OR: [{ status: { in: boardColumns.filter(column => !finishedColumns.has(column.key)).flatMap(column => column.statuses) } }, { updatedAt: { gte: recent } }] }],
  };
  const bugs = await prisma.bug.findMany({ where, select: cardSelect, orderBy: [{ priority: "asc" }, { severity: "asc" }, { updatedAt: "desc" }], take: 500 });
  const actor = { userId: user.id, role: user.role, team: user.team };
  return response.json({
    data: {
      columns: boardColumns.map(column => ({
        ...column,
        bugs: bugs.filter(bug => column.statuses.includes(bug.status)).map(({ reportedById, ...bug }) => ({ ...bug, allowedTransitions: allowedTransitions(actor, { status: bug.status, assigneeId: bug.assigneeId, reportedById }) })),
      })),
      doneDays,
      truncated: bugs.length === 500,
    },
  });
}));

const metricsSchema = bugFilterSchema.pick({ projectId: true, source: true }).extend({
  days: z.coerce.number().int().refine(value => [7, 14, 30, 90].includes(value), "days must be 7, 14, 30, or 90").default(30),
  /** `Date#getTimezoneOffset()` from the viewer's browser, so "today" means their today. */
  tz: z.coerce.number().int().min(-840).max(840).default(0),
});

/** GET /api/v1/bugs/metrics — the tracking dashboard: workload, flow, ageing, and time to fix. */
trackingRouter.get("/bugs/metrics", requireAuth, route(async (request, response) => {
  const user = request.user!;
  const input = metricsSchema.parse(request.query);
  const where = bugWhere({ status: "ALL", severity: "ALL", priority: "ALL", assignee: "ALL", source: input.source, projectId: input.projectId }, user);
  const [bugs, members] = await Promise.all([
    prisma.bug.findMany({ where, select: { id: true, reference: true, title: true, status: true, severity: true, priority: true, assigneeId: true, createdAt: true, dueAt: true, reopenCount: true } }),
    prisma.organizationMembership.findMany({ where: { organizationId: user.organizationId, role: { not: "VIEWER" } }, select: { team: true, user: { select: { id: true, name: true } } } }),
  ]);
  const events = bugs.length
    ? await prisma.bugEvent.findMany({ where: { bugId: { in: bugs.map(bug => bug.id) }, type: "STATUS_CHANGED" }, select: { bugId: true, fromValue: true, toValue: true, createdAt: true }, orderBy: { createdAt: "asc" } })
    : [];
  const metrics = computeMetrics({ bugs, events, people: members.map(member => ({ id: member.user.id, name: member.user.name, team: member.team })), now: new Date(), days: input.days, tzOffsetMinutes: input.tz });
  return response.json({ data: metrics });
}));
