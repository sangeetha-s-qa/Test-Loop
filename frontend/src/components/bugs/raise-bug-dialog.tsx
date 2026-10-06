"use client";

import { useEffect, useRef, useState } from "react";
import { BugPlay } from "lucide-react";
import { Button } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { priorityMeta, severityMeta, teamLabels, type Assignee, type BugPriority, type BugSeverity } from "@/lib/bugs";
import { useResource } from "@/lib/use-resource";

const field = "mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-violet-500";

/** Assignee picker: developers first, each with how many open bugs they already carry. */
export function AssigneeSelect({ value, onChange, id, allowNone = true, disabled }: { value: string; onChange: (value: string) => void; id: string; allowNone?: boolean; disabled?: boolean }) {
  const people = useResource(() => api.get<Assignee[]>("/api/v1/team/assignees"), []);
  return (
    <select id={id} value={value} onChange={event => onChange(event.target.value)} disabled={disabled || people.loading} className={field}>
      {allowNone && <option value="">{people.loading ? "Loading team…" : "Unassigned"}</option>}
      {people.data?.map(person => (
        <option key={person.id} value={person.id}>
          {person.name} · {teamLabels[person.team]} · {person.openBugs} open
        </option>
      ))}
    </select>
  );
}

/**
 * Raises a bug from one failed manual case. Title, steps, expected and actual results, notes, and
 * screenshots all come from the case; the tester chooses triage and, optionally, the developer.
 */
export function RaiseBugDialog({ runId, testCase, onClose, onRaised }: { runId: string; testCase: { id: string; testCaseId: string; title: string; priority?: string }; onClose: () => void; onRaised: (bug: { id: string; reference: string }) => void }) {
  const [title, setTitle] = useState(`${testCase.title} - failed`);
  const [severity, setSeverity] = useState<BugSeverity>((["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(testCase.priority ?? "") ? testCase.priority : "MEDIUM") as BugSeverity);
  const [priority, setPriority] = useState<BugPriority>("P3");
  const [assigneeId, setAssigneeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const bug = await api.post<{ id: string; reference: string }>(`/api/v1/manual-runs/${runId}/test-cases/${testCase.id}/bug`, { title, severity, priority, assigneeId: assigneeId || null });
      onRaised(bug);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The bug could not be raised.");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="raise-bug-title" className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl" onClick={event => event.stopPropagation()}>
        <h2 id="raise-bug-title" className="flex items-center gap-2 font-display text-lg font-bold text-slate-900">
          <BugPlay size={19} className="text-rose-600" /> Raise bug from {testCase.testCaseId}
        </h2>
        <p className="mt-1 text-sm text-slate-500">Steps, expected and actual results, your notes, and the case&apos;s screenshots are attached automatically.</p>

        <div className="mt-5 space-y-4">
          <label className="block text-sm font-semibold text-slate-800">
            Title
            <input ref={titleRef} value={title} onChange={event => setTitle(event.target.value)} maxLength={300} className={field} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm font-semibold text-slate-800">
              Severity
              <select value={severity} onChange={event => setSeverity(event.target.value as BugSeverity)} className={field}>
                {(Object.keys(severityMeta) as BugSeverity[]).map(value => <option key={value} value={value}>{severityMeta[value].label}</option>)}
              </select>
            </label>
            <label className="block text-sm font-semibold text-slate-800">
              Priority
              <select value={priority} onChange={event => setPriority(event.target.value as BugPriority)} className={field}>
                {(Object.keys(priorityMeta) as BugPriority[]).map(value => <option key={value} value={value}>{value} · {priorityMeta[value].detail}</option>)}
              </select>
            </label>
          </div>
          <div>
            <label htmlFor="raise-assignee" className="block text-sm font-semibold text-slate-800">Assign to <span className="font-normal text-slate-400">(optional)</span></label>
            <AssigneeSelect id="raise-assignee" value={assigneeId} onChange={setAssigneeId} />
            <p className="mt-1 text-xs text-slate-500">Leave unassigned to triage later. The assignee is notified in the app.</p>
          </div>
        </div>

        {error && <p role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={busy} disabled={title.trim().length < 3} onClick={submit}>Raise bug</Button>
        </div>
      </div>
    </div>
  );
}
