import type { AuditAnalyzer, AuditImpact, AuditPageStatus, Prisma } from "@prisma/client";
import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from "playwright";
import { config } from "../config";
import { prisma } from "../db";
import { assertSafeUrl, parseAllowedOrigin } from "../discovery/scope";
import { analyzeAccessibility, analyzePerformance, analyzeSecurity, defaultPerformanceThresholds, installPerformanceProbes, mixedContentFinding, type Finding, type Sample } from "./analyzers";
import { probeEndpoints } from "./api";

const browserTypes: Record<string, BrowserType> = { chromium, firefox, webkit };

/** Impacts that make a page's audit FAILED rather than merely noted. */
const failingImpacts = new Set<AuditImpact>(["CRITICAL", "SERIOUS"]);

export type AuditConfiguration = {
  analyzers: AuditAnalyzer[];
  thresholds: { lcp: number; fcp: number; ttfb: number; tbt: number };
  allowedOrigins: string[];
};

function pageStatus(findings: Finding[]): AuditPageStatus {
  if (findings.some(finding => failingImpacts.has(finding.impact))) return "FAILED";
  return findings.length ? "PASSED_WITH_WARNINGS" : "PASSED";
}

/**
 * Runs the selected analyzers over a run's discovered pages.
 *
 * One browser, one fresh context per page. A context per page costs a little more than reusing one,
 * and buys the thing that makes the numbers mean anything: every page is measured on a cold cache
 * with no cookies carried over from the page before it.
 */
