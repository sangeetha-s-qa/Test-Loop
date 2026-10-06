"use client";

import { use, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Ban, BugPlay, Download, Printer, XCircle } from "lucide-react";
import { Shell } from "@/components/shell";
import { ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui";
import { EvidenceThumb, Lightbox, ProgressSummary, StatusPill } from "@/components/manual/shared";
import { BugStatusBadge, PriorityBadge, SeverityBadge } from "@/components/bugs/badges";
import { RaiseBugDialog } from "@/components/bugs/raise-bug-dialog";
import { ApiError } from "@/lib/api";
import type { BugPriority, BugSeverity, BugStatus } from "@/lib/bugs";
import { API_URL, api, blockedReasonLabels, formatDateTime, type BlockedReason, type ManualEvidence, type ManualProgress, type ManualStatus } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

type ReportCase = { id: string; testCaseId: string; title: string; category: string; priority: string; expectedResult: string; actualResult: string; testerNotes: string; blockedReason: BlockedReason | null; executedAt: string | null; executedBy: { name: string } | null; evidence: ManualEvidence[]; bugs: { id: string; reference: string; status: BugStatus; severity: BugSeverity; priority: BugPriority; assignee: { name: string } | null }[] };

type Report = {
  final: boolean;
  run: { id: string; project: { id: string; name: string }; applicationUrl: string; applicationTypeLabel: string | null; testingMethod: string; testingTypes: string[]; browser: string | null; viewport: string | null; status: string; createdAt: string; startedAt: string | null; completedAt: string | null; completedBy: { name: string } | null; testers: string[] };
  summary: ManualProgress;
  byType: (ManualProgress & { type: string })[];
  failed: ReportCase[];
  blocked: ReportCase[];
  cases: { id: string; testCaseId: string; title: string; category: string; priority: string; manualStatus: ManualStatus; executedAt: string | null; executedBy: string | null; evidenceCount: number }[];
  evidenceCount: number;
  timeline: { id: string; type: string; fromStatus: ManualStatus | null; toStatus: ManualStatus | null; detail: Record<string, unknown>; createdAt: string; user: string | null; testCase: { testCaseId: string; title: string } | null }[];
};

const eventLabel = (event: Report["timeline"][number]) => {
  switch (event.type) {
    case "STATUS_CHANGED":
      return `${event.testCase?.testCaseId ?? "Case"} ${event.fromStatus?.replace(/_/g, " ").toLowerCase()} → ${event.toStatus?.replace(/_/g, " ").toLowerCase()}`;
    case "RESULT_UPDATED":
      return `${event.testCase?.testCaseId ?? "Case"} result text updated`;
    case "EVIDENCE_ADDED":
      return `${event.testCase?.testCaseId ?? "Run"} evidence added (${String(event.detail.source ?? "").replace(/_/g, " ").toLowerCase()})`;
    case "EVIDENCE_REMOVED":
      return `${event.testCase?.testCaseId ?? "Run"} evidence removed`;
    case "CASES_GENERATED":
      return `${String(event.detail.count ?? "")} test cases generated${event.detail.usedDiscovery ? " from discovery" : ""}`;
    case "SESSION_STARTED":
      return `Testing window opened (${String(event.detail.browser ?? "")})`;
    case "SESSION_CLOSED":
      return "Testing window closed";
    case "RUN_COMPLETED":
      return "Run completed";
    default:
      return event.type.replace(/_/g, " ").toLowerCase();
  }
};

export default function ManualReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const report = useResource(() => api.get<Report>(`/api/v1/manual-runs/${id}/report`), [id]);
  const [preview, setPreview] = useState<ManualEvidence | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [raising, setRaising] = useState<ReportCase | null>(null);
  const [bulk, setBulk] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null });

  /** Raises a bug for every failed case that does not have one yet. Cases that do are left alone. */
  const raiseAll = async () => {
    setBulk({ busy: true, message: null });
    try {
      const created = await api.post<{ reference: string }[]>(`/api/v1/manual-runs/${id}/bugs`, {});
      setBulk({ busy: false, message: created.length ? `Raised ${created.map(bug => bug.reference).join(", ")}. Assign them from the Bugs page.` : "Every failed case already has a bug." });
      report.reload();
    } catch (caught) {
      setBulk({ busy: false, message: caught instanceof ApiError ? caught.message : "Bugs could not be raised." });
    }
  };

  /** The CSV is produced by the API from stored rows; this only saves what it returns. */
  const downloadCsv = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const response = await fetch(`${API_URL}/api/v1/manual-runs/${id}/report?format=csv`, { credentials: "include" });
      if (!response.ok) throw new Error(`Export failed with status ${response.status}`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `manual-run-${id.slice(0, 8)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setDownloadError(caught instanceof Error ? caught.message : "Export failed");
    } finally {
      setDownloading(false);
    }
  };

  if (report.loading) return <Shell title="Manual test report"><LoadingState label="Building report" /></Shell>;
  if (report.error || !report.data) return <Shell title="Manual test report"><ErrorState error={report.error ?? new Error("Report not found")} retry={report.reload} /></Shell>;

  const { run, summary, byType, failed, blocked, cases, timeline } = report.data;
  const info: [string, string][] = [
    ["Project", run.project.name],
    ["Application URL", run.applicationUrl],
    ["Application type", run.applicationTypeLabel ?? "—"],
    ["Testing method", run.testingMethod === "MANUAL" ? "Manual testing" : run.testingMethod],
    ["Testing types", run.testingTypes.join(", ")],
    ["Browser", run.browser ? `${run.browser}${run.viewport ? ` · ${run.viewport}` : ""}` : "—"],
    ["Tester(s)", run.testers.join(", ") || "—"],
    ["Started", formatDateTime(run.startedAt)],
    ["Completed", run.completedAt ? `${formatDateTime(run.completedAt)}${run.completedBy ? ` by ${run.completedBy.name}` : ""}` : "Not completed"],
  ];

  return (
    <Shell
      title="Manual test report"
      subtitle={`${run.project.name} · ${run.applicationUrl}`}
      actions={
        <div className="flex gap-2 print:hidden">
          <Button variant="secondary" icon={<Download size={15} />} loading={downloading} onClick={downloadCsv}>
            Export CSV
          </Button>
          <Button variant="secondary" icon={<Printer size={15} />} onClick={() => window.print()}>
            Print / PDF
          </Button>
        </div>
      }
    >
      <Link href={`/test-runs/${id}/manual`} className="mb-4 inline-flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-slate-900 print:hidden">
        <ArrowLeft size={16} /> Manual workspace
      </Link>
      {downloadError && <p className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{downloadError}</p>}
      {!report.data.final && (
        <p className="mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertTriangle size={16} /> Draft: this run is still in progress, so these figures will change until it is completed.
        </p>
      )}

      <div className="space-y-5">
        <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="font-display text-base font-bold">Run information</h2>
            <dl className="mt-3 divide-y divide-slate-100 text-sm">
              {info.map(([label, value]) => (
                <div key={label} className="grid grid-cols-[8.5rem_1fr] gap-3 py-2">
                  <dt className="text-slate-500">{label}</dt>
                  <dd className="break-words font-medium text-slate-900">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="font-display text-base font-bold">Summary</h2>
            <dl className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-6">
              {[
                ["Total", summary.total, "text-slate-900"],
                ["Passed", summary.passed, "text-emerald-700"],
                ["Failed", summary.failed, "text-rose-700"],
                ["Blocked", summary.blocked, "text-amber-700"],
                ["Not run", summary.notRun + summary.inProgress, "text-slate-500"],
                ["Pass rate", summary.passRate === null ? "—" : `${summary.passRate}%`, "text-slate-900"],
              ].map(([label, value, tone]) => (
                <div key={label as string} className="rounded-lg bg-slate-50 px-3 py-2.5">
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
                  <dd className={`mt-0.5 font-display text-2xl font-bold tabular-nums ${tone}`}>{value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-5">
              <ProgressSummary progress={summary} compact />
            </div>
            <p className="mt-3 text-xs text-slate-500">Pass rate is passed ÷ (passed + failed). Blocked cases never reached the application, so they are excluded; unexecuted cases are reported as Not run, never as passed.</p>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="font-display text-base font-bold">Testing type breakdown</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-3 font-semibold">Type</th>
                  {["Total", "Passed", "Failed", "Blocked", "Not run", "Pass rate"].map(label => <th key={label} className="px-3 py-2 text-right font-semibold">{label}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {byType.map(row => (
                  <tr key={row.type}>
                    <td className="py-2 pr-3 font-medium text-slate-900">{row.type}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.total}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{row.passed}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-rose-700">{row.failed}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-amber-700">{row.blocked}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">{row.notRun + row.inProgress}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.passRate === null ? "—" : `${row.passRate}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 font-display text-base font-bold">
              <XCircle size={17} className="text-rose-600" /> Failed test cases ({failed.length})
            </h2>
            {failed.some(item => !item.bugs.length) && (
              <Button variant="danger" size="sm" icon={<BugPlay size={14} />} loading={bulk.busy} onClick={raiseAll} className="print:hidden">
                Raise bugs for {failed.filter(item => !item.bugs.length).length} failed case{failed.filter(item => !item.bugs.length).length === 1 ? "" : "s"}
              </Button>
            )}
          </div>
          {bulk.message && <p role="status" className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{bulk.message}</p>}
          {failed.length ? (
            <div className="mt-4 space-y-4">
              {failed.map(item => (
                <article key={item.id} className="break-inside-avoid rounded-lg border border-rose-200">
                  <header className="flex flex-wrap items-baseline gap-2 border-b border-rose-100 bg-rose-50/60 px-4 py-2.5">
                    <span className="font-mono text-xs font-semibold text-rose-800">{item.testCaseId}</span>
                    <h3 className="font-semibold text-slate-900">{item.title}</h3>
                    {item.bugs[0] ? (
                      <Link href={`/bugs/${item.bugs[0].id}`} className="flex items-center gap-1.5 rounded-md bg-white px-2 py-0.5 ring-1 ring-rose-200">
                        <span className="font-mono text-xs font-bold text-violet-700">{item.bugs[0].reference}</span>
                        <BugStatusBadge status={item.bugs[0].status} />
                        <SeverityBadge severity={item.bugs[0].severity} />
                        <PriorityBadge priority={item.bugs[0].priority} />
                        <span className="text-xs text-slate-500">{item.bugs[0].assignee?.name ?? "Unassigned"}</span>
                      </Link>
                    ) : (
                      <Button size="sm" variant="secondary" icon={<BugPlay size={13} />} onClick={() => setRaising(item)} className="print:hidden">Raise bug</Button>
                    )}
                    <span className="ml-auto text-xs text-slate-500">
                      {item.category} · {item.priority.toLowerCase()}
                      {item.executedBy && ` · ${item.executedBy.name}`}
                      {item.executedAt && ` · ${formatDateTime(item.executedAt)}`}
                    </span>
                  </header>
                  <dl className="grid gap-4 p-4 text-sm md:grid-cols-3">
                    <div>
                      <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Expected result</dt>
                      <dd className="mt-1 text-slate-800">{item.expectedResult}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Actual result</dt>
                      <dd className="mt-1 whitespace-pre-wrap text-slate-900">{item.actualResult}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Failure notes</dt>
                      <dd className="mt-1 whitespace-pre-wrap text-slate-800">{item.testerNotes}</dd>
                    </div>
                  </dl>
                  <div className="border-t border-slate-100 px-4 py-3">
                    <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Evidence ({item.evidence.length})</p>
                    {item.evidence.length ? (
                      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                        {item.evidence.map(evidence => <EvidenceThumb key={evidence.id} evidence={evidence} onOpen={() => setPreview(evidence)} />)}
                      </div>
                    ) : (
                      <p className="mt-1 text-xs text-slate-500">No evidence was attached to this failure.</p>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-500">No test case was marked Failed.</p>
          )}
        </section>

        {blocked.length > 0 && (
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="flex items-center gap-2 font-display text-base font-bold">
              <Ban size={17} className="text-amber-600" /> Blocked test cases ({blocked.length})
            </h2>
            <ul className="mt-3 divide-y divide-slate-100 text-sm">
              {blocked.map(item => (
                <li key={item.id} className="grid gap-1 py-2.5 md:grid-cols-[6rem_minmax(0,1fr)_14rem]">
                  <span className="font-mono text-xs text-slate-500">{item.testCaseId}</span>
                  <span>
                    <span className="font-medium text-slate-900">{item.title}</span>
                    {item.testerNotes && <span className="mt-0.5 block text-xs text-slate-500">{item.testerNotes}</span>}
                  </span>
                  <span className="text-amber-800">{item.blockedReason ? blockedReasonLabels[item.blockedReason] : "—"}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="font-display text-base font-bold">All test cases ({cases.length})</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-3 font-semibold">ID</th>
                  <th className="px-3 py-2 font-semibold">Title</th>
                  <th className="px-3 py-2 font-semibold">Type</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold">Executed</th>
                  <th className="px-3 py-2 text-right font-semibold">Evidence</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {cases.map(item => (
                  <tr key={item.id}>
                    <td className="py-2 pr-3 font-mono text-xs text-slate-500">{item.testCaseId}</td>
                    <td className="px-3 py-2 text-slate-900">{item.title}</td>
                    <td className="px-3 py-2 text-slate-600">{item.category}</td>
                    <td className="px-3 py-2"><StatusPill status={item.manualStatus} /></td>
                    <td className="px-3 py-2 text-xs text-slate-500">{item.executedAt ? `${formatDateTime(item.executedAt)}${item.executedBy ? ` · ${item.executedBy}` : ""}` : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{item.evidenceCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="font-display text-base font-bold">Execution timeline</h2>
          {timeline.length ? (
            <ol className="mt-3 space-y-0 border-l border-slate-200 pl-4 text-sm">
              {timeline.map(event => (
                <li key={event.id} className="relative py-1.5">
                  <span className="absolute -left-[21px] top-3 h-2 w-2 rounded-full bg-slate-300" aria-hidden="true" />
                  <time className="mr-3 font-mono text-xs text-slate-400" dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time>
                  <span className="text-slate-800">{eventLabel(event)}</span>
                  {event.user && <span className="text-slate-400"> · {event.user}</span>}
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-3 text-sm text-slate-500">No activity was recorded.</p>
          )}
        </section>
      </div>

      {preview && <Lightbox evidence={preview} onClose={() => setPreview(null)} />}
      {raising && (
        <RaiseBugDialog
          runId={id}
          testCase={raising}
          onClose={() => setRaising(null)}
          onRaised={() => {
            setRaising(null);
            report.reload();
          }}
        />
      )}
    </Shell>
  );
}
