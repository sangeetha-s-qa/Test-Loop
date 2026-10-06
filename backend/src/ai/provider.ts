import { config } from "../config";
import { AIProviderError, type AIProvider, type AIRequest, type AIResult } from "./types";

/**
 * Maps a transport failure to a provider error. The detail carries the underlying cause code for
 * logs; it is never returned to a client.
 */
function transportError(error: unknown): AIProviderError {
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause?.code;
  if (error instanceof Error && error.name === "TimeoutError") return new AIProviderError("AI_PROVIDER_TIMEOUT", "the configured request timeout elapsed");
  // undici applies its own 300s headers/body timeouts underneath fetch, independent of any
  // AbortSignal. Reporting the cause makes that distinguishable from a genuinely down provider.
  if (cause === "UND_ERR_HEADERS_TIMEOUT" || cause === "UND_ERR_BODY_TIMEOUT") return new AIProviderError("AI_PROVIDER_TIMEOUT", `the provider produced no output in time (${cause})`);
  return new AIProviderError("AI_PROVIDER_UNREACHABLE", cause ?? (error instanceof Error ? error.message : "unknown"));
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(config.AI_REQUEST_TIMEOUT_MS) });
  } catch (error) {
    // Network-level failures must not surface a host, port, or stack trace to the client.
    throw transportError(error);
  }
  if (!response.ok) throw new AIProviderError(`AI_PROVIDER_HTTP_${response.status}`);
  return response;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  const response = await post(url, headers, body);
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    throw transportError(error);
  }
}

/**
 * Reads a newline-delimited JSON stream, calling `onChunk` for each object.
 *
 * A local model can take many minutes to produce its first token. A non-streaming request spends
 * that whole time before any byte arrives, which trips undici's 300s headers timeout regardless of
 * the configured request timeout. Streaming makes headers arrive at once and resets the body
 * timeout on every chunk, so `AI_REQUEST_TIMEOUT_MS` becomes the real ceiling.
 */
async function postNdjson(url: string, headers: Record<string, string>, body: unknown, onChunk: (value: Record<string, unknown>) => void) {
  const controller = new AbortController();
  const deadline = Date.now() + config.AI_REQUEST_TIMEOUT_MS;
  let lastChunkAt = Date.now();
  let firstChunkSeen = false;

  // Waiting for the first token and stalling mid-stream are different failures and need different
  // budgets. A local model evaluates the whole prompt (and compiles the JSON grammar) before it
  // emits anything, which on a CPU-only host legitimately takes minutes; applying the short
  // inter-chunk budget to that window aborts perfectly healthy requests. Once tokens are flowing a
  // gap really does mean something is wrong, so the tight budget applies from then on.
  const stallCheck = setInterval(() => {
    const idleFor = Date.now() - lastChunkAt;
    const budget = firstChunkSeen ? config.AI_STREAM_STALL_TIMEOUT_MS : config.AI_STREAM_FIRST_CHUNK_TIMEOUT_MS;
    if (idleFor > budget || Date.now() > deadline) controller.abort();
  }, 1000);

  try {
    const response = await post(url, headers, body, controller.signal);
    if (!response.body) throw new AIProviderError("AI_EMPTY_RESPONSE");
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      lastChunkAt = Date.now();
      firstChunkSeen = true;
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) onChunk(JSON.parse(line) as Record<string, unknown>);
        newline = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail) onChunk(JSON.parse(tail) as Record<string, unknown>);
  } catch (error) {
    if (controller.signal.aborted) {
      if (Date.now() > deadline) throw new AIProviderError("AI_PROVIDER_TIMEOUT", "the overall request deadline elapsed");
      throw new AIProviderError(
        "AI_PROVIDER_STALLED",
        firstChunkSeen ? `output stopped for ${config.AI_STREAM_STALL_TIMEOUT_MS}ms` : `no first token within ${config.AI_STREAM_FIRST_CHUNK_TIMEOUT_MS}ms`,
      );
    }
    throw error instanceof AIProviderError ? error : transportError(error);
  } finally {
    clearInterval(stallCheck);
  }
}

