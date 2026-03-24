import { POST } from "@/app/api/process/route";
import { NextRequest } from "next/server";

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

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/process", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/process", () => {
  it("returns 400 for missing text", async () => {
    const req = makeRequest({});
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty text", async () => {
    const req = makeRequest({ text: "   " });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for text over 100 chars", async () => {
    const req = makeRequest({ text: "a".repeat(101) });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 200 with translations for valid text", async () => {
    const req = makeRequest({ text: "hello world" });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.translations).toHaveLength(3);
  });

  it("returns error when safety check fails", async () => {
    const { checkSafety } = await import("@/lib/safety");
    (checkSafety as jest.Mock).mockResolvedValueOnce({
      safe: false,
      reason: "inappropriate content",
    });
    const req = makeRequest({ text: "unsafe content" });
    const res = await POST(req);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("returns translations with audio", async () => {
    const req = makeRequest({ text: "hello" });
    const res = await POST(req);
    const data = await res.json();
    data.translations.forEach((t: { audioBase64: string }) => {
      expect(t.audioBase64).toBe("base64audio==");
    });
  });
});
