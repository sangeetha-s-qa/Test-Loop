"use client";

import { use, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Copy, MessageSquare, Send } from "lucide-react";
import { ArtifactGrid } from "@/components/artifact-viewer";
import { Avatar, BugStatusBadge, PriorityBadge, SeverityBadge } from "@/components/bugs/badges";
import { AssigneeSelect } from "@/components/bugs/raise-bug-dialog";
import { transitionNeeds } from "@/components/bugs/transition-dialog";
import { EvidenceThumb, Lightbox } from "@/components/manual/shared";
import { Shell } from "@/components/shell";
import { ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui";
import { ApiError, api, formatDateTime, type ManualEvidence, type Me } from "@/lib/api";
import { bugStatusMeta, priorityMeta, severityMeta, transitionVerb, type BugDetail, type BugEvent, type BugPriority, type BugSeverity, type BugStatus } from "@/lib/bugs";
import { useResource } from "@/lib/use-resource";

/** The happy path, drawn as a stepper. Side states (rejected, deferred, duplicate) are shown as a badge instead. */
const mainPath: BugStatus[] = ["NEW", "ASSIGNED", "IN_PROGRESS", "FIXED", "READY_FOR_RETEST", "VERIFIED", "CLOSED"];

/** Moves that ask for something before they can be made - shared with the board. */
const needs = transitionNeeds;

const field = "mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-violet-500";

function Lifecycle({ status }: { status: BugStatus }) {
  const index = mainPath.indexOf(status === "REOPENED" ? "ASSIGNED" : status);
  return (
    <ol className="flex flex-wrap items-center gap-y-2 text-[11px] font-semibold" aria-label="Bug lifecycle">
      {mainPath.map((step, position) => {
        const done = index > position;
        const current = index === position;
        return (
          <li key={step} className="flex items-center">
            <span className={`flex items-center gap-1 rounded-full px-2 py-1 ${current ? "bg-[#111c38] text-white" : done ? "text-emerald-700" : "text-slate-400"}`} aria-current={current ? "step" : undefined}>
              {done && <Check size={11} />}
              {bugStatusMeta[step].label}
            </span>
            {position < mainPath.length - 1 && <span className={`mx-1 h-px w-3 ${done ? "bg-emerald-300" : "bg-slate-200"}`} aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}

function describeEvent(event: BugEvent, people: Record<string, string>) {
  const name = (id: string | null) => (id ? people[id] ?? "someone" : "nobody");
  switch (event.type) {
    case "CREATED":
      return event.note ?? "Raised the bug";
    case "STATUS_CHANGED":
      return `Moved ${bugStatusMeta[event.fromValue as BugStatus]?.label ?? event.fromValue} → ${bugStatusMeta[event.toValue as BugStatus]?.label ?? event.toValue}`;
    case "ASSIGNED":
      return event.fromValue ? `Reassigned from ${name(event.fromValue)} to ${name(event.toValue)}` : `Assigned to ${name(event.toValue)}`;
    case "UNASSIGNED":
      return `Unassigned ${name(event.fromValue)}`;
    case "SEVERITY_CHANGED":
      return `Severity ${event.fromValue} → ${event.toValue}`;
    case "PRIORITY_CHANGED":
      return `Priority ${event.fromValue} → ${event.toValue}`;
    case "DUE_DATE_CHANGED":
      return event.toValue ? `Due ${new Date(event.toValue).toLocaleDateString()}` : "Removed the due date";
    case "COMMENTED":
      return "Commented";
    default:
      return event.type.toLowerCase();
  }
}

export default function BugPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const bug = useResource(() => api.get<BugDetail>(`/api/v1/bugs/${id}`), [id]);
  const me = useResource(() => api.get<Me>("/api/v1/auth/me"), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<BugStatus | null>(null);
  const [input, setInput] = useState({ note: "", resolution: "", assigneeId: "", duplicateOfId: "" });
  const [assignee, setAssignee] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [preview, setPreview] = useState<ManualEvidence | null>(null);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      bug.reload();
      return true;
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The change could not be saved.");
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (bug.loading) return <Shell title="Bug"><LoadingState label="Loading bug" /></Shell>;
  if (bug.error || !bug.data) return <Shell title="Bug"><ErrorState error={bug.error ?? new Error("Not found")} retry={bug.reload} /></Shell>;

  const data = bug.data;
  const myId = me.data?.user?.id;
  // Mirrors the API: everyone but viewers may comment; developers who are not workspace managers work
  // their bugs but leave assignment and triage to QA, product, and managers.
  const canComment = me.data ? me.data.role !== "VIEWER" : false;
  const canTriage = canComment && (me.data?.team !== "DEVELOPER" || me.data.role === "OWNER" || me.data.role === "ADMIN");
  const sideState = !mainPath.includes(data.status) && data.status !== "REOPENED";

  const begin = (to: BugStatus) => {
    setInput({ note: "", resolution: "", assigneeId: data.assignee?.id ?? "", duplicateOfId: "" });
    setPending(to);
    setError(null);
  };

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    if (!pending) return;
    const ok = await run(`move-${pending}`, () =>
      api.post(`/api/v1/bugs/${id}/transition`, {
        to: pending,
        ...(input.note.trim() ? { note: input.note } : {}),
        ...(pending === "FIXED" ? { resolution: input.resolution } : {}),
        ...(pending === "ASSIGNED" ? { assigneeId: input.assigneeId || null } : {}),
        ...(pending === "DUPLICATE" ? { duplicateOfId: input.duplicateOfId } : {}),
      }),
    );
    if (ok) setPending(null);
  };

  return (
    <Shell title={`${data.reference} · ${data.title}`} subtitle={`${data.project.name} · ${data.source === "MANUAL" ? "Raised from manual testing" : "Raised from automated execution"} · ${formatDateTime(data.createdAt)}`}>
      <Link href="/bugs" className="mb-4 inline-flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-slate-900">
        <ArrowLeft size={16} /> Bugs
      </Link>

      <section className="mb-5 rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center gap-2">
          <BugStatusBadge status={data.status} />
          <SeverityBadge severity={data.severity} />
          <PriorityBadge priority={data.priority} />
          {data.reopenCount > 0 && <span className="text-xs font-semibold text-rose-700">Reopened {data.reopenCount}×</span>}
          <span className="ml-auto flex items-center gap-2 text-sm text-slate-600">
            {data.assignee ? (
              <>
                <Avatar name={data.assignee.name} />
                <span>{data.assignee.id === myId ? <b>Assigned to you</b> : <>Assigned to <b>{data.assignee.name}</b></>}</span>
              </>
            ) : (
              <span className="text-slate-400">Unassigned</span>
            )}
          </span>
        </div>
        <div className="mt-4 overflow-x-auto">{sideState ? <p className="text-sm text-slate-500">This bug left the normal flow as <b>{bugStatusMeta[data.status].label.toLowerCase()}</b>{data.duplicateOf && <> of <Link href={`/bugs/${data.duplicateOf.id}`} className="font-mono font-semibold text-violet-700">{data.duplicateOf.reference}</Link></>}.</p> : <Lifecycle status={data.status} />}</div>
      </section>

      {error && <p role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="font-display text-base font-bold">Description</h2>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-700">{data.description}</p>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
                <h3 className="text-[11px] font-bold uppercase tracking-wide text-emerald-800">Expected</h3>
                <p className="mt-1 text-sm text-emerald-950">{data.expectedBehavior}</p>
              </div>
              <div className="rounded-lg border border-rose-200 bg-rose-50/60 p-3">
                <h3 className="text-[11px] font-bold uppercase tracking-wide text-rose-800">Actual</h3>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-rose-950">{data.actualBehavior}</p>
              </div>
            </div>
            {data.resolution && (
              <div className="mt-4 rounded-lg border border-violet-200 bg-violet-50/60 p-3">
                <h3 className="text-[11px] font-bold uppercase tracking-wide text-violet-800">Fix{data.fixedAt ? ` · ${formatDateTime(data.fixedAt)}` : ""}</h3>
                <p className="mt-1 whitespace-pre-wrap text-sm text-violet-950">{data.resolution}</p>
              </div>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="font-display text-base font-bold">Steps to reproduce</h2>
            <ol className="mt-3 space-y-2">
              {data.stepsToReproduce.map(step => (
                <li key={step.step} className="flex gap-3 text-sm">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-bold text-slate-600">{step.step}</span>
                  <span className="min-w-0 pt-0.5">
                    <span className="text-slate-900">{step.action}</span>
                    {step.description && <span className="block text-xs text-slate-500">{data.source === "MANUAL" ? "→ " : ""}{step.description}</span>}
                  </span>
                </li>
              ))}
            </ol>
            {data.testCase && (
              <p className="mt-4 text-xs text-slate-500">
                From test case <span className="font-mono">{data.testCase.testCaseId}</span>
                {data.testRun?.testingMethod === "MANUAL" && <> · <Link href={`/test-runs/${data.testRun.id}/manual`} className="font-semibold text-violet-700 hover:underline">open the manual run</Link></>}
              </p>
            )}
          </section>

          {(data.manualEvidence.length > 0 || data.execution) && (
            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-base font-bold">Evidence</h2>
                {data.execution && <Link href={`/executions/${data.execution.id}`} className="text-sm font-semibold text-violet-700">Open execution</Link>}
              </div>
              {data.manualEvidence.length > 0 && (
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                  {data.manualEvidence.map(item => <EvidenceThumb key={item.id} evidence={item} onOpen={() => setPreview(item)} />)}
                </div>
              )}
              {data.execution && <div className="mt-3"><ArtifactGrid artifacts={data.execution.artifacts} emptyDetail="No artifacts were captured for the source execution." annotate bugId={data.id} /></div>}
            </section>
          )}

          {data.analysis && (
            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="font-display text-base font-bold">AI failure analysis</h2>
              <dl className="mt-3 space-y-2 text-sm">
                <div><dt className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Likely cause</dt><dd className="text-slate-700">{data.analysis.likelyCause}</dd></div>
                <div><dt className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Recommended action</dt><dd className="text-slate-700">{data.analysis.recommendedAction}</dd></div>
              </dl>
            </section>
          )}

          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="flex items-center gap-2 font-display text-base font-bold"><MessageSquare size={16} /> Discussion ({data.comments.length})</h2>
            <ul className="mt-3 space-y-3">
              {data.comments.map(item => (
                <li key={item.id} className="flex gap-3">
                  <Avatar name={item.author?.name} size={28} />
                  <div className="min-w-0 flex-1 rounded-lg bg-slate-50 px-3 py-2">
                    <p className="text-xs text-slate-500"><b className="text-slate-800">{item.author?.name ?? "Former member"}</b> · {formatDateTime(item.createdAt)}</p>
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-slate-800">{item.body}</p>
                  </div>
                </li>
              ))}
              {!data.comments.length && <li className="text-sm text-slate-500">No comments yet.</li>}
            </ul>
            {canComment && (
              <form
                className="mt-4 flex gap-2"
                onSubmit={async event => {
                  event.preventDefault();
                  if (!comment.trim()) return;
                  if (await run("comment", () => api.post(`/api/v1/bugs/${id}/comments`, { body: comment }))) setComment("");
                }}
              >
                <label htmlFor="bug-comment" className="sr-only">Add a comment</label>
                <textarea id="bug-comment" value={comment} onChange={event => setComment(event.target.value)} rows={2} maxLength={5000} placeholder="Ask a question, add detail, or note what you tried…" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-violet-500" />
                <Button type="submit" icon={<Send size={14} />} loading={busy === "comment"} disabled={!comment.trim()} className="self-end">Post</Button>
              </form>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="font-display text-base font-bold">History</h2>
            <ol className="mt-3 border-l border-slate-200 pl-4 text-sm">
              {data.events.map(event => (
                <li key={event.id} className="relative py-1.5">
                  <span className="absolute -left-[21px] top-3 h-2 w-2 rounded-full bg-slate-300" aria-hidden="true" />
                  <span className="text-slate-800">{describeEvent(event, data.people)}</span>
                  <span className="text-slate-400"> · {event.actor?.name ?? "system"} · {formatDateTime(event.createdAt)}</span>
                  {event.note && event.type !== "CREATED" && <span className="mt-0.5 block whitespace-pre-wrap text-xs text-slate-500">{event.note}</span>}
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside className="h-fit space-y-4 lg:sticky lg:top-20">
          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="font-display text-sm font-bold">Next step</h2>
            {data.allowedTransitions.length ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {data.allowedTransitions.map(to => (
                  <Button key={to} size="sm" variant={pending === to ? "primary" : ["REJECTED", "REOPENED"].includes(to) ? "secondary" : to === "VERIFIED" || to === "FIXED" ? "primary" : "secondary"} onClick={() => begin(to)} disabled={Boolean(busy)}>
                    {transitionVerb[to]}
                  </Button>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-xs text-slate-500">
                {me.data?.role === "VIEWER" ? "Viewers can follow bugs but not change them." : data.status === "READY_FOR_RETEST" && data.assignee?.id === myId ? "Someone other than you must retest your fix." : "Nothing for you to do on this bug right now."}
              </p>
            )}

            {pending && (
              <form onSubmit={confirm} className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-sm font-semibold text-slate-900">{transitionVerb[pending]} → {bugStatusMeta[pending].label}</p>
                {needs[pending] === "assignee" && (
                  <div>
                    <label htmlFor="move-assignee" className="text-xs font-semibold text-slate-700">Assign to</label>
                    <AssigneeSelect id="move-assignee" value={input.assigneeId} onChange={value => setInput(current => ({ ...current, assigneeId: value }))} allowNone={false} />
                  </div>
                )}
                {needs[pending] === "resolution" && (
                  <label className="block text-xs font-semibold text-slate-700">
                    What was changed? <span className="text-rose-600">*</span>
                    <textarea value={input.resolution} onChange={event => setInput(current => ({ ...current, resolution: event.target.value }))} rows={3} maxLength={2000} placeholder="Describe the fix so QA knows what to retest." className={field} />
                  </label>
                )}
                {needs[pending] === "duplicate" && (
                  <label className="block text-xs font-semibold text-slate-700">
                    Duplicate of
                    <select value={input.duplicateOfId} onChange={event => setInput(current => ({ ...current, duplicateOfId: event.target.value }))} className={field}>
                      <option value="">Choose a bug</option>
                      {data.duplicateCandidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.reference} · {candidate.title}</option>)}
                    </select>
                    {!data.duplicateCandidates.length && <span className="mt-1 block font-normal text-slate-500">No other open bug exists on this test case.</span>}
                  </label>
                )}
                <label className="block text-xs font-semibold text-slate-700">
                  {needs[pending] === "reason" ? <>Reason <span className="text-rose-600">*</span></> : "Note (optional)"}
                  <textarea value={input.note} onChange={event => setInput(current => ({ ...current, note: event.target.value }))} rows={2} maxLength={2000} className={field} />
                </label>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
                  <Button size="sm" type="submit" loading={busy === `move-${pending}`}>Confirm</Button>
                </div>
              </form>
            )}
          </section>

          {canTriage ? (
            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 className="font-display text-sm font-bold">Assignment</h2>
              <AssigneeSelect id="bug-assignee" value={assignee ?? data.assignee?.id ?? ""} onChange={setAssignee} disabled={Boolean(busy)} />
              {assignee !== null && assignee !== (data.assignee?.id ?? "") && (
                <Button size="sm" className="mt-2 w-full" loading={busy === "assign"} onClick={async () => { if (await run("assign", () => api.post(`/api/v1/bugs/${id}/assign`, { assigneeId: assignee || null }))) setAssignee(null); }}>
                  {assignee ? "Assign" : "Unassign"}
                </Button>
              )}
            </section>
          ) : (
            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 className="font-display text-sm font-bold">Assignment</h2>
              <p className="mt-2 flex items-center gap-2 text-sm text-slate-700">{data.assignee ? <><Avatar name={data.assignee.name} /> {data.assignee.name}</> : <span className="text-slate-400">Unassigned</span>}</p>
              {me.data?.role !== "VIEWER" && <p className="mt-2 text-xs text-slate-500">QA, product, or a workspace admin assigns and triages bugs.</p>}
            </section>
          )}

          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="font-display text-sm font-bold">Triage</h2>
            <label className="mt-2 block text-xs font-semibold text-slate-700">
              Severity <span className="font-normal text-slate-400">(technical impact)</span>
              <select value={data.severity} disabled={!canTriage || Boolean(busy)} onChange={event => run("severity", () => api.patch(`/api/v1/bugs/${id}`, { severity: event.target.value as BugSeverity }))} className={field}>
                {(Object.keys(severityMeta) as BugSeverity[]).map(value => <option key={value} value={value}>{severityMeta[value].label}</option>)}
              </select>
            </label>
            <label className="mt-3 block text-xs font-semibold text-slate-700">
              Priority <span className="font-normal text-slate-400">(business urgency)</span>
              <select value={data.priority} disabled={!canTriage || Boolean(busy)} onChange={event => run("priority", () => api.patch(`/api/v1/bugs/${id}`, { priority: event.target.value as BugPriority }))} className={field}>
                {(Object.keys(priorityMeta) as BugPriority[]).map(value => <option key={value} value={value}>{value} · {priorityMeta[value].detail}</option>)}
              </select>
            </label>
            <label className="mt-3 block text-xs font-semibold text-slate-700">
              Due date
              <input type="date" value={data.dueAt ? data.dueAt.slice(0, 10) : ""} disabled={!canTriage || Boolean(busy)} onChange={event => run("due", () => api.patch(`/api/v1/bugs/${id}`, { dueAt: event.target.value ? new Date(`${event.target.value}T00:00:00Z`).toISOString() : null }))} className={field} />
            </label>
            <dl className="mt-4 space-y-1 border-t border-slate-100 pt-3 text-xs text-slate-500">
              <div className="flex justify-between"><dt>Reported by</dt><dd className="text-slate-800">{data.reportedBy?.name ?? "—"}</dd></div>
              {data.verifiedAt && <div className="flex justify-between"><dt>Verified</dt><dd className="text-slate-800">{formatDateTime(data.verifiedAt)}</dd></div>}
              {data.closedAt && <div className="flex justify-between"><dt>Closed</dt><dd className="text-slate-800">{formatDateTime(data.closedAt)}</dd></div>}
            </dl>
          </section>

          {data.duplicates.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 className="flex items-center gap-2 font-display text-sm font-bold"><Copy size={14} /> Duplicates of this bug</h2>
              <ul className="mt-2 space-y-1 text-xs">
                {data.duplicates.map(duplicate => <li key={duplicate.id}><Link href={`/bugs/${duplicate.id}`} className="font-mono font-semibold text-violet-700">{duplicate.reference}</Link> {duplicate.title}</li>)}
              </ul>
            </section>
          )}
        </aside>
      </div>

      {preview && <Lightbox evidence={preview} onClose={() => setPreview(null)} />}
    </Shell>
  );
}
