"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, Bug, CheckCircle2, CircleSlash, LayoutGrid, Plus, XCircle } from "lucide-react";
import { Shell } from "@/components/shell";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/states";
import { Card, SectionTitle } from "@/components/ui";
import { api, formatRelative, formatTrend, type DashboardPoint, type DashboardTrend, type DashboardTypeTally, type ExecutionBatch, type TestRun } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

type Dashboard = {
  projects: number;
  testRuns: number;
  testCases: number;
  executions: number;
  passed: number;
  failed: number;
  errored: number;
  cancelled: number;
  running: number;
  bugsOpen: number;
  /** null until at least one execution has produced a verdict. Never rendered as 0%. */
  passRate: number | null;
  recentRuns: (TestRun & { discovery?: { status: string; pagesDiscovered: number } | null })[];
  recentBatches: (ExecutionBatch & { testRun: { id: string; project: { name: string } } })[];
  trend: DashboardTrend;
  series: DashboardPoint[];
  testingTypes: DashboardTypeTally[];
};

/**
 * A KPI tile. The trend line is only rendered when the API found a comparable earlier window;
 * otherwise it says so. A fabricated percentage here would be indistinguishable from a real one.
 */
function Kpi({ label, value, icon, tone, trend, hasBaseline, comparedTo }: {
  label: string;
  value: number;
  icon: ReactNode;
  tone: string;
  trend?: number | null;
  hasBaseline?: boolean;
  comparedTo?: string;
}) {
  const formatted = formatTrend(trend);
  return (
    <Card className="flex items-start justify-between gap-3 p-5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        <p className="mt-1 font-display text-3xl font-bold tabular-nums text-slate-900">{value.toLocaleString()}</p>
        {hasBaseline && formatted ? (
          <p className={`mt-1.5 text-xs font-semibold ${trend! >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
            {formatted} <span className="font-normal text-slate-400">vs {comparedTo}</span>
          </p>
        ) : (
          <p className="mt-1.5 text-xs text-slate-400">No previous data</p>
        )}
      </div>
      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${tone}`}>{icon}</span>
    </Card>
  );
}

/**
 * Stacked daily execution counts drawn from real verdicts. Rendered as bars rather than a smoothed
 * line because the underlying data is a count per day, and a curve would imply readings between days.
 */
function ExecutionChart({ series }: { series: DashboardPoint[] }) {
  const max = Math.max(1, ...series.map(point => point.passed + point.failed + point.errored));
  const total = series.reduce((sum, point) => sum + point.passed + point.failed + point.errored, 0);

  if (total === 0) {
    return (
      <div className="grid h-56 place-items-center rounded-lg border border-dashed border-slate-300 text-center">
        <div>
          <p className="text-sm font-semibold text-slate-600">No executions in the last 14 days</p>
          <p className="mt-1 text-xs text-slate-500">Run a test to populate this chart.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex h-48 items-end gap-1.5" role="img" aria-label={`Daily execution outcomes over ${series.length} days`}>
        {series.map(point => {
          const stack = point.passed + point.failed + point.errored;
          return (
            <div key={point.date} className="flex min-w-0 flex-1 flex-col justify-end gap-0.5" title={`${point.date}: ${point.passed} passed, ${point.failed} failed, ${point.errored} errored`}>
              {point.errored > 0 && <span className="w-full rounded-sm bg-orange-400" style={{ height: `${(point.errored / max) * 100}%` }} />}
              {point.failed > 0 && <span className="w-full rounded-sm bg-rose-400" style={{ height: `${(point.failed / max) * 100}%` }} />}
              {point.passed > 0 && <span className="w-full rounded-sm bg-emerald-400" style={{ height: `${(point.passed / max) * 100}%` }} />}
              {stack === 0 && <span className="w-full rounded-sm bg-slate-100" style={{ height: "3px" }} />}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-slate-400">
        <span>{series[0]?.date.slice(5)}</span>
        <span>{series.at(-1)?.date.slice(5)}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-emerald-400" />Passed</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-rose-400" />Failed</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-orange-400" />Errored</span>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const dashboard = useResource(() => api.get<Dashboard>("/api/v1/dashboard"), [], {
    intervalMs: 5000,
    shouldPoll: value => value.running > 0,
  });

  const data = dashboard.data;
  const decided = (data?.passed ?? 0) + (data?.failed ?? 0);

  return (
    <Shell
      title="Dashboard"
      subtitle="Everything below is read from the database, not sampled or estimated"
      actions={
        <Link href="/test-runs/new" className="flex items-center gap-2 rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-semibold text-white">
          <Plus size={16} />
          New test
        </Link>
      }
    >
      {dashboard.loading ? (
        <LoadingState label="Loading dashboard" />
      ) : dashboard.error ? (
        <ErrorState error={dashboard.error} retry={dashboard.reload} />
      ) : !data ? null : data.projects === 0 ? (
        <EmptyState
          title="Nothing here yet"
          detail="Create a project, point it at an application URL, and start your first test run. Every number on this dashboard comes from real runs."
          action={
            <Link href="/projects" className="rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-semibold text-white">
              Create your first project
            </Link>
          }
        />
      ) : (
        <div className="flex flex-col gap-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <Kpi label="Executions" value={data.executions} icon={<LayoutGrid size={19} className="text-violet-700" />} tone="bg-violet-100" trend={data.trend?.total} hasBaseline={data.trend?.hasBaseline} comparedTo={data.trend?.comparedTo} />
            <Kpi label="Passed" value={data.passed} icon={<CheckCircle2 size={19} className="text-emerald-700" />} tone="bg-emerald-100" trend={data.trend?.passed} hasBaseline={data.trend?.hasBaseline} comparedTo={data.trend?.comparedTo} />
            <Kpi label="Failed" value={data.failed} icon={<XCircle size={19} className="text-rose-700" />} tone="bg-rose-100" trend={data.trend?.failed} hasBaseline={data.trend?.hasBaseline} comparedTo={data.trend?.comparedTo} />
            {/* There is no BLOCKED status in this system; cancelled and errored are the real states. */}
            <Kpi label="Errored / cancelled" value={data.errored + data.cancelled} icon={<CircleSlash size={19} className="text-orange-700" />} tone="bg-orange-100" trend={data.trend?.errored} hasBaseline={data.trend?.hasBaseline} comparedTo={data.trend?.comparedTo} />
            <Kpi label="Open bugs" value={data.bugsOpen} icon={<Bug size={19} className="text-fuchsia-700" />} tone="bg-fuchsia-100" />
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Card className="p-6">
              <SectionTitle title="Execution overview" description="Daily verdicts over the last 14 days" />
              <ExecutionChart series={data.series ?? []} />
            </Card>

            <Card className="p-6">
              <SectionTitle title="Testing types" description="Executions attributed to each configured type" />
              {(data.testingTypes ?? []).length === 0 ? (
                <div className="grid h-48 place-items-center rounded-lg border border-dashed border-slate-300 text-center">
                  <div>
                    <p className="text-sm font-semibold text-slate-600">No completed executions yet</p>
                    <p className="mt-1 text-xs text-slate-500">Types appear once a run with those types finishes.</p>
                  </div>
                </div>
              ) : (
                <>
                  <ul className="flex flex-col gap-3">
                    {data.testingTypes.map(entry => {
                      const rate = entry.passed + entry.failed === 0 ? null : entry.passed / (entry.passed + entry.failed);
                      return (
                        <li key={entry.type}>
                          <div className="flex items-baseline justify-between gap-3 text-sm">
                            <span className="truncate font-medium text-slate-700">{entry.type}</span>
                            <span className="shrink-0 font-mono text-xs tabular-nums text-slate-500">
                              {rate === null ? "no verdict" : `${Math.round(rate * 100)}%`} <span className="text-slate-400">({entry.total})</span>
                            </span>
                          </div>
                          <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-slate-200">
                            <span className="block h-full rounded-full bg-violet-500" style={{ width: `${rate === null ? 0 : rate * 100}%` }} />
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-4 text-xs text-slate-400">
                    A run configured with several types counts toward each, so these totals overlap and do not sum to {data.executions}.
                  </p>
                </>
              )}
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="p-6">
              <SectionTitle
                title="Recent test runs"
                action={<Link href="/test-runs" className="text-sm font-semibold text-violet-600 hover:underline">View all</Link>}
              />
              {data.recentRuns.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">No test runs yet.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-slate-100">
                  {data.recentRuns.slice(0, 5).map(run => (
                    <li key={run.id}>
                      <Link href={`/test-runs/${run.id}`} className="flex items-center justify-between gap-3 py-3 hover:bg-slate-50/70">
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-slate-800">{run.project?.name ?? "Test run"}</span>
                          <span className="block truncate text-xs text-slate-500">{run.applicationUrl}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-3">
                          <span className="text-xs text-slate-400">{formatRelative(run.createdAt)}</span>
                          <StatusBadge status={run.discovery?.status ?? run.status} />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="p-6">
              <SectionTitle
                title="Recent executions"
                action={<Link href="/reports" className="text-sm font-semibold text-violet-600 hover:underline">Reports</Link>}
              />
              {data.recentBatches.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
                  No executions yet. Approve automation on a test run to execute it.
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-slate-100">
                  {data.recentBatches.slice(0, 5).map(batch => (
                    <li key={batch.id}>
                      <Link href={`/execution-batches/${batch.id}`} className="flex items-center justify-between gap-3 py-3 hover:bg-slate-50/70">
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-slate-800">{batch.testRun.project.name}</span>
                          <span className="block text-xs text-slate-500">
                            {batch.passedCount} passed · {batch.failedCount} failed · {batch.browser}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-3">
                          <span className="text-xs text-slate-400">{formatRelative(batch.createdAt)}</span>
                          <StatusBadge status={batch.status} />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card className="p-6">
            <SectionTitle title="Pipeline totals" description="Current contents of the workspace" />
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {[
                ["Projects", data.projects, "/projects"],
                ["Test runs", data.testRuns, "/test-runs"],
                ["Test cases", data.testCases, "/test-cases"],
                ["Open bugs", data.bugsOpen, "/bugs"],
              ].map(([label, value, href]) => (
                <Link key={label as string} href={href as string} className="rounded-lg border border-slate-200 p-4 hover:border-violet-300 hover:bg-violet-50/40">
                  <dt className="text-xs uppercase tracking-wide text-slate-400">{label}</dt>
                  <dd className="mt-1 font-display text-2xl font-bold tabular-nums">{(value as number).toLocaleString()}</dd>
                </Link>
              ))}
            </dl>
            {decided === 0 && (
              <p className="mt-4 flex items-center gap-2 text-xs text-slate-500">
                <AlertTriangle size={13} />
                No execution has produced a verdict yet, so no pass rate is shown.
              </p>
            )}
          </Card>
        </div>
      )}
    </Shell>
  );
}
