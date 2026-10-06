"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Ban,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  ClipboardCheck,
  ExternalLink,
  FileBarChart,
  Loader2,
  Monitor,
  MonitorOff,
  Radar,
  Save,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
  XCircle,
} from "lucide-react";
import { Shell } from "@/components/shell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui";
import { ConfirmDialog, EvidenceThumb, Lightbox, ProgressSummary, StatusPill, statusTone } from "@/components/manual/shared";
import { BugStatusBadge } from "@/components/bugs/badges";
import { RaiseBugDialog } from "@/components/bugs/raise-bug-dialog";
import type { BugStatus } from "@/lib/bugs";
import {
  ApiError,
  api,
  applicationTypeOptions,
  blockedReasonLabels,
  formatDateTime,
  manualStatusLabels,
  uploadEvidence,
  type BlockedReason,
  type ManualCase,
  type ManualEvidence,
  type ManualProgress,
  type ManualResultResponse,
  type ManualRun,
  type ManualStatus,
} from "@/lib/api";
import { useResource } from "@/lib/use-resource";

type Draft = { actualResult: string; testerNotes: string; blockedReason: BlockedReason | null };
type FieldErrors = Partial<Record<"actualResult" | "testerNotes" | "blockedReason", string>>;
type Toast = { tone: "success" | "warning" | "error"; text: string } | null;

const draftOf = (item: ManualCase): Draft => ({ actualResult: item.actualResult, testerNotes: item.testerNotes, blockedReason: item.blockedReason });
const sameDraft = (a: Draft, b: Draft) => a.actualResult === b.actualResult && a.testerNotes === b.testerNotes && a.blockedReason === b.blockedReason;

/** Same rules the API enforces, applied first so the tester gets the message without a round trip. */
function validate(status: ManualStatus, draft: Draft): FieldErrors {
  const errors: FieldErrors = {};
  if (status === "FAILED") {
    if (!draft.actualResult.trim()) errors.actualResult = "Please provide the actual result before marking this test as Failed.";
    if (!draft.testerNotes.trim()) errors.testerNotes = "Please describe the failure before marking this test as Failed.";
  }
  if (status === "BLOCKED") {
    if (!draft.blockedReason) errors.blockedReason = "Choose what blocked this test.";
    else if (draft.blockedReason === "OTHER" && !draft.testerNotes.trim()) errors.testerNotes = "Describe the blocker when the reason is Other.";
  }
  return errors;
}

const message = (caught: unknown) => (caught instanceof ApiError ? caught.message : "The request could not be completed.");

const priorityTone: Record<string, string> = { CRITICAL: "text-rose-700", HIGH: "text-amber-700", MEDIUM: "text-slate-700", LOW: "text-slate-500" };

const AUTO_ADVANCE_KEY = "testloop.manual.autoAdvance";
const readAutoAdvance = () => {
  try {
    return typeof window === "undefined" ? true : window.localStorage.getItem(AUTO_ADVANCE_KEY) !== "false";
  } catch {
    return true;
  }
};

