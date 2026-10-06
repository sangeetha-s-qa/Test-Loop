"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { Shell } from "@/components/shell";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/states";
import { Card, Input, Select } from "@/components/ui";
import { api, formatRelative, type CatalogTestCase } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

const statuses = ["ALL", "DRAFT", "APPROVED", "REJECTED"];

export default function TestCasesPage() {
  const cases = useResource(() => api.get<CatalogTestCase[]>("/api/v1/test-cases"), []);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("ALL");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (cases.data ?? []).filter(item => {
      if (status !== "ALL" && item.status !== status) return false;
      if (!needle) return true;
      return `${item.testCaseId} ${item.title} ${item.module} ${item.category} ${item.testRun.project.name}`.toLowerCase().includes(needle);
    });
  }, [cases.data, query, status]);

  const drafts = (cases.data ?? []).filter(item => item.status === "DRAFT").length;

  return (
    <Shell title="Test cases" subtitle={cases.data ? `${cases.data.length} generated across every project · ${drafts} awaiting review` : "Generated cases across every project"}>
      {cases.loading ? (
        <LoadingState label="Loading test cases" />
      ) : cases.error ? (
        <ErrorState error={cases.error} retry={cases.reload} />
      ) : (
        <>
          <div className="mb-5 flex flex-wrap gap-3">
            <label className="flex min-w-64 flex-1 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3">
              <Search size={17} className="shrink-0 text-slate-400" />
              <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by id, title, module, or project" className="border-0 px-0 focus-visible:ring-0" aria-label="Search test cases" />
            </label>
            <Select value={status} onChange={event => setStatus(event.target.value)} aria-label="Filter by status" className="w-auto">
              {statuses.map(value => (
                <option key={value} value={value}>{value === "ALL" ? "All statuses" : value}</option>
              ))}
            </Select>
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              title={cases.data?.length ? "No cases match these filters" : "No test cases yet"}
              detail={cases.data?.length ? "Adjust the search or status filter." : "Start a test run and generate test cases from the discovered pages."}
              action={
                !cases.data?.length && (
                  <Link href="/test-runs/new" className="rounded-lg bg-[#111c38] px-4 py-2.5 text-sm font-semibold text-white">
                    Start a test run
                  </Link>
                )
              }
            />
          ) : (
            <Card className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-left text-sm">
                <thead className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-5 py-3.5">ID</th>
                    <th className="px-5 py-3.5">Title</th>
                    <th className="px-5 py-3.5">Project</th>
                    <th className="px-5 py-3.5">Module</th>
                    <th className="px-5 py-3.5">Priority</th>
                    <th className="px-5 py-3.5">Source</th>
                    <th className="px-5 py-3.5">Status</th>
                    <th className="px-5 py-3.5">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(item => (
                    <tr key={item.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                      <td className="px-5 py-3.5 font-mono text-xs">
                        <Link href={`/test-cases/${item.id}`} className="font-semibold text-violet-600 hover:underline">
                          {item.testCaseId}
                        </Link>
                      </td>
                      <td className="px-5 py-3.5 font-semibold text-slate-800">{item.title}</td>
                      <td className="px-5 py-3.5">
                        <Link href={`/projects/${item.testRun.project.id}`} className="text-slate-600 hover:underline">
                          {item.testRun.project.name}
                        </Link>
                      </td>
                      <td className="px-5 py-3.5 text-slate-600">{item.module}</td>
                      <td className="px-5 py-3.5 text-slate-600">{item.priority}</td>
                      <td className="px-5 py-3.5">
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                          {item.modifiedByUser ? "EDITED" : item.generationSource}
                        </span>
                      </td>
                      <td className="px-5 py-3.5"><StatusBadge status={item.status} /></td>
                      <td className="px-5 py-3.5 text-slate-500">{formatRelative(item.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </Shell>
  );
}
