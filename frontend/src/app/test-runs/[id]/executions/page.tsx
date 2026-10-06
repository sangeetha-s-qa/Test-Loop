"use client";

import { use, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Play } from "lucide-react";
import { Shell } from "@/components/shell";
import { BlockedNotice, EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/states";
import { api, ApiError, formatDuration, type AutomationScript, type ExecutionBatch } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

export default function ExecutionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [browser, setBrowser] = useState<"chromium" | "firefox" | "webkit">("chromium");

  const batches = useResource(() => api.get<ExecutionBatch[]>(`/api/v1/test-runs/${id}/executions`), [id], {
    intervalMs: 3000,
    shouldPoll: rows => rows.some(row => ["QUEUED", "RUNNING"].includes(row.status)),
  });
  const scripts = useResource(() => api.get<AutomationScript[]>(`/api/v1/test-runs/${id}/automation`), [id]);

  const approved = (scripts.data ?? []).filter(script => script.approvedVersionId);
  const active = (batches.data ?? []).find(batch => ["QUEUED", "RUNNING"].includes(batch.status));

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      await api.post(`/api/v1/test-runs/${id}/executions`, { browser });
      batches.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Unable to start the execution.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (batchId: string) => {
    setBusy(true);
    setError("");
    try {
      await api.post(`/api/v1/execution-batches/${batchId}/cancel`);
      batches.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Unable to cancel.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="Executions" subtitle="Real browser runs of approved automation">
      <Link href={`/test-runs/${id}`} className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-slate-500">
        <ArrowLeft size={16} />
        Test run
      </Link>

      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-lg font-bold">Run approved automation</h2>
            <p className="mt-1 text-sm text-slate-500">
              {approved.length} approved automation version{approved.length === 1 ? "" : "s"} ready to execute.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm font-medium">
              Browser
              <select value={browser} onChange={event => setBrowser(event.target.value as typeof browser)} className="ml-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal">
                <option value="chromium">Chromium</option>
                <option value="firefox">Firefox</option>
                <option value="webkit">WebKit</option>
              </select>
            </label>
            {active ? (
              <button disabled={busy} onClick={() => cancel(active.id)} className="rounded-lg border border-rose-200 px-4 py-2.5 text-sm font-bold text-rose-700 disabled:opacity-50">
                Cancel running batch
              </button>
            ) : (
              <button disabled={busy || approved.length === 0} onClick={start} className="flex items-center gap-2 rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40">
                <Play size={15} />
                Run {approved.length || ""} test{approved.length === 1 ? "" : "s"}
              </button>
            )}
          </div>
        </div>

        {error && <p className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}

        {!scripts.loading && approved.length === 0 && (
          <div className="mt-4">
            <BlockedNotice title="No approved automation" detail="Only approved automation versions can execute, so an unreviewed script can never produce a result.">
              <Link href={`/test-runs/${id}/automation`} className="text-sm font-bold text-amber-900 underline">
                Go to automation
              </Link>
            </BlockedNotice>
          </div>
        )}
      </section>

      <h2 className="mt-8 mb-4 font-display text-lg font-bold">Execution history</h2>

      {batches.loading ? (
        <LoadingState label="Loading executions" />
      ) : batches.error ? (
        <ErrorState error={batches.error} retry={batches.reload} />
      ) : (batches.data ?? []).length === 0 ? (
        <EmptyState title="No executions yet" detail="Nothing has been run for this test run. Results appear here only after a browser has actually executed the steps." />
      ) : (
        <div className="space-y-3">
          {batches.data!.map(batch => {
            const decided = batch.passedCount + batch.failedCount;
            return (
              <Link key={batch.id} href={`/execution-batches/${batch.id}`} className="block rounded-xl border border-slate-200 bg-white p-5 hover:border-violet-200">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-3">
                      <StatusBadge status={batch.status} />
                      <span className="text-sm font-semibold">{new Date(batch.createdAt).toLocaleString()}</span>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      {batch.browser} · {batch.viewport.width}×{batch.viewport.height} · {formatDuration(batch.durationMs)}
                    </p>
                  </div>
                  <div className="flex gap-5 text-sm">
                    <span className="text-emerald-700">
                      <b>{batch.passedCount}</b> passed
                    </span>
                    <span className="text-rose-700">
                      <b>{batch.failedCount}</b> failed
                    </span>
                    {batch.erroredCount > 0 && (
                      <span className="text-orange-700">
                        <b>{batch.erroredCount}</b> errored
                      </span>
                    )}
                    <span className="text-slate-500">
                      <b>{decided === 0 ? "—" : `${Math.round((batch.passedCount / decided) * 100)}%`}</b> pass rate
                    </span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </Shell>
  );
}
