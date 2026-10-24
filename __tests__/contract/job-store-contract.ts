/**
 * __tests__/contract/job-store-contract.ts — JobStore conformance (ADR-027, ADR-056 D2)
 *
 * What every job store must guarantee for background work to be safe:
 *   - enqueue is idempotent per tenant and kind: a repeat is the same job; the same key in
 *     another tenant (or for the platform) is another job;
 *   - two concurrent claims never receive the same job, and a claim takes only the kinds asked
 *     for and only due jobs;
 *   - a settle names its lease: a stale token changes nothing;
 *   - retry queues another attempt at its time; bury dead-letters; a dead job is replayed from
 *     its first attempt once (a second replay finds it not dead) or discarded;
 *   - a tenant's administrators see their own tenant's jobs only;
 *   - a schedule slot is taken once, and its jobs are enqueued with it; a shortened interval
 *     makes the slot due at the last run plus the new interval, not a slot later;
 *   - a schedule's outcome is kept per tenant, and its summary is the worst of them: one
 *     tenant's success never hides another's failure;
 *   - a fan-out enqueues one job per tenant in one step;
 *   - release hands a held job back unrun (its attempt not counted); extendLease keeps it held;
 *   - a job is never due before it was enqueued (a past runAt is clamped to now);
 *   - a claim takes tenants in turn: one tenant's backlog cannot starve another's job;
 *   - prune removes old succeeded jobs only.
 *
 * Kinds are prefixed per run, so a store shared with other suites (the database) is not
 * disturbed by, and does not disturb, anything else.
 */

import { randomUUID } from "node:crypto";
import type { ClaimedJob, EnqueueRequest, JobStore } from "@/platform/jobs/types";

export interface JobStoreContractFixtures {
  /** A store for the test (may be shared across tests: kinds are unique per test). */
  makeStore: () => JobStore | Promise<JobStore>;
  /** Two tenants the store knows as active, and a way to run as each. */
  tenants: () => {
    readonly a: { readonly id: string; run<T>(fn: () => T): T };
    readonly b: { readonly id: string; run<T>(fn: () => T): T };
  };
}

const WORKER = "kit-worker";

