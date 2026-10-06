import { describe, expect, it } from "vitest";
import { automationJsonSchema, automationProgramSchema, automationStepSchema, type AutomationAction } from "./program";

/**
 * The JSON Schema drives constrained decoding and the Zod schema drives validation. When they
 * disagree the model produces output that decoding accepts and validation rejects, which costs a
 * full extra generation - minutes on a local model - and can fail the run outright. These tests
 * assert the two agree, so the union cannot be extended without the grammar following.
 */

type Arm = { properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };

const arms = ((automationJsonSchema.properties as { steps: { items: { anyOf: Arm[] } } }).steps.items.anyOf);

const armFor = (action: AutomationAction) =>
  arms.find(arm => ((arm.properties.action as { enum?: string[] }).enum ?? [])[0] === action);

/** Keys Zod will reject the object for omitting. */
function zodRequiredKeys(option: (typeof automationStepSchema.options)[number]) {
  return Object.entries(option.shape)
    .filter(([, value]) => !(value as { isOptional(): boolean }).isOptional())
    .map(([key]) => key)
    .sort();
}

describe("automationJsonSchema", () => {
  it("has exactly one arm per action in the Zod union", () => {
    const zodActions = automationStepSchema.options.map(option => (option.shape.action._def as { value: string }).value).sort();
    const schemaActions = arms.map(arm => ((arm.properties.action as { enum?: string[] }).enum ?? [])[0]).sort();
    expect(schemaActions).toEqual(zodActions);
  });

  it.each(automationStepSchema.options.map(option => [(option.shape.action._def as { value: AutomationAction }).value, option] as const))(
    "%s: decoding requires at least what validation requires, and offers no foreign field",
    (action, option) => {
      const arm = armFor(action);
      expect(arm, `no JSON Schema arm for ${action}`).toBeDefined();
      // Superset, not equality: decoding may be stricter (see decodingRequired), never looser.
      for (const key of zodRequiredKeys(option)) expect(arm?.required ?? []).toContain(key);
      // A field the action does not accept is what let the model put a locator on expectTitle.
      expect(Object.keys(arm?.properties ?? {}).sort()).toEqual(Object.keys(option.shape).sort());
      expect(arm?.additionalProperties).toBe(false);
    },
  );

  it("rejects the exact output that broke the live run", () => {
    // Real output from qwen2.5:3b-instruct: expectTitle carrying a locator and no value.
    const badStep = { action: "expectTitle", description: "Verify Products page is displayed", locator: { strategy: "testId", value: "products" } };
    expect(automationStepSchema.safeParse(badStep).success).toBe(false);
    const arm = armFor("expectTitle");
    expect(arm?.required).toContain("value");
    expect(Object.keys(arm?.properties ?? {})).not.toContain("locator");
  });

  it("requires a path on goto so a navigation test cannot silently target the root", () => {
    expect(armFor("goto")?.required).toContain("path");
    // Validation still tolerates the omission, so stored programs stay readable.
    expect(automationProgramSchema.safeParse({ name: "example", steps: [{ action: "goto", description: "open" }] }).success).toBe(true);
  });

  it("keeps the step array bounded so constrained decoding terminates", () => {
    const steps = (automationJsonSchema.properties as { steps: { maxItems: number; minItems: number } }).steps;
    expect(steps.maxItems).toBe(20);
    expect(steps.minItems).toBe(1);
  });
});

describe("derived constraints", () => {
  const armProps = (action: AutomationAction) =>
    (arms.find(arm => ((arm.properties.action as { enum?: string[] }).enum ?? [])[0] === action)?.properties ?? {}) as Record<string, { maxLength?: number; minLength?: number; pattern?: string; maximum?: number; properties?: Record<string, { maxLength?: number }> }>;

  it("carries string length bounds so a runaway value cannot consume the output budget", () => {
    // locatorSchema.value is min(1).max(400); an unbounded string here would let one field run on.
    expect(armProps("click").locator?.properties?.value?.maxLength).toBe(400);
    expect(armProps("expectTitle").value?.maxLength).toBe(500);
    // fill.value is max(2000) in Zod but the grammar caps at 1000: Ollama fails to compile a
    // maxLength of 2000 outright. Stricter than validation is safe; looser would not be.
    expect(armProps("fill").value?.maxLength).toBe(1000);
    expect(armProps("goto").path?.maxLength).toBe(1000);
  });

  it("carries a regex check across as a grammar pattern", () => {
    expect(armProps("screenshot").name?.pattern).toBe("^[A-Za-z0-9._-]+$");
  });

  it("carries numeric bounds", () => {
    expect(armProps("expectCount").count?.maximum).toBe(1000);
  });

  it("leaves no string field unbounded in any arm", () => {
    const unbounded: string[] = [];
    const walk = (node: Record<string, unknown>, path: string) => {
      if (node.type === "string" && node.maxLength === undefined && node.enum === undefined) unbounded.push(path);
      const properties = node.properties as Record<string, Record<string, unknown>> | undefined;
      for (const [key, value] of Object.entries(properties ?? {})) walk(value, `${path}.${key}`);
    };
    for (const arm of arms) walk(arm as unknown as Record<string, unknown>, ((arm.properties.action as { enum?: string[] }).enum ?? [])[0] ?? "?");
    // sourceElementId is a nullable uuid carried straight from the crawl, not free text.
    expect(unbounded.filter(path => !path.endsWith("sourceElementId"))).toEqual([]);
  });
});
