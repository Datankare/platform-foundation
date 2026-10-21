/**
 * /api/stream — caller verification, server-side bounds, screening and coded errors (TASK-133)
 */

import { POST } from "@/app/api/stream/route";
import { NextRequest } from "next/server";
import { registerAuthProvider } from "@/platform/auth/config";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";
import { mintGuestToken } from "@/platform/auth/guest-token";
import { checkSafety } from "@/lib/safety";
import { getOrchestrator } from "@/platform/ai/orchestrator";
import {
  STREAM_MAX_PROMPT_CHARACTERS,
  STREAM_MAX_TOKENS,
} from "@/platform/ai/stream-policy";

jest.mock("@/lib/safety", () => ({
  checkSafety: jest.fn().mockResolvedValue({ safe: true }),
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

let userToken = "";

beforeAll(async () => {
  const mock = createMockAuthProvider();
  registerAuthProvider(mock);
  userToken = (await mock.signIn("a@b.c", "x")).accessToken ?? "";
});

beforeEach(() => {
  streamMock.mockReset();
  streamMock.mockImplementation(async function* () {
    yield { text: "Hel", done: false };
    yield { text: "lo", done: true };
  });
  (checkSafety as jest.Mock).mockClear();
  (checkSafety as jest.Mock).mockResolvedValue({ safe: true });
  (getOrchestrator as jest.Mock).mockClear();
});

function req(body: unknown, auth: string | null = `Bearer ${userToken}`): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) headers.authorization = auth;
  return new NextRequest("http://localhost:3000/api/stream", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function code(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { code?: string }).code;
}

describe("/api/stream — caller verification", () => {
  it("refuses a request with no credentials", async () => {
    const res = await POST(req({ prompt: "hi" }, null));
    expect(res.status).toBe(401);
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("refuses a bearer value that is not a valid token", async () => {
    const res = await POST(req({ prompt: "hi" }, "Bearer not-a-real-token"));
    expect(res.status).toBe(401);
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("refuses a guest — streaming is for signed-in users", async () => {
    const guest = await mintGuestToken();
    const res = await POST(req({ prompt: "hi" }, `Bearer ${guest.token}`));
    expect(res.status).toBe(401);
    expect(await code(res)).toBe("auth.sign_in_required");
    expect(streamMock).not.toHaveBeenCalled();
  });
});

describe("/api/stream — server-side bounds", () => {
  it.each([
    ["invalid JSON", "{not json", "request.invalid_json"],
    ["a non-object body", "[1,2]", "request.invalid_body"],
    ["an empty prompt", { prompt: "  " }, "request.text_empty"],
    [
      "an over-long prompt",
      { prompt: "x".repeat(STREAM_MAX_PROMPT_CHARACTERS + 1) },
      "request.text_too_long",
    ],
    ["an unknown tier", { prompt: "hi", tier: "premium" }, "request.invalid_value"],
    [
      "maxTokens above the bound",
      { prompt: "hi", maxTokens: STREAM_MAX_TOKENS + 1 },
      "request.invalid_value",
    ],
    ["maxTokens below one", { prompt: "hi", maxTokens: 0 }, "request.invalid_value"],
    [
      "a fractional maxTokens",
      { prompt: "hi", maxTokens: 10.5 },
      "request.invalid_value",
    ],
    [
      "temperature out of range",
      { prompt: "hi", temperature: 2 },
      "request.invalid_value",
    ],
    ["a non-text system prompt", { prompt: "hi", system: 42 }, "request.invalid_value"],
  ])("refuses %s with a coded 400", async (_label, body, expected) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect(await code(res)).toBe(expected);
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("applies the default tier and the token bound when the caller sends neither", async () => {
    const res = await POST(req({ prompt: "hi" }));
    await res.text();
    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "standard", maxTokens: STREAM_MAX_TOKENS }),
      expect.objectContaining({ useCase: "api-stream" })
    );
  });
});

describe("/api/stream — screening and streaming", () => {
  it("screens the prompt and the system prompt before any model call", async () => {
    (checkSafety as jest.Mock).mockResolvedValue({ safe: false, reason: "blocked term" });
    const res = await POST(req({ prompt: "hi", system: "be terse" }));
    expect(res.status).toBe(422);
    expect(await code(res)).toBe("content.rejected");
    expect(checkSafety).toHaveBeenCalledWith("be terse\nhi");
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("streams the model's chunks as server-sent events", async () => {
    const res = await POST(
      req({ prompt: "hi", tier: "fast", maxTokens: 64, temperature: 0.2 })
    );
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"text":"Hel"');
    expect(text).toContain("data: [DONE]");
    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "fast", maxTokens: 64, temperature: 0.2 }),
      expect.anything()
    );
  });

  it("reports an upstream failure by code, without its message", async () => {
    streamMock.mockImplementation(async function* () {
      yield { text: "", done: false };
      throw new Error("upstream secret detail: key sk-123");
    });
    const res = await POST(req({ prompt: "hi" }));
    const text = await res.text();
    expect(text).toContain('"code":"internal.error"');
    expect(text).not.toContain("upstream secret detail");
  });
});
