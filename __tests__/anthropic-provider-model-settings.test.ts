/**
 * AnthropicProvider — per-model request settings and response handling.
 *
 * The standard tier (Sonnet 5.5) rejects `temperature` and thinks by default; the fast tier
 * (Haiku 4.5) takes `temperature` and no `thinking`. Covers what the provider sends to each,
 * that thinking blocks never reach the caller, and that a safety decline surfaces as an error.
 */

jest.mock("@/lib/logger", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { AnthropicProvider, AIProviderError } from "@/platform/ai/provider";
import type { AIRequest, AIStreamChunk } from "@/platform/ai/types";

const originalFetch = global.fetch;
let sentBodies: Record<string, unknown>[] = [];

function mockFetch(respond: (body: Record<string, unknown>) => unknown) {
  sentBodies = [];
  global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sentBodies.push(body);
    return respond(body) as Response;
  }) as unknown as typeof fetch;
}

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data };
}

function sseResponse(events: unknown[]) {
  const enc = new TextEncoder();
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n`).join("");
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(text));
      controller.close();
    },
  });
  return { ok: true, status: 200, body };
}

const REPLY = {
  content: [{ type: "text", text: "ok" }],
  usage: { input_tokens: 5, output_tokens: 1 },
  stop_reason: "end_turn",
};

function request(tier: AIRequest["tier"]): AIRequest {
  return {
    tier,
    maxTokens: 256,
    temperature: 0.1,
    messages: [{ role: "user", content: "hi" }],
  };
}

async function drain(stream: AsyncIterable<AIStreamChunk>): Promise<AIStreamChunk[]> {
  const chunks: AIStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

afterAll(() => {
  global.fetch = originalFetch;
});

describe("request settings per tier", () => {
  beforeEach(() => mockFetch(() => jsonResponse(REPLY)));

  it("standard tier: Sonnet 5.5, no temperature, thinking off", async () => {
    await new AnthropicProvider("k").complete(request("standard"));
    expect(sentBodies[0].model).toBe("claude-sonnet-5-5");
    expect(sentBodies[0]).not.toHaveProperty("temperature");
    expect(sentBodies[0].thinking).toEqual({ type: "between_tools" });
  });

  it("fast tier: keeps temperature, sends no thinking", async () => {
    await new AnthropicProvider("k").complete(request("fast"));
    expect(sentBodies[0].temperature).toBe(0.1);
    expect(sentBodies[0]).not.toHaveProperty("thinking");
  });

  it("stream on the standard tier drops temperature and turns thinking off", async () => {
    mockFetch(() =>
      sseResponse([{ type: "message_start", message: { usage: { input_tokens: 1 } } }])
    );
    await drain(
      new AnthropicProvider("k").stream(request("standard"), { temperature: 0.4 })
    );
    expect(sentBodies[0]).not.toHaveProperty("temperature");
    expect(sentBodies[0].thinking).toEqual({ type: "between_tools" });
  });
});

describe("response handling", () => {
  it("complete() leaves thinking blocks out of the content", async () => {
    mockFetch(() =>
      jsonResponse({
        ...REPLY,
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "redacted_thinking", data: "x" },
          { type: "text", text: "answer" },
        ],
      })
    );
    const res = await new AnthropicProvider("k").complete(request("standard"));
    expect(res.content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("complete() throws a permanent error on a refusal", async () => {
    mockFetch(() => jsonResponse({ ...REPLY, content: [], stop_reason: "refusal" }));
    const call = new AnthropicProvider("k").complete(request("standard"));
    await expect(call).rejects.toBeInstanceOf(AIProviderError);
    await expect(call).rejects.toMatchObject({ kind: "permanent" });
  });

  it("stream() yields only reply text, not thinking deltas", async () => {
    mockFetch(() =>
      sseResponse([
        { type: "message_start", message: { usage: { input_tokens: 1 } } },
        {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "hmm" },
        },
        { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ])
    );
    const chunks = await drain(new AnthropicProvider("k").stream(request("standard")));
    expect(chunks.filter((c) => !c.done).map((c) => c.text)).toEqual(["Hi"]);
  });

  it("stream() throws a permanent error on a refusal", async () => {
    mockFetch(() =>
      sseResponse([
        { type: "message_start", message: { usage: { input_tokens: 1 } } },
        {
          type: "message_delta",
          delta: { stop_reason: "refusal" },
          usage: { output_tokens: 0 },
        },
        { type: "message_stop" },
      ])
    );
    await expect(
      drain(new AnthropicProvider("k").stream(request("standard")))
    ).rejects.toMatchObject({ kind: "permanent" });
  });
});
