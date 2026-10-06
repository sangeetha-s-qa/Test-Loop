"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, Search } from "lucide-react";
import { Shell } from "@/components/shell";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/states";
import { api, API_URL, formatDuration, type BatchDetail } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

const filters = ["ALL", "PASSED", "FAILED", "TIMED_OUT", "ERRORED", "CANCELLED"];

export default function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [status, setStatus] = useState("ALL");
  const [query, setQuery] = useState("");

  const batch = useResource(() => api.get<BatchDetail>(`/api/v1/execution-batches/${id}`), [id], {
    intervalMs: 2000,
    shouldPoll: value => ["QUEUED", "RUNNING"].includes(value.status),
  });

  const executions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (batch.data?.executions ?? []).filter(execution => {
      if (status !== "ALL" && execution.status !== status) return false;
      if (!needle) return true;
      return `${execution.testCase.testCaseId} ${execution.testCase.title} ${execution.testCase.module}`.toLowerCase().includes(needle);
    });
  }, [batch.data, status, query]);

  if (batch.loading) {
    return (
      <Shell title="Execution results">
        <LoadingState label="Loading execution results" />
      </Shell>
    );
  }
  if (batch.error || !batch.data) {
    return (
      <Shell title="Execution results">
        <ErrorState error={batch.error ?? new Error("Not found")} retry={batch.reload} />
      </Shell>
    );
  }

  const data = batch.data;
  const decided = data.passedCount + data.failedCount;
  const tiles = [
    { label: "Passed", value: data.passedCount, tone: "text-emerald-700" },
    { label: "Failed", value: data.failedCount, tone: "text-rose-700" },
    { label: "Errored", value: data.erroredCount, tone: "text-orange-700" },
    { label: "Cancelled", value: data.skippedCount, tone: "text-slate-500" },
  ];

  return (
    <Shell
      title={`${data.testRun.project.name} · execution batch`}
      subtitle={`${data.browser} · ${data.viewport.width}×${data.viewport.height} · ${new Date(data.createdAt).toLocaleString()}`}
      actions={
        <div className="flex gap-2">
          <a href={`${API_URL}/api/v1/execution-batches/${id}/report?format=csv`} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2.5 text-sm font-semibold">
            <Download size={15} />
            CSV
          </a>
          <a href={`${API_URL}/api/v1/execution-batches/${id}/report?format=json-file`} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2.5 text-sm font-semibold">
            <Download size={15} />
            JSON
          </a>
        </div>
      }
    >
      <Link href={`/test-runs/${data.testRunId}/executions`} className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-slate-500">
        <ArrowLeft size={16} />
        Executions
      </Link>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm text-slate-500">Status</p>
          <div className="mt-3">
            <StatusBadge status={data.status} />
          </div>
        </div>
        {tiles.map(tile => (
          <div key={tile.label} className="rounded-xl border border-slate-200 bg-white p-5">
            <p className="text-sm text-slate-500">{tile.label}</p>
            <p className={`mt-2 font-display text-2xl font-bold ${tile.tone}`}>{tile.value}</p>
          </div>
        ))}
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm text-slate-500">Duration</p>
          <p className="mt-2 font-display text-2xl font-bold">{formatDuration(data.durationMs)}</p>
          <p className="mt-1 text-xs text-slate-400">{decided === 0 ? "No verdicts yet" : `${Math.round((data.passedCount / decided) * 100)}% pass rate`}</p>
        </div>
      </div>

      <div className="mt-6 mb-4 flex flex-wrap gap-3">
        <label className="flex min-w-64 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
          <Search size={17} className="text-slate-400" />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search test cases" className="w-full outline-none" />
        </label>
        <select value={status} onChange={event => setStatus(event.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-3 text-sm">
          {filters.map(value => (
            <option key={value} value={value}>
              {value === "ALL" ? "All results" : value.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </div>

      {executions.length === 0 ? (
        <EmptyState title="No executions match this view" detail={data.executions.length ? "Adjust the filters above." : "This batch has no executions recorded."} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-5 py-4">Result</th>
                <th className="px-5 py-4">Test case</th>
                <th className="px-5 py-4">Steps</th>
                <th className="px-5 py-4">Duration</th>
                <th className="px-5 py-4">Failure</th>
                <th className="px-5 py-4">Artifacts</th>
                <th className="px-5 py-4" />
              </tr>
            </thead>
            <tbody>
              {executions.map(execution => (
                <tr key={execution.id} className="border-b border-slate-50 last:border-0">
                  <td className="px-5 py-4">
                    <StatusBadge status={execution.status} />
                  </td>
                  <td className="max-w-[280px] px-5 py-4">
                    <p className="font-mono text-xs text-violet-600">{execution.testCase.testCaseId}</p>
                    <p className="truncate font-semibold">{execution.testCase.title}</p>
                  </td>
                  <td className="px-5 py-4 text-slate-600">
                    {execution.passedSteps}/{execution.totalSteps}
                    {execution.failedStepIndex !== null && <span className="ml-2 text-xs text-rose-600">failed at {execution.failedStepIndex + 1}</span>}
                  </td>
                  <td className="px-5 py-4 text-slate-600">{formatDuration(execution.durationMs)}</td>
                  <td className="max-w-[260px] px-5 py-4">
                    {execution.failureCategory ? (
                      <>
                        <p className="font-mono text-xs font-bold text-rose-700">{execution.failureCategory}</p>
                        <p className="truncate text-xs text-slate-500">{execution.failureMessage}</p>
                      </>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-5 py-4 text-slate-600">{execution._count.artifacts}</td>
                  <td className="px-5 py-4">
                    <Link href={`/executions/${execution.id}`} className="font-semibold text-violet-600">
                      Details
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
