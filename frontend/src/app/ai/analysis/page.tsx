"use client";

import Link from "next/link";
import { Shell } from "@/components/shell";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/states";
import { Card } from "@/components/ui";
import { api, formatRelative, type AnalysisRecord } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

const pending = ["QUEUED", "ANALYZING"];

/** Confidence is the model's own, reported as given. A low number is shown as a low number. */
function Confidence({ value }: { value: number | null }) {
  if (value === null) return <span className="text-slate-400">—</span>;
  const percent = Math.round(value * 100);
  const tone = percent >= 70 ? "bg-emerald-500" : percent >= 40 ? "bg-amber-500" : "bg-slate-400";
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${percent}%` }} />
      </span>
      <span className="font-mono text-xs tabular-nums text-slate-600">{percent}%</span>
    </span>
  );
}

export default function AiAnalysisPage() {
  const analyses = useResource(() => api.get<AnalysisRecord[]>("/api/v1/failure-analyses"), [], {
    intervalMs: 4000,
    shouldPoll: rows => rows.some(row => pending.includes(row.status)),
  });

  return (
    <Shell title="AI bug analyzer" subtitle="Root-cause analysis of real execution failures">
      {analyses.loading ? (
        <LoadingState label="Loading analyses" />
      ) : analyses.error ? (
        <ErrorState error={analyses.error} retry={analyses.reload} />
      ) : (analyses.data?.length ?? 0) === 0 ? (
        <EmptyState
          title="No failure analyses yet"
          detail="Analysis runs against executions that genuinely failed. When a run fails, open it and request an analysis."
          action={
            <Link href="/test-runs" className="rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-semibold text-white">
              View test runs
            </Link>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {analyses.data?.map(record => (
            <Card key={record.id} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-xs font-bold text-violet-600">{record.execution.testCase.testCaseId}</p>
                  <h2 className="mt-1 font-display text-base font-bold text-slate-900">{record.execution.testCase.title}</h2>
                </div>
                <div className="flex items-center gap-2">
                  {record.category && <StatusBadge status={record.category} />}
                  <StatusBadge status={record.status} />
                </div>
              </div>

              {record.status === "COMPLETED" ? (
                <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <dt className="text-xs uppercase tracking-wide text-slate-400">Summary</dt>
                    <dd className="mt-1 text-sm text-slate-700">{record.summary ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-slate-400">Likely cause</dt>
                    <dd className="mt-1 text-sm text-slate-700">{record.likelyCause ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-slate-400">Recommended action</dt>
                    <dd className="mt-1 text-sm text-slate-700">{record.recommendedAction ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-slate-400">Model confidence</dt>
                    <dd className="mt-1"><Confidence value={record.confidence} /></dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-slate-400">Model</dt>
                    <dd className="mt-1 font-mono text-xs text-slate-600">{record.provider && record.model ? `${record.provider}/${record.model}` : "—"}</dd>
                  </div>
                </dl>
              ) : record.error ? (
                <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{record.error}</p>
              ) : (
                <p className="mt-4 text-sm text-slate-500">Analysis is still running on the local model.</p>
              )}

              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4 text-sm">
                <span className="text-slate-500">{formatRelative(record.createdAt)}</span>
                <Link href={`/executions/${record.execution.id}`} className="font-semibold text-violet-600 hover:underline">
                  Open execution
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}
    </Shell>
  );
}
