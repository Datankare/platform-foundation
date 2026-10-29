/**
 * AnthropicProvider — per-model request settings and response handling.
 *
 * The standard tier (Sonnet 5.5) rejects `temperature` and thinks by default; the fast tier
 * (Haiku 4.5) takes `temperature` and no `thinking`. Covers what the provider sends to each,
 * that thinking blocks are kept opaque and passed back unmodified in a tool loop (TASK-186), that
 * a safety decline surfaces as an AIRefusalError, and that prompt caching marks only a fixed
 * `cacheablePrefix` — never `system`, which may carry a tenant's context, or the messages.
 */

jest.mock("@/lib/logger", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  AnthropicProvider,
  AIProviderError,
  AIRefusalError,
} from "@/platform/ai/provider";
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
  it("complete() keeps thinking blocks opaque, apart from the reply text", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig" };
    const redacted = { type: "redacted_thinking", data: "x" };
    mockFetch(() =>
      jsonResponse({
        ...REPLY,
        content: [thinking, redacted, { type: "text", text: "answer" }],
      })
    );
    const res = await new AnthropicProvider("k").complete(request("standard"));
    expect(res.content).toEqual([
      { type: "thinking", raw: thinking },
      { type: "thinking", raw: redacted },
      { type: "text", text: "answer" },
    ]);
    // Never rendered: the reply text a caller reads is the text blocks alone.
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    expect(text).toBe("answer");
  });

  it("a tool loop passes the assistant turn's thinking back unmodified, before its tool_use", async () => {
    // Sonnet 5.5 thinks between tools: the API needs the signed blocks back, byte for byte.
    const thinking = {
      type: "thinking",
      thinking: "check the table",
      signature: "c2ln/+=",
    };
    const redacted = { type: "redacted_thinking", data: "ENCRYPTED==" };
    const toolUse = { type: "tool_use", id: "tu_1", name: "lookup", input: { q: "x" } };
    let call = 0;
    mockFetch(() =>
      jsonResponse(
        call++ === 0
          ? { ...REPLY, content: [thinking, redacted, toolUse], stop_reason: "tool_use" }
          : REPLY
      )
    );
    const provider = new AnthropicProvider("k");
    const first = await provider.complete(request("standard"));
    await provider.complete({
      ...request("standard"),
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: first.content },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "42" }],
        },
      ],
    });
    const sent = sentBodies[1].messages as { role: string; content: unknown }[];
    expect(sent[1]).toEqual({
      role: "assistant",
      content: [thinking, redacted, toolUse],
    });
  });

  it.each([
    [
      "an image smuggled in raw",
      "assistant",
      { type: "image", source: { type: "url", url: "x" } },
    ],
    [
      "a tool_result in raw",
      "assistant",
      { type: "tool_result", tool_use_id: "t", content: "x" },
    ],
    ["no type", "assistant", { thinking: "t" }],
    ["not an object", "assistant", "thinking"],
    [
      "a thinking block in a user turn",
      "user",
      { type: "thinking", thinking: "t", signature: "s" },
    ],
  ])(
    "refuses a thinking block carrying %s — nothing is sent",
    async (_what, role, raw) => {
      mockFetch(() => jsonResponse(REPLY));
      const call = new AnthropicProvider("k").complete({
        ...request("standard"),
        messages: [
          { role: "user", content: "hi" },
          {
            role: role as "user" | "assistant",
            content: [{ type: "thinking", raw: raw as Record<string, unknown> }],
          },
          { role: "user", content: "go on" },
        ],
      });
      await expect(call).rejects.toBeInstanceOf(AIProviderError);
      expect(sentBodies).toHaveLength(0);
    }
  );

  it("stream() passes thinking blocks back unmodified too", async () => {
    const thinking = { type: "thinking", thinking: "t", signature: "s" };
    mockFetch(() =>
      sseResponse([{ type: "message_start", message: { usage: { input_tokens: 1 } } }])
    );
    await drain(
      new AnthropicProvider("k").stream({
        ...request("standard"),
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "thinking", raw: thinking }] },
          { role: "user", content: "go on" },
        ],
      })
    );
    const sent = sentBodies[0].messages as { content: unknown }[];
    expect(sent[1].content).toEqual([thinking]);
  });

  it("a refusal carries what it was billed for (complete and stream)", async () => {
    mockFetch(() =>
      jsonResponse({
        ...REPLY,
        content: [],
        stop_reason: "refusal",
        usage: {
          input_tokens: 812,
          output_tokens: 2,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 7,
        },
      })
    );
    const err = await new AnthropicProvider("k")
      .complete(request("standard"))
      .catch((e) => e);
    expect(err).toBeInstanceOf(AIRefusalError);
    expect(err.usage).toEqual({
      inputTokens: 812,
      outputTokens: 2,
      cacheReadTokens: 50,
      cacheWriteTokens: 7,
    });
    expect(err.model).toBe("claude-sonnet-5-5");

    mockFetch(() =>
      sseResponse([
        {
          type: "message_start",
          message: { usage: { input_tokens: 40, cache_read_input_tokens: 9 } },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "refusal" },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ])
    );
    const serr = await drain(
      new AnthropicProvider("k").stream(request("standard"))
    ).catch((e) => e);
    expect(serr).toBeInstanceOf(AIRefusalError);
    expect(serr.usage).toEqual({
      inputTokens: 40,
      outputTokens: 1,
      cacheReadTokens: 9,
      cacheWriteTokens: 0,
    });
  });

  it("complete() throws a permanent error on a refusal", async () => {
    mockFetch(() => jsonResponse({ ...REPLY, content: [], stop_reason: "refusal" }));
    const call = new AnthropicProvider("k").complete(request("standard"));
    await expect(call).rejects.toBeInstanceOf(AIRefusalError);
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
    ).rejects.toBeInstanceOf(AIRefusalError);
  });
});

