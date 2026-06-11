/**
 * SongIdentificationProvider contract — ACRCloud reference arm (ADR-027).
 *
 * Runs the synced SongId conformance kit against the real ACRCloudIdentifier,
 * with the ACRCloud fingerprint API stubbed by a fetch mock. The no-match path
 * (P11: match=null, not an error) is elicited by a stubbed 1001 status, mirroring
 * how the mock uses forceNoMatch. Single synced arm.
 */

jest.mock("@/lib/logger", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  generateRequestId: () => "contract-req",
}));

import { runSongIdProviderContract } from "./contract/song-id-provider-contract";
import { ACRCloudIdentifier } from "@/platform/voice/acrcloud-identify";

let acrMode: "match" | "nomatch" = "match";

function res(body: Record<string, unknown>) {
  return { ok: true, status: 200, statusText: "OK", json: async () => body };
}

const originalFetch = global.fetch;
const originalEnv = {
  host: process.env.ACRCLOUD_HOST,
  key: process.env.ACRCLOUD_ACCESS_KEY,
  secret: process.env.ACRCLOUD_ACCESS_SECRET,
};

beforeAll(() => {
  process.env.ACRCLOUD_HOST = "identify-eu-west-1.acrcloud.com";
  process.env.ACRCLOUD_ACCESS_KEY = "test-access-key";
  process.env.ACRCLOUD_ACCESS_SECRET = "test-access-secret";

  const fetchMock = jest.fn(async (): Promise<Response> => {
    if (acrMode === "nomatch") {
      return res({ status: { code: 1001, msg: "No result" } }) as unknown as Response;
    }
    return res({
      status: { code: 0, msg: "Success" },
      metadata: {
        music: [
          {
            title: "Contract Song",
            artists: [{ name: "Contract Artist" }],
            album: { name: "Contract Album" },
            score: 95,
            acrid: "acr-xyz",
            duration_ms: 210000,
          },
        ],
      },
    }) as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
  process.env.ACRCLOUD_HOST = originalEnv.host;
  process.env.ACRCLOUD_ACCESS_KEY = originalEnv.key;
  process.env.ACRCLOUD_ACCESS_SECRET = originalEnv.secret;
});

describe("SongIdentificationProvider contract — ACRCloud (PF reference impl)", () => {
  runSongIdProviderContract({
    makeMatchingProvider: () => {
      acrMode = "match";
      return new ACRCloudIdentifier();
    },
    makeNoMatchProvider: () => {
      acrMode = "nomatch";
      return new ACRCloudIdentifier();
    },
    sampleAudio: Buffer.from("contract-fake-audio-bytes-long-enough-to-pass"),
    durationSeconds: 10,
  });
});
