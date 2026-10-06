import type { z } from "zod";
import { AIProviderError, type AIProvider, type AIRequest, type AIResult } from "./types";

/** Everything recorded about one validated generation, persisted for traceability and cost. */
export type StructuredOutcome<T> = {
  value: T;
  attempts: number;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  providerRequestId: string | null;
};

const MAX_OUTPUT_CHARS = 400_000;

/**
 * Models routinely wrap JSON in prose or a markdown fence. Recover the JSON value without
 * evaluating anything: strip fences, then take the outermost balanced object/array.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  const body = (fenced ? fenced[1] : trimmed).trim();
  const start = body.search(/[[{]/);
  if (start === -1) throw new AIProviderError("AI_OUTPUT_NOT_JSON");
  const opener = body[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < body.length; index += 1) {
    const character = body[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === opener) depth += 1;
    else if (character === closer) {
      depth -= 1;
      if (depth === 0) return body.slice(start, index + 1);
    }
  }
  throw new AIProviderError("AI_OUTPUT_TRUNCATED");
}

/** Reported for each rejected attempt so a repair round is diagnosable rather than invisible. */
export type RepairInfo = { attempt: number; reason: string; outputChars: number; completionTokens: number | null };

/**
 * Calls the provider and validates the response against `schema`. Invalid output gets a bounded
 * number of repair attempts that echo the validation errors back; after that the call fails
 * explicitly. Output is never persisted without passing `schema`.
 *
 * A repair round costs a whole extra generation - minutes, on a CPU-only local model - so the
 * rejection reason is surfaced through `onRepair`. Without it a two-attempt success and a
 * one-attempt success look identical except for a doubled duration.
 */
export async function generateValidated<S extends z.ZodTypeAny>(
  provider: AIProvider,
  request: AIRequest,
  schema: S,
  maxRepairAttempts = 2,
  onRepair?: (info: RepairInfo) => void,
  /**
   * Optional rule that a schema-valid value must also satisfy, returning a description of what is
   * wrong or null to accept. Constraints a JSON Schema cannot express - "the first step must be a
   * navigation", "the program must assert something" - are invisible to constrained decoding, and
   * Ollama silently ignores `prefixItems` and `contains` rather than enforcing them. Routing those
   * failures back through the repair loop tells the model what it got wrong instead of discarding a
   * generation that already cost minutes.
   */
  check?: (value: z.output<S>) => string | null,
): Promise<StructuredOutcome<z.output<S>>> {
  let latencyMs = 0;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let providerRequestId: string | null = null;
  let lastIssue = "";

  for (let attempt = 1; attempt <= maxRepairAttempts + 1; attempt += 1) {
    const prompt = attempt === 1
      ? request.prompt
      : `${request.prompt}\n\nYour previous response was rejected for these reasons:\n${lastIssue}\n\nReturn corrected JSON that fixes every point above. Return JSON only.`;

    let result: AIResult;
    try {
      result = await provider.complete({ ...request, prompt });
    } catch (error) {
      throw error instanceof AIProviderError ? error : new AIProviderError("AI_PROVIDER_FAILED");
    }

    latencyMs += result.latencyMs;
    if (result.promptTokens !== null) promptTokens = (promptTokens ?? 0) + result.promptTokens;
    if (result.completionTokens !== null) completionTokens = (completionTokens ?? 0) + result.completionTokens;
    providerRequestId = result.providerRequestId ?? providerRequestId;

    const reject = (reason: string) => {
      lastIssue = reason;
      onRepair?.({ attempt, reason, outputChars: result.text.length, completionTokens: result.completionTokens });
    };

    if (result.text.length > MAX_OUTPUT_CHARS) {
      reject("Response exceeded the maximum allowed size.");
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(result.text));
    } catch (error) {
      reject(error instanceof AIProviderError ? error.code : "Response was not valid JSON.");
      continue;
    }

    const validated = schema.safeParse(parsed);
    if (validated.success) {
      const complaint = check?.(validated.data) ?? null;
      if (!complaint) return { value: validated.data, attempts: attempt, latencyMs, promptTokens, completionTokens, providerRequestId };
      reject(complaint);
      continue;
    }
    reject(validated.error.issues.slice(0, 12).map(issue => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n"));
  }

  throw new AIProviderError("AI_OUTPUT_VALIDATION_FAILED", lastIssue.slice(0, 500));
}
