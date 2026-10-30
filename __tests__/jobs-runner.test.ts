/**
 * @jest-environment node
 */
/**
 * platform/jobs — the registry, backoff, idempotent enqueue, error wording and the runner, on the
 * in-memory store (ADR-056 D2). The Postgres store runs the same runner against the replayed
 * database in __tests__/db/jobs.db.test.ts.
 *
 * Hostile cases: handlers that throw non-Error values (strings, null, objects, symbols,
 * undefined), a handler that hangs past its time, a database error whose message must not reach
 * last_error, an idempotency key reused across tenants, a lease lost mid-attempt, a malformed
 * declaration of every field.
 */

import { randomUUID } from "node:crypto";
import {
  DEFAULT_BACKOFF,
  checkBackoff,
  defineJob,
  describeJobError,
  enqueueJob,
  getJobDefinition,
  hungJobCount,
  InMemoryJobStore,
  JobDefinitionError,
  JobEnqueueError,
  JobFailure,
  JobTimeoutError,
  listJobDefinitions,
  listJobOwners,
  listScheduledJobs,
  MAX_ERROR_LENGTH,
  platformHomeTenant,
  registerJob,
  resetJobRegistry,
  resetJobStore,
  retryDelayMs,
  runDue,
  scheduleKeys,
  setJobStore,
  settleHungJobs,
  type JobContext,
  type JobStore,
} from "@/platform/jobs";
import { DataUnavailableError } from "@/platform/data";
import { isModuleEnabled } from "@/platform/modules";
import {
  DEFAULT_TENANT_ID,
  currentTenant,
  peekTenant,
  runWithTenant,
} from "@/platform/tenancy/context";

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";

let clock = Date.parse("2026-10-24T00:00:00Z");
const now = () => clock;
let store: InMemoryJobStore;

beforeEach(() => {
  clock = Date.parse("2026-10-24T00:00:00Z");
  store = new InMemoryJobStore({
    now,
    activeTenants: async () => [A, B, DEFAULT_TENANT_ID],
  });
  setJobStore(store);
});
afterEach(() => {
  resetJobRegistry();
  resetJobStore();
});

const kind = () => `test.k${randomUUID().slice(0, 8)}`;

function register(handler: (ctx: JobContext) => Promise<unknown>, options = {}) {
  const k = kind();
  registerJob(k, handler as never, { description: "A test job.", ...options });
  return k;
}

const run = (kinds: string[], extra: Partial<Parameters<typeof runDue>[0]> = {}) =>
  runDue({ budgetMs: 60_000, kinds, schedule: false, now, random: () => 0.5, ...extra });

// ── The registry ───────────────────────────────────────────────────────

