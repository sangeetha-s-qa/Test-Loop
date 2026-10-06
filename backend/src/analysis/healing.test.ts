import { describe, expect, it } from "vitest";
import { countMatches, rankHealingCandidates, type DomCandidate } from "./healing";

const dom: DomCandidate[] = [
  { tag: "input", testId: "username", id: "username", name: "username", placeholder: "Your name", ariaLabel: null, text: null, visible: true },
  { tag: "input", testId: "password", id: "password", name: "password", type: "password", ariaLabel: null, text: null, visible: true },
  { tag: "button", testId: "signin", role: null, id: null, name: null, ariaLabel: null, text: "Sign in", visible: true },
  { tag: "a", role: null, id: null, name: null, text: "Home", visible: true },
  { tag: "a", role: null, id: null, name: null, text: "About", visible: true },
];

const failed = { strategy: "testId" as const, value: "login-button" };

describe("countMatches", () => {
  it("counts a unique test id as one match", () => {
    expect(countMatches(dom, { strategy: "testId", value: "signin" })).toBe(1);
  });

  it("counts an absent element as zero", () => {
    expect(countMatches(dom, { strategy: "testId", value: "missing" })).toBe(0);
  });

  it("counts a role that matches several elements", () => {
    expect(countMatches(dom, { strategy: "role", value: "link" })).toBe(2);
  });

  it("narrows a role by accessible name", () => {
    expect(countMatches(dom, { strategy: "role", value: "link", name: "Home" })).toBe(1);
  });

  it("resolves a css id selector against the evidence", () => {
    expect(countMatches(dom, { strategy: "css", value: "#password" })).toBe(1);
  });
});

describe("rankHealingCandidates", () => {
  it("accepts a unique candidate and records why", () => {
    const result = rankHealingCandidates({ candidates: [{ strategy: "testId", value: "signin", confidence: 0.9, rationale: "Stable test id on the submit button" }] }, dom, failed);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].value).toBe("signin");
    expect(result.accepted[0].matchCount).toBe(1);
  });

  it("rejects a candidate that would match multiple elements, whatever the model claimed", () => {
    const result = rankHealingCandidates({ candidates: [{ strategy: "role", value: "link", name: undefined, confidence: 0.99, rationale: "Very confident" }] }, dom, failed);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("ROLE_WITHOUT_ACCESSIBLE_NAME");
  });

  it("rejects a text locator whose substring matches several elements", () => {
    // "o" appears in both "Home" and "About".
    const result = rankHealingCandidates({ candidates: [{ strategy: "text", value: "o", confidence: 0.8, rationale: "matches text" }] }, dom, failed);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("AMBIGUOUS_MATCHES_MULTIPLE_ELEMENTS");
  });

  it("rejects a css selector the evidence cannot verify", () => {
    const result = rankHealingCandidates({ candidates: [{ strategy: "css", value: "form > div:nth-child(3) button", confidence: 0.9, rationale: "structural" }] }, dom, failed);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("NOT_PRESENT_IN_EVIDENCE");
  });

  it("rejects a hallucinated element that is not in the evidence", () => {
    const result = rankHealingCandidates({ candidates: [{ strategy: "testId", value: "invented", confidence: 1, rationale: "Looks right" }] }, dom, failed);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("NOT_PRESENT_IN_EVIDENCE");
  });

  it("rejects re-proposing the locator that already failed", () => {
    const result = rankHealingCandidates({ candidates: [{ strategy: "testId", value: "login-button", confidence: 0.7, rationale: "Try again" }] }, dom, failed);
    expect(result.rejected[0].reason).toBe("IDENTICAL_TO_FAILED_LOCATOR");
  });

  it("prefers a resilient strategy over a higher-confidence fragile one", () => {
    const result = rankHealingCandidates(
      { candidates: [{ strategy: "text", value: "Sign in", confidence: 0.99, rationale: "visible text" }, { strategy: "testId", value: "signin", confidence: 0.5, rationale: "test id" }] },
      dom,
      failed,
    );
    expect(result.accepted.map(candidate => candidate.strategy)).toEqual(["testId", "text"]);
  });

  it("returns nothing rather than guessing when every candidate is unusable", () => {
    const result = rankHealingCandidates({ candidates: [{ strategy: "testId", value: "nope", confidence: 1, rationale: "x" }] }, dom, failed);
    expect(result.accepted).toEqual([]);
  });
});
