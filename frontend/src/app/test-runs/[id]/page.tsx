"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, ExternalLink, Grid3x3, Play, Radar, ShieldCheck, Sparkles, Square, TestTube2, Wand2 } from "lucide-react";
import { ManualActionBanner } from "@/components/manual-action";
import { Shell } from "@/components/shell";
import { BlockedNotice, ErrorState, LoadingState, StatusBadge } from "@/components/states";
import { Button, Card, SectionTitle } from "@/components/ui";
import { ApiError, api, formatDateTime, formatDuration, type AutomationScript, type Discovery, type DiscoveredElement, type DiscoveredForm, type DiscoveryMap, type ExecutionBatch, type TestCase, type TestRun } from "@/lib/api";
import { useResource } from "@/lib/use-resource";

type RunDetail = TestRun & { discovery?: Discovery | null };
type Generation = { id: string; status: string; scenarioCount: number; testCaseCount: number; error?: string | null } | null;
type AutomationStatus = { status: string; generatedCount: number; failedCount: number; requestedCount: number; error?: string | null } | null;

const discoveryActive = ["QUEUED", "DISCOVERING"];
const generationActive = ["QUEUED", "ANALYZING", "GENERATING"];
const automationActive = ["QUEUED", "GENERATING", "VALIDATING"];

/**
 * One row of the pipeline. `state` drives both the badge and whether the action is offered, so a
 * stage that cannot legally run does not present a button that the API would reject.
 */
function Stage({ index, icon, title, detail, status, href, action }: {
  index: number;
  icon: React.ReactNode;
  title: string;
  detail: string;
  status: string | null;
  href?: string;
  action?: React.ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-4 py-4">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <span className="font-mono text-xs text-slate-400">{index}</span>
          {title}
        </p>
        <p className="mt-0.5 text-sm text-slate-500">{detail}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {status ? <StatusBadge status={status} /> : <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Not started</span>}
        {action}
        {href && (
          <Link href={href} className="flex items-center gap-1 text-sm font-semibold text-violet-600 hover:underline">
            Open <ArrowRight size={14} />
          </Link>
        )}
      </div>
    </li>
  );
}

function ManualRedirect({ id }: { id: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(`/test-runs/${id}/manual`);
  }, [id, router]);
  return (
    <Shell title="Test run">
      <LoadingState label="Opening the manual testing workspace" />
      <p className="mt-3 text-center text-sm text-slate-500">
        <Link href={`/test-runs/${id}/manual`} className="font-semibold text-violet-700 underline">Open the manual workspace</Link> if nothing happens.
      </p>
    </Shell>
  );
}

