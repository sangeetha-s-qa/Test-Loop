import { beforeAll, describe, expect, it } from "vitest";
import { generationOutputSchema } from "./types";

let createAIProvider: typeof import("./provider").createAIProvider;
// Set to empty rather than deleted: `dotenv` would otherwise repopulate these from the
// developer's .env once the key is absent, and the test would silently stop testing anything.
beforeAll(async () => { process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough"; process.env.AI_PROVIDER = ""; process.env.AI_MODEL = ""; process.env.OPENAI_API_KEY = ""; process.env.ANTHROPIC_API_KEY = ""; ({ createAIProvider } = await import("./provider")); });

describe("AI provider boundary", () => {
  it("fails explicitly when no provider is configured", () => {
    expect(() => createAIProvider()).toThrow("AI_PROVIDER_NOT_CONFIGURED");
  });

  it("rejects malformed structured output", () => {
    expect(() => generationOutputSchema.parse({ scenarios: [], testCases: [{ title: "missing required fields" }] })).toThrow();
  });

  it("accepts a traceable manual test case", () => {
    const result = generationOutputSchema.parse({ scenarios: [], testCases: [{ testCaseId: "TC-NAV-001", title: "Navigate to the home page", description: "Verify the home page is reachable.", module: "Navigation", category: "NAVIGATION", priority: "MEDIUM", severity: "MEDIUM", preconditions: "None", testData: {}, steps: [{ step: 1, action: "Open the application URL", expectedResult: "The home page is displayed" }], expectedResult: "The page loads successfully.", postconditions: "None", sourcePageId: null, sourceElementId: null }] });
    expect(result.testCases[0].testCaseId).toBe("TC-NAV-001");
  });
});
