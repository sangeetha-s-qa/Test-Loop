import { describe, expect, it } from "vitest";
import { ApplicationType, ManualBlockedReason, ManualTestStatus } from "@prisma/client";
import { applicationTypes, blockedReasons, manualStatuses } from "./catalog";
import { detectEvidenceType } from "./evidence";
import { computeProgress, runPhase, validateResult } from "./rules";

describe("manual result validation", () => {
  const base = { actualResult: "", testerNotes: "", blockedReason: null };

  it("accepts PASSED, NOT_RUN, and IN_PROGRESS with no text", () => {
    for (const status of ["PASSED", "NOT_RUN", "IN_PROGRESS"] as const) expect(validateResult({ ...base, status })).toEqual([]);
  });

  it("refuses FAILED without an actual result and a failure description", () => {
    const errors = validateResult({ ...base, status: "FAILED" });
    expect(errors.map(error => error.field)).toEqual(["actualResult", "testerNotes"]);
    expect(errors[0].message).toBe("Please provide the actual result before marking this test as Failed.");
  });

  it("treats whitespace as empty for FAILED", () => {
    expect(validateResult({ ...base, status: "FAILED", actualResult: "   ", testerNotes: "\n" })).toHaveLength(2);
  });

  it("accepts FAILED once both are present", () => {
    expect(validateResult({ ...base, status: "FAILED", actualResult: "Error 500", testerNotes: "Server error on submit" })).toEqual([]);
  });

  it("requires a reason for BLOCKED, and a note when the reason is OTHER", () => {
    expect(validateResult({ ...base, status: "BLOCKED" }).map(error => error.field)).toEqual(["blockedReason"]);
    expect(validateResult({ ...base, status: "BLOCKED", blockedReason: "OTHER" }).map(error => error.field)).toEqual(["testerNotes"]);
    expect(validateResult({ ...base, status: "BLOCKED", blockedReason: "ENVIRONMENT_UNAVAILABLE" })).toEqual([]);
  });
});

describe("manual progress", () => {
  it("counts every status and computes completion from verdicts only", () => {
    const progress = computeProgress({ PASSED: 24, FAILED: 4, BLOCKED: 2, NOT_RUN: 9, IN_PROGRESS: 1 });
    expect(progress).toMatchObject({ total: 40, passed: 24, failed: 4, blocked: 2, notRun: 9, inProgress: 1, executed: 30, percentComplete: 75 });
  });

  it("excludes blocked cases from the pass rate", () => {
    expect(computeProgress({ PASSED: 3, FAILED: 1, BLOCKED: 6 }).passRate).toBe(75);
  });

  it("reports an empty run as 0% complete with no pass rate, never NaN", () => {
    expect(computeProgress({})).toMatchObject({ total: 0, percentComplete: 0, passRate: null });
    expect(computeProgress({ NOT_RUN: 5 }).passRate).toBeNull();
  });

  it("maps stored run statuses to tester-facing phases", () => {
    expect(runPhase("QUEUED")).toBe("NOT_STARTED");
    expect(runPhase("RUNNING")).toBe("IN_PROGRESS");
    expect(runPhase("COMPLETED")).toBe("COMPLETED");
  });
});

describe("catalog stays in step with the database enums", () => {
  it("application types match ApplicationType", () => expect([...applicationTypes].sort()).toEqual(Object.values(ApplicationType).sort()));
  it("statuses match ManualTestStatus", () => expect([...manualStatuses].sort()).toEqual(Object.values(ManualTestStatus).sort()));
  it("blocked reasons match ManualBlockedReason", () => expect([...blockedReasons].sort()).toEqual(Object.values(ManualBlockedReason).sort()));
});

describe("evidence type detection", () => {
  it("recognises images and videos by their leading bytes", () => {
    expect(detectEvidenceType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))?.contentType).toBe("image/png");
    expect(detectEvidenceType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.contentType).toBe("image/jpeg");
    expect(detectEvidenceType(Buffer.from("RIFF0000WEBPVP8 ", "ascii"))?.contentType).toBe("image/webp");
    expect(detectEvidenceType(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0]))?.kind).toBe("VIDEO");
    expect(detectEvidenceType(Buffer.from("0000ftypisom", "ascii"))?.contentType).toBe("video/mp4");
  });

  it("rejects anything else, whatever it claims to be", () => {
    expect(detectEvidenceType(Buffer.from("<html><script>alert(1)</script>"))).toBeNull();
    expect(detectEvidenceType(Buffer.alloc(0))).toBeNull();
  });
});
