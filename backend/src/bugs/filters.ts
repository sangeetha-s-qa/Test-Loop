import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { bugStatuses, doneStatuses } from "./workflow";

/**
 * One filter vocabulary for the bug list, the board, and the tracking dashboard, so "P1 bugs in
 * project X assigned to me" means the same rows on every screen.
 */

export const severities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
export const priorities = ["P1", "P2", "P3", "P4"] as const;

export const bugFilterSchema = z.object({
  status: z.union([z.enum(bugStatuses), z.literal("OPEN"), z.literal("DONE"), z.literal("ALL")]).default("ALL"),
  severity: z.enum([...severities, "ALL"]).default("ALL"),
  priority: z.enum([...priorities, "ALL"]).default("ALL"),
  /** A user id, "me", "unassigned", or "ALL". */
  assignee: z.string().max(40).default("ALL"),
  source: z.enum(["AUTOMATED", "MANUAL", "ALL"]).default("ALL"),
  projectId: z.string().uuid().optional(),
  q: z.string().trim().max(200).optional(),
});

export type BugFilter = z.infer<typeof bugFilterSchema>;

export function bugWhere(filters: BugFilter, user: { id: string; organizationId: string }): Prisma.BugWhereInput {
  const where: Prisma.BugWhereInput = { project: { organizationId: user.organizationId } };
  if (filters.status === "OPEN") where.status = { notIn: [...doneStatuses] };
  else if (filters.status === "DONE") where.status = { in: [...doneStatuses] };
  else if (filters.status !== "ALL") where.status = filters.status;
  if (filters.severity !== "ALL") where.severity = filters.severity;
  if (filters.priority !== "ALL") where.priority = filters.priority;
  if (filters.source !== "ALL") where.source = filters.source;
  if (filters.projectId) where.projectId = filters.projectId;
  if (filters.assignee === "me") where.assigneeId = user.id;
  else if (filters.assignee === "unassigned") where.assigneeId = null;
  else if (filters.assignee !== "ALL") where.assigneeId = z.string().uuid().parse(filters.assignee);
  if (filters.q) where.OR = [{ title: { contains: filters.q, mode: "insensitive" } }, { reference: { contains: filters.q, mode: "insensitive" } }];
  return where;
}
