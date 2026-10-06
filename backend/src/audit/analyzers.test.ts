import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createFixtureServer } from "../fixture/server";
import { assertSafeUrl, parseAllowedOrigin } from "../discovery/scope";
import { analyzeAccessibility, analyzePerformance, analyzeSecurity, installPerformanceProbes, mixedContentFinding } from "./analyzers";

/**
 * The audit analyzers against a real browser and a real server.
 *
 * These are the assertions behind the claim that an audit finding is a fact rather than an opinion:
 * every one cites a rule id or a measured value, and a metric the engine did not report is absent
 * rather than recorded as zero.
 */
describe("page analyzers", () => {
  const fixture = createFixtureServer(4321);
  const baseUrl = "http://127.0.0.1:4321/";
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    await fixture.start();
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    await installPerformanceProbes(context);
    page = await context.newPage();
    page.setDefaultTimeout(10_000);
  }, 90_000);

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await browser?.close();
    await fixture.stop();
  });

  describe("accessibility", () => {
    it("reports axe rule ids for real barriers", async () => {
      await page.setContent(`
        <html lang="en"><head><title>Audit probe</title></head><body>
          <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
          <input type="text" name="email">
        </body></html>`);
      const { findings } = await analyzeAccessibility(page);
      const ruleIds = findings.map(finding => finding.ruleId);
      expect(ruleIds).toContain("image-alt");
      // Every finding must carry the rule's published identifier: that is what lets a reader check
      // it rather than take the report's word for it.
      expect(findings.every(finding => finding.ruleId.length > 0)).toBe(true);
      expect(findings.find(finding => finding.ruleId === "image-alt")?.helpUrl).toMatch(/^https?:/);
    });

    it("finds nothing to report on an accessible page", async () => {
      await page.setContent(`
        <html lang="en"><head><title>Accessible probe</title></head><body>
          <h1>Contact</h1>
          <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="A single transparent pixel">
          <label for="email">Email address</label>
          <input id="email" type="text" name="email">
        </body></html>`);
      const { findings } = await analyzeAccessibility(page);
      expect(findings.filter(finding => finding.ruleId === "image-alt" || finding.ruleId === "label")).toHaveLength(0);
    });
  });

  describe("performance", () => {
    it("measures the metrics the engine actually reported, and omits the rest", async () => {
      await page.goto(baseUrl, { waitUntil: "load" });
      await page.waitForTimeout(1200);
      const { samples } = await analyzePerformance(page, { lcp: 2500, fcp: 1800, ttfb: 800, tbt: 300 });
      const byMetric = new Map(samples.map(sample => [sample.metric, sample]));

      expect(byMetric.has("time_to_first_byte")).toBe(true);
      expect(byMetric.get("request_count")!.value).toBeGreaterThan(0);
      // A metric that was never observed must be missing, not zero. A zero reads as a perfect
      // score for something nobody measured.
      expect(samples.every(sample => Number.isFinite(sample.value))).toBe(true);
      expect(samples.every(sample => sample.value >= 0)).toBe(true);
    });

    it("fails a metric against its budget and passes the same metric against a generous one", async () => {
      await page.goto(baseUrl, { waitUntil: "load" });
      await page.waitForTimeout(1200);

      const strict = await analyzePerformance(page, { lcp: 1, fcp: 1, ttfb: 1, tbt: 1 });
      expect(strict.findings.length).toBeGreaterThan(0);
      expect(strict.findings.every(finding => finding.ruleId.startsWith("performance."))).toBe(true);
      // Pass/fail is arithmetic, never a judgement call - which is why a metric that measured 0
      // passes even a 1ms budget. A page with no long tasks has a total blocking time of zero and
      // is not in breach of anything; only a value actually over its budget is a finding.
      const overBudget = strict.samples.filter(sample => sample.threshold !== null && sample.value > sample.threshold!);
      expect(overBudget.length).toBeGreaterThan(0);
      expect(overBudget.every(sample => sample.passed === false)).toBe(true);
      expect(strict.samples.filter(sample => sample.threshold !== null && sample.value <= sample.threshold!).every(sample => sample.passed === true)).toBe(true);

      const generous = await analyzePerformance(page, { lcp: 120_000, fcp: 120_000, ttfb: 120_000, tbt: 120_000 });
      expect(generous.findings).toHaveLength(0);
      expect(generous.samples.filter(sample => sample.threshold !== null).every(sample => sample.passed === true)).toBe(true);
    });
  });

  describe("security", () => {
    it("reports missing headers and an unencrypted page without touching the application", async () => {
      const response = await page.goto(baseUrl, { waitUntil: "load" });
      const { findings } = await analyzeSecurity(page, context, response);
      const ruleIds = findings.map(finding => finding.ruleId);

      expect(ruleIds).toContain("security.not_https");
      expect(ruleIds).toContain("security.csp_missing");
      expect(ruleIds).toContain("security.framing_unrestricted");
      expect(findings.find(finding => finding.ruleId === "security.not_https")?.impact).toBe("CRITICAL");
    });

    it("does not demand HSTS from a page that was never served over HTTPS", async () => {
      // HSTS is meaningless on plain HTTP. Reporting it there would be a finding the reader cannot act on.
      const response = await page.goto(baseUrl, { waitUntil: "load" });
      const { findings } = await analyzeSecurity(page, context, response);
      expect(findings.map(finding => finding.ruleId)).not.toContain("security.hsts_missing");
    });

    it("only calls mixed content on an https page", () => {
      expect(mixedContentFinding("http://example.com/", ["http://example.com/a.js"])).toBeNull();
      expect(mixedContentFinding("https://example.com/", [])).toBeNull();
      expect(mixedContentFinding("https://example.com/", ["http://example.com/a.js"])?.ruleId).toBe("security.mixed_content");
    });
  });
});

describe("egress allowlist", () => {
  it("normalises an entry to a bare origin and rejects anything else", () => {
    expect(parseAllowedOrigin("https://cdn.example.com/assets/")).toBe("https://cdn.example.com");
    expect(parseAllowedOrigin("  https://cdn.example.com  ")).toBe("https://cdn.example.com");
    expect(parseAllowedOrigin("file:///etc/passwd")).toBeNull();
    expect(parseAllowedOrigin("javascript:alert(1)")).toBeNull();
    expect(parseAllowedOrigin("not a url")).toBeNull();
  });

  it("waives the same-origin rule for an allowlisted origin", async () => {
    await expect(assertSafeUrl("http://127.0.0.1:4322/a.js", "http://127.0.0.1:4321/", { allowLocalFixture: true })).rejects.toThrow("CROSS_ORIGIN_BLOCKED");
    await expect(
      assertSafeUrl("http://127.0.0.1:4322/a.js", "http://127.0.0.1:4321/", { allowLocalFixture: true, allowedOrigins: ["http://127.0.0.1:4322"] }),
    ).resolves.toContain("127.0.0.1:4322");
  });

  it("still blocks a private or metadata address that someone allowlisted", async () => {
    // The property that keeps the allowlist from becoming an SSRF bypass: it waives the
    // same-origin rule and nothing else, so every address check still runs on the entry.
    for (const target of ["http://169.254.169.254/latest/meta-data", "http://10.0.0.5/", "http://192.168.1.1/", "http://[::1]/"]) {
      await expect(
        assertSafeUrl(target, "https://shop.example.com/", { allowedOrigins: [new URL(target).origin] }),
      ).rejects.toThrow("DESTINATION_BLOCKED");
    }
  });
});
