"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { Shell } from "@/components/shell";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/states";
import { api, type TestRun } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

type RunRow = TestRun & { discovery?: { status: string; pagesDiscovered: number } | null; _count: { testCases: number; executionBatches: number } };

const statuses = ["ALL", "QUEUED", "DISCOVERING", "COMPLETED", "FAILED", "CANCELLED"];

export default function TestRunsPage() {
  const runs = useResource(() => api.get<RunRow[]>("/api/v1/test-runs/summary/list"), [], {
    intervalMs: 4000,
    shouldPoll: rows => rows.some(row => ["QUEUED", "DISCOVERING"].includes(row.discovery?.status ?? "")),
  });
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("ALL");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (runs.data ?? []).filter(run => {
      const runStatus = run.discovery?.status ?? run.status;
      if (status !== "ALL" && runStatus !== status) return false;
      if (!needle) return true;
      return `${run.project?.name ?? ""} ${run.applicationUrl} ${run.testingTypes.join(" ")}`.toLowerCase().includes(needle);
    });
  }, [runs.data, query, status]);

  return (
    <Shell
      title="Test runs"
      subtitle="Every run from discovery through execution"
      actions={
        <Link href="/test-runs/new" className="flex items-center gap-2 rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-semibold text-white">
          <Plus size={17} />
          Start new test
        </Link>
      }
    >
      <div className="mb-5 flex flex-wrap gap-3">
        <label className="flex min-w-64 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
          <Search size={17} className="text-slate-400" />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by project, URL, or testing type" className="w-full outline-none" />
        </label>
        <select value={status} onChange={event => setStatus(event.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-3 text-sm">
          {statuses.map(value => (
            <option key={value} value={value}>
              {value === "ALL" ? "All statuses" : value.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </div>

      {runs.loading ? (
        <LoadingState label="Loading test runs" />
      ) : runs.error ? (
        <ErrorState error={runs.error} retry={runs.reload} />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={runs.data?.length ? "No runs match these filters" : "No test runs yet"}
          detail={runs.data?.length ? "Adjust the search or status filter." : "Create a project, then start a test run against its URL."}
          action={!runs.data?.length && <Link href="/test-runs/new" className="rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-semibold text-white">Start your first run</Link>}
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-5 py-4">Project</th>
                <th className="px-5 py-4">Application</th>
                <th className="px-5 py-4">Discovery</th>
                <th className="px-5 py-4">Pages</th>
                <th className="px-5 py-4">Test cases</th>
                <th className="px-5 py-4">Executions</th>
                <th className="px-5 py-4">Created</th>
                <th className="px-5 py-4" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(run => (
                <tr key={run.id} className="border-b border-slate-50 last:border-0">
                  <td className="px-5 py-4 font-semibold">
                    {run.project?.name ?? "—"}
                    {run.testingMethod === "MANUAL" && <span className="ml-2 rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700 ring-1 ring-inset ring-violet-200">Manual</span>}
                  </td>
                  <td className="max-w-[240px] truncate px-5 py-4 text-slate-600">{run.applicationUrl}</td>
                  <td className="px-5 py-4">
                    <StatusBadge status={run.discovery?.status ?? "QUEUED"} />
                  </td>
                  <td className="px-5 py-4 text-slate-600">{run.discovery?.pagesDiscovered ?? 0}</td>
                  <td className="px-5 py-4 text-slate-600">{run._count.testCases}</td>
                  <td className="px-5 py-4 text-slate-600">{run._count.executionBatches}</td>
                  <td className="px-5 py-4 text-slate-500">{new Date(run.createdAt).toLocaleDateString()}</td>
                  <td className="px-5 py-4">
                    <Link href={run.testingMethod === "MANUAL" ? `/test-runs/${run.id}/manual` : `/test-runs/${run.id}`} className="font-semibold text-violet-600">
                      Open
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
