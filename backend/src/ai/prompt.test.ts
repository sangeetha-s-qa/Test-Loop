import { describe, expect, it } from "vitest";
import { buildGenerationJsonSchema } from "./prompt";
import { generationOutputSchema } from "./types";

/**
 * The JSON Schema drives constrained decoding and the Zod schema drives validation. Where the two
 * disagree the model emits output that decoding accepts and validation rejects, and every rejection
 * costs a whole extra generation - minutes on a local model. Live logs showed exactly that: all six
 * test cases failed on `testCaseId` every run, so each generation silently paid for two.
 */

type Schema = {
  properties: {
    scenarios: { maxItems: number };
    testCases: {
      maxItems: number;
      items: { required: string[]; additionalProperties: boolean; properties: Record<string, { type?: unknown; pattern?: string; enum?: string[] }> & { steps: { minItems: number; maxItems: number } } };
    };
  };
};

const schema = buildGenerationJsonSchema(8) as unknown as Schema;
const testCase = schema.properties.testCases.items;

describe("generation JSON schema", () => {
  it("constrains testCaseId to the pattern validation requires", () => {
    expect(testCase.properties.testCaseId.pattern).toBe("^TC-[A-Z0-9-]+$");
  });

  it("rejects the id shape the model actually produced", () => {
    const pattern = new RegExp(testCase.properties.testCaseId.pattern!);
    // Real output from qwen2.5:3b-instruct that failed validation on every attempt.
    expect(pattern.test("TC-Navigation-001")).toBe(false);
    expect(pattern.test("TC-NAVIGATION-001")).toBe(true);
  });

  it("agrees with the Zod schema on testCaseId", () => {
    const build = (id: string) => ({
      scenarios: [],
      testCases: [{ testCaseId: id, title: "Verify the sign-in form rejects a blank password", module: "Auth", category: "FUNCTIONAL", priority: "HIGH", severity: "HIGH", steps: [{ step: 1, action: "Open", expectedResult: "Loads" }], expectedResult: "Rejected" }],
    });
    const pattern = new RegExp(testCase.properties.testCaseId.pattern!);
    for (const id of ["TC-AUTH-001", "TC-Navigation-001", "tc-auth-001", "AUTH-001"]) {
      expect(pattern.test(id), `grammar disagrees with validation for ${id}`).toBe(generationOutputSchema.safeParse(build(id)).success);
    }
  });

  it("requires enough steps that a case can actually act and verify", () => {
    // With a floor of one the model produced cases whose only step was "Open the About page",
    // expected result "the Home link is functional" - it never clicked the link.
    expect(testCase.properties.steps.minItems).toBe(3);
    expect(generationOutputSchema.safeParse({ scenarios: [], testCases: [{ testCaseId: "TC-A-1", title: "A title long enough", module: "M", category: "C", priority: "LOW", severity: "LOW", steps: [], expectedResult: "x" }] }).success).toBe(false);
  });

  it("keeps every array bounded so constrained decoding terminates", () => {
    expect(schema.properties.testCases.maxItems).toBe(8);
    expect(schema.properties.scenarios.maxItems).toBeLessThanOrEqual(6);
    expect(testCase.properties.steps.maxItems).toBeGreaterThan(0);
    expect(testCase.additionalProperties).toBe(false);
  });
});
