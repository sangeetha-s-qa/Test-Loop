/**
 * Comparing one test case's outcome across the cells of a browser x viewport grid.
 *
 * Running the same suite nine times only has value if something reads the nine results together.
 * A raw list of failures cannot tell a reviewer whether they are looking at one Safari bug or one
 * mobile-layout bug, and that distinction is the whole reason to run a matrix - so it is computed
 * here rather than left to the reader.
 *
 * Pure functions over plain data: no database, no Playwright. The classification rules are the part
 * most likely to be wrong, so they are the part that has to be cheap to test.
 */

export type CellOutcome = {
  browser: string;
  viewportName: string;
  status: string;
  failureCategory: string | null;
  failureMessage: string | null;
};

export type TestCaseOutcomes = {
  testCaseId: string;
  reference: string;
  title: string;
  outcomes: CellOutcome[];
};

/**
 * `BROWSER` - the result tracks the browser and is the same at every viewport within it.
 * `VIEWPORT` - the result tracks the viewport and is the same in every browser at that size.
 * `MIXED` - it does neither, which usually means a specific combination is broken.
 * `INCONCLUSIVE` - a cell errored or did not finish, so there is nothing trustworthy to compare.
 */
export type DivergenceKind = "BROWSER" | "VIEWPORT" | "MIXED" | "INCONCLUSIVE";

export type Divergence = {
  testCaseId: string;
  reference: string;
  title: string;
  kind: DivergenceKind;
  baselineStatus: string | null;
  /** Human summary of which axis the result follows, e.g. "fails in webkit at every viewport". */
  summary: string;
  outcomes: CellOutcome[];
};

export const cellKey = (browser: string, viewportName: string) => `${browser}:${viewportName}`;

/**
 * Only a verdict the browser actually reached counts as comparable.
 *
 * ERRORED means the harness broke and TIMED_OUT may mean the machine was busy; treating either as
 * "this browser fails" would manufacture cross-browser bugs out of infrastructure noise.
 */
const comparable = new Set(["PASSED", "FAILED"]);

const distinct = <T>(values: T[]) => [...new Set(values)];

/** True when every outcome sharing a key on `axis` agrees, i.e. the result tracks that axis. */
function tracksAxis(outcomes: CellOutcome[], axis: "browser" | "viewportName") {
  const groups = new Map<string, Set<string>>();
  for (const outcome of outcomes) {
    const group = groups.get(outcome[axis]) ?? new Set<string>();
    group.add(outcome.status);
    groups.set(outcome[axis], group);
  }
  // Every group internally consistent, and the groups not all identical to one another.
  const allConsistent = [...groups.values()].every(statuses => statuses.size === 1);
  const groupStatuses = distinct([...groups.values()].map(statuses => [...statuses][0]));
  return allConsistent && groupStatuses.length > 1;
}

function describe(outcomes: CellOutcome[], kind: DivergenceKind): string {
  const failing = outcomes.filter(outcome => outcome.status === "FAILED");
  if (kind === "INCONCLUSIVE") {
    const unreached = outcomes.filter(outcome => !comparable.has(outcome.status));
    return `${unreached.length} of ${outcomes.length} cells did not reach a verdict (${distinct(unreached.map(outcome => outcome.status.toLowerCase())).join(", ")}), so this row is not evidence either way.`;
  }
  if (kind === "BROWSER") {
    const browsers = distinct(failing.map(outcome => outcome.browser));
    return `Fails in ${browsers.join(" and ")} at every viewport, and passes in the others. This looks like a browser difference rather than a layout one.`;
  }
  if (kind === "VIEWPORT") {
    const viewports = distinct(failing.map(outcome => outcome.viewportName));
    return `Fails at ${viewports.join(" and ")} in every browser, and passes at the other sizes. This looks like a responsive-layout problem rather than a browser one.`;
  }
  return `Fails in ${failing.length} of ${outcomes.length} cells (${failing.map(outcome => cellKey(outcome.browser, outcome.viewportName)).join(", ")}) with no consistent pattern by browser or by viewport. A specific combination is usually the cause.`;
}

/**
 * Finds the test cases whose result is not the same everywhere.
 *
 * A case that fails in every cell is *not* a divergence - it is an ordinary failure, already
 * reported by the run itself, and repeating it here would bury the handful of rows this screen
 * exists to surface.
 */
export function computeDivergences(cases: TestCaseOutcomes[], baselineKey: string): Divergence[] {
  const divergences: Divergence[] = [];

  for (const testCase of cases) {
    const outcomes = testCase.outcomes;
    if (outcomes.length < 2) continue;

    const baseline = outcomes.find(outcome => cellKey(outcome.browser, outcome.viewportName) === baselineKey) ?? null;
    const statuses = distinct(outcomes.map(outcome => outcome.status));
    if (statuses.length === 1) continue;

    const usable = outcomes.filter(outcome => comparable.has(outcome.status));
    // Something did not finish. Reported, but never classified as a browser or viewport difference.
    if (usable.length !== outcomes.length) {
      divergences.push({
        testCaseId: testCase.testCaseId,
        reference: testCase.reference,
        title: testCase.title,
        kind: "INCONCLUSIVE",
        baselineStatus: baseline?.status ?? null,
        summary: describe(outcomes, "INCONCLUSIVE"),
        outcomes,
      });
      continue;
    }

    // With every cell comparable, the pattern decides the classification. Browser is checked first
    // only because a single-viewport matrix can satisfy both trivially, and "this browser differs"
    // is the more actionable reading of that case.
    const kind: DivergenceKind = tracksAxis(usable, "browser") ? "BROWSER" : tracksAxis(usable, "viewportName") ? "VIEWPORT" : "MIXED";

    divergences.push({
      testCaseId: testCase.testCaseId,
      reference: testCase.reference,
      title: testCase.title,
      kind,
      baselineStatus: baseline?.status ?? null,
      summary: describe(usable, kind),
      outcomes,
    });
  }

  // Actionable first: a clean browser or viewport story is easier to act on than a mixed one, and
  // an inconclusive row is a prompt to re-run rather than a finding.
  const order: DivergenceKind[] = ["BROWSER", "VIEWPORT", "MIXED", "INCONCLUSIVE"];
  return divergences.sort((left, right) => order.indexOf(left.kind) - order.indexOf(right.kind) || left.reference.localeCompare(right.reference));
}
