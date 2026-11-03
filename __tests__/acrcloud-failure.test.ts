/**
 * TASK-197 (audit D-5): ACRCloud answers a bad key or an exhausted plan inside an HTTP 200
 * (status.code 3001, 3003…). That ended as a plain Error — a 500 and a log line. Now each code is
 * classified, and identify throws an ExternalServiceError that is recorded (an alert for a
 * credential or quota) and answered as service.unavailable.
 */

jest.mock("@/platform/observability/alert", () => ({ raiseAlert: jest.fn() }));

import { raiseAlert } from "@/platform/observability/alert";
import { resetExternalAlerts } from "@/platform/observability/external-failure";
import {
  ACRCloudIdentifier,
  acrCloudFailureReason,
} from "@/platform/voice/acrcloud-identify";
import { isExternalServiceError } from "@/platform/errors/external-service";

beforeEach(() => resetExternalAlerts());

describe("ACRCloud failures (TASK-197)", () => {
  it("ACRCloud's in-body codes (an HTTP 200): bad key and signature are credentials, limits quota", () => {
    expect(acrCloudFailureReason(3001)).toBe("credential");
    expect(acrCloudFailureReason(3014)).toBe("credential");
    expect(acrCloudFailureReason(3003)).toBe("quota");
    expect(acrCloudFailureReason(3015)).toBe("quota");
    expect(acrCloudFailureReason(3000)).toBe("unavailable");
    expect(acrCloudFailureReason(2004)).toBe("rejected");
  });

  it("an in-body credential code is thrown as a recorded ExternalServiceError with an alert", async () => {
    const original = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ status: { code: 3001, msg: "Missing/Invalid Access Key" } }),
        {
          status: 200,
        }
      )
    ) as typeof fetch;
    process.env.ACRCLOUD_HOST = "identify.example";
    process.env.ACRCLOUD_ACCESS_KEY = "k";
    process.env.ACRCLOUD_ACCESS_SECRET = "s";
    try {
      const err = await new ACRCloudIdentifier()
        .identify({
          audioData: Buffer.alloc(160_000, 1),
          durationSeconds: 5,
          requestId: "r",
        })
        .catch((e: unknown) => e);
      expect(isExternalServiceError(err)).toBe(true);
      expect(err).toMatchObject({ service: "acrcloud", reason: "credential" });
      expect(raiseAlert).toHaveBeenCalledWith(
        expect.objectContaining({ name: "external.credential" })
      );
    } finally {
      global.fetch = original;
      delete process.env.ACRCLOUD_HOST;
      delete process.env.ACRCLOUD_ACCESS_KEY;
      delete process.env.ACRCLOUD_ACCESS_SECRET;
    }
  });
});
