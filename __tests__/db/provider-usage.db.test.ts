/**
 * @jest-environment node
 */
/**
 * TASK-212 (N-77): the ACRCloud credit's count, on the replayed database (migration 069).
 *
 * The count is what warns before the prepaid credit runs out, so it must not lose a request: every
 * instance adds through provider_usage_add, one statement each. Through the request role
 * (app_tenant, no tenant), exactly as the identification path writes it — concurrent requests add
 * up, the total and since are read back, and the request role reaches the table only through the
 * two functions.
 */

import { withOwnerTx, withPlatformTx } from "@/platform/data";
import {
  readAcrCloudUsage,
  recordAcrCloudRequest,
} from "@/platform/voice/acrcloud-usage";
import { connectTestDatabase, dbDescribe, disconnectTestDatabase } from "../helpers/db";

const clear = () =>
  withOwnerTx("operator", (tx) =>
    tx.query("delete from public.provider_usage where provider = 'acrcloud'")
  );

dbDescribe("the ACRCloud credit's count (TASK-212, N-77)", () => {
  beforeAll(async () => {
    await connectTestDatabase();
    await clear();
  });
  afterAll(async () => {
    await clear();
    await disconnectTestDatabase();
  });

  it("adds every concurrent request, a result one and no result a half", async () => {
    expect(await readAcrCloudUsage()).toEqual({ validRequests: 0, since: null });
    await Promise.all([
      ...Array.from({ length: 12 }, () => recordAcrCloudRequest("result", undefined)),
      ...Array.from({ length: 9 }, () => recordAcrCloudRequest("no_result", undefined)),
    ]);
    const usage = await readAcrCloudUsage();
    expect(usage.validRequests).toBe(16.5);
    expect(Date.parse(usage.since ?? "")).toBeGreaterThan(Date.now() - 600_000);
  });

  it("the request role reaches the table only through the two functions", async () => {
    await expect(
      withPlatformTx((tx) => tx.query("select * from public.provider_usage"))
    ).rejects.toThrow(/permission denied/);
    await expect(
      withPlatformTx((tx) =>
        tx.query("update public.provider_usage set billable_halves = 0")
      )
    ).rejects.toThrow(/permission denied/);
    await expect(
      withPlatformTx((tx) => tx.query("select public.provider_usage_add('acrcloud', -2)"))
    ).rejects.toThrow(/invalid count/);
  });
});
