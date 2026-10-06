import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeEndpoint, probeEndpoints, type EndpointInput } from "./api";

/**
 * The API prober against a real HTTP server.
 *
 * The assertions that matter most are the refusals: a non-idempotent endpoint must never be called,
 * and a secret found in a response must never be copied into the finding that reports it.
 */
describe("api probe", () => {
  /** Records every request the server actually receives, so "never called" can be asserted. */
  const received: { method: string; path: string }[] = [];
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      received.push({ method: request.method ?? "", path: request.url ?? "" });
      const path = (request.url ?? "").split("?")[0];
      if (path === "/api/ok") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ items: [1, 2, 3] }));
      } else if (path === "/api/broken-json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{ not json at all");
      } else if (path === "/api/no-type") {
        response.writeHead(200);
        response.end("plain");
      } else if (path === "/api/leaky") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ user: "ada", password: "hunter2-super-secret" }));
      } else if (path === "/api/boom") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "internal" }));
      } else if (path === "/api/private") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
      } else if (path === "/api/orders") {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ created: true }));
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>(resolve => server.listen(4325, "127.0.0.1", resolve));
    baseUrl = "http://127.0.0.1:4325/";
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const endpoint = (method: string, path: string, overrides: Partial<EndpointInput> = {}): EndpointInput => ({
    id: `id-${method}-${path}`,
    method,
    url: `http://127.0.0.1:4325${path}`,
    normalizedUrl: `http://127.0.0.1:4325${path.split("?")[0]}`,
    observedStatus: 200,
    contentType: "application/json",
    observationCount: 1,
    ...overrides,
  });

  it("never calls a non-idempotent endpoint, and says why", async () => {
    // The whole safety argument for this analyzer. Replaying a POST could create an order; the
    // crawler refuses to submit forms, and it would be incoherent for the prober to do the same
    // thing by another route.
    const before = received.length;
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const result = await probeEndpoint(endpoint(method, "/api/orders"), baseUrl, []);
      expect(result.probed).toBe(false);
      expect(result.findings[0].ruleId).toBe("api.not_probed");
      expect(result.findings[0].impact).toBe("INFO");
      expect(result.findings[0].detail).toContain("not idempotent");
    }
    expect(received.length).toBe(before);
    expect(received.some(entry => entry.path.startsWith("/api/orders"))).toBe(false);
  });

  it("probes a GET and records timing and size", async () => {
    const result = await probeEndpoint(endpoint("GET", "/api/ok"), baseUrl, []);
    expect(result.probed).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(result.samples.map(sample => sample.metric).sort()).toEqual(["response_bytes", "response_time_ms"]);
    expect(result.samples.find(sample => sample.metric === "response_bytes")!.value).toBeGreaterThan(0);
  });

  it("reports a server error as serious", async () => {
    const result = await probeEndpoint(endpoint("GET", "/api/boom"), baseUrl, []);
    expect(result.findings.find(finding => finding.ruleId === "api.server_error")?.impact).toBe("SERIOUS");
  });

  it("catches a response that declares JSON and is not JSON", async () => {
    const result = await probeEndpoint(endpoint("GET", "/api/broken-json"), baseUrl, []);
    expect(result.findings.find(finding => finding.ruleId === "api.malformed_json")?.impact).toBe("SERIOUS");
  });

  it("notes a missing Content-Type without inflating it", async () => {
    const result = await probeEndpoint(endpoint("GET", "/api/no-type"), baseUrl, []);
    expect(result.findings.find(finding => finding.ruleId === "api.missing_content_type")?.impact).toBe("MINOR");
  });

  it("reports a leaked credential without copying the credential into the report", async () => {
    const result = await probeEndpoint(endpoint("GET", "/api/leaky"), baseUrl, []);
    const finding = result.findings.find(entry => entry.ruleId === "api.secret_in_response");
    expect(finding?.impact).toBe("CRITICAL");
    // Recording the secret in order to report it would be the same disclosure, one layer down.
    expect(JSON.stringify(finding)).not.toContain("hunter2-super-secret");
    expect(finding?.snippet).toBeNull();
  });

  it("describes an endpoint that needs a session as an observation, not a defect", async () => {
    const result = await probeEndpoint(endpoint("GET", "/api/private"), baseUrl, []);
    const drift = result.findings.find(finding => finding.ruleId === "api.status_drift");
    expect(drift?.impact).toBe("MODERATE");
    expect(drift?.detail).toContain("requires authentication, which is expected");
  });

  it("refuses an endpoint that would leave the approved origin", async () => {
    const offsite = { ...endpoint("GET", "/api/ok"), url: "http://169.254.169.254/latest/meta-data", normalizedUrl: "http://169.254.169.254/latest/meta-data" };
    const result = await probeEndpoint(offsite, baseUrl, []);
    expect(result.probed).toBe(false);
    expect(result.findings[0].ruleId).toBe("api.blocked");
  });

  it("probes an inventory sequentially so a sweep cannot become a load test", async () => {
    const before = received.length;
    const { probes } = await probeEndpoints([endpoint("GET", "/api/ok"), endpoint("GET", "/api/boom"), endpoint("POST", "/api/orders")], baseUrl, []);
    expect(probes.filter(probe => probe.probed)).toHaveLength(2);
    // Two GETs called, the POST not called at all.
    expect(received.length - before).toBe(2);
  });
});