describe("job declarations", () => {
  const ok = async () => undefined;

  it("applies the defaults and freezes the result", () => {
    const d = defineJob("test.one", ok, { description: "  Does one thing.  " });
    expect(d).toMatchObject({
      kind: "test.one",
      description: "Does one thing.",
      maxAttempts: 5,
      timeoutMs: 25_000,
      backoff: DEFAULT_BACKOFF,
    });
    expect(Object.isFrozen(d)).toBe(true);
  });

  it.each([
    ["no area", "single", {}],
    ["upper case", "Test.Job", {}],
    ["a trailing dot", "test.", {}],
    ["too long", `test.${"x".repeat(100)}`, {}],
    ["no description", "test.d", { description: " " }],
    ["zero attempts", "test.d", { maxAttempts: 0 }],
    ["too many attempts", "test.d", { maxAttempts: 26 }],
    ["fractional attempts", "test.d", { maxAttempts: 1.5 }],
    ["a timeout under a second", "test.d", { timeoutMs: 999 }],
    ["a timeout over five minutes", "test.d", { timeoutMs: 300_001 }],
    ["a backoff below a second", "test.d", { backoff: { baseMs: 10, maxMs: 1000 } }],
    [
      "a backoff max below its base",
      "test.d",
      { backoff: { baseMs: 5000, maxMs: 1000 } },
    ],
    [
      "an unknown scope",
      "test.d",
      {
        schedule: {
          scope: "everywhere",
          defaultIntervalMinutes: 5,
          minIntervalMinutes: 1,
          maxIntervalMinutes: 10,
        },
      },
    ],
    [
      "a default outside its bounds",
      "test.d",
      {
        schedule: {
          scope: "platform",
          defaultIntervalMinutes: 50,
          minIntervalMinutes: 1,
          maxIntervalMinutes: 10,
        },
      },
    ],
    [
      "an interval over a week",
      "test.d",
      {
        schedule: {
          scope: "platform",
          defaultIntervalMinutes: 5,
          minIntervalMinutes: 1,
          maxIntervalMinutes: 20_000,
        },
      },
    ],
    [
      "a tenant opt-out on a platform job",
      "test.d",
      {
        schedule: {
          scope: "platform",
          defaultIntervalMinutes: 5,
          minIntervalMinutes: 1,
          maxIntervalMinutes: 10,
          tenantOptOutKey: "x.y",
        },
      },
    ],
    [
      "a malformed opt-out key",
      "test.d",
      {
        schedule: {
          scope: "each-tenant",
          defaultIntervalMinutes: 5,
          minIntervalMinutes: 1,
          maxIntervalMinutes: 10,
          tenantOptOutKey: "Bad Key",
        },
      },
    ],
  ])("refuses %s", (_label, k, options) => {
    expect(() =>
      defineJob(k as string, ok, { description: "x", ...(options as object) } as never)
    ).toThrow(JobDefinitionError);
  });

  it("refuses a missing handler", () => {
    expect(() => defineJob("test.h", undefined as never, { description: "x" })).toThrow(
      /no handler/
    );
  });

  it("refuses a kind the core already declares, or one registered twice", () => {
    expect(() =>
      registerJob("moderation.escalation-reaper", ok, { description: "dup" })
    ).toThrow(/already declared by the core/);
    if (isModuleEnabled("social")) {
      expect(() => registerJob("social.analyst", ok, { description: "dup" })).toThrow(
        /module "social"/
      );
    }
    registerJob("test.twice", ok, { description: "once" });
    expect(() => registerJob("test.twice", ok, { description: "twice" })).toThrow(
      /already registered/
    );
  });

  it("lists the core's duties, the modules' and the app's, with owners", () => {
    registerJob("test.app", ok, { description: "the app's own" });
    const owners = new Map(listJobOwners().map((o) => [o.kind, o.owner]));
    expect(owners.get("moderation.escalation-reaper")).toBe("core");
    expect(owners.get("social.curator")).toBe(
      isModuleEnabled("social") ? "social" : undefined
    );
    expect(owners.get("test.app")).toBe("app");
    expect(getJobDefinition("test.app")?.description).toBe("the app's own");
    expect(listJobDefinitions().map((d) => d.kind)).toContain("test.app");
    const scheduled = listScheduledJobs();
    expect(scheduled.length).toBeGreaterThan(0);
    expect(scheduled.every((d) => d.schedule)).toBe(true);
    resetJobRegistry();
    expect(getJobDefinition("test.app")).toBeUndefined();
  });

  it("names each schedule's governed settings", () => {
    expect(scheduleKeys("gdpr.retention-purge")).toEqual({
      enabled: "jobs.gdpr.retention-purge.enabled",
      interval: "jobs.gdpr.retention-purge.interval_minutes",
    });
  });
});

// ── Backoff ────────────────────────────────────────────────────────────

describe("retry backoff", () => {
  const policy = { baseMs: 1_000, maxMs: 60_000 };

  it("doubles from the base, with half the delay fixed and half jittered", () => {
    expect(retryDelayMs(1, policy, () => 0)).toBe(500);
    expect(retryDelayMs(1, policy, () => 0.999999)).toBe(1000);
    expect(retryDelayMs(2, policy, () => 0)).toBe(1000);
    expect(retryDelayMs(3, policy, () => 0.5)).toBe(3000);
  });

  it("is capped, and never overflows on a huge attempt number", () => {
    expect(retryDelayMs(10, policy, () => 0.999999)).toBe(60_000);
    expect(retryDelayMs(1_000_000, policy, () => 0)).toBe(30_000);
  });

  it("keeps a broken random source inside the bounds", () => {
    for (const bad of [NaN, -1, 2, Infinity]) {
      const d = retryDelayMs(2, policy, () => bad);
      expect(d).toBeGreaterThanOrEqual(1000);
      expect(d).toBeLessThanOrEqual(2000);
    }
  });

  it("spreads retries with the real source", () => {
    const seen = new Set(Array.from({ length: 50 }, () => retryDelayMs(4)));
    expect(seen.size).toBeGreaterThan(1);
    for (const d of seen) {
      expect(d).toBeGreaterThanOrEqual(240_000);
      expect(d).toBeLessThanOrEqual(480_000);
    }
  });

  it("refuses an attempt below 1 and an invalid policy", () => {
    expect(() => retryDelayMs(0)).toThrow(RangeError);
    expect(() => retryDelayMs(1.5)).toThrow(RangeError);
    expect(() => checkBackoff({ baseMs: 1000, maxMs: 2 * 24 * 60 * 60_000 })).toThrow(
      RangeError
    );
  });
});

