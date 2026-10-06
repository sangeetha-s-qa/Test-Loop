"use client";

import { use, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { Shell } from "@/components/shell";
import { ErrorState, LoadingState, StatusBadge } from "@/components/states";
import { ApiError, api, type TestCase } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

type Step = TestCase["steps"][number];

const priorities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const severities = ["CRITICAL", "MAJOR", "MODERATE", "MINOR", "MEDIUM", "HIGH", "LOW"];

export default function TestCaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const testCase = useResource(() => api.get<TestCase>(`/api/v1/test-cases/${id}`), [id]);

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const review = async (action: "approve" | "reject") => {
    setBusy(true);
    setActionError(null);
    try {
      await api.post(`/api/v1/test-cases/${id}/${action}`);
      testCase.reload();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : "Unable to update this test case.");
    } finally {
      setBusy(false);
    }
  };

  const item = testCase.data;

  return (
    <Shell title={item?.title ?? "Test case"} subtitle={item?.testCaseId}>
      <Link href={item ? `/test-runs/${item.testRunId}/test-cases` : "/test-runs"} className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-slate-900">
        <ArrowLeft size={16} />
        Test cases
      </Link>

      {testCase.loading ? (
        <LoadingState label="Loading test case" />
      ) : testCase.error ? (
        <ErrorState error={testCase.error} retry={testCase.reload} />
      ) : item ? (
        <article className="max-w-4xl rounded-xl border border-slate-200 bg-white p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-xs font-bold text-violet-600">{item.testCaseId}</p>
              <h2 className="mt-2 font-display text-2xl font-bold">{item.title}</h2>
              {item.modifiedByUser && <p className="mt-1 text-xs text-slate-500">Edited by a reviewer · version {item.currentVersion}</p>}
            </div>
            <StatusBadge status={item.status} />
          </div>

          <dl className="mt-6 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            {[
              ["Module", item.module],
              ["Category", item.category],
              ["Priority", item.priority],
              ["Severity", item.severity],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs uppercase tracking-wide text-slate-400">{label}</dt>
                <dd className="mt-1 font-semibold">{value}</dd>
              </div>
            ))}
          </dl>

          <section className="mt-7 space-y-5 text-sm">
            <div>
              <h3 className="font-display font-bold">Objective</h3>
              <p className="mt-1 text-slate-600">{item.description || "None specified."}</p>
            </div>
            <div>
              <h3 className="font-display font-bold">Preconditions</h3>
              <p className="mt-1 text-slate-600">{item.preconditions || "None specified."}</p>
            </div>
            <div>
              <h3 className="font-display font-bold">Steps</h3>
              {item.steps.length === 0 ? (
                <p className="mt-1 text-slate-500">This case has no steps.</p>
              ) : (
                <ol className="mt-2 space-y-2">
                  {item.steps.map(step => (
                    <li key={step.step} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                      <p className="font-semibold">
                        {step.step}. {step.action}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">Expected: {step.expectedResult}</p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div>
              <h3 className="font-display font-bold">Expected result</h3>
              <p className="mt-1 text-slate-600">{item.expectedResult || "None specified."}</p>
            </div>
            {item.postconditions && (
              <div>
                <h3 className="font-display font-bold">Postconditions</h3>
                <p className="mt-1 text-slate-600">{item.postconditions}</p>
              </div>
            )}
          </section>

          {actionError && <p className="mt-6 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{actionError}</p>}

          <div className="mt-7 flex flex-wrap gap-2">
            {item.status === "DRAFT" && (
              <>
                <button onClick={() => review("approve")} disabled={busy} className="flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">
                  <Check size={15} />
                  Approve
                </button>
                <button onClick={() => review("reject")} disabled={busy} className="flex items-center gap-1.5 rounded-lg border border-rose-300 px-4 py-2.5 text-sm font-bold text-rose-700 disabled:opacity-50">
                  <X size={15} />
                  Reject
                </button>
              </>
            )}
            <button onClick={() => setEditing(value => !value)} className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-bold text-slate-700">
              <Pencil size={15} />
              {editing ? "Close editor" : "Edit"}
            </button>
          </div>

          {editing && <EditForm item={item} onSaved={() => { setEditing(false); testCase.reload(); }} />}
        </article>
      ) : null}
    </Shell>
  );
}

/**
 * Edits the fields the API accepts. Saving marks the case as reviewer-modified, which is what
 * distinguishes a human-curated case from raw generated output.
 */
function EditForm({ item, onSaved }: { item: TestCase; onSaved: () => void }) {
  // Seeded once on mount. The editor is unmounted whenever it closes, so reopening it always starts
  // from the freshly loaded record without syncing prop to state.
  const [draft, setDraft] = useState(item);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof TestCase>(key: K, value: TestCase[K]) => setDraft(current => ({ ...current, [key]: value }));

  const setStep = (index: number, patch: Partial<Step>) =>
    setDraft(current => ({ ...current, steps: current.steps.map((step, position) => (position === index ? { ...step, ...patch } : step)) }));

  const addStep = () => setDraft(current => ({ ...current, steps: [...current.steps, { step: current.steps.length + 1, action: "", expectedResult: "" }] }));

  // Renumbered so the stored step numbers stay contiguous after a removal.
  const removeStep = (index: number) =>
    setDraft(current => ({ ...current, steps: current.steps.filter((_, position) => position !== index).map((step, position) => ({ ...step, step: position + 1 })) }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/api/v1/test-cases/${item.id}`, {
        title: draft.title,
        description: draft.description,
        preconditions: draft.preconditions,
        expectedResult: draft.expectedResult,
        postconditions: draft.postconditions,
        priority: draft.priority,
        severity: draft.severity,
        steps: draft.steps,
      });
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : "Unable to save changes.");
    } finally {
      setSaving(false);
    }
  };

  const field = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal outline-none focus:border-violet-500";

  return (
    <div className="mt-7 space-y-4 border-t border-slate-100 pt-6">
      <h3 className="font-display font-bold">Edit test case</h3>

      <label className="block text-sm font-semibold">
        Title
        <input value={draft.title} onChange={event => set("title", event.target.value)} className={field} />
      </label>
      <label className="block text-sm font-semibold">
        Objective
        <textarea value={draft.description} onChange={event => set("description", event.target.value)} className={`${field} min-h-20`} />
      </label>
      <label className="block text-sm font-semibold">
        Preconditions
        <textarea value={draft.preconditions} onChange={event => set("preconditions", event.target.value)} className={`${field} min-h-16`} />
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-semibold">
          Priority
          <select value={draft.priority} onChange={event => set("priority", event.target.value)} className={field}>
            {[...new Set([draft.priority, ...priorities])].map(value => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-semibold">
          Severity
          <select value={draft.severity} onChange={event => set("severity", event.target.value)} className={field}>
            {[...new Set([draft.severity, ...severities])].map(value => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">Steps</p>
          <button onClick={addStep} className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-700">
            <Plus size={13} />
            Add step
          </button>
        </div>
        <div className="mt-2 space-y-3">
          {draft.steps.map((step, index) => (
            <div key={index} className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500">Step {step.step}</span>
                <button onClick={() => removeStep(index)} aria-label={`Remove step ${step.step}`} className="text-slate-400 hover:text-rose-600">
                  <Trash2 size={14} />
                </button>
              </div>
              <input value={step.action} onChange={event => setStep(index, { action: event.target.value })} placeholder="Action" className={field} />
              <input value={step.expectedResult} onChange={event => setStep(index, { expectedResult: event.target.value })} placeholder="Expected result" className={field} />
            </div>
          ))}
        </div>
      </div>

      <label className="block text-sm font-semibold">
        Expected result
        <textarea value={draft.expectedResult} onChange={event => set("expectedResult", event.target.value)} className={`${field} min-h-16`} />
      </label>
      <label className="block text-sm font-semibold">
        Postconditions
        <textarea value={draft.postconditions} onChange={event => set("postconditions", event.target.value)} className={`${field} min-h-16`} />
      </label>

      {error && <p className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}

      <button onClick={save} disabled={saving || !draft.title.trim()} className="rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">
        {saving ? "Saving…" : "Save changes"}
      </button>
    </div>
  );
}
