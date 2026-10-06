import { source as axeSource } from "axe-core";
import type { BrowserContext, Page, Response } from "playwright";
import type { AuditImpact } from "@prisma/client";
import { config } from "../config";

/**
 * The deterministic page analyzers.
 *
 * Nothing here is generated. An axe rule id, a missing `Strict-Transport-Security` header, and a
 * measured largest-contentful-paint are facts the reader can check for themselves - which is the
 * whole reason these are not an AI feature. A model is allowed to *explain* a finding later; it is
 * never allowed to produce one.
 *
 * Every analyzer is read-only. Nothing submits a form, sends a payload, or attempts a bypass.
 */

export type Finding = {
  ruleId: string;
  impact: AuditImpact;
  title: string;
  detail: string;
  selector?: string | null;
  snippet?: string | null;
  helpUrl?: string | null;
};

export type Sample = { metric: string; value: number; unit: string; threshold?: number | null; passed?: boolean | null };

export type AnalyzerResult = { findings: Finding[]; samples: Sample[] };

/** Bounds on untrusted page content copied into a finding, so one page cannot bloat a report. */
const MAX_SNIPPET = 400;
const MAX_SELECTOR = 400;
const MAX_DETAIL = 600;

const trim = (value: unknown, max: number) => (typeof value === "string" && value.length ? value.slice(0, max) : null);

/* ------------------------------------------------------------------ accessibility */

const axeImpact: Record<string, AuditImpact> = { critical: "CRITICAL", serious: "SERIOUS", moderate: "MODERATE", minor: "MINOR" };

type AxeNode = { target?: unknown[]; html?: string; failureSummary?: string };
type AxeViolation = { id: string; impact?: string | null; help?: string; description?: string; helpUrl?: string; nodes?: AxeNode[] };

/**
 * Runs axe-core inside the page.
 *
 * The library is injected as a script rather than driven over CDP because the rules have to
 * evaluate against the live accessibility tree, computed styles included - contrast cannot be
 * judged from markup alone.
 */
export async function analyzeAccessibility(page: Page): Promise<AnalyzerResult> {
  await page.addScriptTag({ content: axeSource });
  const violations = (await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (context: Document, options: unknown) => Promise<{ violations: unknown[] }> } }).axe;
    const results = await axe.run(document, { resultTypes: ["violations"], reporter: "v2" });
    return results.violations;
  })) as AxeViolation[];

  const findings: Finding[] = [];
  for (const violation of violations) {
    // One finding per offending element, capped: a single bad rule on a long list page can match
    // hundreds of nodes, and a hundred identical rows is noise rather than evidence.
    const nodes = (violation.nodes ?? []).slice(0, 10);
    for (const node of nodes.length ? nodes : [{} as AxeNode]) {
      findings.push({
        ruleId: violation.id,
        impact: axeImpact[violation.impact ?? ""] ?? "MINOR",
        title: trim(violation.help, 200) ?? violation.id,
        detail: trim(node.failureSummary ?? violation.description, MAX_DETAIL) ?? "",
        selector: trim(Array.isArray(node.target) ? node.target.filter(part => typeof part === "string").join(" ") : null, MAX_SELECTOR),
        snippet: trim(node.html, MAX_SNIPPET),
        helpUrl: trim(violation.helpUrl, 300),
      });
    }
    if ((violation.nodes?.length ?? 0) > nodes.length) {
      findings.push({
        ruleId: violation.id,
        impact: "INFO",
        title: `${trim(violation.help, 160) ?? violation.id} — and ${violation.nodes!.length - nodes.length} more elements`,
        detail: `This rule failed on ${violation.nodes!.length} elements on this page. The first ${nodes.length} are listed individually.`,
        helpUrl: trim(violation.helpUrl, 300),
      });
    }
  }
  return { findings, samples: [] };
}

/* ------------------------------------------------------------------ performance */

type RawMetrics = { lcp: number | null; fcp: number | null; ttfb: number | null; tbt: number | null; domContentLoaded: number | null; load: number | null; requests: number; transferBytes: number };

/**
 * Installs the observers a navigation-timing read cannot replace.
 *
 * Largest-contentful-paint and long tasks are only reported to an observer that was already
 * listening, so this must be registered on the context *before* the page navigates. Reading
 * `performance.getEntries()` afterwards returns neither.
 */
