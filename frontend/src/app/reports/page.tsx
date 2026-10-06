"use client";

import { useState } from "react";
import Link from "next/link";
import { Download } from "lucide-react";
import { Shell } from "@/components/shell";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/states";
import { api, formatDuration, type Project, type ProjectReport } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

export default function ReportsPage() {
  const projects = useResource(() => api.get<Project[]>("/api/v1/projects"), []);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  // Derived rather than stored, so no effect is needed to default to the first project.
  const projectId = selectedProjectId || projects.data?.[0]?.id || "";

  const report = useResource(() => (projectId ? api.get<ProjectReport>(`/api/v1/projects/${projectId}/report`) : Promise.resolve(null)), [projectId]);

  return (
    <Shell title="Reports" subtitle="Aggregated from real execution records">
      {projects.error ? (
        <ErrorState error={projects.error} retry={projects.reload} />
      ) : !projects.loading && !projects.data?.length ? (
        <EmptyState title="No projects yet" detail="Reports are scoped to a project." action={<Link href="/projects" className="rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-semibold text-white">Go to projects</Link>} />
      ) : (
        <>
          <select value={projectId} onChange={event => setSelectedProjectId(event.target.value)} className="mb-6 rounded-lg border border-slate-200 bg-white px-3 py-3 text-sm">
            {(projects.data ?? []).map(project => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>

          {report.loading ? (
            <LoadingState label="Building report" />
          ) : report.error ? (
            <ErrorState error={report.error} retry={report.reload} />
          ) : report.data ? (
            <ReportBody report={report.data} />
          ) : null}
        </>
      )}
    </Shell>
  );
}

function ReportBody({ report }: { report: ProjectReport }) {
  const tiles = [
    { label: "Test runs", value: report.totals.testRuns },
    { label: "Test cases", value: report.totals.testCases },
    { label: "Approved cases", value: report.totals.approvedTestCases },
    { label: "Approved automation", value: report.totals.automationApproved },
    { label: "Executions", value: report.totals.executions },
    { label: "Open bugs", value: report.totals.bugsOpen },
  ];

  return (
    <>
      <p className="mb-4 text-xs text-slate-400">Generated {new Date(report.generatedAt).toLocaleString()}</p>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
        {tiles.map(tile => (
          <div key={tile.label} className="rounded-xl border border-slate-200 bg-white p-5">
            <p className="text-sm text-slate-500">{tile.label}</p>
            <p className="mt-2 font-display text-2xl font-bold">{tile.value}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm text-slate-500">Pass rate</p>
          <p className="mt-2 font-display text-3xl font-bold">{report.passRate === null ? "—" : `${Math.round(report.passRate * 100)}%`}</p>
          <p className="mt-1 text-xs text-slate-400">{report.passRate === null ? "No decided executions yet" : `${report.totals.passed} passed, ${report.totals.failed} failed`}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm text-slate-500">Average duration</p>
          <p className="mt-2 font-display text-3xl font-bold">{formatDuration(report.averageDurationMs)}</p>
          <p className="mt-1 text-xs text-slate-400">Across completed executions</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm text-slate-500">Errored / cancelled</p>
          <p className="mt-2 font-display text-3xl font-bold">
            {report.totals.errored} / {report.totals.cancelled}
          </p>
          <p className="mt-1 text-xs text-slate-400">Excluded from the pass rate</p>
        </div>
      </div>

      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="font-display text-lg font-bold">Most frequently failing test cases</h2>
        {report.topFailures.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">No failures recorded for this project.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[600px] text-left text-sm">
              <thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="py-3 pr-4">Test case</th>
                  <th className="py-3 pr-4">Title</th>
                  <th className="py-3 pr-4">Failures</th>
                  <th className="py-3">Last failure</th>
                </tr>
              </thead>
              <tbody>
                {report.topFailures.map(failure => (
                  <tr key={failure.testCaseId} className="border-b border-slate-50 last:border-0">
                    <td className="py-3 pr-4 font-mono text-xs text-violet-600">{failure.testCaseId}</td>
                    <td className="max-w-[320px] truncate py-3 pr-4 font-semibold">{failure.title}</td>
                    <td className="py-3 pr-4 font-bold text-rose-700">{failure.failures}</td>
                    <td className="py-3 text-slate-500">{failure.lastFailureAt ? new Date(failure.lastFailureAt).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="font-display text-lg font-bold">Recent execution batches</h2>
        {report.recentBatches.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">No execution batches have run for this project.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {report.recentBatches.map(batch => (
              <div key={batch.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-100 p-4 text-sm">
                <StatusBadge status={batch.status} />
                <span className="font-semibold">{new Date(batch.createdAt).toLocaleString()}</span>
                <span className="text-slate-500">
                  {batch.browser} · {batch.passedCount} passed · {batch.failedCount} failed · {formatDuration(batch.durationMs)}
                </span>
                <div className="ml-auto flex items-center gap-3">
                  <Link href={`/execution-batches/${batch.id}`} className="text-xs font-bold text-violet-600">
                    Open
                  </Link>
                  <a href={`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"}/api/v1/execution-batches/${batch.id}/report?format=csv`} className="flex items-center gap-1 text-xs font-bold text-slate-500">
                    <Download size={12} />
                    CSV
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
