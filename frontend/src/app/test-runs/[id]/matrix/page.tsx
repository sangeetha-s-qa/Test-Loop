"use client";

import { use, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Grid3x3, Square } from "lucide-react";
import { Shell } from "@/components/shell";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/states";
import { Button, Card, SectionTitle } from "@/components/ui";
import { ApiError, api, divergenceLabels, type DivergenceKind, type MatrixDetail, type MatrixRun } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

/**
 * Matrix replay: the same approved automation across browsers and viewports.
 *
 * The grid is the summary; the divergence list is the point. Running a suite nine times only helps
 * if something reads the nine results together and says which axis the difference follows.
 */

const browserOptions = ["chromium", "firefox", "webkit"] as const;
const viewportOptions = ["desktop", "tablet", "mobile"] as const;

const kindStyles: Record<DivergenceKind, string> = {
  BROWSER: "bg-violet-50 text-violet-700 ring-violet-200",
  VIEWPORT: "bg-sky-50 text-sky-700 ring-sky-200",
  MIXED: "bg-amber-50 text-amber-700 ring-amber-200",
  INCONCLUSIVE: "bg-slate-100 text-slate-600 ring-slate-200",
};

/** Per-cell outcome mark. Colour carries the verdict; the label carries the coordinate. */
function CellMark({ status }: { status: string }) {
  const tone =
    status === "PASSED"
      ? "bg-emerald-500"
      : status === "FAILED" || status === "TIMED_OUT"
        ? "bg-rose-500"
        : status === "ERRORED"
          ? "bg-orange-400"
          : "bg-slate-300";
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${tone}`} aria-hidden="true" />;
}

export default function MatrixPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [browsers, setBrowsers] = useState<string[]>(["chromium", "webkit"]);
  const [viewports, setViewports] = useState<string[]>(["desktop", "mobile"]);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const runs = useResource<MatrixRun[]>(() => api.get(`/api/v1/test-runs/${id}/matrix`), [id], {
    intervalMs: 4000,
    shouldPoll: data => data.some(run => run.status === "QUEUED" || run.status === "RUNNING"),
  });
  const latest = runs.data?.[0] ?? null;
  const detail = useResource<MatrixDetail | null>(() => (latest ? api.get(`/api/v1/matrix/${latest.id}`) : Promise.resolve(null)), [latest?.id, latest?.cellsCompleted], {});

  const running = latest?.status === "QUEUED" || latest?.status === "RUNNING";
  const cellCount = browsers.length * viewports.length;

  const toggle = (list: string[], setList: (value: string[]) => void, value: string) =>
    setList(list.includes(value) ? list.filter(entry => entry !== value) : [...list, value]);

  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      await api.post(`/api/v1/test-runs/${id}/matrix`, { browsers, viewports });
      runs.reload();
    } catch (error) {
      setStartError(error instanceof ApiError ? error.message : "The matrix replay could not be started.");
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!latest) return;
    try {
      await api.post(`/api/v1/matrix/${latest.id}/cancel`);
      runs.reload();
    } catch (error) {
      setStartError(error instanceof ApiError ? error.message : "The matrix replay could not be cancelled.");
    }
  };

  const cells = detail.data?.cells ?? [];
  const cellBrowsers = [...new Set(cells.map(cell => cell.browser))];
  const cellViewports = [...new Set(cells.map(cell => cell.viewportName))];

  return (
    <Shell
      title="Matrix replay"
      subtitle="The same approved tests, across browsers and viewports"
      actions={
        <Link href={`/test-runs/${id}`} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
          <ArrowLeft size={14} />
          Back to run
        </Link>
      }
    >
      <div className="flex flex-col gap-6">
        <Card className="p-6">
          <SectionTitle title="Build a grid" description="Nothing new is authored. Every cell runs the automation a person already approved, unchanged — which is what makes a difference between two cells evidence about the application." />
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Browsers</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {browserOptions.map(browser => (
                  <button
                    key={browser}
                    onClick={() => toggle(browsers, setBrowsers, browser)}
                    aria-pressed={browsers.includes(browser)}
                    className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${browsers.includes(browser) ? "border-violet-500 bg-violet-50 font-semibold text-violet-700" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}
                  >
                    {browser}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Viewports</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {viewportOptions.map(viewport => (
                  <button
                    key={viewport}
                    onClick={() => toggle(viewports, setViewports, viewport)}
                    aria-pressed={viewports.includes(viewport)}
                    className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${viewports.includes(viewport) ? "border-violet-500 bg-violet-50 font-semibold text-violet-700" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}
                  >
                    {viewport}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-slate-200 pt-5">
            <Button onClick={start} loading={starting} disabled={running || cellCount === 0} icon={<Grid3x3 size={15} />}>
              {running ? "Replay running" : `Run ${cellCount} cell${cellCount === 1 ? "" : "s"}`}
            </Button>
            {running && (
              <Button variant="secondary" onClick={cancel} icon={<Square size={13} />}>
                Cancel
              </Button>
            )}
            <p className="text-sm text-slate-500">
              {cellCount === 0
                ? "Pick at least one browser and one viewport."
                : `${cellCount} full runs of the approved suite. ${browsers[0] ?? "—"} at ${viewports[0] ?? "—"} is the baseline everything else is compared against.`}
            </p>
          </div>
          {startError && <p role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-800">{startError}</p>}
        </Card>

        {runs.loading ? (
          <LoadingState label="Loading matrix replays" />
        ) : runs.error ? (
          <ErrorState error={runs.error} retry={runs.reload} />
        ) : !latest ? (
          <EmptyState title="No matrix replay yet" detail="Approve some automation, then replay it across browsers and viewports to find differences a single-browser run cannot see." />
        ) : (
          <>
            <Card className="p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <SectionTitle title="The grid" description={`Baseline: ${latest.baselineKey} · ${latest.testCaseCount} approved test cases per cell`} />
                <StatusBadge status={latest.status} />
              </div>

              {detail.loading ? (
                <div className="mt-5"><LoadingState label="Loading cells" /></div>
              ) : (
                <div className="mt-5 overflow-x-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="text-left text-[10px] font-bold uppercase tracking-[.11em] text-slate-500">
                        <th className="border-b border-slate-200 py-2 pr-4">Viewport</th>
                        {cellBrowsers.map(browser => <th key={browser} className="border-b border-slate-200 py-2 pr-4">{browser}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {cellViewports.map(viewport => (
                        <tr key={viewport}>
                          <td className="border-b border-slate-100 py-3 pr-4 font-medium text-slate-700">{viewport}</td>
                          {cellBrowsers.map(browser => {
                            const cell = cells.find(entry => entry.browser === browser && entry.viewportName === viewport);
                            if (!cell) return <td key={browser} className="border-b border-slate-100 py-3 pr-4 text-slate-300">—</td>;
                            const isBaseline = `${browser}:${viewport}` === latest.baselineKey;
                            return (
                              <td key={browser} className="border-b border-slate-100 py-3 pr-4">
                                <Link href={`/execution-batches/${cell.batchId}`} className="block rounded-lg border border-slate-200 p-3 hover:border-slate-300 hover:bg-slate-50">
                                  <div className="flex items-center gap-2">
                                    <StatusBadge status={cell.batch.status} />
                                    {isBaseline && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600">baseline</span>}
                                  </div>
                                  <p className="mt-2 font-mono text-xs tabular-nums text-slate-600">
                                    <span className="font-bold text-emerald-700">{cell.batch.passedCount}</span> passed ·{" "}
                                    <span className="font-bold text-rose-700">{cell.batch.failedCount}</span> failed
                                    {cell.batch.erroredCount > 0 && <> · <span className="font-bold text-orange-700">{cell.batch.erroredCount}</span> errored</>}
                                  </p>
                                </Link>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card className="p-6">
              <SectionTitle
                title={`Differences — ${detail.data?.divergences.length ?? 0} of ${detail.data?.testCasesCompared ?? 0} test cases`}
                description="Only cases whose result is not the same everywhere. A case that fails in every cell is an ordinary failure the run already reports, not a difference."
              />

              {detail.loading ? (
                <div className="mt-5"><LoadingState label="Comparing cells" /></div>
              ) : !detail.data?.divergences.length ? (
                <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-8 text-center">
                  <p className="font-display font-bold text-emerald-900">Every test behaved the same everywhere</p>
                  <p className="mt-1 text-sm text-emerald-800">
                    {detail.data?.consistentCount ?? 0} test cases produced an identical result in all {cells.length} cells.
                  </p>
                </div>
              ) : (
                <ul className="mt-5 flex flex-col gap-3">
                  {detail.data.divergences.map(divergence => (
                    <li key={divergence.testCaseId} className="rounded-xl border border-slate-200 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-mono text-xs text-slate-500">{divergence.reference}</p>
                          <p className="mt-0.5 font-display font-bold text-slate-900">{divergence.title}</p>
                        </div>
                        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wide ring-1 ring-inset ${kindStyles[divergence.kind]}`}>
                          {divergenceLabels[divergence.kind]}
                        </span>
                      </div>
                      <p className="mt-2 text-sm text-slate-600">{divergence.summary}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {divergence.outcomes.map(outcome => (
                          <span
                            key={`${outcome.browser}:${outcome.viewportName}`}
                            title={outcome.failureMessage ?? outcome.status}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 font-mono text-[11px] text-slate-700"
                          >
                            <CellMark status={outcome.status} />
                            {outcome.browser}:{outcome.viewportName}
                          </span>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <p className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                <strong className="font-display font-bold text-slate-800">One matrix cannot tell a flake from a real difference.</strong> A cell that
                errored or timed out is reported as not conclusive rather than as a browser bug, but a genuine-looking single-cell failure can still be
                intermittent. Re-run the grid to confirm anything you intend to raise as a defect.
              </p>
            </Card>
          </>
        )}
      </div>
    </Shell>
  );
}
