import { z } from "zod";

/**
 * Automation is stored as a validated, declarative program rather than generated source code.
 *
 * The Phase 5 gate requires that generated automation "cannot access host resources, secrets, or
 * forbidden network targets". A code string would need a sandbox to make that true; a closed set
 * of typed actions makes it true by construction, because the runner is the only thing that ever
 * touches Playwright and it has no `eval`, no filesystem action, and no arbitrary-URL action.
 *
 * A readable Playwright spec is rendered from this program for human review and export
 * (see `renderer.ts`). That rendered source is never executed.
 */

export const programSchemaVersion = "v1";

/** Locator strategies, ordered from most to least resilient. */
export const locatorStrategies = ["testId", "role", "label", "placeholder", "text", "altText", "title", "css"] as const;
export type LocatorStrategy = (typeof locatorStrategies)[number];

export const locatorSchema = z.object({
  strategy: z.enum(locatorStrategies),
  value: z.string().trim().min(1).max(400),
  /** Required by the `role` strategy to disambiguate, optional elsewhere. */
  name: z.string().trim().min(1).max(300).optional(),
  exact: z.boolean().optional(),
  /** Zero-based index used only when a locator legitimately matches a list. */
  nth: z.number().int().min(0).max(50).optional(),
  /**
   * Evidence link back to the Phase 3 crawl. The model supplies a short prompt ref (`e3`) which the
   * worker resolves to the real element id before the program is stored, so a ref it invented
   * becomes null rather than a dangling reference. Requiring a UUID here made the model fabricate
   * plausible ids and fail every repair attempt; see `buildAutomationPrompt`.
   */
  sourceElementId: z.string().trim().max(40).nullable().optional(),
});
export type AutomationLocator = z.infer<typeof locatorSchema>;

const stepBase = { description: z.string().trim().min(1).max(300), testCaseStep: z.number().int().positive().max(200).optional() };

/**
 * Why a run may legitimately stop and ask a person to act.
 *
 * The set is closed so the reason can drive the UI copy, the deadline, and the audit record
 * without any of them parsing free text. Anything outside it is `OTHER`, which still carries the
 * step's own prompt.
 */
export const manualActionReasons = [
  "OTP",
  "CAPTCHA",
  "EMAIL_VERIFICATION",
  "EXTERNAL_AUTH",
  "PAYMENT_CONFIRMATION",
  "FILE_UPLOAD",
  "USER_APPROVAL",
  "OTHER",
] as const;
export type ManualActionReason = (typeof manualActionReasons)[number];

/**
 * `goto` carries a path relative to the run's application URL, never an absolute URL. The runner
 * resolves it against the approved origin, so automation cannot be pointed at another host.
 */
