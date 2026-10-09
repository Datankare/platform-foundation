import { POST } from "@/app/api/process/route";
import { NextRequest } from "next/server";
import { registerAuthProvider } from "@/platform/auth/config";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";
import { mintGuestToken } from "@/platform/auth/guest-token";
import {
  MemoryGuestUsageStore,
  setGuestUsageStore,
  type GuestUsageStore,
} from "@/platform/auth/guest-allowance";
import { checkSafety } from "@/lib/safety";
import { getConfig } from "@/platform/auth/platform-config";

jest.mock("@/lib/safety", () => ({
  checkSafety: jest.fn().mockResolvedValue({ safe: true }),
}));

jest.mock("@/lib/translate", () => ({
  translateToAllLanguages: jest.fn().mockResolvedValue([
    { code: "en", language: "English", flag: "🇺🇸", translated: "Hello world" },
    { code: "hi", language: "Hindi", flag: "🇮🇳", translated: "नमस्ते दुनिया" },
    { code: "es", language: "Spanish", flag: "🇪🇸", translated: "Hola mundo" },
  ]),
}));

jest.mock("@/lib/tts", () => ({
  textToSpeech: jest.fn().mockResolvedValue("base64audio=="),
}));

jest.mock("@/platform/auth/account-status-guard", () => ({
  checkAccountStatus: jest
    .fn()
    .mockResolvedValue({ allowed: true, accountStatus: "active", feature: "translate" }),
}));

jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: jest.fn(),
}));

const mockGetConfig = getConfig as jest.MockedFunction<typeof getConfig>;
let userToken = "";

beforeAll(async () => {
  const mock = createMockAuthProvider();
  registerAuthProvider(mock);
  userToken = (await mock.signIn("a@b.c", "x")).accessToken ?? "";
});

beforeEach(() => {
  setGuestUsageStore(new MemoryGuestUsageStore());
  mockGetConfig.mockReset();
  mockGetConfig.mockResolvedValue(5 as never);
  (checkSafety as jest.Mock).mockClear();
});

function makeRequest(body: unknown, token: string | null = userToken): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest("http://localhost:3000/api/process", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/process", () => {
  it("returns 400 for missing text", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty text", async () => {
    const res = await POST(makeRequest({ text: "   " }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for text over 100 chars", async () => {
    const res = await POST(makeRequest({ text: "a".repeat(101) }));
    expect(res.status).toBe(400);
  });

  it("returns 200 with translations for valid text", async () => {
    const res = await POST(makeRequest({ text: "hello world" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.translations).toHaveLength(3);
    expect(res.headers.get("X-Guest-Translations-Remaining")).toBeNull();
  });

  it("returns error when safety check fails", async () => {
    (checkSafety as jest.Mock).mockResolvedValueOnce({
      safe: false,
      reason: "inappropriate content",
    });
    const res = await POST(makeRequest({ text: "unsafe content" }));
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.code).toBe("content.rejected");
    expect(JSON.stringify(data)).not.toContain("inappropriate content");
  });

  it("returns translations with audio", async () => {
    const res = await POST(makeRequest({ text: "hello" }));
    const data = await res.json();
    data.translations.forEach((t: { audioBase64: string }) => {
      expect(t.audioBase64).toBe("base64audio==");
    });
  });
});

describe("POST /api/process — actors and the guest allowance (ADR-050 D4)", () => {
  it("refuses an anonymous request before any paid call", async () => {
    const res = await POST(makeRequest({ text: "hello" }, null));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth.required");
    expect(checkSafety).not.toHaveBeenCalled();
  });

  it("serves a guest up to the allowance, then asks them to sign in", async () => {
    mockGetConfig.mockResolvedValue(2 as never);
    const { token } = await mintGuestToken();

    const first = await POST(makeRequest({ text: "hello" }, token));
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Guest-Translations-Remaining")).toBe("1");

    const second = await POST(makeRequest({ text: "hello" }, token));
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Guest-Translations-Remaining")).toBe("0");

    (checkSafety as jest.Mock).mockClear();
    const third = await POST(makeRequest({ text: "hello" }, token));
    expect(third.status).toBe(403);
    const body = await third.json();
    expect(body.code).toBe("guest.allowance_exhausted");
    expect(body.params).toEqual({ limit: 2 });
    expect(body.message).toBe(
      "You've used all 2 free translations. Sign in to keep translating."
    );
    expect(checkSafety).not.toHaveBeenCalled();
  });

  it("an invalid request does not spend the allowance", async () => {
    mockGetConfig.mockResolvedValue(1 as never);
    const { token } = await mintGuestToken();
    expect((await POST(makeRequest({ text: "   " }, token))).status).toBe(400);
    expect((await POST(makeRequest({ text: "hello" }, token))).status).toBe(200);
  });

  it("clamps a governed value outside 1–10", async () => {
    mockGetConfig.mockResolvedValue(0 as never);
    const { token } = await mintGuestToken();
    expect((await POST(makeRequest({ text: "hello" }, token))).status).toBe(200);
    expect((await POST(makeRequest({ text: "hello" }, token))).status).toBe(403);
  });

  it("users are not limited", async () => {
    mockGetConfig.mockResolvedValue(1 as never);
    for (let i = 0; i < 3; i++) {
      expect((await POST(makeRequest({ text: "hello" }))).status).toBe(200);
    }
  });

  it("fails closed when the usage store fails — no paid call is made uncounted", async () => {
    const broken: GuestUsageStore = {
      consume: jest.fn().mockRejectedValue(new Error("db down")),
      used: jest.fn(),
      reset: jest.fn(),
    };
    setGuestUsageStore(broken);
    const { token } = await mintGuestToken();
    const res = await POST(makeRequest({ text: "hello" }, token));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("internal.error");
    expect(checkSafety).not.toHaveBeenCalled();
  });
});
