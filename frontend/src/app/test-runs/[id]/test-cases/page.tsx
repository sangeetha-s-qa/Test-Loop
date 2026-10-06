"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Search, X } from "lucide-react";
import { Shell } from "@/components/shell";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/states";
import { ApiError, api, type TestCase } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

const statuses = ["ALL", "DRAFT", "APPROVED", "REJECTED"];

export default function TestCasesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const cases = useResource(() => api.get<TestCase[]>(`/api/v1/test-runs/${id}/test-cases`), [id]);

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("ALL");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (cases.data ?? []).filter(item => {
      if (status !== "ALL" && item.status !== status) return false;
      if (!needle) return true;
      return `${item.testCaseId} ${item.title} ${item.module} ${item.category}`.toLowerCase().includes(needle);
    });
  }, [cases.data, query, status]);

  const drafts = (cases.data ?? []).filter(item => item.status === "DRAFT");

  /** Reloads from the server afterwards so the row reflects stored state, not an optimistic guess. */
  const act = async (testCaseId: string, action: "approve" | "reject") => {
    setBusy(testCaseId);
    setActionError(null);
    try {
      await api.post(`/api/v1/test-cases/${testCaseId}/${action}`);
      cases.reload();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : "The action could not be completed.");
    } finally {
      setBusy(null);
    }
  };

  const approveAllDrafts = async () => {
    setBusy("ALL");
    setActionError(null);
    // Sequential so one rejection does not leave the rest in an unknown state.
    for (const item of drafts) {
      try {
        await api.post(`/api/v1/test-cases/${item.id}/approve`);
      } catch (caught) {
        setActionError(caught instanceof ApiError ? `${item.testCaseId} - ${caught.code}: ${caught.message}` : `${item.testCaseId} could not be approved.`);
        break;
      }
    }
    cases.reload();
    setBusy(null);
  };

  return (
    <Shell
      title="Manual test cases"
      subtitle="Generated cases stay in draft until a human approves them"
      actions={
        <Link href={`/test-runs/${id}/ai-analysis`} className="rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-semibold text-white">
          AI analysis
        </Link>
      }
    >
      <Link href={`/test-runs/${id}`} className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-slate-900">
        <ArrowLeft size={16} />
        Test run
      </Link>

      {cases.loading ? (
        <LoadingState label="Loading test cases" />
      ) : cases.error ? (
        <ErrorState error={cases.error} retry={cases.reload} />
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <label className="flex min-w-64 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
              <Search size={17} className="text-slate-400" />
              <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by id, title, module, or category" className="w-full outline-none" />
            </label>
            <select value={status} onChange={event => setStatus(event.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-3 text-sm">
              {statuses.map(value => (
                <option key={value} value={value}>
                  {value === "ALL" ? "All statuses" : value}
                </option>
              ))}
            </select>
            {drafts.length > 0 && (
              <button onClick={approveAllDrafts} disabled={busy !== null} className="flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">
                <Check size={16} />
                {busy === "ALL" ? "Approving…" : `Approve all ${drafts.length} drafts`}
              </button>
            )}
          </div>

          {actionError && <p className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{actionError}</p>}

          {filtered.length === 0 ? (
            <EmptyState
              title={cases.data?.length ? "No cases match these filters" : "No test cases yet"}
              detail={cases.data?.length ? "Adjust the search or status filter." : "Run AI analysis on this test run to generate manual test cases from the discovered pages."}
              action={
                !cases.data?.length && (
                  <Link href={`/test-runs/${id}/ai-analysis`} className="rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-semibold text-white">
                    Go to AI analysis
                  </Link>
                )
              }
            />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-5 py-4">ID</th>
                    <th className="px-5 py-4">Title</th>
                    <th className="px-5 py-4">Module</th>
                    <th className="px-5 py-4">Category</th>
                    <th className="px-5 py-4">Priority</th>
                    <th className="px-5 py-4">Status</th>
                    <th className="px-5 py-4 text-right">Review</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(item => (
                    <tr key={item.id} className="border-b border-slate-50 last:border-0">
                      <td className="px-5 py-4 font-mono text-xs">
                        <Link href={`/test-cases/${item.id}`} className="font-semibold text-violet-600">
                          {item.testCaseId}
                        </Link>
                      </td>
                      <td className="px-5 py-4 font-semibold">{item.title}</td>
                      <td className="px-5 py-4 text-slate-600">{item.module}</td>
                      <td className="px-5 py-4 text-slate-600">{item.category}</td>
                      <td className="px-5 py-4 text-slate-600">{item.priority}</td>
                      <td className="px-5 py-4">
                        <StatusBadge status={item.status} />
                      </td>
                      <td className="px-5 py-4">
                        {item.status === "DRAFT" ? (
                          <div className="flex justify-end gap-2">
                            <button onClick={() => act(item.id, "approve")} disabled={busy !== null} className="flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">
                              <Check size={13} />
                              {busy === item.id ? "…" : "Approve"}
                            </button>
                            <button onClick={() => act(item.id, "reject")} disabled={busy !== null} className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold text-slate-600 disabled:opacity-50">
                              <X size={13} />
                              Reject
                            </button>
                          </div>
                        ) : (
                          <p className="text-right text-xs text-slate-400">Reviewed</p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Shell>
  );
}
