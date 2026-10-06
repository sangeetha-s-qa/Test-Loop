"use client";

import { use, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Sparkles } from "lucide-react";
import { Shell } from "@/components/shell";
import { BlockedNotice, ErrorState, LoadingState, StatusBadge } from "@/components/states";
import { ApiError, api, type AiStatus, type Discovery, type TestRun } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

type Generation = { id: string; status: string; provider: string | null; model: string | null; scenarioCount: number; testCaseCount: number; error?: string | null; startedAt?: string | null; completedAt?: string | null } | null;

const inFlight = ["QUEUED", "ANALYZING", "GENERATING"];

export default function AIAnalysisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const run = useResource(() => api.get<TestRun & { discovery?: Discovery | null }>(`/api/v1/test-runs/${id}`), [id]);
  // Polls only while work is actually in flight, and stops on its own once the run settles.
  const generation = useResource(() => api.get<Generation>(`/api/v1/test-runs/${id}/ai-status`), [id], {
    intervalMs: 2500,
    shouldPoll: value => inFlight.includes(value?.status ?? ""),
  });
  const provider = useResource(() => api.get<AiStatus>("/api/v1/ai/status"), []);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const discovery = run.data?.discovery ?? null;
  const discoveryReady = discovery?.status === "COMPLETED" && (discovery.pagesDiscovered ?? 0) > 0;
  const status = generation.data?.status ?? null;
  const running = inFlight.includes(status ?? "");

  const start = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await api.post(`/api/v1/test-runs/${id}/ai-analysis`);
      generation.reload();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : "Unable to start AI generation.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await api.post(`/api/v1/test-runs/${id}/ai-generation/cancel`);
      generation.reload();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : "Unable to cancel AI generation.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="AI test generation" subtitle="Turn discovered pages into reviewable manual test cases">
      <Link href={`/test-runs/${id}`} className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-slate-900">
        <ArrowLeft size={16} />
        Test run
      </Link>

      {run.loading ? (
        <LoadingState label="Loading test run" />
      ) : run.error ? (
        <ErrorState error={run.error} retry={run.reload} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <section className="rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-violet-100 text-violet-700">
                <Sparkles size={20} />
              </span>
              <div className="min-w-0">
                <h2 className="font-display text-xl font-bold">Generation</h2>
                <p className="text-sm text-slate-500">Every generated case is a draft until a human approves it.</p>
              </div>
            </div>

            <dl className="mt-6 space-y-3 text-sm">
              <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-3">
                <dt className="text-slate-500">Website discovery</dt>
                <dd>
                  <StatusBadge status={discovery?.status ?? "QUEUED"} />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-3">
                <dt className="text-slate-500">Discovered</dt>
                <dd className="font-semibold">
                  {discovery?.pagesDiscovered ?? 0} pages · {discovery?.formsDiscovered ?? 0} forms · {discovery?.elementsDiscovered ?? 0} elements
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-3">
                <dt className="text-slate-500">AI generation</dt>
                <dd>{status ? <StatusBadge status={status} /> : <span className="text-sm font-semibold text-slate-500">NOT STARTED</span>}</dd>
              </div>
              {generation.data && (
                <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-3">
                  <dt className="text-slate-500">Produced</dt>
                  <dd className="font-semibold">
                    {generation.data.scenarioCount} scenarios · {generation.data.testCaseCount} test cases
                  </dd>
                </div>
              )}
              {generation.data?.model && (
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-slate-500">Model</dt>
                  <dd className="font-mono text-xs">
                    {generation.data.provider}/{generation.data.model}
                  </dd>
                </div>
              )}
            </dl>

            {generation.data?.error && (
              <p className="mt-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
                <span className="font-bold">Generation failed.</span> {generation.data.error}
              </p>
            )}
            {actionError && <p className="mt-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{actionError}</p>}

            {!discoveryReady && (
              <div className="mt-5">
                <BlockedNotice title="Discovery is not complete" detail="Run and finish website discovery before generating test cases - generation needs the crawled pages, forms, and elements as evidence." />
              </div>
            )}

            <div className="mt-6 flex flex-wrap gap-3">
              {running ? (
                <button onClick={cancel} disabled={busy} className="rounded-lg border border-slate-300 px-4 py-3 text-sm font-bold text-slate-700 disabled:opacity-50">
                  {busy ? "Cancelling…" : "Cancel generation"}
                </button>
              ) : (
                <button onClick={start} disabled={busy || !discoveryReady || provider.data?.ready === false} className="flex items-center gap-2 rounded-lg bg-[#111c38] px-4 py-3 text-sm font-bold text-white disabled:opacity-50">
                  <Sparkles size={16} />
                  {busy ? "Starting…" : status ? "Generate again" : "Generate AI test cases"}
                </button>
              )}
              {(generation.data?.testCaseCount ?? 0) > 0 && (
                <Link href={`/test-runs/${id}/test-cases`} className="rounded-lg bg-violet-600 px-4 py-3 text-sm font-bold text-white">
                  Review {generation.data?.testCaseCount} generated cases
                </Link>
              )}
            </div>

            {running && <p className="mt-4 text-sm text-slate-500">Running on a local model. This can take several minutes; the status above updates on its own.</p>}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-6">
            <h3 className="font-display font-bold">AI provider</h3>
            {provider.loading ? (
              <p className="mt-3 text-sm text-slate-500">Checking…</p>
            ) : provider.error ? (
              <ErrorState error={provider.error} retry={provider.reload} />
            ) : (
              <div className="mt-3 space-y-3 text-sm">
                <p className="flex items-center justify-between gap-3">
                  <span className="text-slate-500">Provider</span>
                  <span className="font-mono text-xs">{provider.data?.provider ?? "not configured"}</span>
                </p>
                <p className="flex items-center justify-between gap-3">
                  <span className="text-slate-500">Model</span>
                  <span className="font-mono text-xs">{provider.data?.model ?? "—"}</span>
                </p>
                <p className="flex items-center justify-between gap-3">
                  <span className="text-slate-500">Status</span>
                  <StatusBadge status={provider.data?.ready ? "PASSED" : "FAILED"} />
                </p>
                {/* The API returns the exact remediation command when a local model is missing. */}
                {provider.data?.ready === false && provider.data.detail && (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">{provider.data.detail}</p>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </Shell>
  );
}