export default function ManualWorkspacePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ referenceUploadFailures?: string }> }) {
  const { id } = use(params);
  const { referenceUploadFailures } = use(searchParams);
  const router = useRouter();

  // A discovery row sits in QUEUED both before anyone asks for it and while its job waits for the
  // worker, so "QUEUED" alone cannot say whether to keep polling. This records that it was asked for.
  const [discoveryRequested, setDiscoveryRequested] = useState(false);
  const run = useResource(() => api.get<ManualRun>(`/api/v1/manual-runs/${id}`), [id], {
    intervalMs: 4000,
    // Polled only while something can change underneath the tester: discovery waiting or running, or
    // a testing window that may be closed from outside this page.
    shouldPoll: value => value.discovery?.status === "DISCOVERING" || (discoveryRequested && value.discovery?.status === "QUEUED") || value.session?.status === "ACTIVE",
  });
  const casesResource = useResource(() => api.get<ManualCase[]>(`/api/v1/manual-runs/${id}/test-cases`), [id]);
  // When a generation that was running finishes, its cases are loaded without a manual refresh. The
  // transition is detected in the poll itself, so no effect has to mirror one state into another.
  const lastAiStatus = useRef<string | null>(null);
  const reloadCases = casesResource.reload;
  const aiStatus = useResource(async () => {
    const value = await api.get<{ status: string; testCaseCount: number; error?: string | null; provider: string } | null>(`/api/v1/test-runs/${id}/ai-status`);
    const active = ["QUEUED", "ANALYZING", "GENERATING"];
    if (lastAiStatus.current && active.includes(lastAiStatus.current) && value && !active.includes(value.status)) reloadCases();
    lastAiStatus.current = value?.status ?? null;
    return value;
  }, [id], {
    intervalMs: 4000,
    shouldPoll: value => ["QUEUED", "ANALYZING", "GENERATING"].includes(value?.status ?? ""),
  });

  // Server responses newer than the last fetch. Each override remembers which fetch it was made
  // against, so the next real fetch always wins and nothing here can drift from the database.
  const [caseOverrides, setCaseOverrides] = useState<{ base: ManualCase[] | null; rows: Record<string, ManualCase> }>({ base: null, rows: {} });
  const [progressOverride, setProgressOverride] = useState<{ base: ManualRun | null; progress: ManualProgress } | null>(null);
  const cases = useMemo(() => {
    const rows = casesResource.data ?? [];
    return caseOverrides.base === casesResource.data ? rows.map(row => caseOverrides.rows[row.id] ?? row) : rows;
  }, [casesResource.data, caseOverrides]);
  const progress = progressOverride && progressOverride.base === run.data ? progressOverride.progress : run.data?.progress;
  // The switch reflects a click at once; the next fetch of the run replaces this with the stored value.
  const [autoCaptureOverride, setAutoCaptureOverride] = useState<{ base: ManualRun | null; value: boolean } | null>(null);
  const autoCaptureOn = autoCaptureOverride && autoCaptureOverride.base === run.data ? autoCaptureOverride.value : Boolean(run.data?.settings.autoScreenshotOnFail);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  const [blockedPicker, setBlockedPicker] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState(readAutoAdvance);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState({ type: "ALL", priority: "ALL", status: "ALL" });
  const [evidenceNonce, setEvidenceNonce] = useState(0);
  const [raising, setRaising] = useState(false);
  const evidenceRefresh = useCallback(() => setEvidenceNonce(value => value + 1), []);

  const selected = cases.find(item => item.id === selectedId) ?? cases.find(item => item.manualStatus === "NOT_RUN") ?? cases[0] ?? null;
  const draft = selected ? (drafts[selected.id] ?? draftOf(selected)) : null;
  const dirtyIds = useMemo(() => Object.keys(drafts).filter(caseId => {
    const row = cases.find(item => item.id === caseId);
    return row ? !sameDraft(drafts[caseId], draftOf(row)) : false;
  }), [drafts, cases]);
  const dirty = Boolean(selected && dirtyIds.includes(selected.id));
  const readOnly = run.data?.phase === "COMPLETED";

  // Leaving the page with unsaved text asks first - both for reloads/closing the tab and for links
  // inside the product, which a client-side router would otherwise follow silently.
  useEffect(() => {
    if (!dirtyIds.length) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement | null)?.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.href.includes(`/test-runs/${id}/manual#`)) return;
      if (!window.confirm("You have unsaved changes to a test case. Leave without saving?")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirtyIds.length, id]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.tone === "success" ? 3500 : 7000);
    return () => clearTimeout(timer);
  }, [toast]);

  const types = useMemo(() => [...new Set(cases.map(item => item.category))].sort(), [cases]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return cases.filter(item => {
      if (filters.type !== "ALL" && item.category !== filters.type) return false;
      if (filters.priority !== "ALL" && item.priority !== filters.priority) return false;
      if (filters.status !== "ALL" && item.manualStatus !== filters.status) return false;
      return !needle || `${item.testCaseId} ${item.title} ${item.module}`.toLowerCase().includes(needle);
    });
  }, [cases, query, filters]);

  const select = (caseId: string) => {
    if (selected && caseId !== selected.id && dirty) return setPendingSelect(caseId);
    setSelectedId(caseId);
    setErrors({});
    setBlockedPicker(false);
  };

  const updateDraft = (patch: Partial<Draft>) => {
    if (!selected || !draft) return;
    setDrafts(current => ({ ...current, [selected.id]: { ...draft, ...patch } }));
    setErrors(current => Object.fromEntries(Object.entries(current).filter(([key]) => !(key in patch))));
  };

  const applyResult = (result: ManualResultResponse) => {
    setCaseOverrides(current => ({ base: casesResource.data, rows: { ...(current.base === casesResource.data ? current.rows : {}), [result.testCase.id]: result.testCase } }));
    setProgressOverride({ base: run.data, progress: result.progress });
    setDrafts(current => {
      const next = { ...current };
      delete next[result.testCase.id];
      return next;
    });
  };

  const nextNotRun = (fromId: string) => {
    const index = cases.findIndex(item => item.id === fromId);
    const ordered = [...cases.slice(index + 1), ...cases.slice(0, index)];
    return ordered.find(item => item.manualStatus === "NOT_RUN" && item.id !== fromId) ?? null;
  };

  /** Saves text and, when given, a new status in one request. Progress comes back with it. */
  const save = async (status?: ManualStatus) => {
    if (!selected || !draft) return false;
    const target = status ?? selected.manualStatus;
    const problems = validate(target, draft);
    if (Object.keys(problems).length) {
      setErrors(problems);
      document.getElementById(`field-${Object.keys(problems)[0]}`)?.focus();
      return false;
    }
    setBusy(status ?? "save");
    setErrors({});
    try {
      const result = await api.patch<ManualResultResponse>(`/api/v1/manual-runs/${id}/test-cases/${selected.id}`, {
        ...(status ? { status } : {}),
        actualResult: draft.actualResult,
        testerNotes: draft.testerNotes,
        ...(target === "BLOCKED" ? { blockedReason: draft.blockedReason } : {}),
      });
      applyResult(result);
      setBlockedPicker(false);
      if (result.autoCapture.captured) evidenceRefresh();
      const captureNote = result.autoCapture.captured ? " · screenshot captured automatically" : "";
      // With the auto-capture setting on, a capture that did not happen is worth telling the tester.
      setToast(
        result.autoCapture.reason && status === "FAILED" && autoCaptureOn
          ? { tone: "warning", text: `Marked Failed. ${result.autoCapture.reason}` }
          : { tone: "success", text: status ? `${selected.testCaseId} marked ${manualStatusLabels[status]} · ${result.progress.percentComplete}% complete${captureNote}` : `${selected.testCaseId} saved` },
      );
      if (result.runStatus !== run.data?.status) run.reload();
      if (status && status !== "NOT_RUN" && status !== "IN_PROGRESS" && autoAdvance) {
        const next = nextNotRun(selected.id);
        if (next) setSelectedId(next.id);
      }
      return true;
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "RESULT_INCOMPLETE" && Array.isArray(caught.details)) {
        setErrors(Object.fromEntries((caught.details as { field: string; message: string }[]).map(item => [item.field, item.message])));
      } else setToast({ tone: "error", text: message(caught) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  /* ------------------------------------------------------------------ evidence */
  const evidence = useResource(() => (selected ? api.get<ManualEvidence[]>(`/api/v1/manual-runs/${id}/test-cases/${selected.id}/evidence`) : Promise.resolve([])), [id, selected?.id, evidenceNonce]);
  const [preview, setPreview] = useState<ManualEvidence | null>(null);
  const [removing, setRemoving] = useState<ManualEvidence | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const afterEvidenceChange = (delta: number) => {
    evidenceRefresh();
    if (!selected) return;
    setCaseOverrides(current => {
      const rows = current.base === casesResource.data ? current.rows : {};
      const row = rows[selected.id] ?? selected;
      return { base: casesResource.data, rows: { ...rows, [selected.id]: { ...row, _count: { manualEvidence: Math.max(0, row._count.manualEvidence + delta) } } } };
    });
  };

  const capture = async () => {
    if (!selected) return;
    setBusy("capture");
    try {
      await api.post(`/api/v1/manual-runs/${id}/test-cases/${selected.id}/evidence/capture`);
      afterEvidenceChange(1);
      setToast({ tone: "success", text: `Screenshot attached to ${selected.testCaseId}` });
    } catch (caught) {
      setToast({ tone: "error", text: message(caught) });
      run.reload();
    } finally {
      setBusy(null);
    }
  };

  const upload = async (files: File[]) => {
    if (!selected || !files.length) return;
    setBusy("upload");
    let added = 0;
    try {
      for (const file of files) {
        await uploadEvidence(`/api/v1/manual-runs/${id}/test-cases/${selected.id}/evidence`, file, file.name || "pasted-screenshot.png");
        added += 1;
      }
      setToast({ tone: "success", text: `${added} file${added === 1 ? "" : "s"} attached to ${selected.testCaseId}` });
    } catch (caught) {
      setToast({ tone: "error", text: message(caught) });
    } finally {
      if (added) afterEvidenceChange(added);
      setBusy(null);
    }
  };

  const onPaste = (event: ClipboardEvent) => {
    if (readOnly) return;
    const images = Array.from(event.clipboardData.files).filter(file => file.type.startsWith("image/"));
    if (images.length) {
      event.preventDefault();
      void upload(images);
    }
  };

  const remove = async (item: ManualEvidence) => {
    setRemoving(null);
    setBusy("remove");
    try {
      await api.delete(`/api/v1/manual-evidence/${item.id}`);
      afterEvidenceChange(-1);
      setToast({ tone: "success", text: "Evidence removed" });
    } catch (caught) {
      setToast({ tone: "error", text: message(caught) });
    } finally {
      setBusy(null);
    }
  };

  /* ------------------------------------------------------------------ run-level actions */
  const act = async (key: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await action();
      if (success) setToast({ tone: "success", text: success });
      return true;
    } catch (caught) {
      setToast({ tone: "error", text: message(caught) });
      return false;
    } finally {
      setBusy(null);
      run.reload();
    }
  };

  const launch = () => act("launch", () => api.post(`/api/v1/manual-runs/${id}/session`), "Testing window opened. Switch to it to start testing.");
  const closeWindow = () => act("close", () => api.delete(`/api/v1/manual-runs/${id}/session`), "Testing window closed");
  const toggleAutoCapture = (value: boolean) => {
    setAutoCaptureOverride({ base: run.data, value });
    return act("settings", () => api.patch(`/api/v1/manual-runs/${id}/settings`, { autoScreenshotOnFail: value }));
  };
  const generate = async () => {
    if (await act("generate", () => api.post(`/api/v1/manual-runs/${id}/test-cases/generate`))) casesResource.reload();
  };
  const startDiscovery = () => {
    setDiscoveryRequested(true);
    return act("discovery", () => api.post(`/api/v1/test-runs/${id}/discovery/start`), "Discovery queued");
  };
  const startAi = async () => {
    if (await act("ai", () => api.post(`/api/v1/test-runs/${id}/ai-analysis`), "AI generation queued. New cases appear here when it finishes.")) aiStatus.reload();
  };

  const complete = async (acknowledgeNotRun: boolean) => {
    setBusy("complete");
    try {
      await api.post(`/api/v1/manual-runs/${id}/complete`, { acknowledgeNotRun });
      setCompleteOpen(false);
      router.push(`/test-runs/${id}/manual/report`);
    } catch (caught) {
      setToast({ tone: "error", text: message(caught) });
      run.reload();
    } finally {
      setBusy(null);
    }
  };

  /* ------------------------------------------------------------------ render */
  if (run.loading || casesResource.loading) return <Shell title="Manual Test Run"><LoadingState label="Loading manual test run" /></Shell>;
  if (run.error || !run.data) return <Shell title="Manual Test Run"><ErrorState error={run.error ?? new Error("Test run not found")} retry={run.reload} /></Shell>;
  if (casesResource.error) return <Shell title="Manual Test Run"><ErrorState error={casesResource.error} retry={casesResource.reload} /></Shell>;

  const data = run.data;
  const summary = progress ?? data.progress;
  const session = data.session;
  const sessionOpen = session?.status === "ACTIVE";
  const index = selected ? cases.findIndex(item => item.id === selected.id) : -1;
  const phaseLabel = { NOT_STARTED: "Not started", IN_PROGRESS: "In progress", COMPLETED: "Completed" }[data.phase];
  const remaining = summary.notRun + summary.inProgress;
  const appType = applicationTypeOptions.find(option => option.value === data.applicationType)?.label;
  const aiRunning = ["QUEUED", "ANALYZING", "GENERATING"].includes(aiStatus.data?.status ?? "") && aiStatus.data?.provider !== "testloop-manual-rules";

  return (
    <Shell
      title="Manual Test Run"
      subtitle={`${data.project?.name ?? "Project"} · ${data.applicationUrl}`}
      actions={
        readOnly ? (
          <Link href={`/test-runs/${id}/manual/report`} className="flex items-center gap-2 rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-semibold text-white">
            <FileBarChart size={16} /> View report
          </Link>
        ) : cases.length ? (
          <Button icon={<ClipboardCheck size={16} />} onClick={() => setCompleteOpen(true)} disabled={Boolean(busy)}>
            Complete Manual Test Run
          </Button>
        ) : null
      }
    >
      <Link href="/test-runs" className="mb-4 inline-flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-slate-900">
        <ArrowLeft size={16} /> Test runs
      </Link>

      {/* ---------------------------------------------------------------- run header */}
      <section className="mb-5 rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
          <div className="min-w-0 flex-1 basis-72">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wide ring-1 ring-inset ${data.phase === "COMPLETED" ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : data.phase === "IN_PROGRESS" ? "bg-sky-50 text-sky-700 ring-sky-200" : "bg-slate-100 text-slate-600 ring-slate-200"}`}>
                {phaseLabel}
              </span>
              <span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-700 ring-1 ring-inset ring-violet-200">Manual testing</span>
              {appType && <span className="text-xs text-slate-500">{appType}</span>}
            </div>
            <a href={data.applicationUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex max-w-full items-center gap-1.5 truncate text-sm font-semibold text-slate-900 hover:text-violet-700">
              {data.applicationUrl} <ExternalLink size={13} className="shrink-0" />
            </a>
            <p className="mt-1 text-xs text-slate-500">
              {(data.testingTypes as string[]).join(" · ")}
              {data.startedAt && ` · started ${formatDateTime(data.startedAt)}`}
              {data.completedAt && ` · completed ${formatDateTime(data.completedAt)}`}
            </p>
          </div>
          <div className="min-w-0 flex-[2] basis-96">
            <ProgressSummary progress={summary} />
          </div>
        </div>
      </section>

      {referenceUploadFailures && (
        <p className="mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertTriangle size={16} /> {referenceUploadFailures} reference file(s) could not be uploaded. The run was created; you can attach screenshots to individual test cases instead.
        </p>
      )}

      {readOnly && (
        <p className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <CheckCircle2 size={16} /> This run was completed{data.completedAt ? ` on ${formatDateTime(data.completedAt)}` : ""}. Results and evidence are locked.
          <Link href={`/test-runs/${id}/manual/report`} className="font-semibold underline">Open the report</Link>
        </p>
      )}

      {!cases.length ? (
        <SetupPanel run={data} busy={busy} requested={discoveryRequested} onDiscover={startDiscovery} onGenerate={generate} readOnly={readOnly} />
      ) : (
        <div className="grid items-start gap-5 xl:grid-cols-[300px_minmax(0,1fr)_340px] lg:grid-cols-[280px_minmax(0,1fr)]" onPaste={onPaste}>
          {/* ------------------------------------------------------------ case list */}
          <aside className="rounded-xl border border-slate-200 bg-white lg:sticky lg:top-4 lg:row-span-2 xl:row-span-1" aria-label="Test cases">
            <div className="space-y-2 border-b border-slate-100 p-3">
              <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm focus-within:ring-2 focus-within:ring-violet-500">
                <Search size={15} className="text-slate-400" />
                <span className="sr-only">Search test cases</span>
                <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search ID or title" className="w-full outline-none" />
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                {([
                  ["type", "Type", ["ALL", ...types]],
                  ["priority", "Priority", ["ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW"]],
                  ["status", "Status", ["ALL", "NOT_RUN", "IN_PROGRESS", "PASSED", "FAILED", "BLOCKED"]],
                ] as const).map(([key, label, options]) => (
                  <label key={key} className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                    {label}
                    <select value={filters[key]} onChange={event => setFilters(current => ({ ...current, [key]: event.target.value }))} className="mt-0.5 w-full rounded-md border border-slate-200 bg-white px-1.5 py-1 text-xs font-normal normal-case tracking-normal text-slate-700">
                      {options.map(option => (
                        <option key={option} value={option}>{option === "ALL" ? "All" : option in manualStatusLabels ? manualStatusLabels[option as ManualStatus] : option.charAt(0) + option.slice(1).toLowerCase()}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <p className="text-xs text-slate-500">
                Showing {visible.length} of {cases.length}
              </p>
            </div>
            <ul className="max-h-[32rem] overflow-y-auto p-1.5 lg:max-h-[calc(100vh-14rem)]">
              {visible.map(item => {
                const active = item.id === selected?.id;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => select(item.id)}
                      aria-current={active ? "true" : undefined}
                      className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-violet-500 ${active ? "bg-violet-50 ring-1 ring-violet-200" : "hover:bg-slate-50"}`}
                    >
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${statusTone[item.manualStatus].dot}`} aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 font-mono text-[11px] text-slate-400">
                          {item.testCaseId}
                          {dirtyIds.includes(item.id) && <span className="rounded bg-amber-100 px-1 font-sans text-[10px] font-bold text-amber-800">Unsaved</span>}
                          {item.bugs?.[0] && <span className="rounded bg-rose-100 px-1 font-sans text-[10px] font-bold text-rose-700" title={`Bug ${item.bugs[0].reference}`}>{item.bugs[0].reference}</span>}
                          {item._count.manualEvidence > 0 && (
                            <span className="ml-auto flex items-center gap-0.5 font-sans" title={`${item._count.manualEvidence} evidence`}>
                              <Camera size={11} /> {item._count.manualEvidence}
                            </span>
                          )}
                        </span>
                        <span className={`mt-0.5 block text-[13px] leading-snug ${active ? "font-semibold text-slate-900" : "text-slate-700"}`}>{item.title}</span>
                        <span className="mt-1 flex items-center gap-2">
                          <StatusPill status={item.manualStatus} />
                          <span className="truncate text-[11px] text-slate-400">{item.category}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
              {!visible.length && <li className="p-6 text-center text-sm text-slate-500">No test cases match these filters.</li>}
            </ul>
            {!readOnly && data.discovery?.status === "COMPLETED" && (
              <div className="border-t border-slate-100 p-3">
                {aiRunning ? (
                  <p className="flex items-center gap-2 text-xs text-slate-600">
                    <Loader2 size={13} className="animate-spin text-violet-600" /> AI is generating additional cases ({aiStatus.data?.status.toLowerCase()})…
                  </p>
                ) : (
                  <button type="button" onClick={startAi} disabled={Boolean(busy)} className="flex items-center gap-1.5 text-xs font-semibold text-violet-700 hover:underline disabled:opacity-50">
                    <Sparkles size={13} /> Add more cases with AI
                  </button>
                )}
                {aiStatus.data?.status === "FAILED" && aiStatus.data.provider !== "testloop-manual-rules" && <p className="mt-1 text-[11px] text-rose-700">Last AI generation failed: {aiStatus.data.error ?? "unknown error"}</p>}
              </div>
            )}
          </aside>

          {/* ------------------------------------------------------------ selected case */}
          {selected && draft && (
            <article className="min-w-0 rounded-xl border border-slate-200 bg-white" aria-labelledby="case-title">
              <header className="border-b border-slate-100 p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-slate-500">{selected.testCaseId}</span>
                  <StatusPill status={selected.manualStatus} />
                  {selected.generationSource === "AI" && <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-bold text-violet-700">AI-generated</span>}
                  <span className="ml-auto text-xs text-slate-400">
                    {index + 1} of {cases.length}
                  </span>
                </div>
                <h2 id="case-title" className="mt-2 font-display text-xl font-bold leading-snug text-slate-900">
                  {selected.title}
                </h2>
                <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                  <div className="flex gap-1.5"><dt className="text-slate-500">Type</dt><dd className="font-semibold text-slate-800">{selected.category}</dd></div>
                  <div className="flex gap-1.5"><dt className="text-slate-500">Priority</dt><dd className={`font-semibold ${priorityTone[selected.priority] ?? ""}`}>{selected.priority.charAt(0) + selected.priority.slice(1).toLowerCase()}</dd></div>
                  <div className="flex gap-1.5"><dt className="text-slate-500">Module</dt><dd className="font-semibold text-slate-800">{selected.module}</dd></div>
                  {selected.executedAt && <div className="flex gap-1.5"><dt className="text-slate-500">Last result</dt><dd className="text-slate-800">{formatDateTime(selected.executedAt)}{selected.executedBy ? ` by ${selected.executedBy.name}` : ""}</dd></div>}
                </dl>
              </header>

              <div className="space-y-5 p-5">
                {selected.description && selected.description !== selected.title && <p className="text-sm text-slate-600">{selected.description}</p>}

                <section>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Preconditions</h3>
                  <p className={`mt-1.5 text-sm ${selected.preconditions.startsWith("Requires verification") ? "rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900" : "text-slate-800"}`}>{selected.preconditions || "None."}</p>
                </section>

                {Object.keys(selected.testData ?? {}).length > 0 && (
                  <section>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Test data</h3>
                    <dl className="mt-1.5 divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
                      {Object.entries(selected.testData).map(([key, value]) => (
                        <div key={key} className="grid grid-cols-[minmax(0,10rem)_1fr] gap-3 px-3 py-2">
                          <dt className="truncate text-slate-500">{key}</dt>
                          <dd className="break-words font-mono text-[13px] text-slate-800">{value}</dd>
                        </div>
                      ))}
                    </dl>
                    {Object.values(selected.testData).some(value => /^</.test(value)) && <p className="mt-1.5 text-xs text-slate-500">Values in angle brackets are placeholders. Type real credentials only into the testing window, never into Testloop.</p>}
                  </section>
                )}

                <section>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Steps</h3>
                  <ol className="mt-1.5 space-y-2">
                    {selected.steps.map(step => (
                      <li key={step.step} className="flex gap-3 text-sm">
                        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-bold text-slate-600">{step.step}</span>
                        <div className="min-w-0 pt-0.5">
                          <p className="text-slate-900">{step.action}</p>
                          {step.expectedResult && <p className="mt-0.5 text-xs text-slate-500">→ {step.expectedResult}</p>}
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>

                <section className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-4 py-3">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-800">Expected result</h3>
                  <p className="mt-1 text-sm text-emerald-950">{selected.expectedResult}</p>
                </section>

                <section>
                  <label htmlFor="field-actualResult" className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    Actual result {(selected.manualStatus === "FAILED" || errors.actualResult) && <span className="text-rose-600">*</span>}
                  </label>
                  <textarea
                    id="field-actualResult"
                    value={draft.actualResult}
                    onChange={event => updateDraft({ actualResult: event.target.value })}
                    disabled={readOnly}
                    maxLength={10000}
                    rows={4}
                    aria-invalid={Boolean(errors.actualResult) || undefined}
                    aria-describedby="actual-error actual-hint"
                    placeholder="Describe what actually happened when you followed the steps."
                    className={`mt-1.5 w-full rounded-lg border px-3 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:bg-slate-50 ${errors.actualResult ? "border-rose-400" : "border-slate-300"}`}
                  />
                  <p id="actual-error" role="alert" className="text-xs font-medium text-rose-600">{errors.actualResult}</p>
                  <p id="actual-hint" className="text-[11px] text-slate-400">Do not paste passwords or other secrets here; results appear in the report.</p>
                </section>
              </div>

              <footer className="flex flex-wrap items-center gap-2 border-t border-slate-100 p-4">
                <Button variant="secondary" size="sm" icon={<ChevronLeft size={15} />} disabled={index <= 0} onClick={() => select(cases[index - 1].id)}>
                  Previous Test Case
                </Button>
                <Button variant="secondary" size="sm" icon={<ChevronRight size={15} />} disabled={index >= cases.length - 1} onClick={() => select(cases[index + 1].id)}>
                  Next Test Case
                </Button>
                <label className="ml-auto flex items-center gap-2 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={autoAdvance}
                    onChange={event => {
                      setAutoAdvance(event.target.checked);
                      try {
                        window.localStorage.setItem(AUTO_ADVANCE_KEY, String(event.target.checked));
                      } catch {
                        /* a per-browser convenience; nothing breaks without it */
                      }
                    }}
                    className="h-4 w-4 accent-violet-600"
                  />
                  After a verdict, go to the next not-run case
                </label>
              </footer>
            </article>
          )}

          {/* ------------------------------------------------------------ window, evidence, verdict */}
          {selected && draft && (
            <aside className="space-y-4 lg:col-start-2 xl:col-start-auto" aria-label="Evidence and result">
              <section className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-center gap-2">
                  {sessionOpen ? <Monitor size={17} className="text-emerald-600" /> : <MonitorOff size={17} className="text-slate-400" />}
                  <h3 className="font-display text-sm font-bold">Testing window</h3>
                  {sessionOpen && <span className="ml-auto rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700 ring-1 ring-emerald-200">Open · {session.browser}</span>}
                </div>
                {!data.browserCapability.enabled ? (
                  <div className="mt-3 space-y-2 text-xs text-slate-600">
                    <p>{data.browserCapability.reason}</p>
                    <a href={data.applicationUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-violet-700 hover:underline">
                      Open the application in a new tab <ExternalLink size={12} />
                    </a>
                  </div>
                ) : sessionOpen ? (
                  <div className="mt-3 space-y-2 text-xs">
                    <p className="text-slate-600">A real {session.browser} window is open on this computer. Test the application there; capture what it shows from here.</p>
                    {session.currentUrl && <p className="truncate font-mono text-[11px] text-slate-500" title={session.currentUrl}>{session.currentUrl}</p>}
                    {session.lastError && <p className="rounded-md bg-amber-50 px-2 py-1.5 text-amber-900">{session.lastError}</p>}
                    {!readOnly && (
                      <Button variant="ghost" size="sm" loading={busy === "close"} onClick={closeWindow} className="-ml-2">
                        Close window
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="mt-3 space-y-2.5 text-xs text-slate-600">
                    <p>Opens a real browser window on this computer at the application URL. You control the application; Testloop only captures screenshots when you ask.</p>
                    <p className="rounded-md bg-slate-50 px-2 py-1.5 text-slate-500">Sign in to the application inside that window. Those credentials go only to the application under test - Testloop never sees or stores them, and they are separate from your Testloop sign-in.</p>
                    {session && ["CLOSED", "CRASHED", "FAILED"].includes(session.status) && session.endReason !== "CLOSED_BY_TESTER" && (
                      <p className={`rounded-md px-2 py-1.5 ${session.status === "CLOSED" ? "bg-slate-50 text-slate-600" : "bg-rose-50 text-rose-800"}`}>
                        Last window: {session.lastError ?? session.endReason?.replace(/_/g, " ").toLowerCase()}
                      </p>
                    )}
                    {!readOnly && (
                      <Button size="sm" icon={<Monitor size={14} />} loading={busy === "launch"} onClick={launch} className="w-full">
                        Launch Testing Window
                      </Button>
                    )}
                  </div>
                )}
              </section>

              <section className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-display text-sm font-bold">Evidence ({evidence.data?.length ?? selected._count.manualEvidence})</h3>
                </div>
                {!readOnly && (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Button size="sm" icon={<Camera size={14} />} loading={busy === "capture"} disabled={!sessionOpen || Boolean(busy && busy !== "capture")} onClick={capture} title={sessionOpen ? "Screenshot the testing window" : "Launch the testing window to capture from it"}>
                      Capture Screenshot
                    </Button>
                    <Button variant="secondary" size="sm" icon={<Upload size={14} />} loading={busy === "upload"} onClick={() => fileInput.current?.click()}>
                      Upload
                    </Button>
                    <input
                      ref={fileInput}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,video/webm,video/mp4"
                      multiple
                      className="sr-only"
                      tabIndex={-1}
                      onChange={event => {
                        void upload(Array.from(event.target.files ?? []));
                        event.target.value = "";
                      }}
                    />
                  </div>
                )}
                {!readOnly && <p className="mt-2 text-[11px] text-slate-400">{sessionOpen ? "Password and card fields are masked in captures. " : ""}You can also paste a screenshot (Ctrl+V).</p>}
                {evidence.error ? (
                  <p className="mt-3 text-xs text-rose-700">{message(evidence.error)}</p>
                ) : evidence.loading ? (
                  <div className="mt-3 h-20 animate-pulse rounded-lg bg-slate-100" />
                ) : evidence.data?.length ? (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {evidence.data.map(item => (
                      <EvidenceThumb key={item.id} evidence={item} onOpen={() => setPreview(item)}>
                        {!readOnly && (
                          <button type="button" onClick={() => setRemoving(item)} className="absolute right-1 top-1 rounded-md bg-white/90 p-1 text-slate-500 opacity-0 shadow-sm transition-opacity hover:text-rose-600 focus-visible:opacity-100 group-hover:opacity-100" aria-label={`Remove ${item.fileName}`}>
                            <Trash2 size={13} />
                          </button>
                        )}
                      </EvidenceThumb>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-500">No evidence yet for this case.</p>
                )}
                {!readOnly && data.browserCapability.enabled && (
                  <label className="mt-3 flex items-start gap-2 border-t border-slate-100 pt-3 text-xs text-slate-700">
                    <input type="checkbox" checked={autoCaptureOn} disabled={busy === "settings"} onChange={event => toggleAutoCapture(event.target.checked)} className="mt-0.5 h-4 w-4 accent-violet-600" />
                    <span>
                      Capture screenshot when marking Failed
                      <span className="block text-[11px] text-slate-400">Takes a screenshot of the testing window at the moment you mark a case Failed. Off until you turn it on.</span>
                    </span>
                  </label>
                )}
              </section>

              {selected.manualStatus === "FAILED" && (
                <section className="rounded-xl border border-rose-200 bg-rose-50/60 p-4">
                  <h3 className="font-display text-sm font-bold text-rose-900">Bug</h3>
                  {selected.bugs?.[0] ? (
                    <Link href={`/bugs/${selected.bugs[0].id}`} className="mt-2 flex items-center gap-2 rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm hover:border-rose-300">
                      <span className="font-mono text-xs font-bold text-violet-700">{selected.bugs[0].reference}</span>
                      <BugStatusBadge status={selected.bugs[0].status as BugStatus} />
                      <span className="ml-auto truncate text-xs text-slate-500">{selected.bugs[0].assignee?.name ?? "Unassigned"}</span>
                    </Link>
                  ) : (
                    <>
                      <p className="mt-1 text-xs text-rose-900/80">Hand this failure to the development team with its steps, results, and screenshots.</p>
                      <Button variant="danger" size="sm" className="mt-3 w-full" onClick={() => setRaising(true)}>
                        Raise bug
                      </Button>
                    </>
                  )}
                </section>
              )}

              <section className="rounded-xl border border-slate-200 bg-white p-4">
                <label htmlFor="field-testerNotes" className="font-display text-sm font-bold">
                  Tester notes {(errors.testerNotes || draft.blockedReason === "OTHER") && <span className="text-rose-600">*</span>}
                </label>
                <textarea
                  id="field-testerNotes"
                  value={draft.testerNotes}
                  onChange={event => updateDraft({ testerNotes: event.target.value })}
                  disabled={readOnly}
                  maxLength={10000}
                  rows={3}
                  aria-invalid={Boolean(errors.testerNotes) || undefined}
                  aria-describedby="notes-error"
                  placeholder="Failure description, observations, environment details…"
                  className={`mt-2 w-full rounded-lg border px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:bg-slate-50 ${errors.testerNotes ? "border-rose-400" : "border-slate-300"}`}
                />
                <p id="notes-error" role="alert" className="text-xs font-medium text-rose-600">{errors.testerNotes}</p>

                {!readOnly && (
                  <>
                    <p className="mt-3 text-xs font-bold uppercase tracking-wider text-slate-400">Status</p>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <StatusButton status="PASSED" icon={<CheckCircle2 size={15} />} current={selected.manualStatus} busy={busy} onClick={() => save("PASSED")} />
                      <StatusButton status="FAILED" icon={<XCircle size={15} />} current={selected.manualStatus} busy={busy} onClick={() => save("FAILED")} />
                      <StatusButton status="BLOCKED" icon={<Ban size={15} />} current={selected.manualStatus} busy={busy} onClick={() => setBlockedPicker(true)} />
                      <StatusButton status="NOT_RUN" icon={<CircleDashed size={15} />} current={selected.manualStatus} busy={busy} onClick={() => save("NOT_RUN")} />
                    </div>
                    {(blockedPicker || selected.manualStatus === "BLOCKED" || errors.blockedReason) && (
                      <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                        <label htmlFor="field-blockedReason" className="text-xs font-semibold text-amber-900">
                          What blocked this test?
                        </label>
                        <select
                          id="field-blockedReason"
                          value={draft.blockedReason ?? ""}
                          onChange={event => updateDraft({ blockedReason: (event.target.value || null) as BlockedReason | null })}
                          aria-invalid={Boolean(errors.blockedReason) || undefined}
                          className={`mt-1 w-full rounded-md border bg-white px-2 py-1.5 text-sm ${errors.blockedReason ? "border-rose-400" : "border-amber-300"}`}
                        >
                          <option value="">Choose a reason</option>
                          {Object.entries(blockedReasonLabels).map(([value, label]) => (
                            <option key={value} value={value}>{label}</option>
                          ))}
                        </select>
                        <p role="alert" className="text-xs font-medium text-rose-600">{errors.blockedReason}</p>
                        <Button size="sm" className="mt-2 w-full bg-amber-600 hover:bg-amber-700" loading={busy === "BLOCKED"} onClick={() => save("BLOCKED")}>
                          {selected.manualStatus === "BLOCKED" ? "Update blocked reason" : "Mark Blocked"}
                        </Button>
                      </div>
                    )}
                    <Button variant="secondary" size="sm" icon={<Save size={14} />} loading={busy === "save"} disabled={!dirty || Boolean(busy && busy !== "save")} onClick={() => save()} className="mt-3 w-full">
                      {dirty ? "Save" : "Saved"}
                    </Button>
                  </>
                )}
              </section>
            </aside>
          )}
        </div>
      )}

      {preview && <Lightbox evidence={preview} onClose={() => setPreview(null)} />}

      {raising && selected && (
        <RaiseBugDialog
          runId={id}
          testCase={selected}
          onClose={() => setRaising(false)}
          onRaised={bug => {
            setRaising(false);
            casesResource.reload();
            setToast({ tone: "success", text: `${bug.reference} raised from ${selected.testCaseId}` });
          }}
        />
      )}

      {removing && (
        <ConfirmDialog
          title="Remove this evidence?"
          onClose={() => setRemoving(null)}
          actions={
            <>
              <Button variant="secondary" data-autofocus onClick={() => setRemoving(null)}>Keep it</Button>
              <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => remove(removing)}>Remove</Button>
            </>
          }
        >
          {removing.fileName} will be permanently deleted from this test case. This is recorded in the run&apos;s timeline.
        </ConfirmDialog>
      )}

      {pendingSelect && selected && (
        <ConfirmDialog
          title="Unsaved changes"
          onClose={() => setPendingSelect(null)}
          actions={
            <>
              <Button variant="ghost" data-autofocus onClick={() => setPendingSelect(null)}>Keep editing</Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setDrafts(current => {
                    const next = { ...current };
                    delete next[selected.id];
                    return next;
                  });
                  setSelectedId(pendingSelect);
                  setErrors({});
                  setPendingSelect(null);
                }}
              >
                Discard changes
              </Button>
              <Button
                icon={<Save size={15} />}
                loading={busy === "save"}
                onClick={async () => {
                  const target = pendingSelect;
                  if (await save()) {
                    setSelectedId(target);
                    setPendingSelect(null);
                  } else setPendingSelect(null);
                }}
              >
                Save and continue
              </Button>
            </>
          }
        >
          {selected.testCaseId} has changes that are not saved yet.
        </ConfirmDialog>
      )}

      {completeOpen && (
        <ConfirmDialog
          title="Complete manual test run"
          onClose={() => setCompleteOpen(false)}
          actions={
            remaining ? (
              <>
                <Button variant="secondary" data-autofocus onClick={() => setCompleteOpen(false)}>Continue Testing</Button>
                <Button loading={busy === "complete"} onClick={() => complete(true)}>Complete Anyway</Button>
              </>
            ) : (
              <>
                <Button variant="secondary" onClick={() => setCompleteOpen(false)}>Cancel</Button>
                <Button data-autofocus loading={busy === "complete"} icon={<ClipboardCheck size={15} />} onClick={() => complete(false)}>Complete run</Button>
              </>
            )
          }
        >
          <dl className="grid grid-cols-5 gap-2 rounded-lg bg-slate-50 p-3 text-center">
            {[["Total", summary.total], ["Passed", summary.passed], ["Failed", summary.failed], ["Blocked", summary.blocked], ["Not run", remaining]].map(([label, value]) => (
              <div key={label}>
                <dt className="text-[11px] text-slate-500">{label}</dt>
                <dd className="font-display text-lg font-bold text-slate-900">{value}</dd>
              </div>
            ))}
          </dl>
          {remaining > 0 ? (
            <p className="mt-3 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>
                You still have {remaining} test case{remaining === 1 ? "" : "s"} that {remaining === 1 ? "has" : "have"} not been executed. {remaining === 1 ? "It stays" : "They stay"} Not Run in the report; nothing is marked as passed.
              </span>
            </p>
          ) : (
            <p className="mt-3">Every case has a result. Completing locks results and evidence, closes the testing window, and produces the report.</p>
          )}
          {dirtyIds.length > 0 && <p className="mt-2 text-xs font-semibold text-rose-700">{dirtyIds.length} case(s) have unsaved changes that will not be included.</p>}
        </ConfirmDialog>
      )}

      {toast && (
        <div role="status" aria-live="polite" className={`fixed bottom-5 right-5 z-50 flex max-w-md items-start gap-2 rounded-lg px-4 py-3 text-sm font-medium shadow-lg ${toast.tone === "success" ? "bg-[#111c38] text-white" : toast.tone === "warning" ? "bg-amber-50 text-amber-900 ring-1 ring-amber-300" : "bg-rose-50 text-rose-900 ring-1 ring-rose-300"}`}>
          {toast.tone === "success" ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-400" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
          {toast.text}
        </div>
      )}
    </Shell>
  );
}

function StatusButton({ status, icon, current, busy, onClick }: { status: ManualStatus; icon: React.ReactNode; current: ManualStatus; busy: string | null; onClick: () => void }) {
  const tones: Record<string, string> = {
    PASSED: "border-emerald-300 text-emerald-800 hover:bg-emerald-50 aria-pressed:bg-emerald-600 aria-pressed:text-white aria-pressed:border-emerald-600",
    FAILED: "border-rose-300 text-rose-800 hover:bg-rose-50 aria-pressed:bg-rose-600 aria-pressed:text-white aria-pressed:border-rose-600",
    BLOCKED: "border-amber-300 text-amber-900 hover:bg-amber-50 aria-pressed:bg-amber-500 aria-pressed:text-white aria-pressed:border-amber-500",
    NOT_RUN: "border-slate-300 text-slate-700 hover:bg-slate-50 aria-pressed:bg-slate-700 aria-pressed:text-white aria-pressed:border-slate-700",
  };
  const label = { PASSED: "Pass", FAILED: "Fail", BLOCKED: "Blocked", NOT_RUN: "Not run" }[status as "PASSED"];
  return (
    <button
      type="button"
      aria-pressed={current === status}
      disabled={Boolean(busy)}
      onClick={onClick}
      className={`flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-bold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-violet-500 disabled:opacity-50 ${tones[status]}`}
    >
      {busy === status ? <Loader2 size={15} className="animate-spin" /> : icon}
      {label}
    </button>
  );
}

function SetupPanel({ run, busy, requested, onDiscover, onGenerate, readOnly }: { run: ManualRun; busy: string | null; requested: boolean; onDiscover: () => void; onGenerate: () => void; readOnly: boolean }) {
  const discovery = run.discovery;
  const waiting = requested && discovery?.status === "QUEUED";
  const discovering = discovery?.status === "DISCOVERING" || waiting;
  const discovered = discovery?.status === "COMPLETED";
  if (readOnly) return <EmptyState title="No test cases" detail="This run was completed without any test cases." />;
  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <div className="border-b border-slate-100 p-6">
        <h2 className="font-display text-lg font-bold">Prepare the test cases</h2>
        <p className="mt-1 text-sm text-slate-500">Test cases are generated from the application URL, its type, the testing types you chose, your requirements, and - if you run it - discovery of the application&apos;s pages, forms, and links. Every case starts as Not Run.</p>
      </div>
      <ol className="divide-y divide-slate-100">
        <li className="flex flex-wrap items-center gap-4 p-6">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600"><Radar size={18} /></span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-slate-900">1. Discover the application <span className="font-normal text-slate-400">(optional, recommended)</span></p>
            <p className="mt-0.5 text-sm text-slate-500">
              {discovered
                ? `Found ${discovery.pagesDiscovered} pages, ${discovery.formsDiscovered} forms, and ${discovery.linksDiscovered} links. Cases will target them specifically.`
                : waiting
                  ? "Queued - waiting for the discovery worker to pick it up. If this does not start, check that the workers are running (npm run workers)."
                  : discovering
                  ? "Crawling the application in a headless browser…"
                  : discovery?.status === "FAILED"
                    ? `Discovery failed${discovery.failureMessage ? `: ${discovery.failureMessage}` : ""}. You can still generate cases without it.`
                    : "Crawls pages, forms, and links so cases name real fields and pages. Runs in the discovery worker."}
            </p>
          </div>
          {discovering ? (
            <span className="flex items-center gap-2 text-sm font-semibold text-violet-700"><Loader2 size={15} className="animate-spin" /> {waiting ? "Queued" : "Discovering"}</span>
          ) : discovered ? (
            <span className="flex items-center gap-1.5 text-sm font-semibold text-emerald-700"><CheckCircle2 size={15} /> Done</span>
          ) : discovery?.status === "QUEUED" ? (
            <Button variant="secondary" size="sm" icon={<Radar size={14} />} loading={busy === "discovery"} onClick={onDiscover}>Start discovery</Button>
          ) : null}
        </li>
        <li className="flex flex-wrap items-center gap-4 p-6">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-violet-100 text-violet-700"><Wand2 size={18} /></span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-slate-900">2. Generate manual test cases</p>
            <p className="mt-0.5 text-sm text-slate-500">{discovered ? "Uses the discovery results." : "Without discovery, cases are based on the URL, application type, testing types, and requirements."}</p>
          </div>
          <Button icon={<ArrowRight size={15} />} loading={busy === "generate"} disabled={discovering} onClick={onGenerate}>Generate test cases</Button>
        </li>
      </ol>
    </section>
  );
}
