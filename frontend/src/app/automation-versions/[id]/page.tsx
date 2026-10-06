"use client";

import { use, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Check, Code2, ListOrdered, X } from "lucide-react";
import { Shell } from "@/components/shell";
import { ErrorState, LoadingState, StatusBadge } from "@/components/states";
import { api, ApiError, type AutomationVersion, type ValidationIssue } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

type Detail = AutomationVersion & {
  script: { id: string; testCaseId: string; approvedVersionId: string | null };
  testCaseVersion: { id: string; version: number; title: string; steps: { step: number; action: string; expectedResult: string }[]; expectedResult: string };
};

const assertionActions = new Set(["expectVisible", "expectHidden", "expectText", "expectValue", "expectUrl", "expectTitle", "expectCount"]);

export default function AutomationVersionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const version = useResource(() => api.get<Detail>(`/api/v1/automation-versions/${id}`), [id]);
  const [tab, setTab] = useState<"steps" | "code">("steps");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const review = async (decision: "approve" | "reject") => {
    setBusy(true);
    setError("");
    try {
      await api.post(`/api/v1/automation-versions/${id}/${decision}`);
      version.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  };

  if (version.loading) {
    return (
      <Shell title="Automation version">
        <LoadingState label="Loading automation version" />
      </Shell>
    );
  }
  if (version.error || !version.data) {
    return (
      <Shell title="Automation version">
        <ErrorState error={version.error ?? new Error("Not found")} retry={version.reload} />
      </Shell>
    );
  }

  const data = version.data;
  const errors = (data.validationIssues ?? []).filter((issue: ValidationIssue) => issue.severity === "ERROR");
  const warnings = (data.validationIssues ?? []).filter((issue: ValidationIssue) => issue.severity === "WARNING");
  const canApprove = data.status === "DRAFT" && data.validationStatus !== "FAILED";

  return (
    <Shell title={`${data.program.name} · v${data.version}`} subtitle={`Generated from test case version ${data.testCaseVersion.version}`}>
      <Link href={`/test-cases/${data.script.testCaseId}`} className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-slate-500">
        <ArrowLeft size={16} />
        Test case
      </Link>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0">
          <div className="mb-4 flex gap-1 rounded-lg border border-slate-200 bg-white p-1">
            <button onClick={() => setTab("steps")} className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-semibold ${tab === "steps" ? "bg-slate-100" : "text-slate-500"}`}>
              <ListOrdered size={15} />
              Program ({data.stepCount} steps)
            </button>
            <button onClick={() => setTab("code")} className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-semibold ${tab === "code" ? "bg-slate-100" : "text-slate-500"}`}>
              <Code2 size={15} />
              Playwright spec
            </button>
          </div>

          {tab === "steps" ? (
            <ol className="space-y-2">
              {data.program.steps.map((step, index) => (
                <li key={index} className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-slate-100 font-mono text-xs font-bold">{index + 1}</span>
                    <span className={`rounded px-2 py-0.5 font-mono text-xs font-bold ${assertionActions.has(step.action) ? "bg-emerald-50 text-emerald-700" : "bg-violet-50 text-violet-700"}`}>{step.action}</span>
                    <span className="text-sm">{step.description}</span>
                  </div>
                  {step.locator && (
                    <p className="mt-2 break-all pl-8 font-mono text-xs text-slate-500">
                      {String(step.locator.strategy)}: {String(step.locator.value)}
                      {step.locator.name ? ` (name: ${String(step.locator.name)})` : ""}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <div>
              <p className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                This spec is rendered from the program for review and export. The runner interprets the program directly and never evaluates this source.
              </p>
              <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-[#111c38] p-5 font-mono text-xs leading-relaxed text-slate-100">{data.sourceCode}</pre>
            </div>
          )}
        </div>

        <aside className="h-fit space-y-4 lg:sticky lg:top-6">
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-500">Version status</span>
              <StatusBadge status={data.status} />
            </div>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500">Validation</dt>
                <dd>
                  <StatusBadge status={data.validationStatus} />
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Steps</dt>
                <dd className="font-semibold">{data.stepCount}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Assertions</dt>
                <dd className="font-semibold">{data.assertionCount}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Source</dt>
                <dd className="font-semibold">{data.source.replace("_", " ").toLowerCase()}</dd>
              </div>
              {data.provider && (
                <div className="flex justify-between gap-3">
                  <dt className="shrink-0 text-slate-500">Model</dt>
                  <dd className="truncate font-semibold">{data.provider}/{data.model}</dd>
                </div>
              )}
            </dl>

            {error && <p className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}

            {data.status === "DRAFT" ? (
              <div className="mt-5 space-y-2">
                <button disabled={busy || !canApprove} onClick={() => review("approve")} className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40">
                  <Check size={15} />
                  Approve for execution
                </button>
                <button disabled={busy} onClick={() => review("reject")} className="flex w-full items-center justify-center gap-2 rounded-lg border border-rose-200 px-4 py-2.5 text-sm font-bold text-rose-700 disabled:opacity-40">
                  <X size={15} />
                  Reject
                </button>
                {!canApprove && <p className="text-xs text-rose-600">A version that failed policy validation cannot be approved.</p>}
              </div>
            ) : (
              <p className="mt-5 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
                {data.status === "APPROVED" ? "This version is approved and is what executes." : data.status === "SUPERSEDED" ? "A newer version has been approved. This one is kept for history and cannot be changed." : "This version was rejected. It is kept for history."}
              </p>
            )}
          </div>

          {(errors.length > 0 || warnings.length > 0) && (
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <h3 className="flex items-center gap-2 font-display font-bold">
                <AlertTriangle size={16} className={errors.length ? "text-rose-600" : "text-amber-600"} />
                Policy validation
              </h3>
              <ul className="mt-3 space-y-2.5 text-xs">
                {[...errors, ...warnings].map((issue, index) => (
                  <li key={index} className={`rounded-lg p-3 ${issue.severity === "ERROR" ? "bg-rose-50 text-rose-800" : "bg-amber-50 text-amber-800"}`}>
                    <p className="font-mono font-bold">
                      {issue.code}
                      {issue.stepIndex !== null && ` · step ${issue.stepIndex + 1}`}
                    </p>
                    <p className="mt-1">{issue.message}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h3 className="font-display font-bold">Test case it covers</h3>
            <p className="mt-2 text-sm font-semibold">{data.testCaseVersion.title}</p>
            <p className="mt-1 text-xs text-slate-500">Version {data.testCaseVersion.version} · {data.testCaseVersion.steps.length} manual steps</p>
            <p className="mt-3 text-xs text-slate-600">
              <b>Expected:</b> {data.testCaseVersion.expectedResult}
            </p>
          </div>
        </aside>
      </div>
    </Shell>
  );
}
