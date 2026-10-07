"use client";

import { useMemo, useRef, useState, type DragEvent } from "react";
import Link from "next/link";
import { CalendarClock, GripVertical, MessageSquare, MoreHorizontal, RotateCcw, Search } from "lucide-react";
import { Avatar, PriorityBadge, SeverityBadge, BugStatusBadge } from "@/components/bugs/badges";
import { BugViewsNav, TransitionDialog, transitionNeeds } from "@/components/bugs/transition-dialog";
import { Shell } from "@/components/shell";
import { ErrorState, LoadingState } from "@/components/states";
import { ApiError, api, type Project } from "@/lib/api";
import { bugStatusMeta, priorityMeta, severityMeta, transitionVerb, type Assignee, type BugPriority, type BugSeverity, type BugStatus } from "@/lib/bugs";
import { useResource } from "@/lib/use-resource";

type Card = {
  id: string;
  reference: string;
  title: string;
  status: BugStatus;
  severity: BugSeverity;
  priority: BugPriority;
  source: "AUTOMATED" | "MANUAL";
  dueAt: string | null;
  reopenCount: number;
  assigneeId: string | null;
  assignee: { id: string; name: string } | null;
  project: { id: string; name: string };
  _count: { comments: number };
  allowedTransitions: BugStatus[];
};
type Column = { key: string; label: string; statuses: BugStatus[]; bugs: Card[] };
type Board = { columns: Column[]; doneDays: number; truncated: boolean };

/** What dropping a card on a column means. Done and Parked hold several statuses, so they can mean several moves. */
const dropTargets: Record<string, BugStatus[]> = {
  NEW: ["NEW"],
  ASSIGNED: ["ASSIGNED"],
  IN_PROGRESS: ["IN_PROGRESS"],
  FIXED: ["FIXED"],
  READY_FOR_RETEST: ["READY_FOR_RETEST"],
  DONE: ["VERIFIED", "CLOSED"],
  PARKED: ["DEFERRED", "REJECTED", "DUPLICATE"],
};

const sharedColumnStatuses: BugStatus[] = ["REOPENED", "VERIFIED", "CLOSED", "DEFERRED", "REJECTED", "DUPLICATE"];

const movesInto = (card: Card, columnKey: string) => dropTargets[columnKey].filter(status => card.allowedTransitions.includes(status));

const select = "rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm";

