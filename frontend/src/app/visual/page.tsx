"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, X } from "lucide-react";
import { Shell } from "@/components/shell";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/states";
import { Button, Card } from "@/components/ui";
import { ApiError, api, artifactUrl, formatRelative, type VisualRecord } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

/** Loads one artifact through a short-lived signed URL. Failure is shown, never hidden. */
function ArtifactImage({ artifactId, label }: { artifactId: string | null; label: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!artifactId) return;
    let cancelled = false;
    artifactUrl(artifactId)
      .then(result => !cancelled && setUrl(result.url))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [artifactId]);

  return (
    <figure className="flex min-w-0 flex-1 flex-col gap-2">
      <figcaption className="text-xs font-bold uppercase tracking-wide text-slate-400">{label}</figcaption>
      {!artifactId ? (
        <div className="grid h-40 place-items-center rounded-lg border border-dashed border-slate-300 text-xs text-slate-500">Not captured</div>
      ) : failed ? (
        <div className="grid h-40 place-items-center rounded-lg border border-rose-200 bg-rose-50 text-xs text-rose-700">Unable to load</div>
      ) : url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={label} className="w-full rounded-lg border border-slate-200 bg-white" />
      ) : (
        <div className="h-40 animate-pulse rounded-lg bg-slate-100" />
      )}
    </figure>
  );
}

export default function VisualTestingPage() {
  const comparisons = useResource(() => api.get<VisualRecord[]>("/api/v1/visual-comparisons"), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (id: string, decision: "approve" | "reject") => {
    setBusy(id);
    setError(null);
    try {
      await api.post(`/api/v1/visual-comparisons/${id}/${decision}`);
      comparisons.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : "The action could not be completed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Shell title="Visual testing" subtitle="Baseline against current, compared pixel by pixel">
      {comparisons.loading ? (
        <LoadingState label="Loading comparisons" />
      ) : comparisons.error ? (
        <ErrorState error={comparisons.error} retry={comparisons.reload} />
      ) : (comparisons.data?.length ?? 0) === 0 ? (
        <EmptyState
          title="No visual comparisons yet"
          detail="A comparison is created from an execution screenshot against an approved baseline. Run a test that captures screenshots, then compare it."
          action={
            <Link href="/test-runs" className="rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-semibold text-white">
              View test runs
            </Link>
          }
        />
      ) : (
        <>
          {error && <p role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</p>}

          <div className="flex flex-col gap-5">
            {comparisons.data?.map(item => {
              const ratio = item.diffRatio;
              return (
                <Card key={item.id} className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-xs font-bold text-violet-600">{item.execution.testCase.testCaseId}</p>
                      <h2 className="mt-1 font-display text-base font-bold text-slate-900">{item.execution.testCase.title}</h2>
                      {item.baseline && (
                        <p className="mt-1 text-sm text-slate-500">
                          Baseline &ldquo;{item.baseline.name}&rdquo; · {item.baseline.browser} · {item.baseline.viewportWidth}&times;{item.baseline.viewportHeight}
                        </p>
                      )}
                    </div>
                    <StatusBadge status={item.status} />
                  </div>

                  <div className="mt-5 flex flex-wrap gap-4">
                    <ArtifactImage artifactId={item.baselineArtifactId} label="Baseline" />
                    <ArtifactImage artifactId={item.currentArtifactId} label="Current" />
                    <ArtifactImage artifactId={item.diffArtifactId} label="Difference" />
                  </div>

                  <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-slate-100 pt-4 text-sm sm:grid-cols-4">
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-slate-400">Difference</dt>
                      <dd className="mt-0.5 font-mono font-semibold tabular-nums">{ratio === null ? "—" : `${(ratio * 100).toFixed(2)}%`}</dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-slate-400">Threshold</dt>
                      <dd className="mt-0.5 font-mono font-semibold tabular-nums">{(item.threshold * 100).toFixed(2)}%</dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-slate-400">Changed pixels</dt>
                      <dd className="mt-0.5 font-mono font-semibold tabular-nums">{item.diffPixelCount?.toLocaleString() ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-slate-400">Dimensions</dt>
                      <dd className="mt-0.5 font-semibold">{item.dimensionsMatch ? "Match" : "Differ"}</dd>
                    </div>
                  </dl>

                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <span className="text-xs text-slate-500">{formatRelative(item.createdAt)}</span>
                    <div className="flex items-center gap-2">
                      <Link href={`/executions/${item.execution.id}`} className="px-3 text-sm font-semibold text-violet-600 hover:underline">
                        Open execution
                      </Link>
                      {/* A baseline is never adopted automatically; a reviewer accepts the change. */}
                      {(item.status === "DIFFERENT" || item.status === "NEW_BASELINE_REQUIRED") && (
                        <>
                          <Button size="sm" onClick={() => decide(item.id, "approve")} loading={busy === item.id} icon={<Check size={13} />} className="bg-emerald-700 hover:bg-emerald-800">
                            Accept as baseline
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => decide(item.id, "reject")} disabled={busy !== null} icon={<X size={13} />}>
                            Reject
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </Shell>
  );
}
