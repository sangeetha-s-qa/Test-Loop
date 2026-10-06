import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Exercises the streaming provider against a real HTTP server that misbehaves in the specific
 * ways a slow local model does: it streams slowly, it goes silent mid-stream, and it emits an
 * error object. These are transport behaviours, so a stub would prove nothing.
 */

let server: http.Server;
let baseUrl = "";
let mode: "ok" | "stall" | "error" | "unterminated" | "slowFirstToken" | "stallAfterOutput" = "ok";

beforeAll(async () => {
  server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    const send = (value: unknown) => response.write(`${JSON.stringify(value)}\n`);

    if (mode === "error") {
      send({ error: "model not found" });
      response.end();
      return;
    }
    if (mode === "stall") {
      // Headers arrive, then nothing ever again - no first token at all.
      return;
    }
    if (mode === "stallAfterOutput") {
      // Output starts and then dies mid-value; the tight inter-chunk budget applies here.
      send({ message: { content: '{"tit' }, done: false });
      return;
    }
    if (mode === "slowFirstToken") {
      // What a CPU-only model actually does: a long silence while it evaluates the prompt and
      // compiles the JSON grammar, then a perfectly good response.
      setTimeout(() => {
        send({ message: { content: '{"title":"slow","count":9}' }, done: true, prompt_eval_count: 677, eval_count: 12 });
        response.end();
      }, 3000);
      return;
    }
    if (mode === "unterminated") {
      // A final object with no trailing newline must still be consumed.
      response.write(JSON.stringify({ message: { content: '{"title":"ok","count":1}' }, done: true, prompt_eval_count: 5, eval_count: 7 }));
      response.end();
      return;
    }
    for (const piece of ['{"title":', '"streamed",', '"count":', "3}"]) send({ message: { content: piece }, done: false });
    send({ done: true, prompt_eval_count: 11, eval_count: 4 });
    response.end();
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.OLLAMA_BASE_URL = baseUrl;
  process.env.AI_PROVIDER = "ollama";
  process.env.AI_MODEL = "test-model";
  // Short enough to keep the test fast; the production default is two minutes.
  process.env.AI_STREAM_STALL_TIMEOUT_MS = "2000";
  // 5s is long enough for the 3s slow-first-token case and short enough to fail fast.
  process.env.AI_STREAM_FIRST_CHUNK_TIMEOUT_MS = "5000";
  process.env.AI_REQUEST_TIMEOUT_MS = "30000";
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

const load = async () => {
  const { createAIProvider } = await import("./provider");
  return createAIProvider();
};

describe("streaming provider", () => {
  it("reassembles a chunked NDJSON response and reports token usage", async () => {
    mode = "ok";
    const result = await (await load()).complete({ system: "s", prompt: "p" });
    expect(result.text).toBe('{"title":"streamed","count":3}');
    expect(result.promptTokens).toBe(11);
    expect(result.completionTokens).toBe(4);
  });

  it("consumes a final object that has no trailing newline", async () => {
    mode = "unterminated";
    const result = await (await load()).complete({ system: "s", prompt: "p" });
    expect(JSON.parse(result.text)).toEqual({ title: "ok", count: 1 });
  });

  it("surfaces a provider error object instead of hanging", async () => {
    mode = "error";
    await expect((await load()).complete({ system: "s", prompt: "p" })).rejects.toThrow("AI_PROVIDER_ERROR");
  });

  it("waits through a slow first token instead of calling it a stall", async () => {
    // Regression: the inter-chunk budget was applied before any output existed, so a model that
    // spent minutes on prompt evaluation was aborted mid-flight as if it had died.
    mode = "slowFirstToken";
    const result = await (await load()).complete({ system: "s", prompt: "p" });
    expect(JSON.parse(result.text)).toEqual({ title: "slow", count: 9 });
    expect(result.promptTokens).toBe(677);
  }, 30_000);

  it("aborts when no first token arrives within the first-chunk budget", async () => {
    mode = "stall";
    const startedAt = Date.now();
    await expect((await load()).complete({ system: "s", prompt: "p" })).rejects.toThrow("AI_PROVIDER_STALLED");
    const elapsed = Date.now() - startedAt;
    // Gives up on the 5s first-token budget, not the 30s overall deadline.
    expect(elapsed).toBeLessThan(15_000);
    expect(elapsed).toBeGreaterThanOrEqual(4_000);
  }, 30_000);

  it("aborts when output starts and then stops", async () => {
    mode = "stallAfterOutput";
    const startedAt = Date.now();
    await expect((await load()).complete({ system: "s", prompt: "p" })).rejects.toThrow("AI_PROVIDER_STALLED");
    const elapsed = Date.now() - startedAt;
    // The tight 2s inter-chunk budget applies once output has begun, not the long first-token one.
    expect(elapsed).toBeLessThan(15_000);
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
  }, 30_000);
});

describe("context window sizing", () => {
  it("grows the window to hold prompt plus requested output", async () => {
    const { chooseContextWindow } = await import("./provider");
    // Ollama's 2048 default cannot hold a 1500-token prompt and a 3072-token output budget.
    expect(chooseContextWindow(4500, 3072)).toBe(8192);
    expect(chooseContextWindow(200, 256)).toBe(2048);
  });

  it("never exceeds the configured ceiling", async () => {
    const { chooseContextWindow } = await import("./provider");
    expect(chooseContextWindow(500_000, 3072, 8192)).toBe(8192);
  });
});
