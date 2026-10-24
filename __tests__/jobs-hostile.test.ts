/**
 * @jest-environment node
 */
/**
 * platform/jobs under a hostile review (R4–R6 review, findings 1, 3, 4, 6, 7, 13): each test
 * began as the reviewer's proof of a defect and now asserts the fixed behaviour.
 *
 *   - a timed-out handler that ignores its signal never runs beside its own retry: its lease is
 *     kept while it runs, and it is settled when it settles (finding 3);
 *   - code in tenant A cannot put work into tenant B, and nobody can forge the authority that
 *     may (finding 4);
 *   - a platform kind is never a tenant's job, a per-tenant kind never a platform job, an
 *     unregistered kind never a job (finding 4);
 *   - a stopping instance claims nothing; one that starts stopping mid-tick hands back what it
 *     has not started and asks the running attempt to stop (finding 1);
 *   - a backdated job cannot jump the queue, and one tenant's backlog cannot starve another's
 *     job (finding 6);
 *   - a legal obligation (runsForSuspended) runs for a suspended tenant; nothing else does
 *     (finding 7);
 *   - a kind whose attempt cannot fit in a tick is refused at boot, by name (finding 13).
 */

import { randomUUID } from "node:crypto";
import {
  checkJobsFitTick,
  defineJob,
  enqueueJob,
  hungJobCount,
  InMemoryJobStore,
  JobEnqueueError,
  JobDefinitionError,
  JobTickFitError,
  operatorJobAuthority,
  registerJob,
  resetJobRegistry,
  resetJobStore,
  runDue,
  setJobStore,
  settleHungJobs,
  TICK_MAX_TIMEOUT_MS,
  type JobAuthority,
  type JobContext,
} from "@/platform/jobs";
import { markDraining, resetShutdownState } from "@/platform/observability/shutdown";
import { DEFAULT_TENANT_ID, peekTenant, runWithTenant } from "@/platform/tenancy/context";

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const S = "cccccccc-0000-4000-8000-00000000000c";

let clock = Date.parse("2026-10-24T00:00:00Z");
const now = () => clock;
let store: InMemoryJobStore;

const operator = operatorJobAuthority({
  userId: "11111111-0000-4000-8000-000000000001",
  sub: "op",
  roleName: "operator",
  permissions: ["platform_operate"],
})!;

beforeEach(() => {
  clock = Date.parse("2026-10-24T00:00:00Z");
  store = new InMemoryJobStore({
    now,
    activeTenants: async () => [A, B, DEFAULT_TENANT_ID],
    suspendedTenants: async () => [S],
  });
  setJobStore(store);
});
afterEach(async () => {
  await settleHungJobs();
  resetJobRegistry();
  resetJobStore();
  resetShutdownState();
});

const kind = () => `test.k${randomUUID().slice(0, 8)}`;
const inA = <T>(fn: () => Promise<T>) =>
  runWithTenant({ tenantId: A, mode: "shared" }, fn);
const run = (kinds: string[], extra: Partial<Parameters<typeof runDue>[0]> = {}) =>
  runDue({
    budgetMs: 60_000,
    kinds,
    schedule: false,
    now,
    random: () => 0.5,
    hungWaitMs: 50,
    ...extra,
  });

describe("finding 3 — a timed-out handler never runs beside its own retry", () => {
  it("keeps the lease of a handler that ignores its signal, and settles it when it settles", async () => {
    const k = kind();
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const releases: (() => void)[] = [];
    registerJob(
      k,
      async () => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((r) => releases.push(r)); // never looks at ctx.signal
        active--;
      },
      { description: "zombie", timeoutMs: 1000, backoff: { baseMs: 1000, maxMs: 1000 } }
    );
    await inA(() => enqueueJob(k, { idempotencyKey: "z" }));

    const r1 = await run([k]);
    expect(r1).toMatchObject({ claimed: 1, retried: 0, hung: 1 });
    expect(hungJobCount()).toBe(1);

    clock += 2000; // past the retry delay a settled failure would have had
    const r2 = await run([k]);
    expect(r2.claimed).toBe(0); // still leased: the zombie holds it

    releases.shift()!();
    await settleHungJobs();
    expect((await store.listJobs({ kind: k }))[0]).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: "The job did not finish within its time (1000 ms).",
    });

    clock += 2000;
    const r3 = run([k]);
    await new Promise((r) => setTimeout(r, 20));
    releases.shift()?.();
    await r3;
    await settleHungJobs();
    expect(calls).toBe(2);
    expect(maxActive).toBe(1); // never two copies at once
  }, 15_000);
});

