"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, CalendarClock, Hourglass, RotateCcw, UserX } from "lucide-react";
import { BugStatusBadge, PriorityBadge } from "@/components/bugs/badges";
import { BugViewsNav } from "@/components/bugs/transition-dialog";
import { BarChart, ChartCard, ColumnChart, Legend, LineChart, StatTile, vizColors } from "@/components/charts";
import { Shell } from "@/components/shell";
import { ErrorState, LoadingState } from "@/components/states";
import { api, type Project } from "@/lib/api";
import { bugStatusMeta, priorityMeta, severityMeta, teamLabels, type BugPriority, type BugSeverity, type BugStatus, type TeamFunction } from "@/lib/bugs";
import { useResource } from "@/lib/use-resource";

type Brief = { id: string; reference: string; title: string; status: BugStatus; severity: BugSeverity; priority: BugPriority; assigneeId: string | null; dueAt: string | null; ageDays: number };
type Metrics = {
  windowDays: number;
  kpis: { open: number; openP1: number; openCritical: number; overdue: number; unassigned: number; inProgress: number; readyForRetest: number; createdInWindow: number; resolvedInWindow: number; medianHoursToFix: number | null; medianHoursToVerify: number | null; reopenRate: number | null };
  trend: { day: string; created: number; resolved: number }[];
  byStatus: { status: BugStatus; count: number }[];
  bySeverity: { severity: BugSeverity; count: number }[];
  byPriority: { priority: BugPriority; count: number }[];
  aging: { key: string; label: string; count: number }[];
  workload: { id: string | null; name: string; team: TeamFunction | null; open: number; byPriority: Record<BugPriority, number>; inProgress: number; readyForRetest: number; overdue: number }[];
  overdue: Brief[];
  oldest: Brief[];
};