export const automationStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), path: z.string().max(2000).default("/"), ...stepBase }),
  z.object({ action: z.literal("click"), locator: locatorSchema, ...stepBase }),
  z.object({ action: z.literal("fill"), locator: locatorSchema, value: z.string().max(2000), ...stepBase }),
  z.object({ action: z.literal("select"), locator: locatorSchema, value: z.string().max(500), ...stepBase }),
  z.object({ action: z.literal("check"), locator: locatorSchema, checked: z.boolean().default(true), ...stepBase }),
  z.object({ action: z.literal("press"), locator: locatorSchema.optional(), key: z.enum(["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"]), ...stepBase }),
  z.object({ action: z.literal("hover"), locator: locatorSchema, ...stepBase }),
  z.object({ action: z.literal("waitForVisible"), locator: locatorSchema, timeoutMs: z.number().int().min(100).max(60_000).optional(), ...stepBase }),
  z.object({ action: z.literal("waitForUrl"), pattern: z.string().max(500), timeoutMs: z.number().int().min(100).max(60_000).optional(), ...stepBase }),
  z.object({ action: z.literal("screenshot"), name: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/), ...stepBase }),
  /**
   * Suspends the run and asks a person to do something the platform must not do itself: receive an
   * OTP, solve a CAPTCHA, confirm a payment.
   *
   * The step deliberately has no value field, and that is the whole safety property. The human acts
   * in their own browser, so the code they type never passes through this program, is never stored
   * in a version, and cannot appear in an artifact or a log. There is nothing here to leak.
   */
  z.object({ action: z.literal("pauseForUser"), reason: z.enum(manualActionReasons), prompt: z.string().trim().min(1).max(300), ...stepBase }),
  z.object({ action: z.literal("expectVisible"), locator: locatorSchema, ...stepBase }),
  z.object({ action: z.literal("expectHidden"), locator: locatorSchema, ...stepBase }),
  z.object({ action: z.literal("expectText"), locator: locatorSchema, value: z.string().max(1000), match: z.enum(["contains", "equals"]).default("contains"), ...stepBase }),
  z.object({ action: z.literal("expectValue"), locator: locatorSchema, value: z.string().max(1000), ...stepBase }),
  z.object({ action: z.literal("expectUrl"), pattern: z.string().max(500), match: z.enum(["contains", "equals"]).default("contains"), ...stepBase }),
  z.object({ action: z.literal("expectTitle"), value: z.string().max(500), match: z.enum(["contains", "equals"]).default("contains"), ...stepBase }),
  z.object({ action: z.literal("expectCount"), locator: locatorSchema, count: z.number().int().min(0).max(1000), ...stepBase }),
]);
export type AutomationStep = z.infer<typeof automationStepSchema>;
export type AutomationAction = AutomationStep["action"];

export const assertionActions: AutomationAction[] = ["expectVisible", "expectHidden", "expectText", "expectValue", "expectUrl", "expectTitle", "expectCount"];

export const automationProgramSchema = z.object({
  schemaVersion: z.literal(programSchemaVersion).default(programSchemaVersion),
  name: z.string().trim().min(3).max(200),
  steps: z.array(automationStepSchema).min(1).max(200),
});
export type AutomationProgram = z.infer<typeof automationProgramSchema>;

type JsonSchemaNode = Record<string, unknown>;

/**
 * Ceiling on a string length expressed in the grammar.
 *
 * Ollama compiles the JSON Schema to a GBNF grammar by expanding a length bound into repetitions,
 * and that expansion has a limit: measured against qwen2.5:3b-instruct, `maxLength` of 1900 compiles
 * and 2000 fails outright with "failed to initialize samplers: failed to parse grammar", which takes
 * the whole request down. Two fields in the step union are `max(2000)` in Zod, so the bound is capped
 * here rather than passed through. Capping only makes the grammar stricter than validation, so
 * nothing the decoder can produce becomes invalid; it just cannot emit a 1500-character locator.
 */
const GRAMMAR_MAX_STRING_LENGTH = 1000;

/** Carries Zod's min/max checks across to the matching JSON Schema keywords. */
function bounds(checks: { kind: string; value?: number }[] | undefined, minKey: string, maxKey: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const check of checks ?? []) {
    if (check.kind === "min" && typeof check.value === "number") result[minKey] = check.value;
    if (check.kind === "max" && typeof check.value === "number") {
      result[maxKey] = maxKey === "maxLength" ? Math.min(check.value, GRAMMAR_MAX_STRING_LENGTH) : check.value;
    }
  }
  return result;
}

/**
 * Converts one Zod node to JSON Schema, reporting whether the field is required.
 *
 * Only the constructs this file actually uses are handled; anything else throws at module load, so
 * extending the step union with an unsupported type fails loudly instead of silently producing a
 * JSON Schema that permits output validation will later reject.
 */
