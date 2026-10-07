"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Button } from "@/components/ui";
import { AssigneeSelect } from "@/components/bugs/raise-bug-dialog";
import { ApiError, api } from "@/lib/api";
import { bugStatusMeta, transitionVerb, type BugStatus } from "@/lib/bugs";
import { useResource } from "@/lib/use-resource";

/** Moves that ask for something before they can be made. Mirrors `checkTransition` in the API. */
export const transitionNeeds: Partial<Record<BugStatus, "assignee" | "resolution" | "reason" | "duplicate">> = {
  ASSIGNED: "assignee",
  FIXED: "resolution",
  REJECTED: "reason",
  DEFERRED: "reason",
  REOPENED: "reason",
  DUPLICATE: "duplicate",
};

const field = "mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-violet-500";

/**
 * Confirms one workflow move and collects whatever it requires. When several moves are possible
 * (dropping onto "Parked" can mean deferred, rejected, or duplicate) the person picks one first.
 * The API remains the authority; a refusal is shown here, not swallowed.
 */
export function TransitionDialog({ bug, options, onClose, onDone }: { bug: { id: string; reference: string; title: string; assigneeId?: string | null }; options: BugStatus[]; onClose: () => void; onDone: () => void }) {
  const [to, setTo] = useState<BugStatus>(options[0]);
  const [note, setNote] = useState("");
  const [resolution, setResolution] = useState("");
  const [assigneeId, setAssigneeId] = useState(bug.assigneeId ?? "");
  const [duplicateOfId, setDuplicateOfId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLFormElement>(null);
  const need = transitionNeeds[to];
  const candidates = useResource(() => (need === "duplicate" ? api.get<{ duplicateCandidates: { id: string; reference: string; title: string }[] }>(`/api/v1/bugs/${bug.id}`).then(detail => detail.duplicateCandidates) : Promise.resolve([])), [bug.id, need]);

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>("select, textarea, button[type=submit]")?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/v1/bugs/${bug.id}/transition`, {
        to,
        ...(note.trim() ? { note } : {}),
        ...(to === "FIXED" ? { resolution } : {}),
        ...(to === "ASSIGNED" ? { assigneeId: assigneeId || null } : {}),
        ...(to === "DUPLICATE" ? { duplicateOfId } : {}),
      });
      onDone();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The bug could not be moved.");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" onClick={onClose}>
      <form ref={panelRef} onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="move-title" className="w-full max-w-md space-y-4 rounded-xl bg-white p-6 shadow-xl" onClick={event => event.stopPropagation()}>
        <div>
          <h2 id="move-title" className="font-display text-lg font-bold text-slate-900">{options.length > 1 ? "Move bug" : `${transitionVerb[to]} → ${bugStatusMeta[to].label}`}</h2>
          <p className="mt-0.5 truncate text-sm text-slate-500"><span className="font-mono font-semibold">{bug.reference}</span> · {bug.title}</p>
        </div>
        {options.length > 1 && (
          <fieldset>
            <legend className="text-xs font-semibold text-slate-700">Move to</legend>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {options.map(option => (
                <label key={option} className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm ${to === option ? "border-violet-500 bg-violet-50 font-semibold text-violet-800" : "border-slate-300 text-slate-700"}`}>
                  <input type="radio" name="move-to" value={option} checked={to === option} onChange={() => setTo(option)} className="sr-only" />
                  {bugStatusMeta[option].label}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {need === "assignee" && (
          <div>
            <label htmlFor="dialog-assignee" className="text-xs font-semibold text-slate-700">Assign to <span className="text-rose-600">*</span></label>
            <AssigneeSelect id="dialog-assignee" value={assigneeId} onChange={setAssigneeId} allowNone={false} />
          </div>
        )}
        {need === "resolution" && (
          <label className="block text-xs font-semibold text-slate-700">
            What was changed? <span className="text-rose-600">*</span>
            <textarea value={resolution} onChange={event => setResolution(event.target.value)} rows={3} maxLength={2000} placeholder="Describe the fix so QA knows what to retest." className={field} />
          </label>
        )}
        {need === "duplicate" && (
          <label className="block text-xs font-semibold text-slate-700">
            Duplicate of <span className="text-rose-600">*</span>
            <select value={duplicateOfId} onChange={event => setDuplicateOfId(event.target.value)} className={field}>
              <option value="">{candidates.loading ? "Loading…" : "Choose a bug"}</option>
              {candidates.data?.map(item => <option key={item.id} value={item.id}>{item.reference} · {item.title}</option>)}
            </select>
            {!candidates.loading && !candidates.data?.length && <span className="mt-1 block font-normal text-slate-500">No other open bug exists on the same test case.</span>}
          </label>
        )}
        <label className="block text-xs font-semibold text-slate-700">
          {need === "reason" ? <>Reason <span className="text-rose-600">*</span></> : "Note (optional)"}
          <textarea value={note} onChange={event => setNote(event.target.value)} rows={2} maxLength={2000} className={field} />
        </label>
        {error && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy}>{transitionVerb[to]}</Button>
        </div>
      </form>
    </div>
  );
}

/** List / Board / Tracking switcher shared by the three bug views. */
export function BugViewsNav({ current }: { current: "list" | "board" | "tracking" }) {
  const items = [
    { key: "list", label: "List", href: "/bugs" },
    { key: "board", label: "Board", href: "/bugs/board" },
    { key: "tracking", label: "Tracking", href: "/bugs/tracking" },
  ] as const;
  return (
    <nav aria-label="Bug views" className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5">
      {items.map(item => (
        <Link key={item.key} href={item.href} aria-current={current === item.key ? "page" : undefined} className={`rounded-md px-3.5 py-1.5 text-sm font-semibold ${current === item.key ? "bg-[#111c38] text-white" : "text-slate-600 hover:bg-slate-50"}`}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