describe("finding 4 — a job is bound to its caller's tenant and its kind's scope", () => {
  it("refuses code in tenant A enqueuing into tenant B", async () => {
    const k = kind();
    let ranIn: string | undefined;
    registerJob(
      k,
      async () => {
        ranIn = peekTenant()?.tenantId;
      },
      { description: "x" }
    );
    await expect(
      inA(() =>
        enqueueJob(k, { idempotencyKey: "x", tenantId: B, payload: { injected: true } })
      )
    ).rejects.toThrow(JobEnqueueError);
    expect(store.size()).toBe(0);
    await run([k]);
    expect(ranIn).toBeUndefined();
  });

  it("refuses a forged authority; accepts an operator's, and the runner's in a platform job", async () => {
    const k = kind();
    registerJob(k, async () => undefined, { description: "x" });
    const forged = { holder: "runner" } as JobAuthority;
    await expect(
      inA(() => enqueueJob(k, { idempotencyKey: "f", tenantId: B, authority: forged }))
    ).rejects.toThrow(/authority is not one the platform issued/);
    await expect(
      inA(() => enqueueJob(k, { idempotencyKey: "o", tenantId: B, authority: operator }))
    ).resolves.toMatchObject({ created: true });
    // Nobody but the runner holds the runner's authority: a second claim throws.
    const { claimRunnerAuthority } = await import("@/platform/jobs/authority");
    expect(() => claimRunnerAuthority()).toThrow(/already held/);
    // An admin without platform_operate is given no authority.
    expect(
      operatorJobAuthority({
        userId: "u",
        sub: "s",
        roleName: "moderator",
        permissions: ["content_review"],
      })
    ).toBeNull();
    // A platform job's handler holds the runner's authority and may fan out; a tenant's holds none.
    const fan = kind();
    const seen: (JobAuthority | null)[] = [];
    registerJob(
      fan,
      async (ctx: JobContext) => {
        seen.push(ctx.authority);
        if (ctx.authority) {
          await enqueueJob(k, {
            idempotencyKey: "from-platform",
            tenantId: B,
            authority: ctx.authority,
          });
        }
      },
      { description: "fan", scope: "platform" }
    );
    await enqueueJob(fan, { idempotencyKey: "p", authority: operator });
    await run([fan]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBeNull();
    const each = kind();
    registerJob(
      each,
      async (ctx: JobContext) => {
        seen.push(ctx.authority);
      },
      { description: "each" }
    );
    await inA(() => enqueueJob(each, { idempotencyKey: "e" }));
    await run([each]);
    expect(seen[1]).toBeNull();
    expect((await store.listJobs({ kind: k })).map((j) => j.tenantId).sort()).toEqual([
      B,
      B,
    ]);
  });

  it("refuses a platform kind for a tenant, a per-tenant kind as a platform job, and an unknown kind", async () => {
    const plat = kind();
    const each = kind();
    const seen: (string | null | undefined)[] = [];
    registerJob(
      plat,
      async (c: JobContext) => {
        seen.push(c.tenantId);
      },
      {
        description: "p",
        schedule: {
          scope: "platform",
          defaultIntervalMinutes: 60,
          minIntervalMinutes: 15,
          maxIntervalMinutes: 1440,
        },
      }
    );
    registerJob(
      each,
      async () => {
        seen.push(peekTenant()?.tenantId);
      },
      {
        description: "e",
        schedule: {
          scope: "each-tenant",
          defaultIntervalMinutes: 60,
          minIntervalMinutes: 15,
          maxIntervalMinutes: 1440,
        },
      }
    );
    await inA(async () => {
      // A platform job, from tenant A's code (no authority): refused.
      await expect(enqueueJob(plat, { idempotencyKey: "p" })).rejects.toThrow(
        /platform job kind: enqueuing it needs/
      );
      // A platform kind for a tenant, even with authority: refused.
      await expect(
        enqueueJob(plat, { idempotencyKey: "p", tenantId: A, authority: operator })
      ).rejects.toThrow(/never enqueued for a tenant/);
      // A tenant job with no tenant: refused.
      await expect(
        enqueueJob(each, { idempotencyKey: "e", tenantId: null })
      ).rejects.toThrow(/never enqueued as a platform job/);
      await expect(enqueueJob("test.nobody", { idempotencyKey: "n" })).rejects.toThrow(
        JobDefinitionError
      );
    });
    expect(store.size()).toBe(0);
    await run([plat, each]);
    expect(seen).toEqual([]);
  });

  it("refuses a kind whose declared scope disagrees with its schedule", () => {
    expect(() =>
      defineJob("test.mixed", async () => undefined, {
        description: "x",
        scope: "platform",
        schedule: {
          scope: "each-tenant",
          defaultIntervalMinutes: 60,
          minIntervalMinutes: 15,
          maxIntervalMinutes: 1440,
        },
      })
    ).toThrow(/differs from its schedule/);
    expect(() =>
      defineJob("test.mixed", async () => undefined, {
        description: "x",
        scope: "platform",
        runsForSuspended: true,
      })
    ).toThrow(/only a per-tenant kind runs for suspended tenants/);
  });
});

describe("finding 1 — a stopping instance claims nothing more and hands back what it has not started", () => {
  it("claims nothing once the instance is draining", async () => {
    const k = kind();
    let calls = 0;
    registerJob(
      k,
      async () => {
        calls++;
      },
      { description: "d" }
    );
    await inA(() => enqueueJob(k, { idempotencyKey: "d" }));
    markDraining();
    const r = await run([k], { schedule: true });
    expect(calls).toBe(0);
    expect(r).toMatchObject({ claimed: 0, stoppedBy: "draining", scheduled: [] });
    expect((await store.listJobs({ kind: k }))[0].status).toBe("queued");
  });

  it("asks the running attempt to stop, and hands back the batch's unstarted jobs unrun", async () => {
    const k = kind();
    const started: string[] = [];
    registerJob(
      k,
      async (ctx: JobContext) => {
        started.push(ctx.jobId);
        markDraining(Date.now() + 5_000);
        // A cooperative handler: stops at the next item, by throwing.
        if (ctx.signal.aborted) throw new Error("stopping");
      },
      { description: "d", timeoutMs: 5_000 }
    );
    for (let i = 0; i < 3; i++) {
      await inA(() => enqueueJob(k, { idempotencyKey: `d${i}` }));
    }
    const r = await run([k]);
    expect(started).toHaveLength(1);
    expect(r).toMatchObject({ claimed: 1, released: 3, stoppedBy: "draining" });
    // Every job is queued again, no attempt spent.
    const jobs = await store.listJobs({ kind: k });
    expect(jobs.map((j) => [j.status, j.attempts])).toEqual([
      ["queued", 0],
      ["queued", 0],
      ["queued", 0],
    ]);
  });
});

describe("finding 6 — no queue-jumping, no starvation", () => {
  it("clamps a backdated run_at to now: it runs after work that was due first", async () => {
    const k = kind();
    const order: string[] = [];
    registerJob(
      k,
      async (ctx: JobContext) => {
        order.push(String(ctx.payload.n));
      },
      { description: "q" }
    );
    await inA(() => enqueueJob(k, { idempotencyKey: "first", payload: { n: "first" } }));
    clock += 1_000;
    const late = await inA(() =>
      enqueueJob(k, {
        idempotencyKey: "q",
        runAt: new Date(0),
        payload: { n: "backdated" },
      })
    );
    expect(late.created).toBe(true);
    const rec = await store.getJob(late.id);
    expect(Date.parse(rec!.runAt)).toBe(clock);
    await run([k]);
    expect(order).toEqual(["first", "backdated"]);
  });

  it("serves another tenant's job before the rest of one tenant's backlog", async () => {
    const k = kind();
    const ran: string[] = [];
    registerJob(
      k,
      async () => {
        ran.push(peekTenant()!.tenantId);
      },
      { description: "fair" }
    );
    for (let i = 0; i < 25; i++)
      await inA(() => enqueueJob(k, { idempotencyKey: `a${i}` }));
    clock += 1_000;
    await runWithTenant({ tenantId: B, mode: "shared" }, () =>
      enqueueJob(k, { idempotencyKey: "b" })
    );
    await run([k]);
    expect(ran).toHaveLength(26);
    // B's one job is among the first claimed batch, not after A's 25.
    expect(ran.indexOf(B)).toBeLessThan(2);
  });
});

describe("finding 7 — legal obligations run for a suspended tenant", () => {
  it("claims a runsForSuspended kind for a suspended tenant, and nothing else of it", async () => {
    const legal = kind();
    const other = kind();
    const ran: string[] = [];
    registerJob(
      legal,
      async () => {
        ran.push(`legal:${peekTenant()!.tenantId}`);
      },
      { description: "erasure", runsForSuspended: true }
    );
    registerJob(
      other,
      async () => {
        ran.push(`other:${peekTenant()!.tenantId}`);
      },
      { description: "digest" }
    );
    for (const k of [legal, other]) {
      await enqueueJob(k, { idempotencyKey: "s", tenantId: S, authority: operator });
    }
    await run([legal, other]);
    expect(ran).toEqual([`legal:${S}`]);
  });

  it("a runsForSuspended schedule reaches suspended tenants; others reach active ones only", async () => {
    const saved = process.env.TENANCY_MODE;
    process.env.TENANCY_MODE = "shared";
    try {
      const schedule = {
        scope: "each-tenant" as const,
        defaultIntervalMinutes: 60,
        minIntervalMinutes: 15,
        maxIntervalMinutes: 1440,
      };
      const legal = kind();
      const other = kind();
      registerJob(legal, async () => undefined, {
        description: "erasure",
        runsForSuspended: true,
        schedule,
      });
      registerJob(other, async () => undefined, { description: "digest", schedule });
      const r = await run([legal, other], { schedule: true });
      expect(r.scheduled).toEqual([
        { kind: legal, enqueued: 4 },
        { kind: other, enqueued: 3 },
      ]);
    } finally {
      if (saved === undefined) delete process.env.TENANCY_MODE;
      else process.env.TENANCY_MODE = saved;
    }
  });
});

describe("finding 13 — a kind no tick can claim is refused at boot", () => {
  const long = () =>
    defineJob("test.long", async () => undefined, {
      description: "too long",
      timeoutMs: TICK_MAX_TIMEOUT_MS + 1,
    });
  const fits = () =>
    defineJob("test.fits", async () => undefined, {
      description: "fits",
      timeoutMs: TICK_MAX_TIMEOUT_MS,
    });

  it.each(["vercel", "container"])("refuses it on %s, naming the kind", (host) => {
    const env = { NODE_ENV: "production", DEPLOYMENT_HOST: host };
    expect(() => checkJobsFitTick([fits(), long()], env)).toThrow(JobTickFitError);
    expect(() => checkJobsFitTick([long()], env)).toThrow(
      new RegExp(`Job "test\\.long": timeoutMs ${TICK_MAX_TIMEOUT_MS + 1} .* on ${host}`)
    );
    expect(() => checkJobsFitTick([fits()], env)).not.toThrow();
  });

  it("refuses nothing outside a deployment", () => {
    expect(() => checkJobsFitTick([long()], { NODE_ENV: "test" })).not.toThrow();
    expect(() =>
      checkJobsFitTick([long()], { NODE_ENV: "production", DEPLOYMENT_HOST: "ci" })
    ).not.toThrow();
  });
});