/**
 * Chooses the context window for one request.
 *
 * Ollama defaults to a 2048-token window regardless of what the model supports, and it truncates
 * silently - a 9000-token prompt reports `prompt_eval_count` of 2050 with no error. The prompt and
 * the generated output share that window, so a large output budget is unreachable unless the window
 * is set to hold both. Left at the default, the discovered page evidence was being cut off the end
 * of the automation prompt and the model invented selectors for elements it could no longer see.
 *
 * Three characters per token is deliberately conservative: this payload is JSON containing ids and
 * URLs, which tokenize far denser than prose, and under-sizing the window truncates real input.
 */
export function chooseContextWindow(charCount: number, maxOutputTokens: number, ceiling = config.AI_MAX_CONTEXT_TOKENS) {
  const needed = Math.ceil(charCount / 3) + maxOutputTokens + 512;
  let window = 2048;
  while (window < needed && window < ceiling) window *= 2;
  return Math.min(window, ceiling);
}

function ollama(): AIProvider {
  const model = config.AI_MODEL ?? "qwen2.5:7b-instruct";
  return {
    name: "ollama",
    model,
    local: true,
    complete: async (request: AIRequest): Promise<AIResult> => {
      const startedAt = Date.now();
      let text = "";
      let promptTokens: number | null = null;
      let completionTokens: number | null = null;
      const maxOutputTokens = request.maxOutputTokens ?? 8192;
      const numCtx = chooseContextWindow(request.system.length + request.prompt.length, maxOutputTokens);

      await postNdjson(`${config.OLLAMA_BASE_URL}/api/chat`, {}, {
        model,
        // Streamed so a slow local model cannot trip undici's own header timeout. See postNdjson.
        stream: true,
        // Ollama constrains decoding to the supplied JSON Schema, which removes most repair rounds.
        format: request.jsonSchema ?? "json",
        options: { temperature: 0.2, num_predict: maxOutputTokens, num_ctx: numCtx },
        messages: [{ role: "system", content: request.system }, { role: "user", content: request.prompt }],
      }, chunk => {
        if (chunk.error) throw new AIProviderError("AI_PROVIDER_ERROR", String(chunk.error).slice(0, 200));
        text += (chunk.message as { content?: string } | undefined)?.content ?? "";
        if (typeof chunk.prompt_eval_count === "number") promptTokens = chunk.prompt_eval_count;
        if (typeof chunk.eval_count === "number") completionTokens = chunk.eval_count;
      });

      if (!text) throw new AIProviderError("AI_EMPTY_RESPONSE");
      // Truncation is silent, so the only evidence is the prompt filling the window exactly. Losing
      // the tail of the prompt means the model answered without the page evidence, which is worth
      // surfacing loudly rather than shipping a confidently wrong program.
      if (promptTokens !== null && promptTokens >= numCtx - 8) {
        console.warn(JSON.stringify({ event: "ai-provider.prompt_truncated", model, promptTokens, numCtx, maxOutputTokens }));
      }
      return { text, latencyMs: Date.now() - startedAt, promptTokens, completionTokens, providerRequestId: null };
    },
  };
}