function BugCard({ card, now, dragging, onDragStart, onDragEnd, onMove }: { card: Card; now: number; dragging: boolean; onDragStart: (event: DragEvent) => void; onDragEnd: () => void; onMove: (to: BugStatus[]) => void }) {
  const [menu, setMenu] = useState(false);
  const overdue = card.dueAt && new Date(card.dueAt).getTime() < now && !["VERIFIED", "CLOSED", "REJECTED", "DUPLICATE"].includes(card.status);
  const movable = card.allowedTransitions.length > 0;
  return (
    <li
      draggable={movable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`group relative rounded-lg border bg-white p-3 shadow-sm transition-opacity ${dragging ? "opacity-40" : ""} ${card.priority === "P1" ? "border-l-4 border-l-rose-500 border-slate-200" : "border-slate-200"} ${movable ? "cursor-grab active:cursor-grabbing" : ""}`}
    >
      <div className="flex items-center gap-1.5">
        {movable && <GripVertical size={13} className="-ml-1 text-slate-300" aria-hidden="true" />}
        <Link href={`/bugs/${card.id}`} className="font-mono text-[11px] font-bold text-violet-700 hover:underline">{card.reference}</Link>
        {/* Only columns that hold several statuses need a badge to tell them apart. */}
        {sharedColumnStatuses.includes(card.status) && <BugStatusBadge status={card.status} />}
        {card.reopenCount > 0 && card.status !== "REOPENED" && <span className="flex items-center gap-0.5 text-[10px] font-bold text-rose-700" title={`Reopened ${card.reopenCount}×`}><RotateCcw size={10} />{card.reopenCount}</span>}
        {movable && (
          <button type="button" onClick={() => setMenu(value => !value)} aria-haspopup="menu" aria-expanded={menu} aria-label={`Move ${card.reference}`} className="ml-auto rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-violet-500">
            <MoreHorizontal size={15} />
          </button>
        )}
      </div>
      <Link href={`/bugs/${card.id}`} className="mt-1 line-clamp-2 block text-sm font-medium leading-snug text-slate-900 hover:underline">{card.title}</Link>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <PriorityBadge priority={card.priority} />
        <SeverityBadge severity={card.severity} />
        {card.source === "MANUAL" && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">Manual</span>}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-500">
        {card.assignee ? <span className="flex min-w-0 items-center gap-1"><Avatar name={card.assignee.name} size={18} /><span className="truncate">{card.assignee.name}</span></span> : <span className="text-slate-400">Unassigned</span>}
        <span className="ml-auto flex items-center gap-2">
          {card._count.comments > 0 && <span className="flex items-center gap-0.5"><MessageSquare size={11} />{card._count.comments}</span>}
          {card.dueAt && <span className={`flex items-center gap-0.5 ${overdue ? "font-bold text-rose-700" : ""}`}>{overdue && <CalendarClock size={11} />}{new Date(card.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>}
        </span>
      </div>
      {menu && (
        <ul role="menu" className="absolute right-2 top-8 z-20 w-48 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg">
          {card.allowedTransitions.map(to => (
            <li key={to}>
              <button type="button" role="menuitem" onClick={() => { setMenu(false); onMove([to]); }} className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-slate-50">
                {transitionVerb[to]}
                <span className="text-[11px] text-slate-400">{bugStatusMeta[to].label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export default function BoardPage() {
  const [filters, setFilters] = useState({ projectId: "", assignee: "ALL", priority: "ALL", severity: "ALL", source: "ALL", doneDays: "14" });
  const [search, setSearch] = useState("");
  const [showParked, setShowParked] = useState(false);
  const [lanes, setLanes] = useState<"none" | "assignee">("none");
  const [dragging, setDragging] = useState<Card | null>(null);
  // The same card, set synchronously on dragstart. Drop acceptance reads this rather than state, so a
  // fast drag that reaches a column before React re-renders is still judged correctly.
  const draggingRef = useRef<Card | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [pending, setPending] = useState<{ card: Card; options: BugStatus[] } | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [now] = useState(() => Date.now());

  const projects = useResource(() => api.get<Project[]>("/api/v1/projects"), []);
  const people = useResource(() => api.get<Assignee[]>("/api/v1/team/assignees"), []);
  const query = new URLSearchParams({ assignee: filters.assignee, priority: filters.priority, severity: filters.severity, source: filters.source, doneDays: filters.doneDays, ...(filters.projectId ? { projectId: filters.projectId } : {}), ...(search.trim() ? { q: search.trim() } : {}) }).toString();
  // Re-read every 20s so moves made by teammates appear without a reload.
  const board = useResource(() => api.get<Board>(`/api/v1/bugs/board?${query}`), [query], { intervalMs: 20_000, shouldPoll: () => true });
  const set = (key: keyof typeof filters, value: string) => setFilters(current => ({ ...current, [key]: value }));

  const columns = useMemo(() => (board.data?.columns ?? []).filter(column => showParked || column.key !== "PARKED"), [board.data, showParked]);
  const swimlanes = useMemo(() => {
    if (lanes === "none") return [{ key: "all", label: null as string | null, filter: () => true }];
    const names = new Map<string | null, string>();
    for (const column of columns) for (const card of column.bugs) names.set(card.assignee?.id ?? null, card.assignee?.name ?? "Unassigned");
    return [...names.entries()].sort((a, b) => (a[0] === null ? 1 : b[0] === null ? -1 : a[1].localeCompare(b[1]))).map(([id, name]) => ({ key: id ?? "none", label: name, filter: (card: Card) => (card.assignee?.id ?? null) === id }));
  }, [columns, lanes]);

  /** Moves straight away when nothing more is needed; otherwise asks in the dialog. */
  const requestMove = async (card: Card, options: BugStatus[]) => {
    if (!options.length) return;
    if (options.length > 1 || transitionNeeds[options[0]]) return setPending({ card, options });
    setMessage(null);
    try {
      await api.post(`/api/v1/bugs/${card.id}/transition`, { to: options[0] });
      setMessage({ tone: "ok", text: `${card.reference} → ${bugStatusMeta[options[0]].label}` });
      board.reload();
    } catch (caught) {
      setMessage({ tone: "error", text: caught instanceof ApiError ? `${card.reference}: ${caught.message}` : "The bug could not be moved." });
      board.reload();
    }
  };

  const drop = (columnKey: string) => {
    const card = draggingRef.current;
    draggingRef.current = null;
    setDragging(null);
    setOver(null);
    if (!card || columns.find(column => column.key === columnKey)?.statuses.includes(card.status)) return;
    const options = movesInto(card, columnKey);
    if (!options.length) return setMessage({ tone: "error", text: `${card.reference} can't move to ${columns.find(column => column.key === columnKey)?.label} from ${bugStatusMeta[card.status].label.toLowerCase()} - or that move isn't yours to make.` });
    // From Verified, dropping on Done can only mean Close; from elsewhere, Verify comes first.
    void requestMove(card, columnKey === "DONE" ? options.slice(0, 1) : options);
  };

  return (
    <Shell title="Bug board" subtitle="Drag a bug to move it through the workflow" actions={<BugViewsNav current="board" />}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="flex min-w-52 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus-within:ring-2 focus-within:ring-violet-500">
          <Search size={15} className="text-slate-400" />
          <span className="sr-only">Search bugs</span>
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search title or BUG-0001" className="w-full outline-none" />
        </label>
        <select aria-label="Project" value={filters.projectId} onChange={event => set("projectId", event.target.value)} className={select}>
          <option value="">All projects</option>
          {projects.data?.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <select aria-label="Assignee" value={filters.assignee} onChange={event => set("assignee", event.target.value)} className={select}>
          <option value="ALL">Everyone</option>
          <option value="me">Assigned to me</option>
          <option value="unassigned">Unassigned</option>
          {people.data?.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
        </select>
        <select aria-label="Priority" value={filters.priority} onChange={event => set("priority", event.target.value)} className={select}>
          <option value="ALL">Any priority</option>
          {Object.keys(priorityMeta).map(value => <option key={value} value={value}>{value}</option>)}
        </select>
        <select aria-label="Severity" value={filters.severity} onChange={event => set("severity", event.target.value)} className={select}>
          <option value="ALL">Any severity</option>
          {Object.entries(severityMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}
        </select>
        <select aria-label="Group by" value={lanes} onChange={event => setLanes(event.target.value as "none" | "assignee")} className={select}>
          <option value="none">No swimlanes</option>
          <option value="assignee">Swimlane per assignee</option>
        </select>
        <select aria-label="Finished bugs shown for" value={filters.doneDays} onChange={event => set("doneDays", event.target.value)} className={select}>
          {["7", "14", "30"].map(days => <option key={days} value={days}>Done: last {days} days</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={showParked} onChange={event => setShowParked(event.target.checked)} className="h-4 w-4 accent-violet-600" />
          Show parked
        </label>
      </div>

      {message && <p role="status" className={`mb-3 rounded-lg px-3 py-2 text-sm ${message.tone === "ok" ? "bg-emerald-50 text-emerald-900" : "bg-rose-50 text-rose-900"}`}>{message.text}</p>}

      {board.loading ? (
        <LoadingState label="Loading board" />
      ) : board.error || !board.data ? (
        <ErrorState error={board.error ?? new Error("Board unavailable")} retry={board.reload} />
      ) : (
        <div className="space-y-6">
          {swimlanes.map(lane => (
            <section key={lane.key} aria-label={lane.label ?? "Board"}>
              {lane.label && <h2 className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-800"><Avatar name={lane.label} size={20} /> {lane.label} <span className="font-normal text-slate-400">· {columns.reduce((sum, column) => sum + column.bugs.filter(lane.filter).length, 0)}</span></h2>}
              <div className="flex gap-3 overflow-x-auto pb-2">
                {columns.map(column => {
                  const cards = column.bugs.filter(lane.filter);
                  const valid = dragging ? !column.statuses.includes(dragging.status) && movesInto(dragging, column.key).length > 0 : false;
                  const home = dragging ? column.statuses.includes(dragging.status) : false;
                  return (
                    <div
                      key={column.key}
                      onDragOver={event => {
                        const current = draggingRef.current;
                        if (!current || column.statuses.includes(current.status) || !movesInto(current, column.key).length) return;
                        event.preventDefault();
                        setOver(`${lane.key}:${column.key}`);
                      }}
                      onDragLeave={() => setOver(current => (current === `${lane.key}:${column.key}` ? null : current))}
                      onDrop={event => {
                        event.preventDefault();
                        drop(column.key);
                      }}
                      className={`flex min-w-48 flex-1 basis-0 flex-col rounded-xl border-2 p-2 transition-colors ${!dragging ? "border-transparent bg-slate-100/70" : valid ? (over === `${lane.key}:${column.key}` ? "border-violet-500 bg-violet-50" : "border-dashed border-violet-300 bg-violet-50/40") : home ? "border-transparent bg-slate-100/70" : "border-transparent bg-slate-100/40 opacity-50"}`}
                    >
                      <h3 className="flex items-center justify-between px-1.5 pb-2 pt-1 text-xs font-bold uppercase tracking-wide text-slate-500">
                        {column.label}
                        <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-slate-600">{cards.length}</span>
                      </h3>
                      <ul className="flex min-h-24 flex-1 flex-col gap-2">
                        {cards.map(card => (
                          <BugCard
                            key={card.id}
                            card={card}
                            now={now}
                            dragging={dragging?.id === card.id}
                            onDragStart={event => {
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData("text/plain", card.id);
                              draggingRef.current = card;
                              setDragging(card);
                              setMessage(null);
                            }}
                            onDragEnd={() => {
                              draggingRef.current = null;
                              setDragging(null);
                              setOver(null);
                            }}
                            onMove={options => requestMove(card, options)}
                          />
                        ))}
                        {!cards.length && <li className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-400">{column.key === "DONE" ? `Nothing finished in the last ${board.data!.doneDays} days` : "No bugs"}</li>}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
          {board.data.truncated && <p className="text-xs text-amber-800">Showing the first 500 bugs. Narrow the filters to see the rest.</p>}
        </div>
      )}

      {pending && (
        <TransitionDialog
          bug={pending.card}
          options={pending.options}
          onClose={() => setPending(null)}
          onDone={() => {
            setMessage({ tone: "ok", text: `${pending.card.reference} moved` });
            setPending(null);
            board.reload();
          }}
        />
      )}
    </Shell>
  );
}
