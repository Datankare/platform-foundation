/**
 * TASK-212 (N-77): ACRCloud's prepaid credit is watched before it runs out.
 *
 * @not-guard: behaviour tests of the credit count, its alert and its probe — not a scan
 *
 * ACRCloud has no balance API and no quota header (docs.acrcloud.com), so the platform counts what
 * ACRCloud bills — a request with a result one, with none a half ("Definition of Terms") — and:
 *   - raises `credentials.acrcloud_credit_low` once, on the request that reaches
 *     ACRCLOUD_CREDIT_ALERT_AT;
 *   - reports readiness's `song-id-credit` degraded at or over the budget, and while ACRCloud
 *     serves without one; healthy below it, and when ACRCloud does not serve;
 *   - never counts an error answer, and never fails an identification because the count could
 *     not be written.
 */

jest.mock("@/platform/observability/alert", () => ({ raiseAlert: jest.fn() }));
jest.mock("@/lib/fetchWithTimeout", () => ({ fetchWithTimeout: jest.fn() }));

import { raiseAlert } from "@/platform/observability/alert";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import * as data from "@/platform/data";
import {
  ACRCLOUD_CREDIT_ALERT,
  ACRCLOUD_CREDIT_PROBE,
  createAcrCloudCreditProbe,
  parseCreditAlertAt,
  readAcrCloudUsage,
  recordAcrCloudRequest,
  resetAcrCloudUsageMemory,
} from "@/platform/voice/acrcloud-usage";
import {
  ACRCloudIdentifier,
  getAcrCloudConfig,
} from "@/platform/voice/acrcloud-identify";
import { SONG_ID_MODULE } from "@/platform/voice/song-id-module";

const alert = raiseAlert as jest.Mock;
const fetchMock = fetchWithTimeout as jest.Mock;
const ENV_KEYS = [
  "ACRCLOUD_HOST",
  "ACRCLOUD_ACCESS_KEY",
  "ACRCLOUD_ACCESS_SECRET",
  "ACRCLOUD_CREDIT_ALERT_AT",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  resetAcrCloudUsageMemory();
  alert.mockReset();
  fetchMock.mockReset();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  jest.restoreAllMocks();
});

describe("the budget (ACRCLOUD_CREDIT_ALERT_AT)", () => {
  it("is a positive whole number of valid requests, read where every ACRCLOUD_* is read", () => {
    expect(parseCreditAlertAt("4000")).toBe(4000);
    expect(parseCreditAlertAt(" 12 ")).toBe(12);
    for (const bad of ["", "0", "-5", "1.5", "ten", "1e3", "1234567890"]) {
      expect(parseCreditAlertAt(bad)).toBeUndefined();
    }
    expect(getAcrCloudConfig({ ACRCLOUD_CREDIT_ALERT_AT: "300" }).creditAlertAt).toBe(
      "300"
    );
    expect(getAcrCloudConfig({}).creditAlertAt).toBe("");
  });
});

describe("the count and its alert", () => {
  it("counts a result as one and no result as a half, as ACRCloud bills", async () => {
    await recordAcrCloudRequest("result", undefined);
    await recordAcrCloudRequest("no_result", undefined);
    await recordAcrCloudRequest("no_result", undefined);
    const usage = await readAcrCloudUsage();
    expect(usage.validRequests).toBe(2);
    expect(usage.since).toEqual(expect.any(String));
  });

  it("raises the alert once, on the request that reaches the budget", async () => {
    await recordAcrCloudRequest("result", 2);
    expect(alert).not.toHaveBeenCalled();
    await recordAcrCloudRequest("no_result", 2); // 1.5
    expect(alert).not.toHaveBeenCalled();
    await recordAcrCloudRequest("result", 2); // 2.5: crosses 2
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(
      expect.objectContaining({
        name: ACRCLOUD_CREDIT_ALERT,
        tags: { provider: "acrcloud" },
        message: expect.stringContaining("ACRCLOUD_CREDIT_ALERT_AT (2)"),
      })
    );
    await recordAcrCloudRequest("result", 2);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("a count that cannot be written is logged, never thrown", async () => {
    jest.spyOn(data, "hasDatabase").mockReturnValue(true);
    jest.spyOn(data, "withPlatformTx").mockRejectedValue(new Error("db down"));
    await expect(recordAcrCloudRequest("result", 1)).resolves.toBeUndefined();
    expect(alert).not.toHaveBeenCalled();
  });

  it("reads the database's total when there is one", async () => {
    jest.spyOn(data, "hasDatabase").mockReturnValue(true);
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ total: "7" }] })
      .mockResolvedValueOnce({
        rows: [{ billable_halves: "7", since: new Date("2026-11-09T00:00:00Z") }],
      })
      .mockResolvedValueOnce({ rows: [] });
    jest
      .spyOn(data, "withPlatformTx")
      .mockImplementation(async (fn) => fn({ query } as unknown as data.Tx));
    await recordAcrCloudRequest("result", 3); // 7 halves: 3.5 ≥ 3, crossed from 2.5
    expect(query.mock.calls[0]).toEqual([
      "select public.provider_usage_add($1, $2)::text as total",
      ["acrcloud", 2],
    ]);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(await readAcrCloudUsage()).toEqual({
      validRequests: 3.5,
      since: "2026-11-09T00:00:00.000Z",
    });
    expect(await readAcrCloudUsage()).toEqual({ validRequests: 0, since: null });
  });
});

