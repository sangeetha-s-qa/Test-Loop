import { describe, expect, it } from "vitest";
import { failureFingerprint } from "./bugs";

const base = { testCaseId: "11111111-1111-1111-1111-111111111111", failureCategory: "ASSERTION_FAILED", failedStepIndex: 3 };

describe("failure fingerprint", () => {
  it("is stable for the same failure", () => {
    const message = "expect(locator).toBeVisible() failed";
    expect(failureFingerprint({ ...base, failureMessage: message })).toBe(failureFingerprint({ ...base, failureMessage: message }));
  });

  it("ignores volatile ids, timestamps, numbers, and whitespace", () => {
    const first = failureFingerprint({ ...base, failureMessage: "Timeout 15000ms exceeded at 2026-01-01T00:00:00Z for run 3f6b9c2a-1111-4222-8333-444455556666" });
    const second = failureFingerprint({ ...base, failureMessage: "Timeout   9000ms exceeded at 2026-08-26T12:30:45Z for run aaaaaaaa-2222-4333-8444-555566667777" });
    expect(first).toBe(second);
  });

  it("separates different failure messages", () => {
    expect(failureFingerprint({ ...base, failureMessage: "element not visible" })).not.toBe(failureFingerprint({ ...base, failureMessage: "wrong text content" }));
  });

  it("separates the same message on a different step", () => {
    expect(failureFingerprint({ ...base, failureMessage: "same" })).not.toBe(failureFingerprint({ ...base, failedStepIndex: 4, failureMessage: "same" }));
  });

  it("separates the same message on a different test case", () => {
    expect(failureFingerprint({ ...base, failureMessage: "same" })).not.toBe(failureFingerprint({ ...base, testCaseId: "22222222-2222-2222-2222-222222222222", failureMessage: "same" }));
  });

  it("separates the same message under a different category", () => {
    expect(failureFingerprint({ ...base, failureMessage: "same" })).not.toBe(failureFingerprint({ ...base, failureCategory: "TIMEOUT", failureMessage: "same" }));
  });

  it("handles a missing failure message without throwing", () => {
    expect(failureFingerprint({ ...base, failureMessage: null })).toHaveLength(32);
  });
});