export async function installPerformanceProbes(context: BrowserContext) {
  await context.addInitScript(() => {
    const metrics = { lcp: 0, longTaskBlocking: 0 };
    (window as unknown as { __qaMetrics: typeof metrics }).__qaMetrics = metrics;
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) metrics.lcp = Math.max(metrics.lcp, entry.startTime);
      }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch {
      // Not every engine implements this entry type. A missing metric is reported as missing.
    }
    try {
      new PerformanceObserver(list => {
        // Total blocking time counts only the part of a long task beyond 50ms, which is the
        // definition; summing whole task durations would overstate it on every page.
        for (const entry of list.getEntries()) metrics.longTaskBlocking += Math.max(0, entry.duration - 50);
      }).observe({ type: "longtask", buffered: true });
    } catch {
      // Chromium-only. Firefox and WebKit report no total-blocking-time rather than a wrong one.
    }
  });
}

export async function analyzePerformance(page: Page, thresholds: { lcp: number; fcp: number; ttfb: number; tbt: number }): Promise<AnalyzerResult> {
  const raw = (await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const paint = performance.getEntriesByName("first-contentful-paint")[0];
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const observed = (window as unknown as { __qaMetrics?: { lcp: number; longTaskBlocking: number } }).__qaMetrics;
    return {
      lcp: observed?.lcp ? observed.lcp : null,
      fcp: paint ? paint.startTime : null,
      ttfb: navigation ? navigation.responseStart - navigation.requestStart : null,
      tbt: observed ? observed.longTaskBlocking : null,
      domContentLoaded: navigation ? navigation.domContentLoadedEventEnd - navigation.startTime : null,
      load: navigation ? navigation.loadEventEnd - navigation.startTime : null,
      requests: resources.length + (navigation ? 1 : 0),
      transferBytes: resources.reduce((total, entry) => total + (entry.transferSize || 0), 0) + (navigation?.transferSize ?? 0),
    };
  })) as RawMetrics;

  const budgeted: { metric: string; value: number | null; threshold: number }[] = [
    { metric: "largest_contentful_paint", value: raw.lcp, threshold: thresholds.lcp },
    { metric: "first_contentful_paint", value: raw.fcp, threshold: thresholds.fcp },
    { metric: "time_to_first_byte", value: raw.ttfb, threshold: thresholds.ttfb },
    { metric: "total_blocking_time", value: raw.tbt, threshold: thresholds.tbt },
  ];

  const samples: Sample[] = [];
  const findings: Finding[] = [];

  for (const { metric, value, threshold } of budgeted) {
    // A metric the engine did not report is omitted, never recorded as zero. A zero here would
    // read as a perfect score for something that was simply not measured.
    if (value === null || Number.isNaN(value)) continue;
    const rounded = Math.round(value);
    const passed = rounded <= threshold;
    samples.push({ metric, value: rounded, unit: "ms", threshold, passed });
    if (!passed) {
      const ratio = rounded / threshold;
      findings.push({
        ruleId: `performance.${metric}`,
        // Severity is arithmetic, not a judgement call: twice the budget is SERIOUS, four times CRITICAL.
        impact: ratio >= 4 ? "CRITICAL" : ratio >= 2 ? "SERIOUS" : "MODERATE",
        title: `${metric.replace(/_/g, " ")} is ${rounded} ms against a ${threshold} ms budget`,
        detail: `Measured ${rounded} ms on a single cold load in a headless browser. This is a lab measurement, comparable between runs rather than to a real user's connection.`,
      });
    }
  }

  for (const { metric, value, unit } of [
    { metric: "dom_content_loaded", value: raw.domContentLoaded, unit: "ms" },
    { metric: "load_event", value: raw.load, unit: "ms" },
    { metric: "request_count", value: raw.requests, unit: "count" },
    { metric: "transfer_bytes", value: raw.transferBytes, unit: "bytes" },
  ]) {
    if (value === null || Number.isNaN(value)) continue;
    samples.push({ metric, value: Math.round(value), unit, threshold: null, passed: null });
  }

  return { findings, samples };
}

/* ------------------------------------------------------------------ security */

type HeaderRule = { header: string; ruleId: string; impact: AuditImpact; title: string; detail: string; httpsOnly?: boolean };

/**
 * Observation only. Every rule below reads something the server volunteered in its own response.
 *
 * Nothing here sends an injection payload, attempts an authentication bypass, or fuzzes an
 * endpoint. That work needs a consented engagement with a defined scope, not an automated scan a
 * user can point at any URL they can type.
 */