describe("prompt caching (opt-in)", () => {
  const TOOLS = [
    { name: "a", description: "A", input_schema: { type: "object" } },
    { name: "b", description: "B", input_schema: { type: "object" } },
  ];

  beforeEach(() => mockFetch(() => jsonResponse(REPLY)));

  it("off by default: system and tools are sent exactly as before, with no cache marker", async () => {
    await new AnthropicProvider("k").complete({
      ...request("standard"),
      system: "rules",
      tools: TOOLS,
    });
    expect(sentBodies[0].system).toBe("rules");
    expect(JSON.stringify(sentBodies[0])).not.toContain("cache_control");
  });

  it("stream is off by default too", async () => {
    mockFetch(() =>
      sseResponse([{ type: "message_start", message: { usage: { input_tokens: 1 } } }])
    );
    await drain(
      new AnthropicProvider("k").stream({ ...request("standard"), system: "rules" })
    );
    expect(sentBodies[0].system).toBe("rules");
    expect(JSON.stringify(sentBodies[0])).not.toContain("cache_control");
  });

  it("on: marks the end of the fixed prefix only — never system, the tools or the messages", async () => {
    await new AnthropicProvider("k").complete({
      ...request("standard"),
      cacheablePrefix: "fixed rules",
      system: "per-request part",
      tools: TOOLS,
      promptCache: true,
    });
    expect(sentBodies[0].system).toEqual([
      { type: "text", text: "fixed rules", cache_control: { type: "ephemeral" } },
      { type: "text", text: "per-request part" },
    ]);
    expect(JSON.stringify(sentBodies[0].tools)).not.toContain("cache_control");
    expect(JSON.stringify(sentBodies[0].messages)).not.toContain("cache_control");
  });

  it("a system prompt carrying tenant context cannot enable it: no prefix, nothing cached", async () => {
    // The admin command bar's shape: the system prompt is built per tenant and panel.
    const tenantSystem =
      "You are the admin assistant for tenant acme-corp (id 7f3c…). Users: 1,204.";
    await new AnthropicProvider("k").complete({
      ...request("standard"),
      system: tenantSystem,
      tools: TOOLS,
      promptCache: true,
    });
    expect(sentBodies[0].system).toBe(tenantSystem);
    expect(JSON.stringify(sentBodies[0])).not.toContain("cache_control");
  });

  it("…nor with a prefix: the tenant's part is sent after the breakpoint, uncached", async () => {
    const tenantSystem = "Tenant: acme-corp. Plan: enterprise.";
    await new AnthropicProvider("k").complete({
      ...request("standard"),
      cacheablePrefix: "fixed rules",
      system: tenantSystem,
      promptCache: true,
    });
    const blocks = sentBodies[0].system as Record<string, unknown>[];
    const cached = blocks.filter((b) => "cache_control" in b);
    expect(cached).toEqual([
      { type: "text", text: "fixed rules", cache_control: { type: "ephemeral" } },
    ]);
    expect(blocks[blocks.length - 1]).toEqual({ type: "text", text: tenantSystem });
  });

  it("without a system prompt or prefix: tools alone are never marked", async () => {
    await new AnthropicProvider("k").complete({
      ...request("standard"),
      tools: TOOLS,
      promptCache: true,
    });
    expect(JSON.stringify(sentBodies[0])).not.toContain("cache_control");
  });

  it("a prefix with the flag off is sent uncached", async () => {
    await new AnthropicProvider("k").complete({
      ...request("standard"),
      cacheablePrefix: "fixed rules",
      system: "rest",
    });
    expect(sentBodies[0].system).toEqual([
      { type: "text", text: "fixed rules" },
      { type: "text", text: "rest" },
    ]);
    expect(JSON.stringify(sentBodies[0])).not.toContain("cache_control");
  });

  it("reports cache reads and writes from the API's usage", async () => {
    mockFetch(() =>
      jsonResponse({
        ...REPLY,
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          cache_read_input_tokens: 600,
          cache_creation_input_tokens: 0,
        },
      })
    );
    const res = await new AnthropicProvider("k").complete(request("standard"));
    expect(res.usage).toMatchObject({ cacheReadTokens: 600, cacheWriteTokens: 0 });
  });
});
