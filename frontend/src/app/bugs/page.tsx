"use client";

import { useState } from "react";
import Link from "next/link";
import { CalendarClock, Download, MessageSquare, Search } from "lucide-react";
import { Avatar, BugStatusBadge, PriorityBadge, SeverityBadge } from "@/components/bugs/badges";
import { BugViewsNav } from "@/components/bugs/transition-dialog";
import { Shell } from "@/components/shell";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { API_URL, api, type Project } from "@/lib/api";
import { bugStatusMeta, bugStatusOrder, priorityMeta, severityMeta, type Assignee, type BugListItem } from "@/lib/bugs";
import { useResource } from "@/lib/use-resource";

/** Saved views for the questions people actually ask of a bug list. */
const views = [
  { key: "mine", label: "My bugs", query: { assignee: "me", status: "OPEN" } },
  { key: "open", label: "Open", query: { status: "OPEN" } },
  { key: "retest", label: "Ready for retest", query: { status: "READY_FOR_RETEST" } },
  { key: "unassigned", label: "Unassigned", query: { assignee: "unassigned", status: "OPEN" } },
  { key: "done", label: "Done", query: { status: "DONE" } },
  { key: "all", label: "All", query: {} },
] as const;

const select = "rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm";

export default function BugsPage() {
  const [view, setView] = useState<(typeof views)[number]["key"]>("open");
  const [filters, setFilters] = useState({ status: "", severity: "ALL", priority: "ALL", assignee: "", source: "ALL", projectId: "" });
  const [search, setSearch] = useState("");
  const projects = useResource(() => api.get<Project[]>("/api/v1/projects"), []);
  const people = useResource(() => api.get<Assignee[]>("/api/v1/team/assignees"), []);

  const base: Record<string, string> = { ...views.find(item => item.key === view)!.query };
  const query = new URLSearchParams({
    status: filters.status || base.status || "ALL",
    assignee: filters.assignee || base.assignee || "ALL",
    severity: filters.severity,
    priority: filters.priority,
    source: filters.source,
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(search.trim() ? { q: search.trim() } : {}),
  }).toString();
  const bugs = useResource(() => api.get<BugListItem[]>(`/api/v1/bugs?${query}`), [query]);
  const set = (key: keyof typeof filters, value: string) => setFilters(current => ({ ...current, [key]: value }));
  // Captured once per visit; "overdue" does not need to tick while the page is open.
  const [now] = useState(() => Date.now());

  return (
    <Shell
      title="Bugs"
      subtitle="Triage, assign, fix, retest, and close"
      actions={
        <div className="flex items-center gap-2">
          {filters.projectId && (
            <a href={`${API_URL}/api/v1/projects/${filters.projectId}/bugs/export`} className="hidden items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 sm:flex">
              <Download size={15} /> Export CSV
            </a>
          )}
          <BugViewsNav current="list" />
        </div>
      }
    >
      <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200" aria-label="Bug views">
        {views.map(item => (
          <button
            key={item.key}
            type="button"
            onClick={() => {
              setView(item.key);
              setFilters(current => ({ ...current, status: "", assignee: "" }));
            }}
            aria-current={view === item.key ? "page" : undefined}
            className={`whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-semibold ${view === item.key ? "border-violet-600 text-violet-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="mb-4 flex flex-wrap gap-2">
        <label className="flex min-w-56 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm focus-within:ring-2 focus-within:ring-violet-500">
          <Search size={16} className="text-slate-400" />
          <span className="sr-only">Search bugs</span>
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search title or BUG-0001" className="w-full outline-none" />
        </label>
        <select aria-label="Status" value={filters.status} onChange={event => set("status", event.target.value)} className={select}>
          <option value="">Status: view default</option>
          {bugStatusOrder.map(value => <option key={value} value={value}>{bugStatusMeta[value].label}</option>)}
        </select>
        <select aria-label="Severity" value={filters.severity} onChange={event => set("severity", event.target.value)} className={select}>
          <option value="ALL">Any severity</option>
          {Object.entries(severityMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}
        </select>
        <select aria-label="Priority" value={filters.priority} onChange={event => set("priority", event.target.value)} className={select}>
          <option value="ALL">Any priority</option>
          {Object.entries(priorityMeta).map(([value, meta]) => <option key={value} value={value}>{value} · {meta.detail}</option>)}
        </select>
        <select aria-label="Assignee" value={filters.assignee} onChange={event => set("assignee", event.target.value)} className={select}>
          <option value="">Assignee: view default</option>
          <option value="me">Me</option>
          <option value="unassigned">Unassigned</option>
          {people.data?.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
        </select>
        <select aria-label="Source" value={filters.source} onChange={event => set("source", event.target.value)} className={select}>
          <option value="ALL">Manual and automated</option>
          <option value="MANUAL">Manual testing</option>
          <option value="AUTOMATED">Automated runs</option>
        </select>
        <select aria-label="Project" value={filters.projectId} onChange={event => set("projectId", event.target.value)} className={select}>
          <option value="">All projects</option>
          {projects.data?.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </div>

      {bugs.loading ? (
        <LoadingState label="Loading bugs" />
      ) : bugs.error ? (
        <ErrorState error={bugs.error} retry={bugs.reload} />
      ) : !bugs.data?.length ? (
        <EmptyState
          title={view === "mine" ? "Nothing assigned to you" : "No bugs here"}
          detail={view === "mine" ? "Bugs assigned to you appear here, most urgent first." : "Bugs are raised from failed manual test cases and failed automated executions."}
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3">Bug</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Severity</th>
                <th className="px-4 py-3">Priority</th>
                <th className="px-4 py-3">Assignee</th>
                <th className="px-4 py-3">Due</th>
                <th className="px-4 py-3">Updated</th>
              </tr>
            </thead>
            <tbody>
              {bugs.data.map(bug => {
                const overdue = bug.dueAt && new Date(bug.dueAt).getTime() < now && !["VERIFIED", "CLOSED", "REJECTED", "DUPLICATE"].includes(bug.status);
                return (
                  <tr key={bug.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                    <td className="max-w-[420px] px-4 py-3">
                      <Link href={`/bugs/${bug.id}`} className="group block">
                        <span className="font-mono text-xs font-bold text-violet-700">{bug.reference}</span>
                        <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">{bug.source === "MANUAL" ? "Manual" : "Automated"}</span>
                        <span className="mt-0.5 block truncate font-medium text-slate-900 group-hover:underline">{bug.title}</span>
                        <span className="flex items-center gap-2 text-xs text-slate-400">
                          {bug.project.name}
                          {bug._count.comments > 0 && <span className="flex items-center gap-0.5"><MessageSquare size={11} /> {bug._count.comments}</span>}
                        </span>
                      </Link>
                    </td>
                    <td className="px-4 py-3"><BugStatusBadge status={bug.status} /></td>
                    <td className="px-4 py-3"><SeverityBadge severity={bug.severity} /></td>
                    <td className="px-4 py-3"><PriorityBadge priority={bug.priority} /></td>
                    <td className="px-4 py-3">
                      {bug.assignee ? <span className="flex items-center gap-2"><Avatar name={bug.assignee.name} /> {bug.assignee.name}</span> : <span className="text-slate-400">Unassigned</span>}
                    </td>
                    <td className={`px-4 py-3 text-xs ${overdue ? "font-bold text-rose-700" : "text-slate-500"}`}>
                      {bug.dueAt ? <span className="flex items-center gap-1">{overdue && <CalendarClock size={12} />}{new Date(bug.dueAt).toLocaleDateString()}</span> : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">{new Date(bug.updatedAt).toLocaleDateString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
