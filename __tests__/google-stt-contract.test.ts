/**
 * STTProvider contract — Google reference arm (ADR-027).
 *
 * Runs the synced STTProvider conformance kit against the real GoogleSTTProvider,
 * with the Google Cloud Speech-to-Text REST API stubbed by a fetch mock. Single
 * synced arm.
 */

jest.mock("@/lib/logger", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  generateRequestId: () => "contract-req",
}));
jest.mock("@/shared/config/apiKeys", () => ({
  getGoogleApiKey: () => "test-google-key",
}));

import { runSTTProviderContract } from "./contract/stt-provider-contract";
import { GoogleSTTProvider } from "@/platform/voice/google-stt";

function ok(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body };
}

const originalFetch = global.fetch;

beforeAll(() => {
  const fetchMock = jest.fn(async (): Promise<Response> => {
    return ok({
      results: [
        {
          alternatives: [{ transcript: "hello world", confidence: 0.95 }],
          languageCode: "en-US",
        },
      ],
    }) as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe("STTProvider contract — Google (PF reference impl)", () => {
  runSTTProviderContract({
    makeProvider: () => new GoogleSTTProvider(),
    sampleAudioBase64: Buffer.from("contract-fake-audio").toString("base64"),
  });
});