function openAI(): AIProvider {
  const apiKey = config.OPENAI_API_KEY;
  if (!apiKey) throw new AIProviderError("AI_PROVIDER_NOT_CONFIGURED");
  const model = config.AI_MODEL ?? "gpt-4.1-mini";
  return {
    name: "openai",
    model,
    local: false,
    complete: async (request: AIRequest): Promise<AIResult> => {
      const startedAt = Date.now();
      const payload = await postJson("https://api.openai.com/v1/chat/completions", { authorization: `Bearer ${apiKey}` }, {
        model,
        temperature: 0.2,
        max_tokens: request.maxOutputTokens ?? 8192,
        response_format: request.jsonSchema ? { type: "json_schema", json_schema: { name: "output", strict: false, schema: request.jsonSchema } } : { type: "json_object" },
        messages: [{ role: "system", content: request.system }, { role: "user", content: request.prompt }],
      });
      const text = (payload.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content;
      if (!text) throw new AIProviderError("AI_EMPTY_RESPONSE");
      const usage = payload.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      return { text, latencyMs: Date.now() - startedAt, promptTokens: usage?.prompt_tokens ?? null, completionTokens: usage?.completion_tokens ?? null, providerRequestId: typeof payload.id === "string" ? payload.id : null };
    },
  };
}

function anthropic(): AIProvider {
  const apiKey = config.ANTHROPIC_API_KEY;
  if (!apiKey) throw new AIProviderError("AI_PROVIDER_NOT_CONFIGURED");
  const model = config.AI_MODEL ?? "claude-haiku-4-5-20251001";
  return {
    name: "anthropic",
    model,
    local: false,
    complete: async (request: AIRequest): Promise<AIResult> => {
      const startedAt = Date.now();
      const payload = await postJson("https://api.anthropic.com/v1/messages", { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, {
        model,
        max_tokens: request.maxOutputTokens ?? 8192,
        temperature: 0.2,
        system: request.system,
        messages: [{ role: "user", content: request.prompt }],
      });
      const text = (payload.content as { text?: string }[] | undefined)?.[0]?.text;
      if (!text) throw new AIProviderError("AI_EMPTY_RESPONSE");
      const usage = payload.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      return { text, latencyMs: Date.now() - startedAt, promptTokens: usage?.input_tokens ?? null, completionTokens: usage?.output_tokens ?? null, providerRequestId: typeof payload.id === "string" ? payload.id : null };
    },
  };
}

/**
 * Deterministic adapter for tests. It returns nothing usable on its own; a test supplies the
 * response through `setMockResponse`, so it can never masquerade as a real model result.
 */
let mockResponse: string | null = null;
export function setMockResponse(value: string | null) { mockResponse = value; }

function mock(): AIProvider {
  return {
    name: "mock",
    model: config.AI_MODEL ?? "mock",
    local: true,
    complete: async (): Promise<AIResult> => {
      if (mockResponse === null) throw new AIProviderError("AI_MOCK_RESPONSE_NOT_SET");
      return { text: mockResponse, latencyMs: 0, promptTokens: null, completionTokens: null, providerRequestId: null };
    },
  };
}

export function createAIProvider(): AIProvider {
  switch (config.AI_PROVIDER) {
    case "ollama": return ollama();
    case "openai": return openAI();
    case "anthropic": return anthropic();
    case "mock": return mock();
    default: throw new AIProviderError("AI_PROVIDER_NOT_CONFIGURED");
  }
}

/**
 * Verifies the configured provider is actually reachable and that the configured model exists.
 * Used by the API before queueing work so the user gets an actionable message instead of a
 * job that fails minutes later inside a worker.
 */
export async function checkProviderReady(): Promise<{ ready: true } | { ready: false; code: string; detail: string }> {
  let provider: AIProvider;
  try {
    provider = createAIProvider();
  } catch (error) {
    return { ready: false, code: error instanceof AIProviderError ? error.code : "AI_PROVIDER_NOT_CONFIGURED", detail: "Set AI_PROVIDER and the matching credentials or local endpoint." };
  }
  if (provider.name !== "ollama") return { ready: true };
  try {
    const response = await fetch(`${config.OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { ready: false, code: "AI_PROVIDER_UNREACHABLE", detail: "Ollama did not respond successfully." };
    const models = ((await response.json()) as { models?: { name?: string }[] }).models ?? [];
    if (!models.some(entry => entry.name === provider.model || entry.name?.split(":")[0] === provider.model.split(":")[0])) {
      return { ready: false, code: "AI_MODEL_NOT_INSTALLED", detail: `Ollama is running but the model "${provider.model}" is not installed. Run: ollama pull ${provider.model}` };
    }
    return { ready: true };
  } catch {
    return { ready: false, code: "AI_PROVIDER_UNREACHABLE", detail: `Ollama is not reachable at ${config.OLLAMA_BASE_URL}. Start it with: ollama serve` };
  }
}
