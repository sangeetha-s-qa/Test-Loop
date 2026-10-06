import { z } from "zod";

export const stepSchema = z.object({ step: z.number().int().positive(), action: z.string().trim().min(1).max(500), expectedResult: z.string().trim().min(1).max(500) });
export const refSchema = z.string().trim().max(12).nullable().optional();
export const generatedScenarioSchema = z.object({ title: z.string().trim().min(5).max(200), description: z.string().trim().max(1000).default(""), module: z.string().trim().min(1).max(120), category: z.string().trim().min(1).max(50), priority: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]), risk: z.enum(["HIGH", "MEDIUM", "LOW"]), sourcePageId: refSchema });
export const generatedTestCaseSchema = z.object({ testCaseId: z.string().regex(/^TC-[A-Z0-9-]+$/), title: z.string().trim().min(5).max(200), description: z.string().trim().max(1000).default(""), module: z.string().trim().min(1).max(120), category: z.string().trim().min(1).max(50), priority: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]), severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]), preconditions: z.string().max(1000).default(""), testData: z.record(z.string().max(500)).default({}), steps: z.array(stepSchema).min(1).max(30), expectedResult: z.string().trim().min(1).max(1000), postconditions: z.string().max(1000).default(""), sourcePageId: refSchema, sourceElementId: refSchema });
export const generationOutputSchema = z.object({ scenarios: z.array(generatedScenarioSchema).max(500), testCases: z.array(generatedTestCaseSchema).max(500) });
export type GenerationOutput = z.infer<typeof generationOutputSchema>;

/** A single provider call. `jsonSchema` is a JSON Schema object for providers that support constrained decoding. */
export type AIRequest = { system: string; prompt: string; jsonSchema?: Record<string, unknown>; maxOutputTokens?: number };

/** Result of a provider call. Recorded against every generation run for cost and traceability. */
export type AIResult = { text: string; latencyMs: number; promptTokens: number | null; completionTokens: number | null; providerRequestId: string | null };

export type AIProvider = {
  /** Stable adapter identity persisted with every generated artifact. */
  name: string;
  model: string;
  /** True when the adapter reaches only localhost and contacts no third-party service. */
  local: boolean;
  complete: (request: AIRequest) => Promise<AIResult>;
};

/** Thrown for every provider-layer failure so callers never leak provider internals to clients. */
export class AIProviderError extends Error {
  constructor(
    public readonly code: string,
    /** Optional diagnostic context. Kept out of client responses; safe to log. */
    public readonly detail?: string,
  ) {
    // The code must lead the message: logs and worker failure records read `.message`.
    super(detail ? `${code}: ${detail}` : code);
    this.name = "AIProviderError";
  }
}
