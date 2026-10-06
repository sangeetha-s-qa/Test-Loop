import { config } from "../config";
import { assertSafeUrl } from "../discovery/scope";
import type { AnalyzerResult, Finding, Sample } from "./analyzers";

/**
 * Replays endpoints the application called itself during the crawl.
 *
 * Two rules define this analyzer, and both are refusals:
 *
 * 1. **Only idempotent methods are replayed.** A POST, PUT, PATCH or DELETE observed during a crawl
 *    is inventory and nothing more. Replaying one could create an order, overwrite a record, or
 *    delete a customer - the crawler deliberately never submits a form, and it would be incoherent
 *    for the prober to do by another route what the crawler refuses to do directly.
 *
 * 2. **Probes are anonymous.** No cookie, no token, no header copied from the observed call. What
 *    this analyzer reports is therefore what an unauthenticated caller can reach, which is a fact
 *    worth knowing and is not the same question as "does this endpoint work when signed in".
 */

export type EndpointInput = {
  id: string;
  method: string;
  url: string;
  normalizedUrl: string;
  observedStatus: number | null;
  contentType: string | null;
  observationCount: number;
};

/** Methods that are safe to repeat because, by definition, repeating them changes nothing. */
const idempotentMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/** Enough of a response to judge it. A probe is not a download. */
const MAX_BODY_BYTES = 256 * 1024;

/** Patterns that should never appear in a response body an anonymous caller can read. */
const secretPatterns: { pattern: RegExp; label: string }[] = [
  { pattern: /\b(sk|pk)-[A-Za-z0-9]{16,}\b/, label: "an API key" },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, label: "a JSON web token" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "a private key" },
  { pattern: /"(password|passwordHash|secret|clientSecret|privateKey)"\s*:\s*"[^"]{4,}"/i, label: "a credential field" },
];

export type EndpointProbe = { endpoint: EndpointInput; findings: Finding[]; samples: Sample[]; probed: boolean };

/**
 * Probes one endpoint. Never throws: a probe that cannot run is reported as a probe that could not
 * run, because an analyzer that dies on one bad endpoint loses the whole inventory.
 */
