/**
 * AIProvider contract — Anthropic reference arm (ADR-027).
 *
 * Runs the synced AIProvider conformance kit against the real AnthropicProvider.
 * complete() is stubbed with a Messages-API JSON response; stream() is exercised
 * against a real SSE ReadableStream (message_start / content_block_delta /
 * message_delta / message_stop). Single synced arm.
 */

jest.mock("@/lib/logger", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { runAIProviderContract } from "./contract/ai-provider-contract";
import { AnthropicProvider } from "@/platform/ai/provider";

function completeResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: "text", text: "Hello!" }],
      model: "claude-test",
      usage: { input_tokens: 5, output_tokens: 3 },
      stop_reason: "end_turn",
    }),
  };
}

function sseResponse() {
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 5 } } },
    { type: "content_block_delta", delta: { text: "Hello" } },
    { type: "message_delta", usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
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

const originalFetch = global.fetch;

beforeAll(() => {
  const fetchMock = jest.fn(
    async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as { stream?: boolean })
        : {};
      if (body.stream) return sseResponse() as unknown as Response;
      return completeResponse() as unknown as Response;
    }
  );
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe("AIProvider contract — Anthropic (PF reference impl)", () => {
  runAIProviderContract({
    makeProvider: () => new AnthropicProvider("test-key"),
  });
});