describe("readiness: song-id-credit", () => {
  const check = (serving: boolean, at: number | undefined) =>
    createAcrCloudCreditProbe(
      () => serving,
      () => at
    ).check();

  it("is healthy when ACRCloud does not serve, whatever the budget", async () => {
    expect((await check(false, undefined)).status).toBe("healthy");
  });

  it("is degraded while ACRCloud serves with no budget set", async () => {
    const r = await check(true, undefined);
    expect(r.name).toBe(ACRCLOUD_CREDIT_PROBE);
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("ACRCLOUD_CREDIT_ALERT_AT is not set");
  });

  it("is healthy below the budget, degraded at or over it", async () => {
    await recordAcrCloudRequest("result", undefined);
    expect((await check(true, 2)).status).toBe("healthy");
    await recordAcrCloudRequest("result", undefined);
    const at = await check(true, 2);
    expect(at.status).toBe("degraded");
    expect(at.detail).toContain("at or over ACRCLOUD_CREDIT_ALERT_AT (2)");
  });

  it("is degraded when the count cannot be read", async () => {
    jest.spyOn(data, "hasDatabase").mockReturnValue(true);
    jest.spyOn(data, "withPlatformTx").mockRejectedValue(new Error("db down"));
    const r = await check(true, 5);
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("could not be read");
  });

  it("is one of the song-id module's probes, built around the live provider and budget", async () => {
    const probe = SONG_ID_MODULE.healthProbes.find(
      (p) => p.name === ACRCLOUD_CREDIT_PROBE
    );
    expect(probe).toBeDefined();
    // The jest setup installs the mock provider: ACRCloud does not serve.
    expect((await probe!.create().check()).status).toBe("healthy");
  });
});

describe("an identification is counted as ACRCloud bills it", () => {
  const WAV = Buffer.alloc(44 + 32_000 * 11);
  const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  const identify = () =>
    new ACRCloudIdentifier().identify({
      audioData: WAV,
      durationSeconds: 11,
      format: "wav",
    } as unknown as Parameters<ACRCloudIdentifier["identify"]>[0]);

  beforeEach(() => {
    process.env.ACRCLOUD_HOST = "identify-eu-west-1.acrcloud.com";
    process.env.ACRCLOUD_ACCESS_KEY = "k";
    process.env.ACRCLOUD_ACCESS_SECRET = "s";
    process.env.ACRCLOUD_CREDIT_ALERT_AT = "1";
  });

  it("a result is one, no result a half; an error status is not counted", async () => {
    fetchMock.mockResolvedValueOnce(
      answer({
        status: { code: 0, msg: "Success" },
        metadata: { music: [{ title: "T", artists: [{ name: "A" }], score: 90 }] },
      })
    );
    await identify();
    expect((await readAcrCloudUsage()).validRequests).toBe(1);
    expect(alert).toHaveBeenCalledWith(
      expect.objectContaining({ name: ACRCLOUD_CREDIT_ALERT })
    );
    fetchMock.mockResolvedValueOnce(answer({ status: { code: 1001, msg: "No result" } }));
    await identify();
    expect((await readAcrCloudUsage()).validRequests).toBe(1.5);
    fetchMock.mockResolvedValueOnce(
      answer({ status: { code: 3003, msg: "Request count limit exceeded" } })
    );
    await expect(identify()).rejects.toThrow();
    expect((await readAcrCloudUsage()).validRequests).toBe(1.5);
  });
});