export async function runAudit(auditRunId: string, organizationId: string): Promise<{ pagesCompleted: number; findingCount: number; failedCount: number }> {
  const auditRun = await prisma.auditRun.findFirst({
    where: { id: auditRunId, project: { organizationId } },
    include: { testRun: { select: { applicationUrl: true, discovery: { select: { id: true } } } } },
  });
  if (!auditRun) throw new Error("AUDIT_RUN_NOT_AUTHORIZED");

  const configuration = auditRun.configuration as AuditConfiguration;
  const analyzers = configuration.analyzers ?? [];
  // API probing is not a page analyzer: it walks the endpoint inventory rather than the page list,
  // and needs no browser at all. It runs as its own pass after the page sweep.
  const pageAnalyzers = analyzers.filter(analyzer => analyzer !== "API");
  const thresholds = configuration.thresholds ?? defaultPerformanceThresholds();
  // Re-parsed here rather than trusted from the stored JSON: a stored entry could predate a policy
  // change, and anything unparseable must degrade to "not allowed" rather than to "allowed".
  const allowedOrigins = (configuration.allowedOrigins ?? []).map(parseAllowedOrigin).filter((value): value is string => value !== null);

  const baseUrl = auditRun.testRun.applicationUrl;
  const discoveryId = auditRun.testRun.discovery?.id;

  // Audits follow discovery: the crawl already decided which pages are in scope and proved they
  // were reachable. Auditing a URL the crawler never reached would be auditing a guess.
  const pages = pageAnalyzers.length === 0
    ? []
    : discoveryId
    ? await prisma.discoveredPage.findMany({
        where: { discoveryRunId: discoveryId },
        select: { id: true, normalizedUrl: true },
        orderBy: [{ depth: "asc" }, { createdAt: "asc" }],
        take: Math.min(config.AUDIT_MAX_PAGES, auditRun.pagesRequested || config.AUDIT_MAX_PAGES),
      })
    : [{ id: null, normalizedUrl: baseUrl }];

  await prisma.auditRun.update({ where: { id: auditRun.id }, data: { status: "RUNNING", startedAt: new Date(), pagesRequested: pages.length } });

  const browserType = browserTypes[auditRun.browser] ?? chromium;
  let browser: Browser | undefined;
  let pagesCompleted = 0;
  let findingCount = 0;
  let failedCount = 0;

  try {
    browser = await browserType.launch({ headless: true });

    for (const discovered of pages) {
      const cancelled = await prisma.auditRun.findUnique({ where: { id: auditRun.id }, select: { status: true } });
      if (cancelled?.status === "CANCELLED") break;

      let context: BrowserContext | undefined;
      const startedAt = Date.now();
      const insecureUrls: string[] = [];

      try {
        context = await browser.newContext({ viewport: auditRun.viewport as { width: number; height: number }, ignoreHTTPSErrors: false });
        if (analyzers.includes("PERFORMANCE")) await installPerformanceProbes(context);
        const page: Page = await context.newPage();
        page.setDefaultTimeout(config.AUDIT_PAGE_TIMEOUT_MS);

        // Same egress policy as execution, plus this project's allowlist. Blocking a site's CDN
        // would make a performance number describe a page no visitor ever loads.
        await page.route("**/*", async route => {
          const url = route.request().url();
          try {
            await assertSafeUrl(url, baseUrl, { allowLocalFixture: config.AUDIT_ALLOW_LOCAL_FIXTURE, allowedOrigins });
            if (url.startsWith("http://")) insecureUrls.push(url.slice(0, 200));
            await route.continue();
          } catch {
            await route.abort("blockedbyclient");
          }
        });

        const response = await page.goto(discovered.normalizedUrl, { waitUntil: "load", timeout: config.AUDIT_PAGE_TIMEOUT_MS });
        // Paint and long-task entries arrive after `load`. Without this settle the largest
        // contentful paint is routinely missed on a page whose hero image resolves late.
        await page.waitForTimeout(1200);

        for (const analyzer of pageAnalyzers) {
          const analyzerStartedAt = Date.now();
          let findings: Finding[] = [];
          let samples: Sample[] = [];
          let error: string | null = null;

          try {
            if (analyzer === "ACCESSIBILITY") ({ findings, samples } = await analyzeAccessibility(page));
            if (analyzer === "PERFORMANCE") ({ findings, samples } = await analyzePerformance(page, thresholds));
            if (analyzer === "SECURITY") {
              ({ findings, samples } = await analyzeSecurity(page, context, response));
              const mixed = mixedContentFinding(page.url(), insecureUrls);
              if (mixed) findings = [...findings, mixed];
            }
          } catch (cause) {
            // One analyzer failing must not lose the other two. ERRORED is recorded for this
            // analyzer on this page and the sweep carries on.
            error = cause instanceof Error ? cause.message.slice(0, 500) : String(cause).slice(0, 500);
          }

          const status: AuditPageStatus = error ? "ERRORED" : pageStatus(findings);
          if (status === "FAILED") failedCount += 1;
          findingCount += findings.length;

          await prisma.pageAudit.create({
            data: {
              auditRunId: auditRun.id,
              pageId: discovered.id,
              url: discovered.normalizedUrl.slice(0, 2000),
              analyzer,
              status,
              durationMs: Date.now() - analyzerStartedAt,
              error,
              findings: { create: findings.map(finding => ({ ...finding, selector: finding.selector ?? null, snippet: finding.snippet ?? null, helpUrl: finding.helpUrl ?? null })) },
              samples: { create: samples.map(sample => ({ ...sample, threshold: sample.threshold ?? null, passed: sample.passed ?? null })) },
            },
          });
        }
        pagesCompleted += 1;
      } catch (cause) {
        // The page itself could not be reached or rendered. Recorded against every requested
        // analyzer so the report shows a gap rather than silently listing fewer pages.
        const message = cause instanceof Error ? cause.message.slice(0, 500) : String(cause).slice(0, 500);
        for (const analyzer of pageAnalyzers) {
          await prisma.pageAudit
            .create({ data: { auditRunId: auditRun.id, pageId: discovered.id, url: discovered.normalizedUrl.slice(0, 2000), analyzer, status: "ERRORED", durationMs: Date.now() - startedAt, error: message } })
            .catch(() => undefined);
        }
      } finally {
        await context?.close().catch(() => undefined);
      }

      await prisma.auditRun.update({ where: { id: auditRun.id }, data: { pagesCompleted, findingCount, failedCount } });
    }
  } finally {
    await browser?.close().catch(() => undefined);
  }

  // --------------------------------------------------------------- API probe pass
  if (analyzers.includes("API") && discoveryId) {
    const endpoints = await prisma.discoveredEndpoint.findMany({
      where: { discoveryRunId: discoveryId },
      orderBy: [{ method: "asc" }, { normalizedUrl: "asc" }],
      take: config.AUDIT_MAX_ENDPOINTS,
      select: { id: true, method: true, url: true, normalizedUrl: true, observedStatus: true, contentType: true, observationCount: true },
    });

    const { probes } = await probeEndpoints(endpoints, baseUrl, allowedOrigins);
    for (const probe of probes) {
      const status = probe.findings.some(finding => finding.impact === "CRITICAL" || finding.impact === "SERIOUS")
        ? "FAILED"
        : probe.findings.length
          ? "PASSED_WITH_WARNINGS"
          : "PASSED";
      if (status === "FAILED") failedCount += 1;
      findingCount += probe.findings.length;
      await prisma.pageAudit
        .create({
          data: {
            auditRunId: auditRun.id,
            pageId: null,
            // Keyed by method and path so two endpoints differing only by query are one row, and
            // so a GET and a POST on the same path do not collide on the unique constraint.
            url: `${probe.endpoint.method} ${probe.endpoint.normalizedUrl}`.slice(0, 2000),
            analyzer: "API",
            status,
            durationMs: null,
            error: null,
            findings: { create: probe.findings.map(finding => ({ ...finding, selector: finding.selector ?? null, snippet: finding.snippet ?? null, helpUrl: finding.helpUrl ?? null })) },
            samples: { create: probe.samples.map(sample => ({ ...sample, threshold: sample.threshold ?? null, passed: sample.passed ?? null })) },
          },
        })
        .catch(() => undefined);
    }
    await prisma.auditRun.update({ where: { id: auditRun.id }, data: { findingCount, failedCount } });
  }

  await prisma.auditRun.updateMany({
    where: { id: auditRun.id, status: { notIn: ["CANCELLED"] } },
    data: { status: "COMPLETED", completedAt: new Date(), pagesCompleted, findingCount, failedCount },
  });

  return { pagesCompleted, findingCount, failedCount };
}

/** Shapes the stored configuration for a new audit run. */
export function buildAuditConfiguration(analyzers: AuditAnalyzer[], egressAllowlist: Prisma.JsonValue): AuditConfiguration {
  const allowedOrigins = Array.isArray(egressAllowlist) ? egressAllowlist.filter((entry): entry is string => typeof entry === "string") : [];
  return { analyzers, thresholds: defaultPerformanceThresholds(), allowedOrigins };
}