// ── Errors ─────────────────────────────────────────────────────────────

describe("what a failed job records", () => {
  it("keeps a JobFailure's own wording, cleaned and bounded", () => {
    expect(describeJobError(new JobFailure("  Two\nerasures\tfailed.  "))).toBe(
      "Two erasures failed."
    );
    const long = describeJobError(new JobFailure("x".repeat(5000)));
    expect(long.length).toBe(MAX_ERROR_LENGTH);
    expect(describeJobError(new JobFailure(""))).toBe("The job reported a failure.");
  });

  it("never records a database's own message", () => {
    const pg = Object.assign(
      new Error(
        'duplicate key value violates unique constraint "users_pkey" on table users'
      ),
      { code: "23505" }
    );
    const text = describeJobError(pg);
    expect(text).toBe("A database statement failed (SQLSTATE 23505).");
    expect(text).not.toMatch(/users|constraint/);
    expect(
      describeJobError(new DataUnavailableError("connect ECONNREFUSED 10.0.0.5"))
    ).toBe("The database was unavailable.");
  });

  it("records only the class of an unexpected Error", () => {
    expect(describeJobError(new TypeError("secret=abc in a message"))).toBe(
      "The job failed with an unexpected TypeError."
    );
    const odd = new Error("x");
    odd.name = "<script>alert(1)</script>";
    expect(describeJobError(odd)).toBe("The job failed with an unexpected Error.");
  });

  it.each([
    ["a string", "token=hunter2", "The job failed: it threw a string value."],
    ["null", null, "The job failed: it threw null."],
    ["undefined", undefined, "The job failed: it threw a undefined value."],
    [
      "an object",
      { password: "x" },
      "The job failed: it threw a non-Error object value.",
    ],
    ["a number", 42, "The job failed: it threw a number value."],
    ["a symbol", Symbol("s"), "The job failed: it threw a symbol value."],
  ])("describes a thrown %s without its content", (_l, value, want) => {
    expect(describeJobError(value)).toBe(want);
  });

  it("describes a timeout", () => {
    expect(describeJobError(new JobTimeoutError(1500))).toBe(
      "The job did not finish within its time (1500 ms)."
    );
  });
});

// ── Enqueue ────────────────────────────────────────────────────────────

describe("enqueueJob", () => {
  it("is idempotent per tenant and kind; the same key in another tenant is another job", async () => {
    const k = register(async () => undefined);
    const first = await runWithTenant({ tenantId: A, mode: "shared" }, () =>
      enqueueJob(k, { idempotencyKey: "same" })
    );
    const again = await runWithTenant({ tenantId: A, mode: "shared" }, () =>
      enqueueJob(k, { idempotencyKey: "same", payload: { other: true } })
    );
    const inB = await runWithTenant({ tenantId: B, mode: "shared" }, () =>
      enqueueJob(k, { idempotencyKey: "same" })
    );
    expect(again).toEqual({ id: first.id, created: false });
    expect(new Set([first.id, inB.id]).size).toBe(2);
    expect((await store.getJob(inB.id))?.tenantId).toBe(B);
  });

  it("needs a tenant unless a platform job is asked for", async () => {
    const k = register(async () => undefined);
    await expect(enqueueJob(k, { idempotencyKey: "x" })).rejects.toThrow(/tenant/i);
  });

  it.each([
    ["an unknown kind", "test.nobody", { idempotencyKey: "x" }, JobDefinitionError],
    ["an empty key", null, { idempotencyKey: "" }, JobEnqueueError],
    ["a key over 200", null, { idempotencyKey: "k".repeat(201) }, JobEnqueueError],
    ["an array payload", null, { idempotencyKey: "x", payload: [] }, JobEnqueueError],
    [
      "a payload over 64 KB",
      null,
      { idempotencyKey: "x", payload: { big: "x".repeat(70_000) } },
      JobEnqueueError,
    ],
    [
      "a malformed tenant",
      null,
      { idempotencyKey: "x", tenantId: "nope" },
      JobEnqueueError,
    ],
    [
      "an invalid time",
      null,
      { idempotencyKey: "x", runAt: new Date(NaN) },
      JobEnqueueError,
    ],
  ])("refuses %s", async (_l, k, options, error) => {
    const target = k ?? register(async () => undefined);
    await expect(
      runWithTenant({ tenantId: A, mode: "shared" }, () =>
        enqueueJob(target, options as never)
      )
    ).rejects.toThrow(error as never);
    expect(store.size()).toBe(0);
  });

  it("refuses a payload that cannot be serialised", async () => {
    const k = register(async () => undefined);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(
      runWithTenant({ tenantId: A, mode: "shared" }, () =>
        enqueueJob(k, { idempotencyKey: "x", payload: cyclic })
      )
    ).rejects.toThrow(/JSON/);
  });
});

