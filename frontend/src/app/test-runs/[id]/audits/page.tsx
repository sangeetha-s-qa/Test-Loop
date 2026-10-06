"use client";

import { use, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Play } from "lucide-react";
import { Shell } from "@/components/shell";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/states";
import { Button, Card, SectionTitle } from "@/components/ui";
import {
  ApiError,
  analyzerLabels,
  api,
  formatSample,
  metricLabels,
  type AuditAnalyzer,
  type AuditDetail,
  type AuditFinding,
  type AuditRun,
  type PageAudit,
} from "@/lib/api";
import { useResource } from "@/lib/use-resource";

/**
 * Page audits: accessibility, performance and security over the run's discovered pages.
 *
 * Every row here is a measurement or a named rule, which is what separates this screen from the
 * AI stages. Nothing on it is generated, so nothing on it needs hedging.
 */

const impactOrder = ["CRITICAL", "SERIOUS", "MODERATE", "MINOR", "INFO"] as const;

const impactStyles: Record<AuditFinding["impact"], string> = {
  CRITICAL: "bg-rose-50 text-rose-700 ring-rose-200",
  SERIOUS: "bg-rose-50 text-rose-700 ring-rose-200",
  MODERATE: "bg-amber-50 text-amber-700 ring-amber-200",
  MINOR: "bg-slate-100 text-slate-600 ring-slate-200",
  INFO: "bg-sky-50 text-sky-700 ring-sky-200",
};