const headerRules: HeaderRule[] = [
  { header: "strict-transport-security", ruleId: "security.hsts_missing", impact: "SERIOUS", title: "Strict-Transport-Security is not set", detail: "Without HSTS a browser can be talked into a plaintext connection before the redirect to HTTPS happens.", httpsOnly: true },
  { header: "content-security-policy", ruleId: "security.csp_missing", impact: "SERIOUS", title: "Content-Security-Policy is not set", detail: "A CSP is the main defence that limits what a cross-site scripting bug can do once one exists." },
  { header: "x-content-type-options", ruleId: "security.nosniff_missing", impact: "MODERATE", title: "X-Content-Type-Options is not set", detail: "Without nosniff a browser may treat a response as a type the server did not intend." },
  { header: "referrer-policy", ruleId: "security.referrer_policy_missing", impact: "MINOR", title: "Referrer-Policy is not set", detail: "Full URLs, including any identifiers in a path, are sent to third-party sites by default." },
];

export async function analyzeSecurity(page: Page, context: BrowserContext, response: Response | null): Promise<AnalyzerResult> {
  const findings: Finding[] = [];
  const pageUrl = new URL(page.url());
  const isHttps = pageUrl.protocol === "https:";
  const headers = response ? await response.allHeaders().catch(() => ({} as Record<string, string>)) : ({} as Record<string, string>);

  for (const rule of headerRules) {
    if (rule.httpsOnly && !isHttps) continue;
    if (headers[rule.header]) continue;
    findings.push({ ruleId: rule.ruleId, impact: rule.impact, title: rule.title, detail: rule.detail, selector: null, snippet: null, helpUrl: null });
  }

  // Framing protection is satisfied by either header, so neither alone is a finding.
  const csp = headers["content-security-policy"] ?? "";
  if (!headers["x-frame-options"] && !/frame-ancestors/i.test(csp)) {
    findings.push({
      ruleId: "security.framing_unrestricted",
      impact: "MODERATE",
      title: "Nothing restricts who may frame this page",
      detail: "Neither X-Frame-Options nor a frame-ancestors directive is present, so another site can embed this page and overlay it.",
    });
  }

  if (!isHttps) {
    findings.push({ ruleId: "security.not_https", impact: "CRITICAL", title: "This page was served over plain HTTP", detail: "Everything on it, including anything typed into a form, travels unencrypted." });
  }

  for (const cookie of await context.cookies().catch(() => [])) {
    const problems: string[] = [];
    if (isHttps && !cookie.secure) problems.push("no Secure flag");
    if (!cookie.httpOnly) problems.push("no HttpOnly flag");
    if (!cookie.sameSite || cookie.sameSite === "None") problems.push(`SameSite is ${cookie.sameSite ?? "not set"}`);
    if (!problems.length) continue;
    findings.push({
      ruleId: "security.cookie_attributes",
      // A cookie readable by script is materially worse than one merely missing SameSite.
      impact: !cookie.httpOnly || (isHttps && !cookie.secure) ? "SERIOUS" : "MODERATE",
      title: `Cookie "${cookie.name}" is missing protection`,
      detail: `${problems.join(", ")}. A session cookie without HttpOnly can be read by any script that runs on the page.`,
      selector: trim(cookie.name, 200),
    });
  }

  return { findings, samples: [] };
}

/** Thresholds in force for a run, read once so a run's own record says what it compared against. */
export const defaultPerformanceThresholds = () => ({
  lcp: config.AUDIT_PERF_LCP_MS,
  fcp: config.AUDIT_PERF_FCP_MS,
  ttfb: config.AUDIT_PERF_TTFB_MS,
  tbt: config.AUDIT_PERF_TBT_MS,
});

/** Mixed content is only meaningful on an HTTPS page; collected from the network, not the markup. */
export function mixedContentFinding(pageUrl: string, insecureUrls: string[]): Finding | null {
  if (!insecureUrls.length || new URL(pageUrl).protocol !== "https:") return null;
  return {
    ruleId: "security.mixed_content",
    impact: "SERIOUS",
    title: `${insecureUrls.length} resource${insecureUrls.length === 1 ? "" : "s"} loaded over plain HTTP`,
    detail: `An HTTPS page is only as trustworthy as its least secure subresource. First: ${insecureUrls.slice(0, 3).join(", ")}`.slice(0, MAX_DETAIL),
  };
}
