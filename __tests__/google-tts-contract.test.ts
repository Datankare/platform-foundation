/**
 * TTSProvider contract — Google reference arm (ADR-027).
 *
 * Runs the synced TTSProvider conformance kit against the real GoogleTTSProvider,
 * with the Google Cloud TTS REST API stubbed by a fetch mock. Single synced arm.
 */

jest.mock("@/lib/logger", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  generateRequestId: () => "contract-req",
}));
jest.mock("@/shared/config/apiKeys", () => ({
  getGoogleApiKey: () => "test-google-key",
}));

import { runTTSProviderContract } from "./contract/tts-provider-contract";
import { GoogleTTSProvider } from "@/platform/voice/google-tts";

const FAKE_AUDIO_B64 = Buffer.from("fake-mp3-audio-bytes").toString("base64");

function ok(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body };
}

const originalFetch = global.fetch;

beforeAll(() => {
  const fetchMock = jest.fn(async (): Promise<Response> => {
    return ok({ audioContent: FAKE_AUDIO_B64 }) as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe("TTSProvider contract — Google (PF reference impl)", () => {
  runTTSProviderContract({
    makeProvider: () => new GoogleTTSProvider(),
  });
});
