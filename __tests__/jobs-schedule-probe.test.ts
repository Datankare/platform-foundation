/**
 * @jest-environment node
 */
/**
 * The stale-schedule probe (platform/jobs/schedule-probe.ts, review finding 2): a deployment
 * whose ticks never arrive booted, answered ready and ran no duty, silently. The probe — optional,
 * so readiness says "degraded", never unready — names each enabled recurring kind that has not
 * run on time: never, a grace period after boot or after it was turned on; or not for twice its
 * interval. A turned-off kind is never stale.
 */

const mockEnabled = new Map<string, boolean>();
jest.mock("@/platform/auth/platform-config", () => ({
  getConfigBoolean: jest.fn(async (k: string, d: boolean) => mockEnabled.get(k) ?? d),
  getConfigNumber: jest.fn(async (_k: string, d: number) => d),
}));

import {
  createScheduleFreshnessProbe,
  InMemoryJobStore,
  listScheduledJobs,
  resetJobStore,
  runDue,
  scheduleKeys,
  setJobStore,
  STALE_SCHEDULE_GRACE_MS,
  type JobStore,
} from "@/platform/jobs";

const T0 = Date.parse("2026-10-24T00:00:00Z");
let clock = T0;
const now = () => clock;
let store: InMemoryJobStore;

beforeEach(() => {
  clock = T0;
  mockEnabled.clear();
  store = new InMemoryJobStore({ now, activeTenants: async () => [] });
  setJobStore(store);
});
afterAll(() => resetJobStore());

const probe = () => createScheduleFreshnessProbe({ now, since: T0, cacheMs: 0 });
const tick = () => runDue({ budgetMs: 3_500, now });

describe("the stale-schedule probe", () => {
  it("is healthy within the grace period after boot, then names every schedule that never ran", async () => {
    const p = probe();
    expect((await p.check()).status).toBe("healthy");
    clock = T0 + STALE_SCHEDULE_GRACE_MS + 1;
    const r = await p.check();
    expect(r.status).toBe("degraded");
    for (const def of listScheduledJobs()) {
      expect(r.detail).toContain(`${def.kind} has never run`);
    }
    expect(r.detail).toMatch(/is the job tick called/);
  });

  it("is healthy once a tick takes every slot, and names a duty two intervals late", async () => {
    const p = probe();
    await tick();
    clock = T0 + STALE_SCHEDULE_GRACE_MS + 1;
    expect((await p.check()).status).toBe("healthy");
    // The escalation reaper runs every 15 minutes: 31 minutes without a slot is two intervals.
    clock = T0 + 31 * 60_000;
    const r = await p.check();
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain(
      "moderation.escalation-reaper last ran 31 min ago (every 15 min)"
    );
    expect(r.detail).not.toContain("gdpr.retention-purge");
  });

  it("never names a schedule that is turned off; one turned on gets the grace period again", async () => {
    const reaper = scheduleKeys("moderation.escalation-reaper").enabled;
    const p = probe();
    await tick();
    mockEnabled.set(reaper, false);
    clock = T0 + 60 * 60_000;
    expect((await p.check()).detail).not.toContain("moderation.escalation-reaper");
    mockEnabled.set(reaper, true);
    expect((await p.check()).detail).not.toContain("moderation.escalation-reaper");
    clock += 31 * 60_000;
    expect((await p.check()).detail).toContain("moderation.escalation-reaper");
  });

  it("is degraded, not failing, when the schedules cannot be read", async () => {
    const broken = Object.assign(Object.create(store), {
      listScheduleTimes: async () => {
        throw new Error("down: password=x");
      },
    }) as JobStore;
    const r = await createScheduleFreshnessProbe({
      store: () => broken,
      now,
      cacheMs: 0,
    }).check();
    expect(r).toMatchObject({ name: "job-schedules", status: "degraded" });
    expect(r.detail).not.toContain("password");
  });

  it("reuses its answer within its cache period", async () => {
    const spy = jest.spyOn(store, "listScheduleTimes");
    const p = createScheduleFreshnessProbe({ now, since: T0 });
    await p.check();
    await p.check();
    expect(spy).toHaveBeenCalledTimes(1);
    clock += 61_000;
    await p.check();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
