import { describe, expect, it } from "vitest";
import { buildAutomationPrompt } from "./prompt";
import { locatorSchema } from "./program";

/**
 * The model addresses discovered elements by short ref rather than by UUID. Two live runs failed
 * every repair attempt with "sourceElementId: Invalid uuid" because a 3B model cannot copy a
 * 36-character UUID back verbatim - it invents `element-1` instead.
 */

const input = {
  applicationUrl: "http://127.0.0.1:4317/",
  testCase: { testCaseId: "TC-NAV-001", title: "Home links to About", description: "d", module: "Navigation", preconditions: "", testData: {}, steps: [{ step: 1, action: "Open", expectedResult: "Loads" }], expectedResult: "About page shown" },
  pages: [
    { id: "11111111-1111-4111-8111-111111111111", path: "/", title: "Home" },
    { id: "22222222-2222-4222-8222-222222222222", path: "/about", title: "About" },
  ],
  elements: [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", pageId: "11111111-1111-4111-8111-111111111111", tagName: "a", role: "link", accessibleName: "About", selectorCandidates: ["[data-testid=\"about\"]", "#about", ".nav a"] },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", pageId: "22222222-2222-4222-8222-222222222222", tagName: "h1", role: null, accessibleName: "About us", selectorCandidates: ["h1"] },
  ],
  forms: [],
};

describe("buildAutomationPrompt", () => {
  it("addresses elements by short ref and maps each back to its real id", () => {
    const { prompt, refs } = buildAutomationPrompt(input);
    expect(prompt).toContain('"ref":"e1"');
    expect(refs.elements.get("e1")).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(refs.elements.get("e2")).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  it("keeps element UUIDs out of the prompt entirely", () => {
    const { prompt } = buildAutomationPrompt(input);
    // A UUID in the payload is what the model copies badly; it must never see one.
    expect(prompt).not.toContain("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(prompt).not.toContain("11111111-1111-4111-8111-111111111111");
  });

  it("sends the selectors a locator can actually be built from", () => {
    const { prompt } = buildAutomationPrompt(input);
    expect(prompt).toContain("data-testid");
    expect(prompt).toContain('"role":"link"');
  });

  it("accepts a short ref where validation once demanded a uuid", () => {
    // The exact value the model produced when the schema required a uuid.
    expect(locatorSchema.safeParse({ strategy: "testId", value: "about", sourceElementId: "e1" }).success).toBe(true);
    expect(locatorSchema.safeParse({ strategy: "testId", value: "about", sourceElementId: null }).success).toBe(true);
  });

  it("tells the model to use the ref and never invent an id", () => {
    const { prompt } = buildAutomationPrompt(input);
    expect(prompt).toMatch(/short ref/i);
    expect(prompt).toMatch(/never invent an id/i);
  });
});