export default function TestRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useResource(() => api.get<RunDetail>(`/api/v1/test-runs/${id}`), [id], {
    intervalMs: 3000,
    shouldPoll: value => discoveryActive.includes(value.discovery?.status ?? ""),
  });
  const generation = useResource(() => api.get<Generation>(`/api/v1/test-runs/${id}/ai-status`), [id], {
    intervalMs: 3000,
    shouldPoll: value => generationActive.includes(value?.status ?? ""),
  });
  const automation = useResource(() => api.get<AutomationStatus>(`/api/v1/test-runs/${id}/automation/status`), [id], {
    intervalMs: 3000,
    shouldPoll: value => automationActive.includes(value?.status ?? ""),
  });
  const testCases = useResource(() => api.get<TestCase[]>(`/api/v1/test-runs/${id}/test-cases`), [id]);
  const scripts = useResource(() => api.get<AutomationScript[]>(`/api/v1/test-runs/${id}/automation`), [id]);
  const batches = useResource(() => api.get<ExecutionBatch[]>(`/api/v1/test-runs/${id}/executions`), [id]);
  const map = useResource(() => api.get<DiscoveryMap>(`/api/v1/test-runs/${id}/discovery/map`).catch(() => null), [id]);
  const forms = useResource(() => api.get<DiscoveredForm[]>(`/api/v1/test-runs/${id}/discovery/forms`).catch(() => []), [id]);
  const elements = useResource(() => api.get<DiscoveredElement[]>(`/api/v1/test-runs/${id}/discovery/elements`).catch(() => []), [id]);

  /** Every action posts to the real endpoint and then refreshes the state it affects. */
  const act = async (key: string, path: string, body?: unknown) => {
    setBusy(key);
    setError(null);
    try {
      await api.post(path, body);
      run.reload();
      generation.reload();
      automation.reload();
      testCases.reload();
      scripts.reload();
      batches.reload();
      map.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : "The request could not be completed.");
    } finally {
      setBusy(null);
    }
  };

  if (run.loading) return <Shell title="Test run"><LoadingState label="Loading test run" /></Shell>;
  if (run.error || !run.data) return <Shell title="Test run"><ErrorState error={run.error ?? new Error("Test run not found")} retry={run.reload} /></Shell>;
  // A manual run has no automated pipeline to show; its home is the manual workspace.
  if (run.data.testingMethod === "MANUAL") return <ManualRedirect id={id} />;

  const data = run.data;
  const discovery = data.discovery ?? null;
  const discoveryDone = discovery?.status === "COMPLETED" && discovery.pagesDiscovered > 0;
  const cases = testCases.data ?? [];
  const approvedCases = cases.filter(item => item.status === "APPROVED");
  const approvedScripts = (scripts.data ?? []).filter(script => script.approvedVersionId);
  const generationDone = (generation.data?.testCaseCount ?? 0) > 0;
  const latestBatch = batches.data?.[0] ?? null;

  return (
    <Shell
      title={data.project?.name ?? "Test run"}
      subtitle={data.applicationUrl}
      actions={
        <a href={data.applicationUrl} target="_blank" rel="noreferrer" className="hidden items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 sm:flex">
          Open app <ExternalLink size={14} />
        </a>
      }
    >
      <Link href="/test-runs" className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-slate-900">
        <ArrowLeft size={16} />
        All test runs
      </Link>

      {error && <p role="alert" className="mb-5 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</p>}

      <Card className="mb-6 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-wide text-violet-600">Test run</p>
            <h2 className="mt-1 break-all font-display text-xl font-bold text-slate-900">{data.applicationUrl}</h2>
            <p className="mt-1 text-sm text-slate-500">Created {formatDateTime(data.createdAt)}</p>
          </div>
          <StatusBadge status={discovery?.status ?? data.status} />
        </div>
        {Array.isArray(data.testingTypes) && data.testingTypes.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {data.testingTypes.map(type => (
              <span key={type} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{type}</span>
            ))}
          </div>
        )}
        {data.requirements && <p className="mt-4 max-w-3xl border-l-2 border-slate-200 pl-4 text-sm text-slate-600">{data.requirements}</p>}
      </Card>

      {/* Mounted above the pipeline and unconditionally: a run blocked on a person is the most
          urgent thing on this page, and the banner renders nothing when nothing is pending. */}
      <div className="mb-6 empty:mb-0">
        <ManualActionBanner testRunId={data.id} />
      </div>

      <Card className="mb-6 p-6">
        <SectionTitle title="Pipeline" description="Each stage unlocks only when the one before it has genuinely completed" />
        <ul className="divide-y divide-slate-100">
          <Stage
            index={1}
            icon={<Radar size={18} />}
            title="Website discovery"
            detail={discovery ? `${discovery.pagesDiscovered} pages · ${discovery.formsDiscovered} forms · ${discovery.elementsDiscovered} elements` : "Crawl the application to build its map"}
            status={discovery?.status ?? null}
            action={
              discovery?.status === "QUEUED" ? (
                <Button size="sm" loading={busy === "discovery"} onClick={() => act("discovery", `/api/v1/test-runs/${id}/discovery/start`)} icon={<Play size={13} />}>
                  Start discovery
                </Button>
              ) : discoveryActive.includes(discovery?.status ?? "") ? (
                <Button size="sm" variant="secondary" loading={busy === "cancel-discovery"} onClick={() => act("cancel-discovery", `/api/v1/test-runs/${id}/discovery/cancel`)} icon={<Square size={12} />}>
                  Cancel
                </Button>
              ) : undefined
            }
          />
          <Stage
            index={2}
            icon={<Wand2 size={18} />}
            title="AI test-case generation"
            detail={generation.data ? `${generation.data.scenarioCount} scenarios · ${generation.data.testCaseCount} test cases` : "Turn the crawled pages into reviewable test cases"}
            status={generation.data?.status ?? null}
            href={`/test-runs/${id}/ai-analysis`}
            action={
              generationActive.includes(generation.data?.status ?? "") ? (
                <Button size="sm" variant="secondary" loading={busy === "cancel-ai"} onClick={() => act("cancel-ai", `/api/v1/test-runs/${id}/ai-generation/cancel`)} icon={<Square size={12} />}>
                  Cancel
                </Button>
              ) : discoveryDone ? (
                <Button size="sm" loading={busy === "ai"} onClick={() => act("ai", `/api/v1/test-runs/${id}/ai-analysis`)} icon={<Sparkles size={13} />}>
                  {generationDone ? "Generate again" : "Generate"}
                </Button>
              ) : undefined
            }
          />
          <Stage
            index={3}
            icon={<TestTube2 size={18} />}
            title="Review and approval"
            detail={cases.length ? `${approvedCases.length} of ${cases.length} approved` : "Generated cases stay in draft until a human approves them"}
            status={cases.length ? (approvedCases.length ? "APPROVED" : "DRAFT") : null}
            href={`/test-runs/${id}/test-cases`}
          />
          <Stage
            index={4}
            icon={<Wand2 size={18} />}
            title="Automation generation"
            detail={automation.data ? `${automation.data.generatedCount} generated · ${automation.data.failedCount} failed` : "Convert approved cases into executable programs"}
            status={automation.data?.status ?? null}
            href={`/test-runs/${id}/automation`}
            action={
              automationActive.includes(automation.data?.status ?? "") ? (
                <Button size="sm" variant="secondary" loading={busy === "cancel-auto"} onClick={() => act("cancel-auto", `/api/v1/test-runs/${id}/automation/cancel`)} icon={<Square size={12} />}>
                  Cancel
                </Button>
              ) : approvedCases.length > 0 ? (
                <Button size="sm" loading={busy === "auto"} onClick={() => act("auto", `/api/v1/test-runs/${id}/automation/generate`, { testCaseIds: approvedCases.map(item => item.id) })} icon={<Wand2 size={13} />}>
                  Generate automation
                </Button>
              ) : undefined
            }
          />
          <Stage
            index={5}
            icon={<Play size={18} />}
            title="Execution"
            detail={latestBatch ? `${latestBatch.passedCount} passed · ${latestBatch.failedCount} failed · ${latestBatch.browser}` : "Run approved automation in a real browser"}
            status={latestBatch?.status ?? null}
            href={`/test-runs/${id}/executions`}
            action={
              approvedScripts.length > 0 ? (
                <Button size="sm" loading={busy === "exec"} onClick={() => act("exec", `/api/v1/test-runs/${id}/executions`, { browser: "chromium" })} icon={<Play size={13} />}>
                  Execute
                </Button>
              ) : undefined
            }
          />
          {/* Audits run off discovery, not off execution: they check the pages the crawl reached
              rather than the journeys the tests walk, so they are available as soon as discovery has. */}
          {/* Matrix replay follows execution, not discovery: it replays the approved programs, so it
              is only meaningful once there is approved automation to replay. */}
          <Stage
            index={6}
            icon={<Grid3x3 size={18} />}
            title="Matrix replay"
            detail="Replay the approved tests across browsers and viewports, and compare the results"
            status={null}
            href={approvedScripts.length > 0 ? `/test-runs/${id}/matrix` : undefined}
            action={
              approvedScripts.length > 0 ? (
                <Link href={`/test-runs/${id}/matrix`} className="inline-flex items-center gap-1.5 rounded-lg bg-[#111c38] px-3 py-2 text-xs font-semibold text-white hover:bg-[#1b2a52]">
                  <Grid3x3 size={13} />
                  Open matrix
                </Link>
              ) : undefined
            }
          />
          <Stage
            index={7}
            icon={<ShieldCheck size={18} />}
            title="Page audits"
            detail="Accessibility, performance and security across the discovered pages — measured, not generated"
            status={null}
            href={discoveryDone ? `/test-runs/${id}/audits` : undefined}
            action={
              discoveryDone ? (
                <Link href={`/test-runs/${id}/audits`} className="inline-flex items-center gap-1.5 rounded-lg bg-[#111c38] px-3 py-2 text-xs font-semibold text-white hover:bg-[#1b2a52]">
                  <ShieldCheck size={13} />
                  Open audits
                </Link>
              ) : undefined
            }
          />
        </ul>

        {!discoveryDone && discovery?.status !== "QUEUED" && !discoveryActive.includes(discovery?.status ?? "") && (
          <div className="mt-4">
            <BlockedNotice title="Discovery has not produced any pages" detail="The later stages need the crawled pages, forms, and elements as evidence. Re-run discovery before generating test cases." />
          </div>
        )}
        {discovery?.failureMessage && (
          <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            <span className="font-bold">{discovery.failureCode ?? "Discovery failed"}:</span> {discovery.failureMessage}
          </p>
        )}
      </Card>

      {discovery && (
        <Card className="p-6">
          <SectionTitle
            title="Application map"
            description={discovery.completedAt ? `Crawled in ${formatDuration(new Date(discovery.completedAt).getTime() - new Date(discovery.startedAt ?? discovery.completedAt).getTime())}` : "Discovered structure of the application"}
          />

          <dl className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              ["Pages", discovery.pagesDiscovered],
              ["Links", discovery.linksDiscovered],
              ["Forms", discovery.formsDiscovered],
              ["Elements", discovery.elementsDiscovered],
            ].map(([label, value]) => (
              <div key={label as string} className="rounded-lg border border-slate-200 p-4">
                <dt className="text-xs uppercase tracking-wide text-slate-400">{label}</dt>
                <dd className="mt-1 font-display text-2xl font-bold tabular-nums">{value as number}</dd>
              </div>
            ))}
          </dl>

          {map.loading ? (
            <LoadingState label="Loading application map" />
          ) : !map.data?.pages?.length ? (
            <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
              No pages have been crawled for this run yet.
            </p>
          ) : (
            <div className="grid gap-6 lg:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-bold text-slate-800">Pages by depth</h3>
                <ul className="max-h-80 overflow-y-auto rounded-lg border border-slate-200">
                  {[...map.data.pages].sort((left, right) => left.depth - right.depth).map(page => (
                    <li key={page.id} className="flex items-start gap-2 border-b border-slate-50 px-3 py-2.5 last:border-0">
                      <span className="mt-0.5 shrink-0 font-mono text-[10px] text-slate-400" style={{ paddingLeft: `${page.depth * 10}px` }}>d{page.depth}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-slate-800">{page.title || "(untitled)"}</span>
                        <span className="block truncate font-mono text-xs text-slate-500">{page.normalizedUrl}</span>
                      </span>
                      <span className="ml-auto shrink-0 text-xs text-slate-400">{page.outgoingLinks.length} links</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex flex-col gap-6">
                <div>
                  <h3 className="mb-2 text-sm font-bold text-slate-800">Forms</h3>
                  {(forms.data ?? []).length === 0 ? (
                    <p className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500">No forms discovered.</p>
                  ) : (
                    <ul className="max-h-36 space-y-2 overflow-y-auto">
                      {forms.data?.map(form => (
                        <li key={form.id} className="rounded-lg border border-slate-200 p-3">
                          <p className="font-mono text-xs font-semibold text-slate-700">{form.identifier || form.action || "form"}</p>
                          <p className="mt-1 text-xs text-slate-500">
                            {form.method?.toUpperCase()} · {form.fields.length} field{form.fields.length === 1 ? "" : "s"}
                            {form.fields.some(field => field.required) && " · has required fields"}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div>
                  <h3 className="mb-2 text-sm font-bold text-slate-800">Interactive elements</h3>
                  {(elements.data ?? []).length === 0 ? (
                    <p className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500">No elements discovered.</p>
                  ) : (
                    <ul className="max-h-36 space-y-1.5 overflow-y-auto">
                      {elements.data?.slice(0, 40).map(element => (
                        <li key={element.id} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs">
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono font-semibold text-slate-600">{element.tagName}</span>
                          {element.role && <span className="text-slate-500">{element.role}</span>}
                          <span className="truncate text-slate-700">{element.accessibleName || "(no accessible name)"}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}
        </Card>
      )}
    </Shell>
  );
}
