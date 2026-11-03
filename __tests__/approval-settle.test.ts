/**
 * @jest-environment node
 */
/**
 * __tests__/approval-settle.test.ts — when an approval whose outcome is being checked is settled
 * (TASK-194 round 17, I-1; round 18)
 *
 * The approval-expiry job (config.expire-approvals) settles it; it is required (round 18), so the
 * bound is always the lease, the job's interval and a tick. The interval is the platform's
 * schedule: read without a tenant, as the scheduler reads it (round 18, I-2) — a tenant's override
 * of the interval setting is not the schedule the job runs on.
 */

import { peekTenant, runWithTenant } from "@/platform/tenancy/context";

const platform = new Map<string, number>();
const tenant = new Map<string, number>();
jest.mock("@/platform/auth/platform-config", () => ({
  ...jest.requireActual("@/platform/auth/platform-config"),
  // As the real read: a tenant's override when there is a tenant, else the platform's value.
  getConfigNumber: async (key: string, fallback: number) => {
    const { peekTenant: peek } = jest.requireActual("@/platform/tenancy/context");
    if (peek() && tenant.has(key)) return tenant.get(key);
    return platform.has(key) ? platform.get(key) : fallback;
  },
}));

import { scheduleKeys } from "@/platform/jobs/registry";
import { settlesWithinMinutes, SETTLING_JOB } from "@/platform/admin/approval-settle";

const INTERVAL = scheduleKeys(SETTLING_JOB).interval;
beforeEach(() => {
  platform.clear();
  tenant.clear();
});

describe("settlesWithinMinutes (rounds 17–18)", () => {
  it("the lease, the job's interval as scheduled, and a tick", async () => {
    platform.set(INTERVAL, 30);
    await expect(settlesWithinMinutes(600)).resolves.toBe(10 + 30 + 5);
  });

  it("inside a tenant with its own override of the interval: the platform's schedule (I-2)", async () => {
    platform.set(INTERVAL, 30);
    tenant.set(INTERVAL, 15);
    const minutes = await runWithTenant(
      { tenantId: "00000000-0000-4000-8000-0000000000c1", mode: "shared" } as never,
      async () => {
        expect(peekTenant()).toBeDefined();
        return settlesWithinMinutes(600);
      }
    );
    expect(minutes).toBe(10 + 30 + 5);
  });
});
