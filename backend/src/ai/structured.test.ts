import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractJson, generateValidated } from "./structured";
import { AIProviderError, type AIProvider } from "./types";

const schema = z.object({ title: z.string().min(1), count: z.number().int() });

/** Replays a fixed script of responses so repair behaviour is deterministic. */
function scriptedProvider(responses: string[]): AIProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "scripted",
    model: "scripted",
    local: true,
    calls,
    complete: async request => {
      calls.push(request.prompt);
      const text = responses.shift();
      if (text === undefined) throw new AIProviderError("AI_SCRIPT_EXHAUSTED");
      return { text, latencyMs: 1, promptTokens: 10, completionTokens: 5, providerRequestId: null };
    },
  };
}

describe("extractJson", () => {
  it("returns a bare JSON object unchanged", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it("unwraps a markdown fence", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("discards prose around the JSON value", () => {
    expect(extractJson('Sure! Here you go:\n{"a":1}\nLet me know.')).toBe('{"a":1}');
  });

  it("does not stop at a brace inside a string literal", () => {
    expect(extractJson('{"a":"}"}')).toBe('{"a":"}"}');
    expect(extractJson('{"a":"\\"}"}')).toBe('{"a":"\\"}"}');
  });

  it("rejects output containing no JSON value", () => {
    expect(() => extractJson("I cannot help with that.")).toThrow("AI_OUTPUT_NOT_JSON");
  });

  it("rejects a truncated value instead of guessing", () => {
    expect(() => extractJson('{"a":1')).toThrow("AI_OUTPUT_TRUNCATED");
  });
});

describe("generateValidated", () => {
  const request = { system: "s", prompt: "p" };

  it("returns validated output on the first attempt", async () => {
    const provider = scriptedProvider(['{"title":"ok","count":2}']);
    const outcome = await generateValidated(provider, request, schema);
    expect(outcome.value).toEqual({ title: "ok", count: 2 });
    expect(outcome.attempts).toBe(1);
    expect(outcome.promptTokens).toBe(10);
  });

  it("repairs invalid output and reports the validation errors back to the model", async () => {
    const provider = scriptedProvider(['{"title":"","count":"two"}', '{"title":"fixed","count":3}']);
    const outcome = await generateValidated(provider, request, schema);
    expect(outcome.value.title).toBe("fixed");
    expect(outcome.attempts).toBe(2);
    expect(provider.calls[1]).toContain("rejected for these reasons");
    expect(provider.calls[1]).toContain("count:");
  });

  it("accumulates token usage across repair attempts", async () => {
    const provider = scriptedProvider(["not json", '{"title":"fixed","count":3}']);
    const outcome = await generateValidated(provider, request, schema);
    expect(outcome.promptTokens).toBe(20);
    expect(outcome.completionTokens).toBe(10);
  });

  it("fails explicitly rather than persisting invalid output", async () => {
    const provider = scriptedProvider(['{"count":1}', '{"count":1}', '{"count":1}']);
    await expect(generateValidated(provider, request, schema)).rejects.toThrow("AI_OUTPUT_VALIDATION_FAILED");
  });

  it("stops after the configured number of repair attempts", async () => {
    const provider = scriptedProvider(["bad", "bad", "bad", '{"title":"late","count":1}']);
    await expect(generateValidated(provider, request, schema, 2)).rejects.toThrow("AI_OUTPUT_VALIDATION_FAILED");
    expect(provider.calls).toHaveLength(3);
  });
});

describe("post-schema policy check", () => {
  it("repairs a value the schema accepts but policy rejects, reporting why", async () => {
    // Ollama silently ignores `prefixItems` and `contains`, so rules like "must start with a
    // navigation step" can only be enforced after decoding. They must still reach the model.
    const provider = scriptedProvider(['{"title":"a","count":1}', '{"title":"ok","count":2}']);
    const outcome = await generateValidated(provider, { system: "s", prompt: "p" }, schema, 2, undefined, value =>
      value.count < 2 ? "COUNT_TOO_LOW: count must be at least 2." : null,
    );
    expect(outcome.value.count).toBe(2);
    expect(outcome.attempts).toBe(2);
    expect(provider.calls[1]).toContain("COUNT_TOO_LOW");
  });

  it("fails explicitly when policy keeps rejecting rather than storing a violating value", async () => {
    const provider = scriptedProvider(['{"title":"a","count":1}', '{"title":"a","count":1}', '{"title":"a","count":1}']);
    await expect(
      generateValidated(provider, { system: "s", prompt: "p" }, schema, 2, undefined, () => "ALWAYS_BAD: nope."),
    ).rejects.toThrow("AI_OUTPUT_VALIDATION_FAILED");
  });
});
