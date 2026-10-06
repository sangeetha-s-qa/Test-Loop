import type { BlockedReason, ManualStatus } from "./catalog";

/**
 * The rules a manual result has to satisfy, kept free of I/O so the API, the tests, and the report
 * all apply exactly the same ones.
 */

export type ResultInput = { status: ManualStatus; actualResult: string; testerNotes: string; blockedReason: BlockedReason | null };
export type FieldError = { field: "actualResult" | "testerNotes" | "blockedReason"; message: string };

/**
 * A FAILED result must say what actually happened and why it is a failure; a BLOCKED one must say
 * what blocked it. Anything less is a verdict nobody can act on, so it is rejected rather than
 * stored. PASSED, NOT_RUN, and IN_PROGRESS carry no mandatory text.
 */
export function validateResult(input: ResultInput): FieldError[] {
  const errors: FieldError[] = [];
  if (input.status === "FAILED") {
    if (!input.actualResult.trim()) errors.push({ field: "actualResult", message: "Please provide the actual result before marking this test as Failed." });
    if (!input.testerNotes.trim()) errors.push({ field: "testerNotes", message: "Please describe the failure before marking this test as Failed." });
  }
  if (input.status === "BLOCKED") {
    if (!input.blockedReason) errors.push({ field: "blockedReason", message: "Choose what blocked this test." });
    else if (input.blockedReason === "OTHER" && !input.testerNotes.trim()) errors.push({ field: "testerNotes", message: "Describe the blocker when the reason is Other." });
  }
  return errors;
}

/** Statuses that mean a person reached a verdict. IN_PROGRESS is deliberately not one of them. */
export const executedStatuses: readonly ManualStatus[] = ["PASSED", "FAILED", "BLOCKED"];

export type Progress = {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  notRun: number;
  inProgress: number;
  /** Cases with a verdict: passed + failed + blocked. */
  executed: number;
  /** executed / total, as a whole percentage. 0 for an empty run, never NaN. */
  percentComplete: number;
  /**
   * passed / (passed + failed). Blocked cases are excluded because they never reached the
   * application, so counting them either way would misstate its quality. Null when nothing has
   * passed or failed yet, rather than a fabricated 0% or 100%.
   */
  passRate: number | null;
};

export function computeProgress(counts: Partial<Record<ManualStatus, number>>): Progress {
  const passed = counts.PASSED ?? 0;
  const failed = counts.FAILED ?? 0;
  const blocked = counts.BLOCKED ?? 0;
  const notRun = counts.NOT_RUN ?? 0;
  const inProgress = counts.IN_PROGRESS ?? 0;
  const total = passed + failed + blocked + notRun + inProgress;
  const executed = passed + failed + blocked;
  return {
    total,
    passed,
    failed,
    blocked,
    notRun,
    inProgress,
    executed,
    percentComplete: total ? Math.round((executed / total) * 100) : 0,
    passRate: passed + failed ? Math.round((passed / (passed + failed)) * 1000) / 10 : null,
  };
}

/** The three phases a tester sees, derived from the run's stored status. */
export function runPhase(status: string): "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" {
  if (status === "COMPLETED") return "COMPLETED";
  if (status === "RUNNING" || status === "WAITING_FOR_USER") return "IN_PROGRESS";
  return "NOT_STARTED";
}