// ── The runner ─────────────────────────────────────────────────────────

describe("runDue", () => {
  it("runs a job in its tenant's context and marks it succeeded", async () => {
    let seen: string | undefined;
    const k = register(async () => {
      seen = currentTenant().tenantId;
      return { summary: { did: 1 } };
    });
    const { id } = await store.enqueue({
      tenantId: A,
      kind: k,
      idempotencyKey: "1",
      maxAttempts: 3,
      source: "enqueue",
    });
    const r = await run([k]);
    expect(r).toMatchObject({ claimed: 1, succeeded: 1, stoppedBy: "idle" });
    expect(seen).toBe(A);
    expect((await store.getJob(id))?.status).toBe("succeeded");
    // The runner itself is outside any tenant afterwards.
    expect(peekTenant()).toBeUndefined();
  });

  it("runs a platform job from the platform's home tenant", async () => {
    let seen: string | undefined;
    const k = register(async (ctx) => {
      expect(ctx.tenantId).toBeNull();
      seen = currentTenant().tenantId;
    });
    await store.enqueue({
      tenantId: null,
      kind: k,
      idempotencyKey: "p",
      maxAttempts: 1,
      source: "enqueue",
    });
    await run([k]);
    expect(seen).toBe(platformHomeTenant().tenantId);
    expect(platformHomeTenant()).toEqual({ tenantId: DEFAULT_TENANT_ID, mode: "single" });
  });

  it("keeps two tenants' jobs apart: each handler sees only its own tenant", async () => {
    const seen: string[] = [];
    const k = register(async (ctx) => {
      expect(currentTenant().tenantId).toBe(ctx.tenantId);
      seen.push(ctx.tenantId!);
    });
    for (const t of [A, B]) {
      await store.enqueue({
        tenantId: t,
        kind: k,
        idempotencyKey: "same-key",
        maxAttempts: 1,
        source: "enqueue",
      });
    }
    await run([k]);
    expect(seen.sort()).toEqual([A, B].sort());
  });

  it("retries a failure with backoff, then dead-letters it after the last attempt", async () => {
    let calls = 0;
    const k = register(
      async () => {
        calls++;
        throw new Error("boom: password=hunter2");
      },
      { maxAttempts: 2, backoff: { baseMs: 1000, maxMs: 4000 } }
    );
    const { id } = await store.enqueue({
      tenantId: A,
      kind: k,
      idempotencyKey: "r",
      maxAttempts: 2,
      source: "enqueue",
    });
    let r = await run([k]);
    expect(r).toMatchObject({ claimed: 1, retried: 1, dead: 0 });
    const queued = await store.getJob(id);
    expect(queued).toMatchObject({ status: "queued", attempts: 1 });
    expect(queued?.lastError).toBe("The job failed with an unexpected Error.");
    // Not due until the backoff (750 ms at jitter 0.5 of the first 1 s) has passed.
    expect(new Date(queued!.runAt).getTime()).toBe(clock + 750);
    expect((await run([k])).claimed).toBe(0);
    clock += 1000;
    r = await run([k]);
    expect(r).toMatchObject({ claimed: 1, dead: 1 });
    expect(await store.getJob(id)).toMatchObject({ status: "dead", attempts: 2 });
    expect(calls).toBe(2);
    expect(JSON.stringify(await store.getJob(id))).not.toContain("hunter2");
  });

  it.each([
    ["a string", "token=abc"],
    ["null", null],
    ["undefined", undefined],
    ["an object", { secret: "x" }],
    ["a symbol", Symbol("x")],
  ])("survives a handler that throws %s, recording no content", async (_l, value) => {
    const k = register(
      async () => {
        throw value;
      },
      { maxAttempts: 1 }
    );
    const { id } = await store.enqueue({
      tenantId: A,
      kind: k,
      idempotencyKey: "x",
      maxAttempts: 1,
      source: "enqueue",
    });
    const r = await run([k]);
    expect(r.dead).toBe(1);
    const rec = await store.getJob(id);
    expect(rec?.lastError).toMatch(/^The job failed: it threw/);
    expect(rec?.lastError).not.toMatch(/abc|secret/);
  });
});