export async function probeEndpoint(endpoint: EndpointInput, baseUrl: string, allowedOrigins: string[]): Promise<EndpointProbe> {
  const findings: Finding[] = [];
  const samples: Sample[] = [];

  if (!idempotentMethods.has(endpoint.method.toUpperCase())) {
    findings.push({
      ruleId: "api.not_probed",
      impact: "INFO",
      title: `${endpoint.method} ${endpoint.normalizedUrl} was recorded but not called`,
      detail: `${endpoint.method} is not idempotent, so replaying it could change or destroy data. It is listed as inventory only. Test it through an approved test case, where the steps are reviewed before anything runs.`,
      selector: null,
      snippet: null,
      helpUrl: null,
    });
    return { endpoint, findings, samples, probed: false };
  }

  let safeUrl: string;
  try {
    // The same egress policy as everything else. An endpoint observed on the page cannot be used
    // to reach a host the run was never authorised for.
    safeUrl = await assertSafeUrl(endpoint.url, baseUrl, { allowLocalFixture: config.AUDIT_ALLOW_LOCAL_FIXTURE, allowedOrigins });
  } catch (error) {
    findings.push({
      ruleId: "api.blocked",
      impact: "INFO",
      title: `${endpoint.method} ${endpoint.normalizedUrl} was not reachable under this run's egress policy`,
      detail: error instanceof Error ? error.message : "Blocked",
      selector: null,
      snippet: null,
      helpUrl: null,
    });
    return { endpoint, findings, samples, probed: false };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.AUDIT_ENDPOINT_TIMEOUT_MS);

  try {
    const response = await fetch(safeUrl, {
      method: endpoint.method.toUpperCase(),
      // Manual redirect handling: following one could walk off the approved origin, and the
      // redirect itself is part of what is being observed.
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "*/*" },
    });

    const durationMs = Date.now() - startedAt;
    const contentType = response.headers.get("content-type");
    const buffer = await response.arrayBuffer().catch(() => new ArrayBuffer(0));
    const truncated = buffer.byteLength > MAX_BODY_BYTES;
    const body = new TextDecoder().decode(truncated ? buffer.slice(0, MAX_BODY_BYTES) : buffer);

    samples.push({ metric: "response_time_ms", value: durationMs, unit: "ms", threshold: null, passed: null });
    samples.push({ metric: "response_bytes", value: buffer.byteLength, unit: "bytes", threshold: null, passed: null });

    if (response.status >= 500) {
      findings.push({
        ruleId: "api.server_error",
        impact: "SERIOUS",
        title: `${endpoint.method} ${endpoint.normalizedUrl} returned HTTP ${response.status}`,
        detail: `The application called this endpoint successfully while being crawled (observed ${endpoint.observedStatus ?? "unknown"}), but replaying it returned a server error.`,
        selector: null,
        snippet: null,
        helpUrl: null,
      });
    } else if (endpoint.observedStatus !== null && endpoint.observedStatus < 400 && response.status >= 400) {
      // The interesting case: it worked for the page and does not work for an anonymous caller.
      // Stated as an observation, not diagnosed - it is usually correct behaviour (the endpoint
      // needs a session), and occasionally it is a real regression.
      findings.push({
        ruleId: "api.status_drift",
        impact: "MODERATE",
        title: `${endpoint.method} ${endpoint.normalizedUrl} returned ${response.status} when called without a session`,
        detail: `The page received ${endpoint.observedStatus} for this endpoint during the crawl. A ${response.status} here usually means the endpoint requires authentication, which is expected; it is worth a look only if this endpoint is meant to be public.`,
        selector: null,
        snippet: null,
        helpUrl: null,
      });
    }

    if (!contentType) {
      findings.push({ ruleId: "api.missing_content_type", impact: "MINOR", title: `${endpoint.normalizedUrl} responded without a Content-Type`, detail: "A client has to guess how to parse the response, and browsers may guess differently from one another.", selector: null, snippet: null, helpUrl: null });
    } else if (/application\/json/i.test(contentType) && body.trim().length > 0 && !truncated) {
      try {
        JSON.parse(body);
      } catch {
        findings.push({ ruleId: "api.malformed_json", impact: "SERIOUS", title: `${endpoint.normalizedUrl} declares JSON but did not return valid JSON`, detail: "The Content-Type says application/json and the body does not parse. Any client following the declared type will fail on this response.", selector: null, snippet: body.slice(0, 200), helpUrl: null });
      }
    }

    for (const { pattern, label } of secretPatterns) {
      if (!pattern.test(body)) continue;
      findings.push({
        ruleId: "api.secret_in_response",
        impact: "CRITICAL",
        title: `${endpoint.normalizedUrl} returned what looks like ${label} to an unauthenticated caller`,
        // The matched text is deliberately not copied into the finding: recording the secret in
        // order to report it would be the same disclosure, one layer down.
        detail: `A pattern matching ${label} appeared in the response body. The value itself is not stored here. Confirm by hand before acting, and treat it as exposed if confirmed.`,
        selector: null,
        snippet: null,
        helpUrl: null,
      });
      break;
    }

    return { endpoint, findings, samples, probed: true };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    findings.push({
      ruleId: aborted ? "api.timeout" : "api.unreachable",
      impact: "MODERATE",
      title: `${endpoint.method} ${endpoint.normalizedUrl} ${aborted ? `did not respond within ${config.AUDIT_ENDPOINT_TIMEOUT_MS} ms` : "could not be reached"}`,
      detail: aborted ? "The endpoint answered the page during the crawl but did not answer this probe in time." : error instanceof Error ? error.message.slice(0, 300) : "Unknown error",
      selector: null,
      snippet: null,
      helpUrl: null,
    });
    return { endpoint, findings, samples, probed: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Probes an inventory in order, sequentially - a probe sweep must not become a load test. */
export async function probeEndpoints(endpoints: EndpointInput[], baseUrl: string, allowedOrigins: string[]): Promise<AnalyzerResult & { probes: EndpointProbe[] }> {
  const probes: EndpointProbe[] = [];
  for (const endpoint of endpoints) {
    probes.push(await probeEndpoint(endpoint, baseUrl, allowedOrigins));
  }
  return { findings: probes.flatMap(probe => probe.findings), samples: [], probes };
}
