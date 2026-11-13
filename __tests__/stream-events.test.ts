/**
 * __tests__/stream-events.test.ts — the stream hook's reading of /api/stream, driven by the real
 * route (TASK-204, N-45)
 *
 * The events come from the route handler itself (the model is the only double), so the hook's
 * reader is held to what the route sends: text appended, a coded end as an error, and an answer
 * cut off at its token limit reported as truncated with the catalog's notice — never as complete.
 */
import { POST } from "@/app/api/stream/route";
import { sessionHeadersFor } from "@/__tests__/helpers/session";
import { NextRequest } from "next/server";
import { registerAuthProvider } from "@/platform/auth/config";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";
import { renderMessage } from "@/platform/errors/messages";
import { consumeStreamEvents } from "@/hooks/stream-events";

jest.mock("@/lib/safety", () => ({
  checkSafety: jest.fn().mockResolvedValue({ safe: true }),
  checkOutputSafety: jest.fn().mockResolvedValue({ safe: true }),
}));
jest.mock("@/platform/auth/account-status-guard", () => ({
  checkAccountStatus: jest
    .fn()
    .mockResolvedValue({ allowed: true, accountStatus: "active", feature: "stream" }),
}));
const streamMock = jest.fn();
jest.mock("@/platform/ai/orchestrator", () => ({
  getOrchestrator: jest.fn(() => ({ stream: streamMock })),
}));

let token = "";
beforeAll(async () => {
  const mock = createMockAuthProvider();
  registerAuthProvider(mock);
  token = (await mock.signIn("a@b.c", "x")).accessToken ?? "";
});

async function read() {
  const res = await POST(
    new NextRequest("http://localhost:3000/api/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await sessionHeadersFor(token, { origin: "http://localhost:3000" })),
      },
      body: JSON.stringify({ prompt: "hi", maxTokens: 64 }),
    })
  );
  const seen = { text: "", errors: [] as string[], truncated: [] as string[] };
  await consumeStreamEvents(res.body as ReadableStream<Uint8Array>, {
    onText: (t) => (seen.text += t),
    onError: (m) => seen.errors.push(m),
    onTruncated: (n) => seen.truncated.push(n),
  });
  return seen;
}

// Hostile cases (REVIEW.md 3): this reads the route's events; its callers are stream-api's.
// hostile:role n/a: the caller's role is the route's test (stream-api.test.ts, a guest refused)
// hostile:self n/a: a streamed answer names no account, so there is no self to act on
// hostile:store-down n/a: the screen failing is stream-api's test; here a coded end is read
// hostile:id-spelling n/a: the route takes no id, only the caller's prompt and tier

describe("consumeStreamEvents over the route's own events", () => {
  it("a complete answer: its text, nothing truncated", async () => {
    streamMock.mockImplementation(async function* () {
      yield { text: "Hel", done: false };
      yield { text: "lo", done: true, stopReason: "end_turn" };
    });
    expect(await read()).toEqual({ text: "Hello", errors: [], truncated: [] });
  });

  it("an answer cut off at max_tokens is reported truncated, with the catalog's notice", async () => {
    streamMock.mockImplementation(async function* () {
      yield { text: "Half an ans", done: false };
      yield { text: "", done: true, stopReason: "max_tokens" };
    });
    expect(await read()).toEqual({
      text: "Half an ans",
      errors: [],
      truncated: [renderMessage("screens.stream.truncated")],
    });
  });

  it("[hostile] a coded end is an error, not text", async () => {
    streamMock.mockImplementation(async function* () {
      yield { text: "partial", done: false };
      throw new Error("upstream");
    });
    const seen = await read();
    expect(seen.errors).toHaveLength(1);
    expect(seen.truncated).toEqual([]);
  });

  it("[hostile] skips lines that do not parse, [DONE], non-objects and a truncated flag without a notice", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          enc.encode(
            'data: {"text":"a"}\n\ndata: not json\n\ndata: 7\n\ndata: {"truncated":true}\n\n'
          )
        );
        c.enqueue(enc.encode('data: {"te'));
        c.enqueue(enc.encode('xt":"b"}\n\ndata: [DONE]\n\n'));
        c.close();
      },
    });
    const seen: string[] = [];
    const cut: string[] = [];
    await consumeStreamEvents(body, {
      onText: (t) => seen.push(t),
      onError: () => seen.push("ERR"),
      onTruncated: (n) => cut.push(n),
    });
    expect(seen).toEqual(["a", "b"]);
    expect(cut).toEqual([]);
  });
});
