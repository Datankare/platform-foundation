/**
 * __tests__/r13-hostile.test.ts — Review 13, the unit-level proofs (the Postgres ones are in
 * __tests__/db/r13.db.test.ts)
 *
 *   M2  a stamped key's read never waits on a hanging shared cache: each stamp read is bounded
 *       (200 ms) and, after 5 failures in a row, a circuit breaker stops asking (alerted) until a
 *       half-open probe answers — every such read is served from the database, never the cache.
 *       The permissions cache likewise. On jest's fake clock (TASK-198, D-13): the reader's own
 *       heartbeat decides whether a timeout was event-loop lag, so on a real clock a loaded runner
 *       (a GC pause, another worker) turned these "failures" into lag and the breaker never
 *       opened — reproduced 1 in 8 runs under two CPU burners, the likeliest cause of TASK-191.
 *       The fake clock runs every timer on time: a responsive loop, exactly.
 *   M1  a held reset applies only onto the platform default it was requested to inherit; one that
 *       recorded none is stale (fail closed).
 *   L1  a hold's scope: a reset is the tenant's; an update its named scope, else the deployment's.
 *   L2  the kill switch re-run when every agent is already suspended publishes the invalidation
 *       again (the runbook's recovery for config.invalidation_unpublished) — and writes nothing.
 *   L7  withdrawing the holds on a key is bounded: found by label and key, withdrawn and audited
 *       in batches — a constant number of store calls and audit records per 100 holds.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));
jest.mock("@/platform/data", () => require("./helpers/fake-data").fakeDataModule());
const raiseAlert = jest.fn();
jest.mock("@/platform/observability/alert", () => ({
  raiseAlert: (...a: unknown[]) => raiseAlert(...a),
}));
let cacheGet: jest.Mock;
const cacheSet = jest.fn(async () => undefined);
jest.mock("@/platform/cache", () => ({
  getCache: () => ({ get: (...a: unknown[]) => cacheGet(...a), set: cacheSet }),
}));

const resolvePermissions = jest.fn(async (sub: string) => ({
  userId: sub,
  permissions: ["x"],
}));
jest.mock("@/platform/auth/permissions", () => ({
  resolvePermissions: (...a: [string]) => resolvePermissions(...a),
}));

import { fakeData } from "./helpers/fake-data";
import {
  clearConfigCache,
  getConfig,
  getConfigOrThrow,
} from "@/platform/auth/platform-config";
import {
  resetStampBreaker,
  stampBreakerState,
  STAMP_BREAKER_COOLDOWN_MS,
  STAMP_BREAKER_FAILURES,
  STAMP_READ_TIMEOUT_MS,
} from "@/platform/cache/stamp-reader";
import { holdScope, withdrawSupersededHolds } from "@/platform/admin/hold-withdrawal";
import {
  InMemoryProposalStore,
  setProposalStore,
} from "@/platform/agents/proposal-store";
import { runWithTenant } from "@/platform/tenancy/context";

const hang = () => new Promise<never>(() => {});
const SHARED = Object.freeze({
  tenantId: "00000000-0000-4000-8000-0000000000e1",
  mode: "shared" as const,
});

beforeEach(() => {
  fakeData().reset();
  clearConfigCache();
  resetStampBreaker();
  raiseAlert.mockReset();
  cacheSet.mockClear();
  cacheGet = jest.fn(async () => "-");
});

describe("R13-M2 a hanging shared cache never holds a read of a stamped key", () => {
  const KEY = "agent.trusted_agents";
  let dbValue: unknown = [["agent:a", { status: "active" }]];
  beforeEach(() => {
    dbValue = [["agent:a", { status: "active" }]];
    fakeData().answer = (sql) =>
      /from platform_config where key = \$1/.test(sql) ? [{ value: dbValue }] : [];
  });
  const dbReads = () =>
    fakeData().statements.filter((s) => /from platform_config/.test(s.sql)).length;
  // The fake clock (see the header). Promises and nextTick stay real: only timers and Date move.
  beforeEach(() => jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] }));
  afterEach(() => jest.useRealTimers());
  /**
   * Runs `read` with the fake clock moved 1 ms at a time until it settles, and returns how long
   * it took on that clock and its value. A read still pending after `limitMs` of fake time fails
   * the test at once (it would otherwise wait for jest's own timeout).
   */
  async function timed<T>(read: () => Promise<T>, limitMs = 5_000) {
    const started = Date.now();
    let out: { value: T } | undefined;
    const p = read().then((value) => (out = { value }));
    while (!out && Date.now() - started <= limitMs)
      await jest.advanceTimersByTimeAsync(1);
    if (!out)
      throw new Error(`the read did not settle within ${limitMs} ms of fake time`);
    await p;
    return { tookMs: Date.now() - started, value: out!.value };
  }
  /** Whether `read` settles with the clock standing still: it waited on nothing. */
  async function settlesAtOnce<T>(read: () => Promise<T>): Promise<boolean> {
    let done = false;
    const p = read().then(() => (done = true));
    for (let i = 0; i < 20 && !done; i++) await Promise.resolve();
    await jest.advanceTimersByTimeAsync(0);
    await p;
    return done;
  }

  it("each read returns at the bound, from the database — never the cached value", async () => {
    // Warm the cache while the shared cache answers.
    expect(await getConfig(KEY)).toEqual(dbValue);
    expect(dbReads()).toBe(1);
    // The shared cache hangs; the database moved on.
    cacheGet = jest.fn(hang);
    dbValue = [["agent:a", { status: "suspended" }]];
    const read = await timed(() => getConfig(KEY));
    expect(read.value).toEqual(dbValue);
    // The bound, and the one turn of the loop the reader yields at it (review 14 M-2).
    expect(read.tookMs).toBeGreaterThanOrEqual(STAMP_READ_TIMEOUT_MS);
    expect(read.tookMs).toBeLessThanOrEqual(STAMP_READ_TIMEOUT_MS + 1);
    expect(dbReads()).toBe(2);
    // getConfigOrThrow too.
    expect((await timed(() => getConfigOrThrow(KEY))).value).toEqual(dbValue);
    expect(dbReads()).toBe(3);
  });

  it(`opens after ${STAMP_BREAKER_FAILURES} failures (alerted): no more waiting, still from the database`, async () => {
    cacheGet = jest.fn(hang);
    for (let i = 0; i < STAMP_BREAKER_FAILURES; i++) await timed(() => getConfig(KEY));
    expect(cacheGet).toHaveBeenCalledTimes(STAMP_BREAKER_FAILURES);
    expect(stampBreakerState()).toBe("open");
    expect(raiseAlert).toHaveBeenCalledTimes(1);
    expect(raiseAlert.mock.calls[0][0]).toMatchObject({
      name: "cache.stamp_breaker_open",
    });
    // Open: answered from the database at once (the clock standing still), the shared cache not
    // asked.
    for (let i = 0; i < 20; i++)
      expect(await settlesAtOnce(() => getConfig(KEY))).toBe(true);
    expect(await getConfig(KEY)).toEqual(dbValue);
    expect(cacheGet).toHaveBeenCalledTimes(STAMP_BREAKER_FAILURES);
    expect(dbReads()).toBe(STAMP_BREAKER_FAILURES + 21);
    expect(raiseAlert).toHaveBeenCalledTimes(1); // once per opening
  });

  it("half-open after the cool-down: one probe; it answers → closed; it fails → open again", async () => {
    cacheGet = jest.fn(async () => {
      throw new Error("ECONNRESET");
    });
    for (let i = 0; i < STAMP_BREAKER_FAILURES; i++) await getConfig(KEY);
    expect(stampBreakerState()).toBe("open");
    const now = Date.now();
    const clock = jest
      .spyOn(Date, "now")
      .mockReturnValue(now + STAMP_BREAKER_COOLDOWN_MS + 1);
    try {
      expect(stampBreakerState()).toBe("half-open");
      // The probe fails: open again, for another cool-down.
      await getConfig(KEY);
      expect(cacheGet).toHaveBeenCalledTimes(STAMP_BREAKER_FAILURES + 1);
      expect(stampBreakerState()).toBe("open");
      await getConfig(KEY);
      expect(cacheGet).toHaveBeenCalledTimes(STAMP_BREAKER_FAILURES + 1);
      // Past the next cool-down the probe answers: closed, and the cache is trusted again.
      clock.mockReturnValue(now + 2 * (STAMP_BREAKER_COOLDOWN_MS + 1));
      cacheGet = jest.fn(async () => "-");
      expect(await getConfig(KEY)).toEqual(dbValue);
      expect(stampBreakerState()).toBe("closed");
      const reads = dbReads();
      expect(await getConfig(KEY)).toEqual(dbValue); // cached under the stamp now
      expect(dbReads()).toBe(reads);
    } finally {
      clock.mockRestore();
    }
  });

  it("a key that is not stamped never asks the shared cache", async () => {
    cacheGet = jest.fn(hang);
    await getConfig("moderation.level1.block_severity");
    expect(cacheGet).not.toHaveBeenCalled();
  });

  it("the permissions cache: a hanging shared cache bounds the check, resolved from the database", async () => {
    const { getCachedPermissions } = await import("@/platform/auth/permissions-cache");
    cacheGet = jest.fn(hang);
    const check = await timed(() => getCachedPermissions("sub-r13"));
    expect(check.value).toMatchObject({ userId: "sub-r13" });
    expect(check.tookMs).toBeLessThanOrEqual(STAMP_READ_TIMEOUT_MS + 1);
    expect(resolvePermissions).toHaveBeenCalledTimes(1);
    // Unreadable stamps: the next check resolves again — nothing cached is trusted.
    await timed(() => getCachedPermissions("sub-r13"));
    expect(resolvePermissions).toHaveBeenCalledTimes(2);
  });
});

