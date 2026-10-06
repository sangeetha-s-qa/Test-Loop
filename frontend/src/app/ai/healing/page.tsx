"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, X } from "lucide-react";
import { Shell } from "@/components/shell";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/states";
import { Button, Card } from "@/components/ui";
import { ApiError, api, formatRelative, type HealingRecord } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

/** Renders a locator the way the runner reads it, so the two can be compared directly. */
function Locator({ value, tone }: { value: Record<string, unknown>; tone: "failed" | "proposed" }) {
  const strategy = typeof value.strategy === "string" ? value.strategy : "?";
  const target = typeof value.value === "string" ? value.value : JSON.stringify(value.value ?? "");
  const name = typeof value.name === "string" ? value.name : null;
  return (
    <span className={`inline-flex flex-wrap items-baseline gap-1.5 rounded-lg border px-3 py-2 font-mono text-xs ${tone === "failed" ? "border-rose-200 bg-rose-50 text-rose-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>
      <b className="font-semibold">{strategy}</b>
      <span className="break-all">{target}</span>
      {name && <span className="opacity-70">name={name}</span>}
    </span>
  );
}

export default function SelfHealingPage() {
  const proposals = useResource(() => api.get<HealingRecord[]>("/api/v1/healing-proposals"), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Approval creates a new automation version; nothing is rewritten in place. */
  const decide = async (id: string, decision: "approve" | "reject") => {
    setBusy(id);
    setError(null);
    try {
      await api.post(`/api/v1/healing-proposals/${id}/${decision}`);
      proposals.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : "The action could not be completed.");
    } finally {
      setBusy(null);
    }
  };

  const open = (proposals.data ?? []).filter(item => item.status === "PROPOSED");

  return (
    <Shell title="Self healing" subtitle={proposals.data ? `${open.length} proposal${open.length === 1 ? "" : "s"} awaiting review` : "Locator repairs proposed from real failures"}>
      {proposals.loading ? (
        <LoadingState label="Loading healing proposals" />
      ) : proposals.error ? (
        <ErrorState error={proposals.error} retry={proposals.reload} />
      ) : (proposals.data?.length ?? 0) === 0 ? (
        <EmptyState
          title="No healing proposals"
          detail="A proposal is created when an execution fails because a locator no longer matches, and a better candidate is found in the captured DOM."
          action={
            <Link href="/test-runs" className="rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-semibold text-white">
              View test runs
            </Link>
          }
        />
      ) : (
        <>
          {error && <p role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</p>}

          <p className="mb-5 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
            Approving a proposal creates a new automation version for review. Nothing is applied to a running
            test automatically.
          </p>

          <div className="flex flex-col gap-4">
            {proposals.data?.map(item => (
              <Card key={item.id} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-xs font-bold text-violet-600">{item.script.testCase.testCaseId}</p>
                    <h2 className="mt-1 font-display text-base font-bold text-slate-900">{item.script.testCase.title}</h2>
                    <p className="mt-1 text-sm text-slate-500">
                      Step {item.stepIndex + 1}
                      {item.automationVersion && ` · automation v${item.automationVersion.version}`}
                    </p>
                  </div>
                  <StatusBadge status={item.status} />
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Locator value={item.failedLocator} tone="failed" />
                  <ArrowRight size={16} className="shrink-0 text-slate-400" />
                  <Locator value={item.proposedLocator} tone="proposed" />
                </div>

                <p className="mt-3 text-sm text-slate-700">{item.rationale}</p>

                <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
                  <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500">
                    <span>Confidence <b className="font-mono tabular-nums text-slate-700">{Math.round(item.confidence * 100)}%</b></span>
                    {item.model && <span className="font-mono">{item.provider}/{item.model}</span>}
                    <span>{formatRelative(item.createdAt)}</span>
                  </div>

                  {item.status === "PROPOSED" && (
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => decide(item.id, "approve")} loading={busy === item.id} icon={<Check size={13} />} className="bg-emerald-700 hover:bg-emerald-800">
                        Approve
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => decide(item.id, "reject")} disabled={busy !== null} icon={<X size={13} />}>
                        Reject
                      </Button>
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
    </Shell>
  );
}