describe("runDue at its limits: misbehaving handlers, budgets, leases", () => {
  it("survives a handler that throws synchronously (not an async function)", async () => {
    const k = register(
      (() => {
        throw new JobFailure("Refused at once.");
      }) as never,
      { maxAttempts: 1 }
    );
    const { id } = await store.enqueue({
      tenantId: A,
      kind: k,
      idempotencyKey: "s",
      maxAttempts: 1,
      source: "enqueue",
    });
    await run([k]);
    expect((await store.getJob(id))?.lastError).toBe("Refused at once.");
  });

  it("settles a handler that stops soon after its time as timed out", async () => {
    let aborted = false;
    const k = register(
      (ctx) =>
        new Promise((_, reject) => {
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("stopped"));
          });
        }),
      { timeoutMs: 1_000, maxAttempts: 2 }
    );
    const { id } = await store.enqueue({
      tenantId: A,
      kind: k,
      idempotencyKey: "h",
      maxAttempts: 2,
      source: "enqueue",
    });
    const r = await runDue({ budgetMs: 4_000, kinds: [k], schedule: false });
    expect(r).toMatchObject({ claimed: 1, retried: 1, hung: 0 });
    expect(aborted).toBe(true);
    expect((await store.getJob(id))?.lastError).toBe(
      "The job did not finish within its time (1000 ms)."
    );
  });

  it("moves on from a handler that hangs past its time, never past the budget, and never retries it while it runs", async () => {
    let release: () => void = () => undefined;
    const k = register(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
      { timeoutMs: 1_000, maxAttempts: 2, backoff: { baseMs: 1_000, maxMs: 1_000 } }
    );
    const { id } = await store.enqueue({
      tenantId: A,
      kind: k,
      idempotencyKey: "h",
      maxAttempts: 2,
      source: "enqueue",
    });
    // On the timers the runner waits with, not the wall clock (review 10 L11): it answers when
    // the handler's 1 s runs out — not at the 4 s budget — while the handler still hangs.
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    let r!: Awaited<ReturnType<typeof runDue>>;
    try {
      let answered = false;
      const pending = runDue({ budgetMs: 4_000, kinds: [k], schedule: false, now }).then(
        (v) => {
          answered = true;
          r = v;
        }
      );
      await jest.advanceTimersByTimeAsync(900);
      expect(answered).toBe(false);
      await jest.advanceTimersByTimeAsync(1_100);
      await pending;
      expect(answered).toBe(true);
    } finally {
      jest.useRealTimers();
    }
    expect(r).toMatchObject({ claimed: 1, retried: 0, hung: 1 });
    expect(hungJobCount()).toBe(1);
    // Still running: still leased (extended), so nothing claims it again — though a retry
    // would long have been due (its backoff is a second).
    expect(await store.getJob(id)).toMatchObject({ status: "running", attempts: 1 });
    clock += 20_000;
    expect((await run([k])).claimed).toBe(0);
    // When it finally settles, it is settled as timed out and retried.
    release();
    await settleHungJobs();
    expect(await store.getJob(id)).toMatchObject({
      status: "queued",
      lastError: "The job did not finish within its time (1000 ms).",
    });
  });

  it("claims nothing whose attempt would not fit in what is left of the budget", async () => {
    const k = register(async () => undefined, { timeoutMs: 30_000 });
    await store.enqueue({
      tenantId: A,
      kind: k,
      idempotencyKey: "b",
      maxAttempts: 1,
      source: "enqueue",
    });
    const r = await runDue({ budgetMs: 20_000, kinds: [k], schedule: false });
    expect(r).toMatchObject({ claimed: 0, stoppedBy: "budget" });
  });

  it("stops at the budget even with work left, and the rest waits for the next tick", async () => {
    const k = register(
      async () => {
        clock += 9_000;
      },
      { timeoutMs: 5_000 }
    );
    for (let i = 0; i < 5; i++) {
      await store.enqueue({
        tenantId: A,
        kind: k,
        idempotencyKey: `w${i}`,
        maxAttempts: 1,
        source: "enqueue",
      });
    }
    const r = await run([k], { budgetMs: 20_000 });
    expect(r.stoppedBy).toBe("budget");
    expect(r.succeeded).toBeLessThan(5);
    expect((await store.listJobs({ kind: k, status: "queued" })).length).toBe(
      5 - r.succeeded
    );
  });

  it("refuses a budget outside 1 s – 14 min", async () => {
    await expect(runDue({ budgetMs: 999 })).rejects.toThrow(RangeError);
    await expect(runDue({ budgetMs: 15 * 60_000 })).rejects.toThrow(RangeError);
  });

  it("enqueues the next part once when a handler's batch was full", async () => {
    const payloads: unknown[] = [];
    const k = register(async (ctx) => {
      payloads.push(ctx.payload);
      return payloads.length === 1 ? { continueWith: { after: "g1" } } : {};
    });
    await store.enqueue({
      tenantId: A,
      kind: k,
      idempotencyKey: "c",
      maxAttempts: 1,
      source: "schedule",
    });
    const r = await run([k]);
    expect(r).toMatchObject({ succeeded: 2, continued: 1 });
    expect(payloads).toEqual([{}, { after: "g1" }]);
    const jobs = await store.listJobs({ kind: k });
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((j) => j.source === "schedule" && j.tenantId === A)).toBe(true);
  });

  it("reports a lost lease rather than claiming success", async () => {
    const k = register(async () => undefined);
    await store.enqueue({
      tenantId: A,
      kind: k,
      idempotencyKey: "l",
      maxAttempts: 1,
      source: "enqueue",
    });
    const lossy: JobStore = Object.assign(Object.create(store), {
      complete: async () => false,
    });
    const r = await run([k], { store: lossy });
    expect(r).toMatchObject({ claimed: 1, succeeded: 0, lostLease: 1 });
  });

  it("ends the tick when the store cannot claim, or cannot settle", async () => {
    const k = register(async () => undefined);
    const broken: JobStore = Object.assign(Object.create(store), {
      claim: async () => {
        throw new DataUnavailableError("down");
      },
    });
    expect(await run([k], { store: broken })).toMatchObject({ claimed: 0 });

    await store.enqueue({
      tenantId: A,
      kind: k,
      idempotencyKey: "s",
      maxAttempts: 1,
      source: "enqueue",
    });
    const unsettled: JobStore = Object.assign(Object.create(store), {
      complete: async () => {
        throw new DataUnavailableError("down");
      },
    });
    expect(await run([k], { store: unsettled })).toMatchObject({
      claimed: 1,
      succeeded: 0,
    });
  });

  it("recovers a job whose worker died: the lease lapses and another worker takes it", async () => {
    const k = register(async () => undefined, { timeoutMs: 1_000 });
    const { id } = await store.enqueue({
      tenantId: A,
      kind: k,
      idempotencyKey: "d",
      maxAttempts: 3,
      source: "enqueue",
    });
    const [held] = await store.claim({
      workerId: "dead",
      kinds: [k],
      limit: 1,
      leaseMs: 5_000,
    });
    expect(held.id).toBe(id);
    expect((await run([k])).claimed).toBe(0);
    clock += 6_000;
    const r = await run([k]);
    expect(r).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await store.getJob(id)).toMatchObject({ status: "succeeded", attempts: 2 });
    // The dead worker's late settle changes nothing.
    expect(await store.complete(held)).toBe(false);
  });

  it("dead-letters a job whose lease lapsed on its last attempt", async () => {
    const k = register(async () => undefined);
    const { id } = await store.enqueue({
      tenantId: A,
      kind: k,
      idempotencyKey: "z",
      maxAttempts: 1,
      source: "enqueue",
    });
    await store.claim({ workerId: "dead", kinds: [k], limit: 1, leaseMs: 5_000 });
    clock += 6_000;
    expect((await run([k])).claimed).toBe(0);
    expect((await store.getJob(id))?.status).toBe("dead");
    expect((await store.getJob(id))?.lastError).toMatch(/lease expired/);
  });

  it("does not run a suspended tenant's jobs", async () => {
    const only: InMemoryJobStore = new InMemoryJobStore({
      now,
      activeTenants: async () => [A],
    });
    const k = register(async () => undefined);
    await only.enqueue({
      tenantId: B,
      kind: k,
      idempotencyKey: "s",
      maxAttempts: 1,
      source: "enqueue",
    });
    expect((await run([k], { store: only })).claimed).toBe(0);
  });
});

