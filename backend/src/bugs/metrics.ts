import type { BugPriority, BugSeverity, BugStatus } from "@prisma/client";
import { doneStatuses, isOpenStatus } from "./workflow";

/**
 * Bug-tracking metrics, computed from stored rows only. Pure, so every number on the tracking
 * dashboard can be checked by a unit test against hand-made data.
 *
 * Time-to-fix and time-to-verify come from the event history rather than the bug's own timestamps,
 * because reopening a bug clears `fixedAt` - the history is the only place every fix is remembered.
 */

export type MetricBug = { id: string; reference: string; title: string; status: BugStatus; severity: BugSeverity; priority: BugPriority; assigneeId: string | null; createdAt: Date; dueAt: Date | null; reopenCount: number };
export type MetricEvent = { bugId: string; fromValue: string | null; toValue: string | null; createdAt: Date };
export type MetricPerson = { id: string; name: string; team: string };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const priorities: BugPriority[] = ["P1", "P2", "P3", "P4"];
const severities: BugSeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const statuses: BugStatus[] = ["NEW", "ASSIGNED", "IN_PROGRESS", "FIXED", "READY_FOR_RETEST", "VERIFIED", "CLOSED", "REOPENED", "REJECTED", "DEFERRED", "DUPLICATE"];

export const agingBuckets = [
  { key: "lt1d", label: "< 1 day", maxDays: 1 },
  { key: "1to3d", label: "1–3 days", maxDays: 3 },
  { key: "3to7d", label: "3–7 days", maxDays: 7 },
  { key: "7to30d", label: "1–4 weeks", maxDays: 30 },
  { key: "gt30d", label: "> 4 weeks", maxDays: Infinity },
] as const;

export const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** The calendar day of `date` in the viewer's time zone, as YYYY-MM-DD. `tzOffsetMinutes` is `Date#getTimezoneOffset()`. */
export const localDay = (date: Date, tzOffsetMinutes: number) => new Date(date.getTime() - tzOffsetMinutes * 60_000).toISOString().slice(0, 10);

const round1 = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10);

