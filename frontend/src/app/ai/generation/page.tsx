"use client";

import Link from "next/link";
import { Plus, Wand2 } from "lucide-react";
import { Shell } from "@/components/shell";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/states";
import { Card } from "@/components/ui";
import { api, formatRelative, type AiStatus, type GenerationRun } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

const active = ["QUEUED", "ANALYZING", "GENERATING"];

export default function AiGenerationPage() {
  const runs = useResource(() => api.get<GenerationRun[]>("/api/v1/ai-generations"), [], {
    intervalMs: 4000,
    shouldPoll: rows => rows.some(row => active.includes(row.status)),
  });
  const provider = useResource(() => api.get<AiStatus>("/api/v1/ai/status"), []);

  return (
    <Shell
      title="AI test generator"
      subtitle="Every generation run, newest first"
      actions={
        <Link href="/test-runs/new" className="flex items-center gap-2 rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-semibold text-white">
          <Plus size={16} />
          New test run
        </Link>
      }
    >
      <Card className="mb-6 flex flex-wrap items-center gap-x-8 gap-y-3 p-5">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-violet-100 text-violet-700">
            <Wand2 size={19} />
          </span>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Provider</p>
            <p className="font-mono text-sm font-semibold">{provider.data?.provider ?? (provider.loading ? "checking…" : "not configured")}</p>
          </div>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Model</p>
          <p className="font-mono text-sm font-semibold">{provider.data?.model ?? "—"}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Status</p>
          {provider.loading ? <p className="text-sm text-slate-500">Checking…</p> : <StatusBadge status={provider.data?.ready ? "PASSED" : "FAILED"} />}
        </div>
        {/* The API returns the exact remediation command when a local model is missing. */}
        {provider.data?.ready === false && provider.data.detail && (
          <p className="w-full rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">{provider.data.detail}</p>
        )}
      </Card>

      {runs.loading ? (
        <LoadingState label="Loading generation runs" />
      ) : runs.error ? (
        <ErrorState error={runs.error} retry={runs.reload} />
      ) : (runs.data?.length ?? 0) === 0 ? (
        <EmptyState
          title="No generation runs yet"
          detail="Complete website discovery on a test run, then generate test cases from the crawled pages."
          action={
            <Link href="/test-runs/new" className="rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-semibold text-white">
              Start a test run
            </Link>
          }
        />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-5 py-3.5">Status</th>
                <th className="px-5 py-3.5">Project</th>
                <th className="px-5 py-3.5">Application</th>
                <th className="px-5 py-3.5">Model</th>
                <th className="px-5 py-3.5">Scenarios</th>
                <th className="px-5 py-3.5">Test cases</th>
                <th className="px-5 py-3.5">Started</th>
                <th className="px-5 py-3.5" />
              </tr>
            </thead>
            <tbody>
              {runs.data?.map(run => (
                <tr key={run.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                  <td className="px-5 py-3.5"><StatusBadge status={run.status} /></td>
                  <td className="px-5 py-3.5 font-semibold text-slate-800">{run.testRun.project.name}</td>
                  <td className="max-w-[220px] truncate px-5 py-3.5 text-slate-600">{run.testRun.applicationUrl}</td>
                  <td className="px-5 py-3.5 font-mono text-xs text-slate-600">{run.provider && run.model ? `${run.provider}/${run.model}` : "—"}</td>
                  <td className="px-5 py-3.5 text-slate-600">{run.scenarioCount}</td>
                  <td className="px-5 py-3.5 text-slate-600">{run.testCaseCount}</td>
                  <td className="px-5 py-3.5 text-slate-500">{formatRelative(run.startedAt ?? run.createdAt)}</td>
                  <td className="px-5 py-3.5">
                    <Link href={`/test-runs/${run.testRun.id}/ai-analysis`} className="font-semibold text-violet-600 hover:underline">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {runs.data?.some(run => run.error) && (
        <div className="mt-5 space-y-2">
          {runs.data.filter(run => run.error).slice(0, 5).map(run => (
            <p key={run.id} className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
              <span className="font-semibold">{run.testRun.project.name}:</span> {run.error}
            </p>
          ))}
        </div>
      )}
    </Shell>
  );
}