export function runJobStoreContract(fx: JobStoreContractFixtures): void {
  let store: JobStore;
  let kind: string;
  let other: string;

  const req = (overrides: Partial<EnqueueRequest> = {}): EnqueueRequest => ({
    tenantId: fx.tenants().a.id,
    kind,
    idempotencyKey: "k1",
    maxAttempts: 3,
    source: "enqueue",
    runAt: new Date(Date.now() - 1000),
    ...overrides,
  });
  const claim = (kinds = [kind], limit = 10) =>
    store.claim({ workerId: WORKER, kinds, limit, leaseMs: 60_000 });

  beforeEach(async () => {
    store = await fx.makeStore();
    const run = randomUUID().slice(0, 8);
    kind = `kit.k${run}`;
    other = `kit.o${run}`;
  });

  it("enqueue is idempotent per tenant and kind", async () => {
    const first = await store.enqueue(req());
    const again = await store.enqueue(req({ payload: { different: true } }));
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false });
  });

  it("the same key in another tenant, or for the platform, is another job", async () => {
    const { a, b } = fx.tenants();
    const inA = await store.enqueue(req({ tenantId: a.id }));
    const inB = await store.enqueue(req({ tenantId: b.id }));
    const platform = await store.enqueue(req({ tenantId: null }));
    const platformAgain = await store.enqueue(req({ tenantId: null }));
    expect(new Set([inA.id, inB.id, platform.id]).size).toBe(3);
    expect([inA.created, inB.created, platform.created]).toEqual([true, true, true]);
    expect(platformAgain).toEqual({ id: platform.id, created: false });
  });

  it("claims only due jobs of the kinds asked for, and counts the attempt", async () => {
    await store.enqueue(req({ idempotencyKey: "due" }));
    await store.enqueue(
      req({ idempotencyKey: "later", runAt: new Date(Date.now() + 3_600_000) })
    );
    await store.enqueue(req({ kind: other, idempotencyKey: "other" }));
    const claimed = await claim();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      kind,
      attempts: 1,
      maxAttempts: 3,
      tenantId: fx.tenants().a.id,
      source: "enqueue",
    });
    expect(claimed[0].leaseToken).toEqual(expect.any(String));
    expect(await claim()).toEqual([]);
  });

  it("two concurrent claims never receive the same job", async () => {
    for (let i = 0; i < 12; i++) await store.enqueue(req({ idempotencyKey: `c${i}` }));
    const [x, y, z] = await Promise.all([
      claim([kind], 5),
      claim([kind], 5),
      claim([kind], 5),
    ]);
    const ids = [...x, ...y, ...z].map((j) => j.id);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
  });

  it("completes a job it holds; a stale lease changes nothing", async () => {
    await store.enqueue(req());
    const [job] = await claim();
    const stale: ClaimedJob = { ...job, leaseToken: randomUUID() };
    expect(await store.complete(stale)).toBe(false);
    expect(await store.retry(stale, "x", new Date())).toBe(false);
    expect(await store.bury(stale, "x")).toBe(false);
    expect(await store.complete(job)).toBe(true);
    expect(await store.complete(job)).toBe(false);
    expect((await store.getJob(job.id))?.status).toBe("succeeded");
  });

  it("retry queues another attempt at its time, with the error recorded", async () => {
    await store.enqueue(req());
    const [job] = await claim();
    expect(
      await store.retry(job, "The job failed once.", new Date(Date.now() + 3_600_000))
    ).toBe(true);
    expect(await claim()).toEqual([]);
    const record = await store.getJob(job.id);
    expect(record).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: "The job failed once.",
    });
  });

  it("bury dead-letters; a dead job is replayed once from its first attempt", async () => {
    await store.enqueue(req());
    const [job] = await claim();
    expect(await store.bury(job, "It failed for good.")).toBe(true);
    expect(await store.getJob(job.id)).toMatchObject({
      status: "dead",
      lastError: "It failed for good.",
    });
    expect(await store.replay(job.id)).toBe("replayed");
    expect(await store.replay(job.id)).toBe("not_dead");
    const [again] = await claim();
    expect(again).toMatchObject({ id: job.id, attempts: 1, source: "replay" });
  });

  it("discards only a dead job; unknown and malformed ids are not found", async () => {
    await store.enqueue(req());
    const [job] = await claim();
    expect(await store.discard(job.id)).toBe("not_dead");
    await store.bury(job, "dead");
    expect(await store.discard(job.id)).toBe("discarded");
    expect(await store.getJob(job.id)).toBeNull();
    expect(await store.discard(job.id)).toBe("not_found");
    expect(await store.replay(randomUUID())).toBe("not_found");
    expect(await store.replay("not-a-uuid")).toBe("not_found");
    expect(await store.getJob("not-a-uuid")).toBeNull();
  });

  it("a tenant sees only its own jobs", async () => {
    const { a, b } = fx.tenants();
    const inA = await store.enqueue(req({ tenantId: a.id, idempotencyKey: "a" }));
    const inB = await store.enqueue(req({ tenantId: b.id, idempotencyKey: "b" }));
    await store.enqueue(req({ tenantId: null, idempotencyKey: "p" }));
    const seenByA = (await a.run(() => store.listTenantJobs({ kind }))).map((j) => j.id);
    const seenByB = (await b.run(() => store.listTenantJobs({ kind }))).map((j) => j.id);
    expect(seenByA).toEqual([inA.id]);
    expect(seenByB).toEqual([inB.id]);
    const all = (await store.listJobs({ kind })).map((j) => j.id);
    expect(all).toHaveLength(3);
  });

  it("a schedule slot is taken once, with its jobs", async () => {
    const { a } = fx.tenants();
    const slot = {
      kind,
      scope: "each-tenant" as const,
      intervalMs: 3_600_000,
      maxAttempts: 2,
      now: new Date(),
      tenantIds: [a.id],
    };
    const [first, second] = await Promise.all([
      store.takeScheduleSlot(slot),
      store.takeScheduleSlot(slot),
    ]);
    const taken = [first, second].filter((r) => r !== null);
    expect(taken).toHaveLength(1);
    expect(taken[0]!.enqueued).toBe(1);
    const jobs = await store.listJobs({ kind });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ tenantId: a.id, source: "schedule", maxAttempts: 2 });
    const state = (await store.listSchedules()).find((s) => s.kind === kind);
    expect(state).toMatchObject({ lastEnqueued: 1, queued: 1 });
    await store.recordScheduleOutcome(kind, a.id, "dead", "It failed.");
    expect((await store.listSchedules()).find((s) => s.kind === kind)).toMatchObject({
      lastStatus: "dead",
      lastError: "It failed.",
      reported: 1,
      failing: 1,
    });
  });

  it("keeps each tenant's outcome: the last to finish never hides another's failure", async () => {
    const { a, b } = fx.tenants();
    await store.takeScheduleSlot({
      kind,
      scope: "each-tenant",
      intervalMs: 3_600_000,
      maxAttempts: 1,
      now: new Date(),
      tenantIds: [a.id, b.id],
    });
    await store.recordScheduleOutcome(kind, a.id, "dead", "A's purge failed.");
    await store.recordScheduleOutcome(kind, b.id, "succeeded", null);
    const state = (await store.listSchedules()).find((s) => s.kind === kind);
    expect(state).toMatchObject({
      lastStatus: "dead",
      lastError: "A's purge failed.",
      reported: 2,
      failing: 1,
    });
    // A later success in A clears its failure; B's retry is now the worst.
    await store.recordScheduleOutcome(kind, a.id, "succeeded", null);
    await store.recordScheduleOutcome(kind, b.id, "retrying", "B failed once.");
    expect((await store.listSchedules()).find((s) => s.kind === kind)).toMatchObject({
      lastStatus: "retrying",
      lastError: "B failed once.",
      failing: 1,
    });
    await store.recordScheduleOutcome(kind, b.id, "succeeded", null);
    expect((await store.listSchedules()).find((s) => s.kind === kind)).toMatchObject({
      lastStatus: "succeeded",
      lastError: null,
      failing: 0,
    });
  });

  it("a shortened interval makes the slot due at the last run plus the new interval", async () => {
    const slot = (intervalMs: number, at: Date) =>
      store.takeScheduleSlot({
        kind,
        scope: "platform",
        intervalMs,
        maxAttempts: 1,
        now: at,
      });
    expect(await slot(24 * 3_600_000, new Date())).not.toBeNull();
    // Not due under the long interval…
    expect(await slot(24 * 3_600_000, new Date())).toBeNull();
    // …due at once under a shorter one whose time since the last run has passed (1 s).
    await new Promise((r) => setTimeout(r, 1_100));
    expect(await slot(1_000, new Date())).not.toBeNull();
  });

  it("fans out one job per tenant reached, in one step; a repeat adds none", async () => {
    const { a, b } = fx.tenants();
    const request = {
      kind,
      scope: "each-tenant" as const,
      idempotencyKey: "manual:x",
      maxAttempts: 2,
      source: "manual" as const,
      runsForSuspended: false,
      tenantIds: [a.id, b.id],
    };
    expect(await store.fanOut(request)).toBe(2);
    expect(await store.fanOut(request)).toBe(0);
    const jobs = await store.listJobs({ kind });
    expect(jobs.map((j) => j.tenantId).sort()).toEqual([a.id, b.id].sort());
    expect(jobs.every((j) => j.source === "manual")).toBe(true);
    expect(
      await store.fanOut({ ...request, scope: "platform", tenantIds: undefined })
    ).toBe(1);
  });

  it("release hands a held job back unrun; extendLease keeps it held", async () => {
    await store.enqueue(req());
    const [job] = await claim();
    expect(await store.extendLease(job, 120_000)).toBe(true);
    expect(await claim()).toEqual([]);
    expect(await store.release(job)).toBe(true);
    expect(await store.release(job)).toBe(false);
    expect(await store.extendLease(job, 120_000)).toBe(false);
    expect(await store.getJob(job.id)).toMatchObject({ status: "queued", attempts: 0 });
    const [again] = await claim();
    expect(again).toMatchObject({ id: job.id, attempts: 1 });
  });

  it("never makes a job due before it was enqueued (a past runAt is clamped to now)", async () => {
    const before = Date.now();
    const { id } = await store.enqueue(req({ runAt: new Date(0) }));
    const runAt = Date.parse((await store.getJob(id))!.runAt);
    expect(runAt).toBeGreaterThanOrEqual(before - 1_000);
  });

  it("takes tenants in turn: one tenant's backlog cannot starve another's job", async () => {
    const { a, b } = fx.tenants();
    for (let i = 0; i < 8; i++) {
      await store.enqueue(req({ tenantId: a.id, idempotencyKey: `a${i}` }));
    }
    // B's one job was enqueued after all of A's.
    await new Promise((r) => setTimeout(r, 20));
    await store.enqueue(req({ tenantId: b.id, idempotencyKey: "b0" }));
    const firstTwo = await claim([kind], 2);
    expect(firstTwo.map((j) => j.tenantId).sort()).toEqual([a.id, b.id].sort());
  });

  it("a platform slot enqueues one job with no tenant", async () => {
    const r = await store.takeScheduleSlot({
      kind,
      scope: "platform",
      intervalMs: 3_600_000,
      maxAttempts: 1,
      now: new Date(),
    });
    expect(r?.enqueued).toBe(1);
    const jobs = await store.listJobs({ kind });
    expect(jobs.map((j) => j.tenantId)).toEqual([null]);
  });

  it("prune removes succeeded jobs finished before the cutoff, and nothing else", async () => {
    await store.enqueue(req({ idempotencyKey: "done" }));
    await store.enqueue(req({ idempotencyKey: "dead" }));
    const jobs = await claim();
    await store.complete(jobs[0]);
    await store.bury(jobs[1], "dead");
    expect(await store.prune(new Date(Date.now() - 3_600_000), 100)).toBe(0);
    const removed = await store.prune(new Date(Date.now() + 60_000), 100);
    expect(removed).toBeGreaterThanOrEqual(1);
    const left = await store.listJobs({ kind });
    expect(left.map((j) => j.status)).toEqual(["dead"]);
  });
}
