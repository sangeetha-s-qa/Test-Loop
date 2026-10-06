"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileWarning, Film, X } from "lucide-react";
import { manualEvidenceUrl, manualStatusLabels, type ManualEvidence, type ManualProgress, type ManualStatus } from "@/lib/api";

/** Status colours carry meaning, so they are the same everywhere a manual status appears. */
export const statusTone: Record<ManualStatus, { pill: string; dot: string; bar: string }> = {
  PASSED: { pill: "bg-emerald-50 text-emerald-700 ring-emerald-200", dot: "bg-emerald-500", bar: "bg-emerald-500" },
  FAILED: { pill: "bg-rose-50 text-rose-700 ring-rose-200", dot: "bg-rose-500", bar: "bg-rose-500" },
  BLOCKED: { pill: "bg-amber-50 text-amber-800 ring-amber-200", dot: "bg-amber-500", bar: "bg-amber-400" },
  IN_PROGRESS: { pill: "bg-sky-50 text-sky-700 ring-sky-200", dot: "bg-sky-500", bar: "bg-sky-400" },
  NOT_RUN: { pill: "bg-slate-100 text-slate-600 ring-slate-200", dot: "bg-slate-300", bar: "bg-slate-200" },
};

export function StatusPill({ status, className = "" }: { status: ManualStatus; className?: string }) {
  return <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ring-1 ring-inset ${statusTone[status].pill} ${className}`}>{manualStatusLabels[status]}</span>;
}

/**
 * Segmented progress bar plus counts. Every number comes from the server's progress object, which
 * is computed from stored case statuses, so a refresh shows exactly the same thing.
 */
export function ProgressSummary({ progress, compact = false }: { progress: ManualProgress; compact?: boolean }) {
  const segments: { status: ManualStatus; value: number }[] = [
    { status: "PASSED", value: progress.passed },
    { status: "FAILED", value: progress.failed },
    { status: "BLOCKED", value: progress.blocked },
    { status: "IN_PROGRESS", value: progress.inProgress },
  ];
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-semibold text-slate-900">
          {progress.executed} / {progress.total} executed
        </span>
        <span className="font-display text-lg font-bold text-slate-900">{progress.percentComplete}%</span>
      </div>
      <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percentComplete} aria-label="Manual run progress">
        {progress.total > 0 && segments.map(segment => (segment.value ? <span key={segment.status} className={statusTone[segment.status].bar} style={{ width: `${(segment.value / progress.total) * 100}%` }} /> : null))}
      </div>
      {!compact && (
        <dl className="mt-3 grid grid-cols-3 gap-x-4 gap-y-1 text-xs sm:grid-cols-6">
          {[
            ["Total", progress.total, "bg-slate-900"],
            ["Passed", progress.passed, statusTone.PASSED.dot],
            ["Failed", progress.failed, statusTone.FAILED.dot],
            ["Blocked", progress.blocked, statusTone.BLOCKED.dot],
            ["In progress", progress.inProgress, statusTone.IN_PROGRESS.dot],
            ["Not run", progress.notRun, statusTone.NOT_RUN.dot],
          ].map(([label, value, dot]) => (
            <div key={label as string} className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
              <dt className="text-slate-500">{label}</dt>
              <dd className="ml-auto font-bold tabular-nums text-slate-900 sm:ml-1">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** Loads one piece of evidence through a freshly minted signed URL. */
export function useEvidenceUrl(id: string) {
  const [state, setState] = useState<{ url: string | null; error: string | null }>({ url: null, error: null });
  useEffect(() => {
    let cancelled = false;
    manualEvidenceUrl(id)
      .then(result => !cancelled && setState({ url: result.url, error: null }))
      .catch(caught => !cancelled && setState({ url: null, error: caught instanceof Error ? caught.message : "Unable to load evidence" }));
    return () => {
      cancelled = true;
    };
  }, [id]);
  return state;
}

export function EvidenceThumb({ evidence, onOpen, children }: { evidence: ManualEvidence; onOpen: () => void; children?: ReactNode }) {
  const { url, error } = useEvidenceUrl(evidence.id);
  return (
    <figure className="group relative overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
      <button type="button" onClick={onOpen} className="block aspect-video w-full outline-none focus-visible:ring-2 focus-visible:ring-violet-500" aria-label={`Preview ${evidence.fileName}`}>
        {error ? (
          <span className="flex h-full items-center justify-center gap-1 p-2 text-[11px] text-rose-700">
            <FileWarning size={13} /> Unavailable
          </span>
        ) : !url ? (
          <span className="block h-full animate-pulse bg-slate-100" />
        ) : evidence.kind === "VIDEO" ? (
          <span className="flex h-full items-center justify-center gap-1.5 bg-slate-900 text-xs font-semibold text-white">
            <Film size={15} /> Video
          </span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={evidence.fileName} className="h-full w-full object-cover object-top" />
        )}
      </button>
      <figcaption className="flex items-center justify-between gap-1 border-t border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-500">
        <span className="truncate">{evidence.source === "AUTO_ON_FAIL" ? "Auto · on fail" : evidence.source === "BROWSER_CAPTURE" ? "Window capture" : "Upload"}</span>
        <time dateTime={evidence.createdAt}>{new Date(evidence.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
      </figcaption>
      {children}
    </figure>
  );
}

/** Full-size view of one piece of evidence. Escape and the backdrop both close it. */
export function Lightbox({ evidence, onClose }: { evidence: ManualEvidence; onClose: () => void }) {
  const { url, error } = useEvidenceUrl(evidence.id);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4" role="dialog" aria-modal="true" aria-label={evidence.fileName} onClick={onClose}>
      <div className="relative max-h-full max-w-6xl" onClick={event => event.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between gap-4 text-sm text-white">
          <span className="truncate">
            {evidence.fileName}
            {evidence.pageUrl && <span className="ml-2 text-white/60">{evidence.pageUrl}</span>}
          </span>
          <button ref={closeRef} type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white" aria-label="Close preview">
            <X size={18} />
          </button>
        </div>
        {error ? (
          <p className="rounded-lg bg-white p-6 text-sm text-rose-700">{error}</p>
        ) : !url ? (
          <div className="h-64 w-96 animate-pulse rounded-lg bg-white/10" />
        ) : evidence.kind === "VIDEO" ? (
          <video src={url} controls className="max-h-[80vh] rounded-lg bg-black" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={evidence.fileName} className="max-h-[80vh] rounded-lg bg-white object-contain" />
        )}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, children, actions, onClose }: { title: string; children: ReactNode; actions: ReactNode; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" onClick={onClose}>
      <div ref={panelRef} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={event => event.stopPropagation()}>
        <h2 id="confirm-title" className="font-display text-lg font-bold text-slate-900">
          {title}
        </h2>
        <div className="mt-3 text-sm text-slate-600">{children}</div>
        <div className="mt-6 flex flex-wrap justify-end gap-2">{actions}</div>
      </div>
    </div>
  );
}
