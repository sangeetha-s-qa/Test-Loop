"use client";

import { use, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Play, ShieldCheck, Sparkles, Square } from "lucide-react";
import { Shell } from "@/components/shell";
import { BlockedNotice, EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/states";
import { api, ApiError, type AiStatus, type AutomationGenerationRun, type AutomationScript, type TestCase } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

const activeStatuses = ["QUEUED", "GENERATING", "VALIDATING"];

export default function AutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [action, setAction] = useState<{ busy: boolean; error: string }>({ busy: false, error: "" });

  const scripts = useResource(() => api.get<AutomationScript[]>(`/api/v1/test-runs/${id}/automation`), [id]);
  const testCases = useResource(() => api.get<TestCase[]>(`/api/v1/test-runs/${id}/test-cases`), [id]);
  const aiStatus = useResource(() => api.get<AiStatus>("/api/v1/ai/status"), []);
  const generation = useResource(() => api.get<AutomationGenerationRun | null>(`/api/v1/test-runs/${id}/automation/status`), [id], {
    intervalMs: 3000,
    shouldPoll: run => !!run && activeStatuses.includes(run.status),
  });

  const approvedCases = (testCases.data ?? []).filter(testCase => testCase.status === "APPROVED");
  const running = !!generation.data && activeStatuses.includes(generation.data.status);

  const call = async (path: string, onDone: () => void) => {
    setAction({ busy: true, error: "" });
    try {
      await api.post(path);
      onDone();
    } catch (error) {
      setAction({ busy: false, error: error instanceof ApiError ? error.message : "The request failed." });
      return;
    }
    setAction({ busy: false, error: "" });
  };

  return (
    <Shell title="Automation" subtitle="Generate and review executable automation for approved test cases">
      <Link href={`/test-runs/${id}`} className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-slate-500">
        <ArrowLeft size={16} />
        Test run
      </Link>

      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 font-display text-lg font-bold">
              <Sparkles size={18} className="text-violet-600" />
              Automation generation
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              {generation.data ? (
                <>
                  Last run: <b>{generation.data.status}</b> · {generation.data.generatedCount} generated, {generation.data.failedCount} failed · {generation.data.provider}/{generation.data.model}
                </>
              ) : (
                "No automation generation has run for this test run yet."
              )}
            </p>
          </div>
          <div className="flex gap-2">
            {running ? (
              <button
                disabled={action.busy}
                onClick={() => call(`/api/v1/test-runs/${id}/automation/cancel`, generation.reload)}
                className="flex items-center gap-1.5 rounded-lg border border-rose-200 px-3 py-2.5 text-sm font-bold text-rose-700 disabled:opacity-50"
              >
                <Square size={14} />
                Cancel
              </button>
            ) : (
              <button
                disabled={action.busy || approvedCases.length === 0 || aiStatus.data?.ready === false}
                onClick={() =>
                  call(`/api/v1/test-runs/${id}/automation/generate`, () => {
                    generation.reload();
                    scripts.reload();
                  })
                }
                className="flex items-center gap-1.5 rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40"
              >
                <Sparkles size={15} />
                {generation.data ? "Generate again" : "Generate automation"}
              </button>
            )}
          </div>
        </div>

        {action.error && <p className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{action.error}</p>}
        {generation.data?.error && <p className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{generation.data.error}</p>}

        {aiStatus.data && !aiStatus.data.ready && (
          <div className="mt-4">
            <BlockedNotice title="The AI provider is not usable right now" detail={aiStatus.data.detail ?? "The configured provider did not respond."}>
              <p className="font-mono text-xs text-amber-900">{aiStatus.data.code}</p>
            </BlockedNotice>
          </div>
        )}

        {!testCases.loading && approvedCases.length === 0 && (
          <div className="mt-4">
            <BlockedNotice title="No approved test cases" detail="Automation is only generated from approved test cases, so the script always matches content a person signed off on.">
              <Link href={`/test-runs/${id}/test-cases`} className="text-sm font-bold text-amber-900 underline">
                Review test cases
              </Link>
            </BlockedNotice>
          </div>
        )}

        {running && (
          <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-800">
            Generating automation… {generation.data?.generatedCount ?? 0} of {generation.data?.requestedCount ?? 0} complete.
          </div>
        )}
      </section>

      <h2 className="mt-8 mb-4 font-display text-lg font-bold">Automation scripts</h2>

      {scripts.loading ? (
        <LoadingState label="Loading automation" />
      ) : scripts.error ? (
        <ErrorState error={scripts.error} retry={scripts.reload} />
      ) : (scripts.data ?? []).length === 0 ? (
        <EmptyState title="No automation has been generated yet" detail="Approve at least one test case, then generate automation. Nothing is executable until a version is approved." />
      ) : (
        <div className="space-y-4">
          {scripts.data!.map(script => (
            <article key={script.id} className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-xs text-violet-600">{script.testCase.testCaseId}</p>
                  <h3 className="mt-1 font-display font-bold">{script.testCase.title}</h3>
                  <p className="mt-1 text-xs text-slate-500">
                    {script.testCase.module} · {script.versions.length} version{script.versions.length === 1 ? "" : "s"}
                  </p>
                </div>
                {script.approvedVersion ? (
                  <span className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700 ring-1 ring-inset ring-emerald-200">
                    <ShieldCheck size={13} />v{script.approvedVersion.version} approved
                  </span>
                ) : (
                  <span className="rounded-full bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-700 ring-1 ring-inset ring-amber-200">Awaiting approval</span>
                )}
              </div>

              <div className="mt-4 divide-y divide-slate-100 border-t border-slate-100">
                {script.versions.map(version => (
                  <div key={version.id} className="flex flex-wrap items-center gap-3 py-3">
                    <span className="w-12 font-mono text-sm font-bold">v{version.version}</span>
                    <StatusBadge status={version.status} />
                    <StatusBadge status={version.validationStatus} />
                    <span className="text-xs text-slate-500">
                      {version.stepCount} steps · {version.assertionCount} assertion{version.assertionCount === 1 ? "" : "s"} · {version.source.replace("_", " ").toLowerCase()}
                    </span>
                    <Link href={`/automation-versions/${version.id}`} className="ml-auto text-sm font-bold text-violet-600">
                      Review
                    </Link>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}

      {(scripts.data ?? []).some(script => script.approvedVersion) && (
        <div className="mt-6 flex justify-end">
          <Link href={`/test-runs/${id}/executions`} className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-3 text-sm font-bold text-white">
            <Play size={16} />
            Go to executions
          </Link>
        </div>
      )}
    </Shell>
  );
}
