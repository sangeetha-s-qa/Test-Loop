"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Hand, X } from "lucide-react";
import { Button } from "@/components/ui";
import { ApiError, api, manualActionTitles, type ManualAction } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

/**
 * The human-in-the-loop surface: a banner on the run, and the dialog that answers it.
 *
 * Nothing here collects the code. The person completes the action in their own browser and tells
 * us only that they finished, which is why the confirm button posts an empty body. A field for the
 * OTP would be the one place in the product capable of leaking one.
 */

/**
 * Counts down to a deadline and reports when it has passed, so the UI never offers a dead button.
 *
 * Only the clock is state; the remainder is derived from it. Storing the remainder instead would
 * mean re-syncing it whenever the deadline moved - which it does, every time someone extends.
 */
function useCountdown(deadlineAt: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const remainingMs = new Date(deadlineAt).getTime() - now;
  const clamped = Math.max(0, remainingMs);
  const minutes = Math.floor(clamped / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  return { expired: remainingMs <= 0, remainingMs: clamped, label: `${minutes}:${seconds.toString().padStart(2, "0")}` };
}

function Countdown({ deadlineAt, totalMs }: { deadlineAt: string; totalMs: number }) {
  const { expired, label, remainingMs: remaining } = useCountdown(deadlineAt);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <span className="font-mono text-lg font-bold tabular-nums text-slate-900">{expired ? "0:00" : label}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-slate-600">{expired ? "the waiting period has ended" : "until this run gives up"}</p>
        <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-slate-200">
          <span className="block h-full bg-amber-600" style={{ width: `${Math.min(100, (remaining / Math.max(1, totalMs)) * 100)}%` }} />
        </span>
      </div>
    </div>
  );
}

function Dialog({ action, onClose, onSettled }: { action: ManualAction; onClose: () => void; onSettled: () => void }) {
  const [busy, setBusy] = useState<"resolve" | "abort" | "extend" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { expired } = useCountdown(action.deadlineAt);
  const totalMs = new Date(action.deadlineAt).getTime() - new Date(action.createdAt).getTime();

  // Escape closes, matching every other dismissable surface in the product.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const send = async (verb: "resolve" | "abort" | "extend") => {
    setBusy(verb);
    setError(null);
    try {
      await api.post(`/api/v1/manual-actions/${action.id}/${verb}`);
      onSettled();
      if (verb !== "extend") onClose();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "The action could not be completed.");
      onSettled();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/55 p-4 sm:p-8">
      <div role="dialog" aria-modal="true" aria-labelledby="manual-action-title" className="w-full max-w-xl overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-center gap-3 border-b border-slate-200 p-5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-amber-200 bg-amber-50 text-amber-700">
            <Hand size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="manual-action-title" className="font-display text-lg font-bold text-slate-900">
              {manualActionTitles[action.reason]}
            </h2>
            <p className="truncate text-xs text-slate-500">
              {action.execution.testCase.testCaseId} · {action.execution.testCase.title} · step {action.stepIndex + 1}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100">
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-4 p-5">
          <p className="text-sm text-slate-800">{action.prompt}</p>

          {action.pageUrl && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">The run is waiting on</p>
              <p className="mt-1 break-all font-mono text-xs text-slate-700">{action.pageUrl}</p>
            </div>
          )}

          <ol className="flex flex-col gap-1.5 rounded-lg bg-slate-50 p-4 text-sm text-slate-700">
            <li>1. Open the application in your own browser.</li>
            <li>2. Complete the step described above.</li>
            <li>3. Come back here and confirm.</li>
          </ol>

          <p className="rounded-lg border border-violet-200 bg-violet-50 p-3 text-xs text-violet-900">
            <strong className="font-display font-bold">We never ask for the code.</strong> Whatever you enter goes into your own browser.
            Testloop is told only that you finished, and no one-time code is ever stored.
          </p>

          <Countdown deadlineAt={action.deadlineAt} totalMs={totalMs} />

          {expired && (
            <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
              The waiting period ended. This run has stopped and will need to be started again.
            </p>
          )}
          {error && (
            <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-800">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 pt-4">
            <Button variant="ghost" onClick={() => send("extend")} loading={busy === "extend"} disabled={busy !== null || expired}>
              Give me longer
            </Button>
            <Button variant="secondary" onClick={() => send("abort")} loading={busy === "abort"} disabled={busy !== null}>
              Stop this test
            </Button>
            <Button onClick={() => send("resolve")} loading={busy === "resolve"} disabled={busy !== null || expired}>
              I&rsquo;ve completed it
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Banner shown on a run that is blocked on a person.
 *
 * Polls on a short interval: the alternative is a user discovering minutes later that the run has
 * been waiting on them the whole time. It renders nothing at all when nothing is pending, so it is
 * safe to mount unconditionally.
 */
export function ManualActionBanner({ testRunId }: { testRunId: string }) {
  // The *id* of the action being shown, not a boolean. If the pause is settled elsewhere - by a
  // colleague, or by the deadline passing - the dialog closes on its own because the id no longer
  // matches, and a later unrelated pause does not inherit an open dialog.
  const [openId, setOpenId] = useState<string | null>(null);
  const actions = useResource<ManualAction[]>(() => api.get(`/api/v1/test-runs/${testRunId}/manual-actions`), [testRunId], {
    intervalMs: 5000,
    shouldPoll: () => true,
  });

  const pending = actions.data?.find(action => action.status === "PENDING") ?? null;
  if (!pending) return null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-amber-600 text-white">
          <AlertTriangle size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display font-bold text-amber-900">Waiting for you — {manualActionTitles[pending.reason].toLowerCase()}</p>
          <p className="mt-0.5 text-sm text-amber-800">
            {pending.execution.testCase.testCaseId} is paused. The browser is held open with its session, so the run can continue once you have acted.
          </p>
        </div>
        <Button onClick={() => setOpenId(pending.id)}>Open</Button>
      </div>
      {openId === pending.id && <Dialog action={pending} onClose={() => setOpenId(null)} onSettled={actions.reload} />}
    </>
  );
}
