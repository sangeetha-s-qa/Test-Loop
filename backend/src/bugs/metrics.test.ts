import { describe, expect, it } from "vitest";
import { computeMetrics, localDay, median, type MetricBug, type MetricEvent } from "./metrics";

const now = new Date("2026-10-07T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
const bug = (id: string, overrides: Partial<MetricBug> = {}): MetricBug => ({ id, reference: `BUG-${id}`, title: `Bug ${id}`, status: "NEW", severity: "MEDIUM", priority: "P3", assigneeId: null, createdAt: hoursAgo(10), dueAt: null, reopenCount: 0, ...overrides });
const event = (bugId: string, fromValue: string, toValue: string, hours: number): MetricEvent => ({ bugId, fromValue, toValue, createdAt: hoursAgo(hours) });
const people = [{ id: "dana", name: "Dana", team: "DEVELOPER" }, { id: "ravi", name: "Ravi", team: "DEVELOPER" }, { id: "quinn", name: "Quinn", team: "QA" }];

describe("bug metrics", () => {
  const bugs = [
    bug("1", { status: "IN_PROGRESS", priority: "P1", severity: "CRITICAL", assigneeId: "dana", createdAt: hoursAgo(50), dueAt: hoursAgo(5) }),
    bug("2", { status: "READY_FOR_RETEST", priority: "P2", assigneeId: "dana", createdAt: hoursAgo(30) }),
    bug("3", { status: "CLOSED", assigneeId: "ravi", createdAt: hoursAgo(100), reopenCount: 1 }),
    bug("4", { status: "NEW", createdAt: hoursAgo(24 * 40) }),
    bug("5", { status: "VERIFIED", assigneeId: "ravi", createdAt: hoursAgo(20) }),
  ];
  const events = [
    event("2", "IN_PROGRESS", "FIXED", 20), // fixed 10h after creation
    event("2", "FIXED", "READY_FOR_RETEST", 19),
    event("3", "IN_PROGRESS", "FIXED", 90), // 10h after creation
    event("3", "READY_FOR_RETEST", "REOPENED", 80),
    event("3", "IN_PROGRESS", "FIXED", 70), // 30h after creation
    event("3", "READY_FOR_RETEST", "VERIFIED", 60), // retest 10h after the latest fix
    event("3", "VERIFIED", "CLOSED", 50), // not a second resolution
    event("5", "IN_PROGRESS", "FIXED", 14), // 6h after creation
    event("5", "READY_FOR_RETEST", "VERIFIED", 12), // retest 2h
  ];
  const metrics = computeMetrics({ bugs, events, people, now, days: 7, tzOffsetMinutes: 0 });

  it("counts the headline numbers from open bugs only", () => {
    expect(metrics.kpis).toMatchObject({ open: 3, openP1: 1, openCritical: 1, overdue: 1, unassigned: 1, inProgress: 1, readyForRetest: 1 });
  });

  it("counts a resolution once per close-out, not VERIFIED and CLOSED twice", () => {
    expect(metrics.kpis.resolvedInWindow).toBe(2);
    expect(metrics.kpis.createdInWindow).toBe(4);
  });

  it("takes time to fix and time to retest from the history", () => {
    expect(metrics.kpis.medianHoursToFix).toBe(10); // 10, 10, 30, 6 -> median 10
    expect(metrics.kpis.medianHoursToVerify).toBe(6); // 10 and 2 -> median 6
    expect(metrics.kpis.reopenRate).toBe(33.3); // 1 of 3 fixed bugs reopened
  });

  it("builds one trend point per day and puts each event on its local day", () => {
    expect(metrics.trend).toHaveLength(7);
    expect(metrics.trend.reduce((sum, point) => sum + point.resolved, 0)).toBe(2);
    expect(localDay(new Date("2026-10-06T20:00:00Z"), -330)).toBe("2026-10-07"); // IST, after midnight locally
  });

  it("buckets open bugs by age and per-person workload by priority", () => {
    expect(metrics.aging.find(bucket => bucket.key === "gt30d")!.count).toBe(1);
    expect(metrics.aging.find(bucket => bucket.key === "1to3d")!.count).toBe(2);
    const dana = metrics.workload.find(row => row.id === "dana")!;
    expect(dana).toMatchObject({ open: 2, inProgress: 1, readyForRetest: 1, overdue: 1, byPriority: { P1: 1, P2: 1, P3: 0, P4: 0 } });
    // Ravi has no open bugs but is a developer, so he still appears with zero load; QA with none does not.
    expect(metrics.workload.find(row => row.id === "ravi")!.open).toBe(0);
    expect(metrics.workload.some(row => row.id === "quinn")).toBe(false);
    expect(metrics.workload.find(row => row.id === null)!.open).toBe(1);
  });

  it("lists overdue and oldest open bugs", () => {
    expect(metrics.overdue.map(item => item.id)).toEqual(["1"]);
    expect(metrics.oldest[0].id).toBe("4");
  });

  it("reports nothing rather than zero when there is no data", () => {
    const empty = computeMetrics({ bugs: [], events: [], people: [], now, days: 30, tzOffsetMinutes: 0 });
    expect(empty.kpis).toMatchObject({ open: 0, medianHoursToFix: null, medianHoursToVerify: null, reopenRate: null });
    expect(median([])).toBeNull();
  });
});