export function computeMetrics(input: { bugs: MetricBug[]; events: MetricEvent[]; people: MetricPerson[]; now: Date; days: number; tzOffsetMinutes: number }) {
  const { bugs, events, people, now, days, tzOffsetMinutes } = input;
  const windowStart = new Date(now.getTime() - days * DAY);
  const open = bugs.filter(bug => isOpenStatus(bug.status));
  const created = new Map(bugs.map(bug => [bug.id, bug.createdAt]));

  // A bug is resolved when it first enters a done state from an open one. VERIFIED -> CLOSED is not
  // a second resolution, and a reopen followed by another verify is a genuine second one.
  const resolutions = events.filter(event => event.toValue && doneStatuses.includes(event.toValue as BugStatus) && !doneStatuses.includes(event.fromValue as BugStatus));
  const fixes = events.filter(event => event.toValue === "FIXED");
  const verifies = events.filter(event => event.toValue === "VERIFIED");

  /* -------------------------------------------------------------- headline numbers */
  const fixHours = fixes
    .filter(event => event.createdAt >= windowStart)
    .map(event => (event.createdAt.getTime() - (created.get(event.bugId)?.getTime() ?? event.createdAt.getTime())) / HOUR);
  // Retest time: from the latest fix before each verification to that verification.
  const verifyHours = verifies
    .filter(event => event.createdAt >= windowStart)
    .map(event => {
      const fix = fixes.filter(item => item.bugId === event.bugId && item.createdAt <= event.createdAt).at(-1);
      return fix ? (event.createdAt.getTime() - fix.createdAt.getTime()) / HOUR : null;
    })
    .filter((value): value is number => value !== null);
  const everFixed = new Set(fixes.map(event => event.bugId));
  const reopenedAfterFix = bugs.filter(bug => everFixed.has(bug.id) && bug.reopenCount > 0).length;

  const kpis = {
    open: open.length,
    openP1: open.filter(bug => bug.priority === "P1").length,
    openCritical: open.filter(bug => bug.severity === "CRITICAL").length,
    overdue: open.filter(bug => bug.dueAt && bug.dueAt < now).length,
    unassigned: open.filter(bug => !bug.assigneeId).length,
    inProgress: open.filter(bug => bug.status === "IN_PROGRESS").length,
    readyForRetest: open.filter(bug => bug.status === "READY_FOR_RETEST").length,
    createdInWindow: bugs.filter(bug => bug.createdAt >= windowStart).length,
    resolvedInWindow: resolutions.filter(event => event.createdAt >= windowStart).length,
    medianHoursToFix: round1(median(fixHours)),
    medianHoursToVerify: round1(median(verifyHours)),
    // Share of fixed bugs that came back. Null until anything has been fixed, never a made-up 0%.
    reopenRate: everFixed.size ? Math.round((reopenedAfterFix / everFixed.size) * 1000) / 10 : null,
  };

  /* -------------------------------------------------------------- created vs resolved, per local day */
  const trend: { day: string; created: number; resolved: number }[] = [];
  const index = new Map<string, number>();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = localDay(new Date(now.getTime() - offset * DAY), tzOffsetMinutes);
    if (index.has(day)) continue;
    index.set(day, trend.length);
    trend.push({ day, created: 0, resolved: 0 });
  }
  for (const bug of bugs) {
    const slot = index.get(localDay(bug.createdAt, tzOffsetMinutes));
    if (slot !== undefined && bug.createdAt >= windowStart) trend[slot].created += 1;
  }
  for (const event of resolutions) {
    const slot = index.get(localDay(event.createdAt, tzOffsetMinutes));
    if (slot !== undefined && event.createdAt >= windowStart) trend[slot].resolved += 1;
  }

  /* -------------------------------------------------------------- distributions */
  const byStatus = statuses.map(status => ({ status, count: bugs.filter(bug => bug.status === status).length }));
  const bySeverity = severities.map(severity => ({ severity, count: open.filter(bug => bug.severity === severity).length }));
  const byPriority = priorities.map(priority => ({ priority, count: open.filter(bug => bug.priority === priority).length }));

  const aging = agingBuckets.map((bucket, position) => {
    const min = position ? agingBuckets[position - 1].maxDays : 0;
    return { key: bucket.key, label: bucket.label, count: open.filter(bug => {
      const age = (now.getTime() - bug.createdAt.getTime()) / DAY;
      return age >= min && age < bucket.maxDays;
    }).length };
  });

  /* -------------------------------------------------------------- workload */
  const workloadFor = (assigneeId: string | null) => {
    const mine = open.filter(bug => bug.assigneeId === assigneeId);
    return {
      open: mine.length,
      byPriority: Object.fromEntries(priorities.map(priority => [priority, mine.filter(bug => bug.priority === priority).length])) as Record<BugPriority, number>,
      inProgress: mine.filter(bug => bug.status === "IN_PROGRESS").length,
      readyForRetest: mine.filter(bug => bug.status === "READY_FOR_RETEST").length,
      overdue: mine.filter(bug => bug.dueAt && bug.dueAt < now).length,
    };
  };
  const workload = [
    ...people.map(person => ({ id: person.id, name: person.name, team: person.team, ...workloadFor(person.id) })),
    { id: null, name: "Unassigned", team: null, ...workloadFor(null) },
  ]
    .filter(row => row.open > 0 || row.team === "DEVELOPER")
    .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));

  /* -------------------------------------------------------------- lists that need action */
  const brief = (bug: MetricBug) => ({ id: bug.id, reference: bug.reference, title: bug.title, status: bug.status, severity: bug.severity, priority: bug.priority, assigneeId: bug.assigneeId, dueAt: bug.dueAt, ageDays: Math.floor((now.getTime() - bug.createdAt.getTime()) / DAY) });
  const overdue = open.filter(bug => bug.dueAt && bug.dueAt < now).sort((a, b) => a.dueAt!.getTime() - b.dueAt!.getTime()).slice(0, 10).map(brief);
  const oldest = [...open].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, 10).map(brief);

  return { windowDays: days, generatedAt: now, kpis, trend, byStatus, bySeverity, byPriority, aging, workload, overdue, oldest };
}

export type BugMetrics = ReturnType<typeof computeMetrics>;
