import { describe, expect, it } from "vitest";
import { computeDivergences, type CellOutcome, type TestCaseOutcomes } from "./divergence";

/**
 * The classification rules are the part of matrix replay most likely to be wrong and the part a
 * reviewer will trust the most, so they are pinned here against a real 3x3 grid.
 */

const browsers = ["chromium", "firefox", "webkit"];
const viewports = ["desktop", "tablet", "mobile"];

/** Builds a full grid, then applies overrides keyed by "browser:viewport". */
function grid(defaultStatus: string, overrides: Record<string, Partial<CellOutcome>> = {}): CellOutcome[] {
  return browsers.flatMap(browser =>
    viewports.map(viewportName => ({
      browser,
      viewportName,
      status: defaultStatus,
      failureCategory: null,
      failureMessage: null,
      ...(overrides[`${browser}:${viewportName}`] ?? {}),
    })),
  );
}

const testCase = (outcomes: CellOutcome[]): TestCaseOutcomes => ({ testCaseId: "id-1", reference: "TC-0001", title: "Checkout completes", outcomes });

const baseline = "chromium:desktop";

describe("matrix divergence", () => {
  it("says nothing when every cell agrees", () => {
    expect(computeDivergences([testCase(grid("PASSED"))], baseline)).toHaveLength(0);
    // A case that fails everywhere is an ordinary failure the run already reports, not a divergence.
    expect(computeDivergences([testCase(grid("FAILED"))], baseline)).toHaveLength(0);
  });

  it("calls it a browser difference when one engine fails at every viewport", () => {
    const outcomes = grid("PASSED", Object.fromEntries(viewports.map(viewport => [`webkit:${viewport}`, { status: "FAILED" }])));
    const [divergence] = computeDivergences([testCase(outcomes)], baseline);
    expect(divergence.kind).toBe("BROWSER");
    expect(divergence.summary).toContain("webkit");
    expect(divergence.summary).toContain("browser difference");
    expect(divergence.baselineStatus).toBe("PASSED");
  });

  it("calls it a viewport difference when one size fails in every browser", () => {
    const outcomes = grid("PASSED", Object.fromEntries(browsers.map(browser => [`${browser}:mobile`, { status: "FAILED" }])));
    const [divergence] = computeDivergences([testCase(outcomes)], baseline);
    expect(divergence.kind).toBe("VIEWPORT");
    expect(divergence.summary).toContain("mobile");
    expect(divergence.summary).toContain("responsive-layout");
  });

  it("calls it mixed when one specific combination fails", () => {
    const outcomes = grid("PASSED", { "webkit:mobile": { status: "FAILED" } });
    const [divergence] = computeDivergences([testCase(outcomes)], baseline);
    expect(divergence.kind).toBe("MIXED");
    expect(divergence.summary).toContain("webkit:mobile");
  });

  it("refuses to classify when a cell never reached a verdict", () => {
    // ERRORED is the harness breaking and TIMED_OUT may be a busy machine. Treating either as
    // "this browser fails" would manufacture a cross-browser bug out of infrastructure noise.
    for (const noise of ["ERRORED", "TIMED_OUT", "CANCELLED", "RUNNING"]) {
      const outcomes = grid("PASSED", { "firefox:tablet": { status: noise } });
      const [divergence] = computeDivergences([testCase(outcomes)], baseline);
      expect(divergence.kind).toBe("INCONCLUSIVE");
      expect(divergence.summary).toContain("not evidence");
    }
  });

  it("ranks an actionable pattern above an inconclusive one", () => {
    const browserBug = { ...testCase(grid("PASSED", Object.fromEntries(viewports.map(viewport => [`webkit:${viewport}`, { status: "FAILED" }])))), testCaseId: "b", reference: "TC-0002" };
    const noisy = { ...testCase(grid("PASSED", { "firefox:tablet": { status: "ERRORED" } })), testCaseId: "n", reference: "TC-0001" };
    const ranked = computeDivergences([noisy, browserBug], baseline);
    expect(ranked.map(divergence => divergence.kind)).toEqual(["BROWSER", "INCONCLUSIVE"]);
  });

  it("ignores a case that only ran in one cell", () => {
    // Nothing to compare against. A single result is a result, not a difference.
    expect(computeDivergences([testCase([{ browser: "chromium", viewportName: "desktop", status: "FAILED", failureCategory: "ASSERTION_FAILED", failureMessage: "x" }])], baseline)).toHaveLength(0);
  });

  it("reports a divergence even when the baseline cell is missing from the grid", () => {
    // A cancelled baseline must not hide the fact that the other cells disagree.
    const outcomes = grid("PASSED", { "webkit:mobile": { status: "FAILED" } }).filter(outcome => `${outcome.browser}:${outcome.viewportName}` !== baseline);
    const [divergence] = computeDivergences([testCase(outcomes)], baseline);
    expect(divergence.baselineStatus).toBeNull();
    expect(divergence.kind).toBe("MIXED");
  });
});
