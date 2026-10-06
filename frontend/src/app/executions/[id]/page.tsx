"use client";

import { use, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Bug, Brain, Wrench } from "lucide-react";
import { ArtifactGrid } from "@/components/artifact-viewer";
import { Shell } from "@/components/shell";
import { BlockedNotice, ErrorState, LoadingState, StatusBadge } from "@/components/states";
import { api, ApiError, formatDuration, type AiStatus, type Bug as BugRecord, type ExecutionDetail, type FailureAnalysis, type VisualComparison } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

const failedStatuses = ["FAILED", "TIMED_OUT", "ERRORED"];

export default function ExecutionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const execution = useResource(() => api.get<ExecutionDetail>(`/api/v1/executions/${id}`), [id], {
    intervalMs: 2000,
    shouldPoll: value => ["QUEUED", "PROVISIONING", "RUNNING", "COLLECTING_ARTIFACTS"].includes(value.status),
  });
  const analyses = useResource(() => api.get<FailureAnalysis[]>(`/api/v1/executions/${id}/analysis`), [id], {
    intervalMs: 3000,
    shouldPoll: rows => rows.some(row => ["QUEUED", "ANALYZING"].includes(row.status)),
  });
  const comparisons = useResource(() => api.get<VisualComparison[]>(`/api/v1/executions/${id}/visual-comparisons`), [id]);
  const aiStatus = useResource(() => api.get<AiStatus>("/api/v1/ai/status"), []);

  const act = async (key: string, path: string, body: unknown, onDone: (result: unknown) => void) => {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      onDone(await api.post(path, body));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The request failed.");
    } finally {
      setBusy("");
    }
  };

  if (execution.loading) {
    return (
      <Shell title="Execution">
        <LoadingState label="Loading execution" />
      </Shell>
    );
  }
  if (execution.error || !execution.data) {
    return (
      <Shell title="Execution">
        <ErrorState error={execution.error ?? new Error("Not found")} retry={execution.reload} />
      </Shell>
    );
  }

  const data = execution.data;
  const failed = failedStatuses.includes(data.status);
  const latestAnalysis = analyses.data?.[0];
  const analysisRunning = !!latestAnalysis && ["QUEUED", "ANALYZING"].includes(latestAnalysis.status);
  const screenshots = data.artifacts.filter(artifact => artifact.type === "SCREENSHOT");
  const other = data.artifacts.filter(artifact => artifact.type !== "SCREENSHOT");

  return (
    <Shell title={data.testCase.title} subtitle={`${data.testCase.testCaseId} · ${data.browser}${data.browserVersion ? ` ${data.browserVersion}` : ""} · automation v${data.automationVersion.version}`}>
      <Link href={`/execution-batches/${data.batch.id}`} className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-slate-500">
        <ArrowLeft size={16} />
        Batch results
      </Link>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm text-slate-500">Result</p>
          <div className="mt-3">
            <StatusBadge status={data.status} />
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm text-slate-500">Steps passed</p>
          <p className="mt-2 font-display text-2xl font-bold">
            {data.passedSteps}/{data.totalSteps}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm text-slate-500">Duration</p>
          <p className="mt-2 font-display text-2xl font-bold">{formatDuration(data.durationMs)}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm text-slate-500">Console errors</p>
          <p className="mt-2 font-display text-2xl font-bold">{data.consoleErrorCount}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm text-slate-500">Network failures</p>
          <p className="mt-2 font-display text-2xl font-bold">{data.networkFailureCount}</p>
        </div>
      </div>

      {data.failureMessage && (
        <div className="mt-6 rounded-xl border border-rose-200 bg-rose-50 p-5">
          <p className="font-mono text-xs font-bold text-rose-700">{data.failureCategory}</p>
          <p className="mt-2 break-words text-sm text-rose-900">{data.failureMessage}</p>
        </div>
      )}

      {error && <p className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
      {notice && <p className="mt-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</p>}

      {failed && (
        <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="flex items-center gap-2 font-display text-lg font-bold">
            <Brain size={18} className="text-violet-600" />
            Failure analysis
          </h2>

          {aiStatus.data && !aiStatus.data.ready ? (
            <div className="mt-4">
              <BlockedNotice title="The AI provider is not usable right now" detail={aiStatus.data.detail ?? "The configured provider did not respond."}>
                <p className="font-mono text-xs text-amber-900">{aiStatus.data.code}</p>
              </BlockedNotice>
            </div>
          ) : (
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                disabled={busy !== "" || analysisRunning}
                onClick={() => act("analyse", `/api/v1/executions/${id}/analysis`, { includeHealing: true }, () => { analyses.reload(); setNotice("Analysis queued. It will appear here when the worker finishes."); })}
                className="flex items-center gap-2 rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40"
              >
                <Brain size={15} />
                {analysisRunning ? "Analysing…" : analyses.data?.length ? "Re-analyse" : "Analyse this failure"}
              </button>
              <button
                disabled={busy !== ""}
                onClick={() =>
                  act("bug", `/api/v1/executions/${id}/bugs`, { analysisId: latestAnalysis?.status === "COMPLETED" ? latestAnalysis.id : undefined }, result => {
                    const bug = result as BugRecord;
                    setNotice(`Bug ${bug.reference} recorded (${bug.occurrenceCount} occurrence${bug.occurrenceCount === 1 ? "" : "s"}).`);
                  })
                }
                className="flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-bold disabled:opacity-40"
              >
                <Bug size={15} />
                Create or update bug
              </button>
            </div>
          )}

          {analyses.data?.length ? (
            <div className="mt-5 space-y-3">
              {analyses.data.map(analysis => (
                <div key={analysis.id} className="rounded-lg border border-slate-200 p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-mono text-xs font-bold">v{analysis.version}</span>
                    <StatusBadge status={analysis.status} />
                    {analysis.category && <span className="rounded bg-violet-50 px-2 py-0.5 text-xs font-bold text-violet-700">{analysis.category.replace(/_/g, " ")}</span>}
                    {analysis.confidence !== null && <span className="text-xs text-slate-500">confidence {Math.round(analysis.confidence * 100)}%</span>}
                    <span className="ml-auto text-xs text-slate-400">
                      {analysis.provider}/{analysis.model}
                    </span>
                  </div>
                  {analysis.error && <p className="mt-3 rounded bg-rose-50 p-2 font-mono text-xs text-rose-700">{analysis.error}</p>}
                  {analysis.summary && (
                    <dl className="mt-3 space-y-2 text-sm">
                      <div>
                        <dt className="text-xs font-bold uppercase tracking-wide text-slate-400">Summary</dt>
                        <dd className="mt-0.5 text-slate-700">{analysis.summary}</dd>
                      </div>
                      <div>
                        <dt className="text-xs font-bold uppercase tracking-wide text-slate-400">Likely cause</dt>
                        <dd className="mt-0.5 text-slate-700">{analysis.likelyCause}</dd>
                      </div>
                      <div>
                        <dt className="text-xs font-bold uppercase tracking-wide text-slate-400">Recommended action</dt>
                        <dd className="mt-0.5 text-slate-700">{analysis.recommendedAction}</dd>
                      </div>
                    </dl>
                  )}
                  <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500">
                    <Wrench size={12} />
                    This is a suggestion. It has not changed the test, the automation, or any bug.
                  </p>
                </div>
              ))}
            </div>
          ) : (
            !analysisRunning && <p className="mt-5 text-sm text-slate-500">No analysis has been requested for this failure.</p>
          )}
        </section>
      )}

      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="font-display text-lg font-bold">Step results</h2>
        <p className="mt-1 text-sm text-slate-500">Recorded by the browser as each step ran.</p>
        <ol className="mt-5 space-y-2">
          {data.steps.map(step => (
            <li key={step.id} className={`rounded-lg border p-4 ${step.status === "FAILED" ? "border-rose-200 bg-rose-50" : step.status === "SKIPPED" ? "border-slate-100 bg-slate-50" : "border-slate-200"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-white font-mono text-xs font-bold ring-1 ring-slate-200">{step.stepIndex + 1}</span>
                <StatusBadge status={step.status} />
                <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs">{step.action}</span>
                <span className="text-sm">{step.description}</span>
                <span className="ml-auto text-xs text-slate-400">{formatDuration(step.durationMs)}</span>
              </div>
              {step.locator && (
                <p className="mt-2 break-all pl-8 font-mono text-xs text-slate-500">
                  {String(step.locator.strategy)}: {String(step.locator.value)}
                </p>
              )}
              {step.failureMessage && (
                <div className="mt-2 pl-8">
                  <p className="font-mono text-xs font-bold text-rose-700">{step.failureCategory}</p>
                  <p className="mt-1 break-words text-xs text-rose-900">{step.failureMessage}</p>
                  {step.pageUrl && <p className="mt-1 break-all text-xs text-slate-500">at {step.pageUrl}</p>}
                </div>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="font-display text-lg font-bold">Screenshots</h2>
        <p className="mt-1 mb-5 text-sm text-slate-500">Captured during the run and served through short-lived signed URLs.</p>
        <ArtifactGrid artifacts={screenshots} emptyDetail="No screenshots were captured for this execution." annotate />
      </section>

      {other.length > 0 && (
        <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="font-display text-lg font-bold">Video, trace, and logs</h2>
          <p className="mt-1 mb-5 text-sm text-slate-500">Only artifacts that were actually written appear here.</p>
          <ArtifactGrid artifacts={other} emptyDetail="No additional artifacts." />
        </section>
      )}

      {comparisons.data && comparisons.data.length > 0 && (
        <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="font-display text-lg font-bold">Visual comparisons</h2>
          <div className="mt-4 space-y-3">
            {comparisons.data.map(comparison => (
              <div key={comparison.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 p-4 text-sm">
                <StatusBadge status={comparison.status} />
                <span className="font-semibold">{comparison.baseline?.name ?? "baseline"}</span>
                <span className="text-slate-500">
                  {comparison.diffRatio === null ? "not measured" : `${(comparison.diffRatio * 100).toFixed(3)}% different`} · threshold {(comparison.threshold * 100).toFixed(2)}%
                </span>
                {!comparison.dimensionsMatch && <span className="text-xs font-bold text-rose-700">dimensions changed</span>}
              </div>
            ))}
          </div>
        </section>
      )}
    </Shell>
  );
}
