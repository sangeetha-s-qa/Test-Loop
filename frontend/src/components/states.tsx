"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { AlertTriangle, Ban, Inbox, Loader2, Lock, RefreshCw } from "lucide-react";
import { ApiError } from "@/lib/api";

/**
 * The four states every data view must be able to show honestly: loading, empty, error, and
 * permission-denied. No view is allowed to render a plausible-looking zero instead of an error.
 */

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 rounded-xl border border-slate-200 bg-white p-12 text-sm text-slate-500">
      <Loader2 size={18} className="animate-spin text-violet-600" />
      {label}…
    </div>
  );
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center">
      <Inbox className="mx-auto text-slate-300" size={28} />
      <p className="mt-3 font-display font-bold text-slate-700">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{detail}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

/**
 * Renders the specific reason a request failed. A 401 sends the user to sign in and a 403 says
 * plainly that the role is insufficient, rather than showing a blank page.
 */
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  if (error instanceof ApiError && error.isUnauthenticated) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-8 text-center">
        <Lock className="mx-auto text-amber-600" size={24} />
        <p className="mt-3 font-display font-bold text-amber-900">Sign in required</p>
        <p className="mt-1 text-sm text-amber-800">Your session has expired or you are not signed in.</p>
        <Link href="/login" className="mt-5 inline-block rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-semibold text-white">
          Go to sign in
        </Link>
      </div>
    );
  }

  if (error instanceof ApiError && error.isForbidden) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
        <Ban className="mx-auto text-slate-400" size={24} />
        <p className="mt-3 font-display font-bold text-slate-700">Not permitted</p>
        <p className="mt-1 text-sm text-slate-500">{error.message}</p>
      </div>
    );
  }

  const message = error instanceof Error ? error.message : "Something went wrong.";
  const code = error instanceof ApiError ? error.code : null;
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 p-6">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 shrink-0 text-rose-600" size={20} />
        <div className="min-w-0 flex-1">
          <p className="font-display font-bold text-rose-900">Unable to load this view</p>
          <p className="mt-1 break-words text-sm text-rose-800">{message}</p>
          {code && <p className="mt-2 font-mono text-xs text-rose-600">{code}</p>}
        </div>
        {retry && (
          <button onClick={retry} className="flex shrink-0 items-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3 py-2 text-xs font-bold text-rose-700">
            <RefreshCw size={13} />
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

/** Explains why an action is unavailable instead of showing a button that silently does nothing. */
export function BlockedNotice({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <p className="flex items-center gap-2 text-sm font-bold text-amber-900">
        <AlertTriangle size={15} />
        {title}
      </p>
      <p className="mt-1 pl-6 text-sm text-amber-800">{detail}</p>
      {children && <div className="mt-3 pl-6">{children}</div>}
    </div>
  );
}

const statusStyles: Record<string, string> = {
  PASSED: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  APPROVED: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  MATCHED: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  COMPLETED: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  FAILED: "bg-rose-50 text-rose-700 ring-rose-200",
  REJECTED: "bg-rose-50 text-rose-700 ring-rose-200",
  DIFFERENT: "bg-rose-50 text-rose-700 ring-rose-200",
  TIMED_OUT: "bg-rose-50 text-rose-700 ring-rose-200",
  ERRORED: "bg-orange-50 text-orange-700 ring-orange-200",
  RUNNING: "bg-sky-50 text-sky-700 ring-sky-200",
  DISCOVERING: "bg-sky-50 text-sky-700 ring-sky-200",
  ANALYZING: "bg-sky-50 text-sky-700 ring-sky-200",
  GENERATING: "bg-sky-50 text-sky-700 ring-sky-200",
  PROVISIONING: "bg-sky-50 text-sky-700 ring-sky-200",
  COLLECTING_ARTIFACTS: "bg-sky-50 text-sky-700 ring-sky-200",
  QUEUED: "bg-amber-50 text-amber-700 ring-amber-200",
  PENDING: "bg-slate-100 text-slate-600 ring-slate-200",
  PROPOSED: "bg-violet-50 text-violet-700 ring-violet-200",
  DRAFT: "bg-slate-100 text-slate-600 ring-slate-200",
  CANCELLED: "bg-slate-100 text-slate-500 ring-slate-200",
  SKIPPED: "bg-slate-100 text-slate-500 ring-slate-200",
  SUPERSEDED: "bg-slate-100 text-slate-500 ring-slate-200",
  PASSED_WITH_WARNINGS: "bg-amber-50 text-amber-700 ring-amber-200",
  NEW_BASELINE_REQUIRED: "bg-violet-50 text-violet-700 ring-violet-200",
};

export function StatusBadge({ status, className = "" }: { status: string; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wide ring-1 ring-inset ${statusStyles[status] ?? "bg-slate-100 text-slate-600 ring-slate-200"} ${className}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}