const select = "rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm";
/** Minutes under an hour, hours under two days, then days - so a quick fix never reads as "0.0 h". */
const duration = (hours: number | null) => {
  if (hours === null) return "—";
  if (hours < 1 / 60) return "< 1 min";
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  return hours < 48 ? `${hours.toFixed(1)} h` : `${(hours / 24).toFixed(1)} d`;
};
const shortDay = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function BriefList({ items, empty, detail }: { items: Brief[]; empty: string; detail: (item: Brief) => string }) {
  if (!items.length) return <p className="py-6 text-center text-sm text-slate-500">{empty}</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {items.map(item => (
        <li key={item.id}>
          <Link href={`/bugs/${item.id}`} className="flex items-center gap-2 py-2 text-sm hover:bg-slate-50">
            <span className="font-mono text-xs font-bold text-violet-700">{item.reference}</span>
            <PriorityBadge priority={item.priority} />
            <span className="min-w-0 flex-1 truncate text-slate-800">{item.title}</span>
            <BugStatusBadge status={item.status} />
            <span className="w-24 shrink-0 text-right text-xs text-slate-500">{detail(item)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function TrackingPage() {
  const [filters, setFilters] = useState({ days: "30", projectId: "", source: "ALL" });
  const projects = useResource(() => api.get<Project[]>("/api/v1/projects"), []);
  const [tz] = useState(() => new Date().getTimezoneOffset());
  const query = new URLSearchParams({ days: filters.days, source: filters.source, tz: String(tz), ...(filters.projectId ? { projectId: filters.projectId } : {}) }).toString();
  const metrics = useResource(() => api.get<Metrics>(`/api/v1/bugs/metrics?${query}`), [query], { intervalMs: 60_000, shouldPoll: () => true });
  const set = (key: keyof typeof filters, value: string) => setFilters(current => ({ ...current, [key]: value }));
  const priorityKeys = (Object.keys(priorityMeta) as BugPriority[]).map(key => ({ key, label: `${key} · ${priorityMeta[key].detail}`, color: vizColors.priority[key] }));

  return (
    <Shell title="Bug tracking" subtitle="Where the bugs are, who has them, and how fast they move" actions={<BugViewsNav current="tracking" />}>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <select aria-label="Time window" value={filters.days} onChange={event => set("days", event.target.value)} className={select}>
          {["7", "14", "30", "90"].map(days => <option key={days} value={days}>Last {days} days</option>)}
        </select>
        <select aria-label="Project" value={filters.projectId} onChange={event => set("projectId", event.target.value)} className={select}>
          <option value="">All projects</option>
          {projects.data?.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <select aria-label="Source" value={filters.source} onChange={event => set("source", event.target.value)} className={select}>
          <option value="ALL">Manual and automated</option>
          <option value="MANUAL">Manual testing</option>
          <option value="AUTOMATED">Automated runs</option>
        </select>
        {metrics.data && <span className="ml-auto text-xs text-slate-400">Updates every minute</span>}
      </div>

      {metrics.loading ? (
        <LoadingState label="Calculating" />
      ) : metrics.error || !metrics.data ? (
        <ErrorState error={metrics.error ?? new Error("Metrics unavailable")} retry={metrics.reload} />
      ) : (
        (() => {
          const data = metrics.data;
          const k = data.kpis;
          return (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <div className="rounded-xl border border-slate-200 bg-[#111c38] px-4 py-3 text-white sm:row-span-2">
                  <p className="text-xs font-medium text-slate-300">Open bugs</p>
                  <p className="mt-1 font-display text-5xl font-bold tabular-nums">{k.open}</p>
                  <p className="mt-2 text-xs text-slate-300">{k.inProgress} in progress · {k.readyForRetest} waiting for retest</p>
                  <p className="mt-1 text-xs text-slate-300">{k.createdInWindow} raised · {k.resolvedInWindow} resolved in {data.windowDays} days</p>
                </div>
                <StatTile label="P1 open" value={String(k.openP1)} tone={k.openP1 ? "critical" : "default"} icon={k.openP1 ? <AlertTriangle size={12} className="text-rose-600" /> : undefined} note="Urgent - fix now" />
                <StatTile label="Critical severity open" value={String(k.openCritical)} tone={k.openCritical ? "critical" : "default"} icon={k.openCritical ? <AlertTriangle size={12} className="text-rose-600" /> : undefined} />
                <StatTile label="Overdue" value={String(k.overdue)} tone={k.overdue ? "critical" : "default"} icon={<CalendarClock size={12} className={k.overdue ? "text-rose-600" : ""} />} note="Past due date, still open" />
                <StatTile label="Unassigned" value={String(k.unassigned)} tone={k.unassigned ? "warning" : "default"} icon={<UserX size={12} className={k.unassigned ? "text-amber-600" : ""} />} note="Open with no owner" />
                <StatTile label="Median time to fix" value={duration(k.medianHoursToFix)} icon={<Hourglass size={12} />} note="Raised → marked fixed" />
                <StatTile label="Median time to retest" value={duration(k.medianHoursToVerify)} icon={<Hourglass size={12} />} note="Fixed → verified by QA" />
                <StatTile label="Reopen rate" value={k.reopenRate === null ? "—" : `${k.reopenRate}%`} tone={k.reopenRate && k.reopenRate > 20 ? "warning" : "default"} icon={<RotateCcw size={12} />} note="Fixed bugs that came back" />
                <StatTile label="Ready for retest" value={String(k.readyForRetest)} note="Waiting on QA" />
              </div>

              <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
                <ChartCard
                  title="Raised vs resolved"
                  subtitle={`Per day, last ${data.windowDays} days. Resolved = verified, closed, rejected, or marked duplicate.`}
                  legend={<Legend items={[{ label: "Raised", color: vizColors.series1 }, { label: "Resolved", color: vizColors.series2 }]} />}
                  table={{ columns: ["Day", "Raised", "Resolved"], rows: data.trend.map(point => [shortDay(point.day), point.created, point.resolved]) }}
                >
                  <LineChart labels={data.trend.map(point => point.day)} formatLabel={shortDay} series={[{ key: "created", label: "Raised", color: vizColors.series1, values: data.trend.map(point => point.created) }, { key: "resolved", label: "Resolved", color: vizColors.series2, values: data.trend.map(point => point.resolved) }]} />
                </ChartCard>

                <ChartCard title="Open bugs by age" subtitle="How long open bugs have been waiting" table={{ columns: ["Age", "Open bugs"], rows: data.aging.map(bucket => [bucket.label, bucket.count]) }}>
                  <ColumnChart rows={data.aging.map(bucket => ({ label: bucket.label, value: bucket.count }))} />
                </ChartCard>
              </div>

              <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
                <ChartCard
                  title="Workload by person"
                  subtitle="Open bugs each person holds, by priority. Developers with none are shown too."
                  legend={<Legend items={priorityKeys} />}
                  table={{ columns: ["Person", "Team", "Open", "P1", "P2", "P3", "P4", "In progress", "Retest", "Overdue"], rows: data.workload.map(row => [row.name, row.team ? teamLabels[row.team] : "—", row.open, row.byPriority.P1, row.byPriority.P2, row.byPriority.P3, row.byPriority.P4, row.inProgress, row.readyForRetest, row.overdue]) }}
                >
                  {data.workload.length ? (
                    <BarChart keys={priorityKeys} rows={data.workload.map(row => ({ label: row.name, values: row.byPriority }))} />
                  ) : (
                    <p className="py-6 text-center text-sm text-slate-500">No open bugs.</p>
                  )}
                </ChartCard>

                <ChartCard title="Open bugs by severity" subtitle="Technical impact of what is still open" table={{ columns: ["Severity", "Open"], rows: data.bySeverity.map(row => [severityMeta[row.severity].label, row.count]) }}>
                  <BarChart rows={data.bySeverity.map(row => ({ label: severityMeta[row.severity].label, values: { value: row.count } }))} />
                </ChartCard>
              </div>

              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <ChartCard title="All bugs by status" subtitle="Every bug in scope, open and finished" table={{ columns: ["Status", "Bugs"], rows: data.byStatus.map(row => [bugStatusMeta[row.status].label, row.count]) }}>
                  <BarChart rows={data.byStatus.filter(row => row.count > 0).map(row => ({ label: bugStatusMeta[row.status].label, values: { value: row.count } }))} />
                  {data.byStatus.every(row => !row.count) && <p className="py-6 text-center text-sm text-slate-500">No bugs yet.</p>}
                </ChartCard>

                <section className="space-y-5">
                  <div className="rounded-xl border border-slate-200 bg-white p-5">
                    <h2 className="flex items-center gap-2 font-display text-base font-bold"><CalendarClock size={16} className="text-rose-600" /> Overdue</h2>
                    <BriefList items={data.overdue} empty="Nothing is overdue." detail={item => `due ${new Date(item.dueAt!).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`} />
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-5">
                    <h2 className="flex items-center gap-2 font-display text-base font-bold"><Hourglass size={16} className="text-slate-500" /> Oldest open bugs</h2>
                    <BriefList items={data.oldest} empty="No open bugs." detail={item => (item.ageDays ? `${item.ageDays} days old` : "today")} />
                  </div>
                </section>
              </div>
            </div>
          );
        })()
      )}
    </Shell>
  );
}