function Impact({ impact }: { impact: AuditFinding["impact"] }) {
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wide ring-1 ring-inset ${impactStyles[impact]}`}>{impact.toLowerCase()}</span>;
}

/** Groups findings by rule so one bad rule across twenty pages reads as one problem, not twenty. */
function groupFindings(audits: PageAudit[]) {
  const groups = new Map<string, { ruleId: string; impact: AuditFinding["impact"]; title: string; detail: string; helpUrl: string | null; pages: Set<string>; elements: string[] }>();
  for (const audit of audits) {
    for (const finding of audit.findings) {
      const existing = groups.get(finding.ruleId);
      if (existing) {
        existing.pages.add(audit.url);
        if (finding.selector && existing.elements.length < 5) existing.elements.push(finding.selector);
        // Keep the worst impact seen for a rule; a rule that is critical anywhere is critical.
        if (impactOrder.indexOf(finding.impact) < impactOrder.indexOf(existing.impact)) existing.impact = finding.impact;
        continue;
      }
      groups.set(finding.ruleId, {
        ruleId: finding.ruleId,
        impact: finding.impact,
        title: finding.title,
        detail: finding.detail,
        helpUrl: finding.helpUrl,
        pages: new Set([audit.url]),
        elements: finding.selector ? [finding.selector] : [],
      });
    }
  }
  return [...groups.values()].sort((left, right) => impactOrder.indexOf(left.impact) - impactOrder.indexOf(right.impact));
}

function FindingsTable({ audits }: { audits: PageAudit[] }) {
  const groups = groupFindings(audits);
  if (!groups.length) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-8 text-center">
        <p className="font-display font-bold text-emerald-900">Nothing to report</p>
        <p className="mt-1 text-sm text-emerald-800">Every rule this analyzer checks passed on all audited pages.</p>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-[10px] font-bold uppercase tracking-[.11em] text-slate-500">
            <th className="py-2 pr-4">Rule</th>
            <th className="py-2 pr-4">Impact</th>
            <th className="py-2 pr-4">What it means</th>
            <th className="py-2 pr-4 text-right">Pages</th>
          </tr>
        </thead>
        <tbody>
          {groups.map(group => (
            <tr key={group.ruleId} className="border-b border-slate-100 align-top">
              <td className="py-3 pr-4">
                <p className="font-mono text-xs font-semibold text-slate-900">{group.ruleId}</p>
                {group.elements.length > 0 && <p className="mt-1 break-all font-mono text-[11px] text-slate-500">{group.elements[0]}</p>}
              </td>
              <td className="py-3 pr-4"><Impact impact={group.impact} /></td>
              <td className="py-3 pr-4">
                <p className="font-medium text-slate-800">{group.title}</p>
                <p className="mt-0.5 text-xs text-slate-500">{group.detail}</p>
                {group.helpUrl && (
                  <a href={group.helpUrl} target="_blank" rel="noreferrer noopener" className="mt-1 inline-block text-xs font-semibold text-violet-700 underline">
                    How to fix this
                  </a>
                )}
              </td>
              <td className="py-3 pr-4 text-right font-mono text-xs tabular-nums text-slate-600">{group.pages.size}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * API results are per endpoint, not per page, so they get their own shape: the method and path are
 * the identity, and "not probed" is a first-class outcome rather than an absence.
 */
function EndpointTable({ audits }: { audits: PageAudit[] }) {
  if (!audits.length) return <EmptyState title="No endpoints were found" detail="An endpoint inventory is built from the XHR and fetch traffic the application makes while being crawled. A site that renders entirely on the server has none." />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-[10px] font-bold uppercase tracking-[.11em] text-slate-500">
            <th className="py-2 pr-4">Endpoint</th>
            <th className="py-2 pr-4">Result</th>
            <th className="py-2 pr-4 text-right">Response</th>
            <th className="py-2 text-right">Status</th>
          </tr>
        </thead>
        <tbody>
          {audits.map(audit => {
            const [method, ...rest] = audit.url.split(" ");
            const path = rest.join(" ");
            const notProbed = audit.findings.some(finding => finding.ruleId === "api.not_probed" || finding.ruleId === "api.blocked");
            const time = audit.samples.find(sample => sample.metric === "response_time_ms");
            const bytes = audit.samples.find(sample => sample.metric === "response_bytes");
            return (
              <tr key={audit.id} className="border-b border-slate-100 align-top">
                <td className="py-3 pr-4">
                  <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-bold text-slate-700">{method}</span>
                  <span className="break-all font-mono text-xs text-slate-700">{path.replace(/^https?:\/\/[^/]+/, "")}</span>
                </td>
                <td className="py-3 pr-4">
                  {audit.findings.length === 0 ? (
                    <span className="text-xs text-slate-500">Responded normally</span>
                  ) : (
                    <ul className="flex flex-col gap-1.5">
                      {audit.findings.map(finding => (
                        <li key={finding.id} className="flex items-start gap-2">
                          <Impact impact={finding.impact} />
                          <span className="text-xs text-slate-700">{finding.detail}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="py-3 pr-4 text-right font-mono text-xs tabular-nums text-slate-600">
                  {time ? formatSample(time) : <span className="text-slate-300">—</span>}
                  {bytes && <span className="block text-slate-400">{formatSample(bytes)}</span>}
                </td>
                <td className="py-3 text-right">{notProbed ? <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-slate-600 ring-1 ring-inset ring-slate-200">not called</span> : <StatusBadge status={audit.status} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PerformanceTable({ audits }: { audits: PageAudit[] }) {
  // Only metrics that were actually reported appear as columns. A metric the engine never produced
  // is absent rather than shown as zero, which would read as a perfect score for something nobody measured.
  const metrics = [...new Set(audits.flatMap(audit => audit.samples.map(sample => sample.metric)))].sort(
    (left, right) => Object.keys(metricLabels).indexOf(left) - Object.keys(metricLabels).indexOf(right),
  );
  if (!audits.length) return <EmptyState title="No performance data" detail="No page produced a measurement in this run." />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-[10px] font-bold uppercase tracking-[.11em] text-slate-500">
            <th className="py-2 pr-4">Page</th>
            {metrics.map(metric => <th key={metric} className="py-2 pr-4 text-right">{metricLabels[metric] ?? metric}</th>)}
            <th className="py-2 text-right">Verdict</th>
          </tr>
        </thead>
        <tbody>
          {audits.map(audit => {
            const byMetric = new Map(audit.samples.map(sample => [sample.metric, sample]));
            return (
              <tr key={audit.id} className="border-b border-slate-100">
                <td className="max-w-xs truncate py-3 pr-4 font-mono text-xs text-slate-700">{audit.url}</td>
                {metrics.map(metric => {
                  const sample = byMetric.get(metric);
                  return (
                    <td key={metric} className={`py-3 pr-4 text-right font-mono text-xs tabular-nums ${sample?.passed === false ? "font-bold text-rose-700" : "text-slate-700"}`}>
                      {sample ? formatSample(sample) : <span className="text-slate-300">—</span>}
                    </td>
                  );
                })}
                <td className="py-3 text-right"><StatusBadge status={audit.status} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-slate-500">
        Lab measurements from one cold load in a headless browser. They are comparable between runs, not to what a visitor on a real connection experiences.
      </p>
    </div>
  );
}

export default function AuditsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [tab, setTab] = useState<AuditAnalyzer>("ACCESSIBILITY");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const runs = useResource<AuditRun[]>(() => api.get(`/api/v1/test-runs/${id}/audits`), [id], {
    intervalMs: 4000,
    shouldPoll: data => data.some(run => run.status === "QUEUED" || run.status === "RUNNING"),
  });
  const latest = runs.data?.[0] ?? null;

  const detail = useResource<AuditDetail | null>(() => (latest ? api.get(`/api/v1/audits/${latest.id}`) : Promise.resolve(null)), [latest?.id, latest?.pagesCompleted], {});

  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      await api.post(`/api/v1/test-runs/${id}/audits`, { analyzers: ["ACCESSIBILITY", "PERFORMANCE", "SECURITY", "API"] });
      runs.reload();
    } catch (error) {
      setStartError(error instanceof ApiError ? error.message : "The audit could not be started.");
    } finally {
      setStarting(false);
    }
  };

  const audits = detail.data?.pageAudits.filter(audit => audit.analyzer === tab) ?? [];
  const running = latest?.status === "QUEUED" || latest?.status === "RUNNING";

  return (
    <Shell
      title="Page audits"
      subtitle="Accessibility, performance and security — measured, not generated"
      actions={
        <div className="flex items-center gap-2">
          <Link href={`/test-runs/${id}`} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            <ArrowLeft size={14} />
            Back to run
          </Link>
          <Button onClick={start} loading={starting} disabled={running} icon={<Play size={15} />}>
            {running ? "Audit running" : "Run audit"}
          </Button>
        </div>
      }
    >
      {startError && <div className="mb-6 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm font-medium text-rose-800" role="alert">{startError}</div>}

      {runs.loading ? (
        <LoadingState label="Loading audits" />
      ) : runs.error ? (
        <ErrorState error={runs.error} retry={runs.reload} />
      ) : !latest ? (
        <EmptyState
          title="No audit has run yet"
          detail="An audit sweeps the pages discovery already reached and checks each one against published accessibility rules, your performance budgets, and a set of security observations."
          action={<Button onClick={start} loading={starting} icon={<Play size={15} />}>Run audit</Button>}
        />
      ) : (
        <div className="flex flex-col gap-6">
          <Card className="p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <SectionTitle title="Latest audit" description={`${latest.browser} · ${latest.configuration.analyzers.map(analyzer => analyzerLabels[analyzer]).join(", ")}`} />
              </div>
              <StatusBadge status={latest.status} />
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-4">
              {[
                { label: "Pages audited", value: `${latest.pagesCompleted} / ${latest.pagesRequested}` },
                { label: "Findings", value: latest.findingCount.toLocaleString() },
                { label: "Page checks failed", value: latest.failedCount.toLocaleString() },
                { label: "Allowlisted origins", value: latest.configuration.allowedOrigins.length.toString() },
              ].map(tile => (
                <div key={tile.label} className="rounded-lg border border-slate-200 p-4">
                  <p className="text-xs font-medium text-slate-500">{tile.label}</p>
                  <p className="mt-1 font-display text-2xl font-bold tabular-nums text-slate-900">{tile.value}</p>
                </div>
              ))}
            </div>
            {latest.error && <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{latest.error}</p>}
            {latest.configuration.allowedOrigins.length > 0 && (
              <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                <strong className="font-display font-bold">{latest.configuration.allowedOrigins.length} origin(s) were reachable during this audit:</strong>{" "}
                {latest.configuration.allowedOrigins.join(", ")}. Performance measured with a site&rsquo;s CDN blocked would not reflect what a visitor loads. Every other host stayed blocked.
              </p>
            )}
          </Card>

          <Card className="p-6">
            <div className="mb-5 flex flex-wrap gap-2 border-b border-slate-200 pb-4">
              {(["ACCESSIBILITY", "PERFORMANCE", "SECURITY", "API"] as const).map(analyzer => {
                const count = detail.data?.pageAudits.filter(audit => audit.analyzer === analyzer).reduce((total, audit) => total + audit._count.findings, 0) ?? 0;
                const available = latest.configuration.analyzers.includes(analyzer);
                return (
                  <button
                    key={analyzer}
                    onClick={() => setTab(analyzer)}
                    disabled={!available}
                    className={`rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tab === analyzer ? "bg-[#111c38] text-white" : "text-slate-600 hover:bg-slate-100"}`}
                  >
                    {analyzerLabels[analyzer]}
                    {available && count > 0 && <span className="ml-2 font-mono text-xs opacity-70">{count}</span>}
                  </button>
                );
              })}
            </div>

            {detail.loading ? (
              <LoadingState label="Loading findings" />
            ) : detail.error ? (
              <ErrorState error={detail.error} retry={detail.reload} />
            ) : !latest.configuration.analyzers.includes(tab) ? (
              <EmptyState title={`${analyzerLabels[tab]} was not part of this audit`} detail="Start a new audit with this analyzer selected to see results here." />
            ) : audits.length === 0 && running ? (
              <LoadingState label={`Auditing pages for ${analyzerLabels[tab].toLowerCase()}`} />
            ) : tab === "PERFORMANCE" ? (
              <PerformanceTable audits={audits} />
            ) : tab === "API" ? (
              <EndpointTable audits={audits} />
            ) : (
              <FindingsTable audits={audits} />
            )}

            {tab === "API" && (
              <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                <strong className="font-display font-bold text-slate-800">Only GET, HEAD and OPTIONS are ever called.</strong> A POST, PUT, PATCH or DELETE
                seen during the crawl is listed as inventory and left alone — replaying one could create an order or delete a record. Probes are also
                anonymous, carrying no cookie or token, so what you see here is what an unauthenticated caller can reach.
              </p>
            )}
            {tab === "SECURITY" && audits.length > 0 && (
              <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                <strong className="font-display font-bold text-slate-800">Nothing here was exploited.</strong> These are observations of response headers, cookie
                attributes and what the page loaded. Testloop does not attempt injection, authentication bypass, or fuzzing — that belongs to a consented
                penetration test with a defined scope.
              </p>
            )}
          </Card>
        </div>
      )}
    </Shell>
  );
}
