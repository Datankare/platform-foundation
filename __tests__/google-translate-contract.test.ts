/**
 * TranslationProvider contract — Google reference arm (ADR-027).
 *
 * Runs the synced TranslationProvider conformance kit against the real
 * GoogleTranslateProvider, with the Google Translate v2 REST API stubbed by a
 * URL-routed fetch mock. Single synced arm — the impl is identical across
 * consumers (only Cognito is consumer-reimplemented).
 */

jest.mock("@/lib/logger", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  generateRequestId: () => "contract-req",
}));
jest.mock("@/shared/config/apiKeys", () => ({
  getGoogleApiKey: () => "test-google-key",
}));

import { runTranslationProviderContract } from "./contract/translation-provider-contract";
import { GoogleTranslateProvider } from "@/platform/translation/google-translate";

function ok(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body };
}

const originalFetch = global.fetch;

beforeAll(() => {
  const fetchMock = jest.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("/detect")) {
      return ok({
        data: { detections: [[{ language: "en", confidence: 0.98 }]] },
      }) as unknown as Response;
    }
    return ok({
      data: {
        translations: [{ translatedText: "Hola, mundo.", detectedSourceLanguage: "en" }],
      },
    }) as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe("TranslationProvider contract — Google (PF reference impl)", () => {
  runTranslationProviderContract({
    makeProvider: () => new GoogleTranslateProvider(),
  });
});