function toJsonSchema(schema: z.ZodTypeAny): { node: JsonSchemaNode; required: boolean } {
  const def = schema._def as { typeName: string; innerType?: z.ZodTypeAny; value?: unknown; values?: readonly string[]; checks?: { kind: string; value?: number }[] };
  switch (def.typeName) {
    // A default still satisfies validation when absent, so it is not required for decoding either.
    case "ZodOptional":
    case "ZodDefault":
      return { node: toJsonSchema(def.innerType as z.ZodTypeAny).node, required: false };
    case "ZodNullable": {
      const inner = toJsonSchema(def.innerType as z.ZodTypeAny);
      return { node: { ...inner.node, type: [inner.node.type, "null"] }, required: inner.required };
    }
    case "ZodLiteral": return { node: { type: "string", enum: [def.value] }, required: true };
    case "ZodEnum": return { node: { type: "string", enum: [...(def.values ?? [])] }, required: true };
    // Length and range bounds are carried across deliberately. An unbounded rule gives the decoder no
    // reason to stop, and a single runaway string can consume an entire output budget.
    case "ZodString": {
      // A regex check becomes a grammar pattern for the same reason bounds are carried: the prose
      // instruction alone is not binding, and a mismatch costs a whole rejected generation.
      const regex = def.checks?.find(check => check.kind === "regex") as { regex?: RegExp } | undefined;
      return { node: { type: "string", ...bounds(def.checks, "minLength", "maxLength"), ...(regex?.regex ? { pattern: regex.regex.source } : {}) }, required: true };
    }
    case "ZodBoolean": return { node: { type: "boolean" }, required: true };
    case "ZodNumber": return { node: { type: def.checks?.some(check => check.kind === "int") ? "integer" : "number", ...bounds(def.checks, "minimum", "maximum") }, required: true };
    case "ZodObject": return { node: objectToJsonSchema(schema as z.ZodObject<z.ZodRawShape>), required: true };
    default: throw new Error(`automationJsonSchema: unsupported Zod type ${def.typeName}`);
  }
}

function objectToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): JsonSchemaNode {
  const properties: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(schema.shape)) {
    const converted = toJsonSchema(value as z.ZodTypeAny);
    properties[key] = converted.node;
    if (converted.required) required.push(key);
  }
  // Closing the object stops the decoder emitting a plausible-looking field that belongs to a
  // different action - the exact failure this schema exists to prevent.
  return { type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) };
}

/**
 * Fields that decoding requires even though validation would accept their absence, because the
 * Zod default is a safe fallback rather than a useful instruction. A `goto` without a path silently
 * becomes "/", which turns a navigation test into an assertion against the wrong page.
 *
 * This may only ever *add* to what validation requires; adding a field here can never make output
 * that decoding accepts fail validation.
 */
const decodingRequired: Partial<Record<AutomationAction, string[]>> = { goto: ["path"] };

function stepArmToJsonSchema(option: z.ZodObject<z.ZodRawShape>): JsonSchemaNode {
  const node = objectToJsonSchema(option);
  const action = (option.shape.action._def as { value: AutomationAction }).value;
  const extra = decodingRequired[action] ?? [];
  const required = [...new Set([...((node.required as string[] | undefined) ?? []), ...extra])];
  return { ...node, required };
}

/**
 * JSON Schema used for constrained decoding, derived from `automationStepSchema` so the two cannot
 * drift apart.
 *
 * A previous hand-written version collapsed the 17-arm union into a single object requiring only
 * `action` and `description`, with every other field optional. Decoding could not then enforce that
 * `expectTitle` carries a `value` or that `goto` carries a `path`, so the model guessed - it
 * attached a locator to `expectTitle` - and validation rejected the result after the generation had
 * already been paid for. Emitting the union as `anyOf` makes each action's own required fields part
 * of the grammar, so an invalid step cannot be produced in the first place.
 */
export const automationJsonSchema: JsonSchemaNode = {
  type: "object",
  required: ["name", "steps"],
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    steps: { type: "array", minItems: 1, maxItems: 20, items: { anyOf: automationStepSchema.options.map(option => stepArmToJsonSchema(option)) } },
  },
};