// ── Scheduling ─────────────────────────────────────────────────────────

describe("runDue scheduling", () => {
  it("takes each due slot once, for every active tenant or the platform", async () => {
    const perTenant = register(async () => undefined, {
      schedule: {
        scope: "each-tenant",
        defaultIntervalMinutes: 10,
        minIntervalMinutes: 5,
        maxIntervalMinutes: 60,
      },
    });
    const platform = register(async () => undefined, {
      schedule: {
        scope: "platform",
        defaultIntervalMinutes: 10,
        minIntervalMinutes: 5,
        maxIntervalMinutes: 60,
      },
    });
    const first = await run([perTenant, platform], { schedule: true });
    // Single-tenant deployment (the test default): the one tenant only.
    expect(first.scheduled).toEqual([
      { kind: perTenant, enqueued: 1 },
      { kind: platform, enqueued: 1 },
    ]);
    expect(first.succeeded).toBe(2);
    const again = await run([perTenant, platform], { schedule: true });
    expect(again.scheduled).toEqual([]);
    const jobs = await store.listJobs({ kind: perTenant });
    expect(jobs.map((j) => j.tenantId)).toEqual([DEFAULT_TENANT_ID]);
    const state = (await store.listSchedules()).find((s) => s.kind === perTenant);
    expect(state).toMatchObject({ lastStatus: "succeeded", lastEnqueued: 1 });
  });

  it("reaches every active tenant in a shared deployment", async () => {
    const saved = process.env.TENANCY_MODE;
    process.env.TENANCY_MODE = "shared";
    try {
      const k = register(async () => undefined, {
        schedule: {
          scope: "each-tenant",
          defaultIntervalMinutes: 10,
          minIntervalMinutes: 5,
          maxIntervalMinutes: 60,
        },
      });
      const r = await run([k], { schedule: true });
      expect(r.scheduled).toEqual([{ kind: k, enqueued: 3 }]);
      expect(r.succeeded).toBe(3);
    } finally {
      if (saved === undefined) delete process.env.TENANCY_MODE;
      else process.env.TENANCY_MODE = saved;
    }
  });

  it("counts a slot it could not take, and goes on", async () => {
    const k = register(async () => undefined, {
      schedule: {
        scope: "platform",
        defaultIntervalMinutes: 10,
        minIntervalMinutes: 5,
        maxIntervalMinutes: 60,
      },
    });
    const broken: JobStore = Object.assign(Object.create(store), {
      takeScheduleSlot: async () => {
        throw new DataUnavailableError("down");
      },
    });
    const r = await run([k], { schedule: true, store: broken });
    expect(r.scheduleErrors).toBe(1);
  });

  it("skips scheduling when the budget is nearly spent", async () => {
    const k = register(async () => undefined, {
      schedule: {
        scope: "platform",
        defaultIntervalMinutes: 10,
        minIntervalMinutes: 5,
        maxIntervalMinutes: 60,
      },
    });
    const r = await runDue({ budgetMs: 2_000, kinds: [k], now });
    expect(r.scheduled).toEqual([]);
  });

  it("takes a slot for every core duty and module job (a full tick, no work fitting)", async () => {
    const r = await runDue({ budgetMs: 3_500, now });
    expect(r.scheduled.map((s) => s.kind).sort()).toEqual(
      listScheduledJobs()
        .map((d) => d.kind)
        .sort()
    );
    expect(r.claimed).toBe(0);
  });
});