describe("R13-L1 a held config change's scope", () => {
  it("a reset is the tenant's; an update its named scope, else the deployment's", () => {
    runWithTenant(SHARED, () => {
      expect(holdScope({ label: "reset_config", payload: { scope: "platform" } })).toBe(
        "tenant"
      );
      expect(holdScope({ label: "update_config", payload: { scope: "platform" } })).toBe(
        "platform"
      );
      expect(holdScope({ label: "update_config", payload: {} })).toBe("tenant");
      expect(holdScope({ label: "update_config", payload: { scope: "tenant" } })).toBe(
        "tenant"
      );
    });
    runWithTenant({ tenantId: SHARED.tenantId, mode: "single" }, () => {
      expect(holdScope({ label: "update_config", payload: {} })).toBe("platform");
    });
  });
});

describe("R13-L7 withdrawing many holds is bounded", () => {
  const KEY = "agent.trusted_agents";
  it("250 holds on the key, 50 of the other scope, 50 on another key: 3 batches, counted", async () => {
    const store = new InMemoryProposalStore();
    setProposalStore(store);
    const calls = { query: 0, supersede: 0, decide: 0, withdraw: 0 };
    const query = store.query.bind(store);
    const supersede = store.supersede.bind(store);
    jest.spyOn(store, "query").mockImplementation(async (o) => {
      calls.query++;
      return query(o);
    });
    jest.spyOn(store, "supersede").mockImplementation(async (...a) => {
      calls.supersede++;
      return supersede(...a);
    });
    await runWithTenant(SHARED, async () => {
      const make = (i: number, key: string, scope?: string) =>
        store.create({
          operationId: `op_${key}_${scope ?? "-"}_${i}`,
          sessionId: "s",
          trajectoryId: "t",
          label: "update_config",
          actor: {
            actorType: "agent",
            actorId: "config-manager",
            agentRole: "config-manager",
          },
          effects: ["stateWrite"],
          effectiveRisk: "restricted",
          payload: {
            key,
            value: i,
            heldPrevious: { value: 0 },
            ...(scope ? { scope } : {}),
          },
        });
      for (let i = 0; i < 250; i++) await make(i, KEY);
      for (let i = 0; i < 50; i++) await make(i, KEY, "platform");
      for (let i = 0; i < 50; i++) await make(i, "agent.capability_features");
      // Some of them approved and not yet run: withdrawn too.
      const some = (await query({ payloadKey: KEY, limit: 10 })).filter(
        (p) => p.payload.scope !== "platform"
      );
      for (const p of some) await store.decide(p.proposalId, "approved", "someone");

      const out = await withdrawSupersededHolds(
        KEY,
        "agent-ops",
        "test reduction",
        "tenant"
      );
      expect(out.holds).toHaveLength(250);
      expect(out.failed).toEqual([]);
      // Bounded by batches, not by holds: ceil(300 / 100) pages + the empty one at most.
      expect(calls.query).toBeLessThanOrEqual(4);
      expect(calls.supersede).toBe(3);
      const records = fakeData().audit.filter(
        (a) => a.details.type === "approval_withdrawn" && a.details.source === "runtime"
      );
      // One record per batch, never per hold: at most 100 ids each, 250 in all.
      const counts = records.map((r) => r.details.count as number);
      expect(counts).toHaveLength(3);
      expect(Math.max(...counts)).toBeLessThanOrEqual(100);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(250);
      // The other scope and the other key stand.
      const left = await query({ statuses: ["proposed", "approved"] });
      expect(left).toHaveLength(100);
      expect(
        left.filter((p) => p.payload.key === KEY && p.payload.scope !== "platform")
      ).toEqual([]);
      // The approvals table: one update + one audit record per batch (here: one empty batch).
      const approvalUpdates = fakeData().statements.filter((s) =>
        /update config_pending_approvals/.test(s.sql)
      );
      expect(approvalUpdates).toHaveLength(1);
      expect(approvalUpdates[0].values).toEqual([
        KEY,
        null,
        expect.any(String),
        "tenant",
        100,
      ]);
    });
  });

  it("the approvals of the key are withdrawn in batches of 100, each audited once", async () => {
    setProposalStore(new InMemoryProposalStore());
    let pending = 230;
    fakeData().answer = (sql, values) => {
      if (!/update config_pending_approvals/.test(sql)) return [];
      const n = Math.min(Number(values[4]), pending);
      pending -= n;
      return Array.from({ length: n }, (_, i) => ({ id: `a-${pending + i}` }));
    };
    const out = await runWithTenant(SHARED, () =>
      withdrawSupersededHolds(KEY, "agent-ops", "test", "platform")
    );
    expect(out.approvals).toHaveLength(230);
    const records = fakeData().audit.filter(
      (a) => a.details.source === "config-approval"
    );
    expect(records.map((r) => [r.details.count, r.details.scope])).toEqual([
      [100, "platform"],
      [100, "platform"],
      [30, "platform"],
    ]);
  });
});
