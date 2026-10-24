/**
 * @jest-environment node
 */
/**
 * PostgresMetricsSink against the replayed database (ADR-014, ADR-053 D4): the conformance kit
 * inside one tenant, isolation between tenants, every query filter, flushes that run outside
 * any tenant (the timer) writing each event in the tenant it was recorded in, metrics recorded
 * with no tenant dropped and counted without throwing, and a failed write never thrown.
 */

import { runMetricsSinkContract } from "../contract/metrics-sink-contract";
import { runTenantIsolationContract } from "../contract/tenant-isolation-contract";
import {
  PostgresMetricsSink,
  createMetricsSink,
} from "@/platform/observability/metrics-sink";
import type { MetricEvent } from "@/platform/observability/types";
import { runWithoutTenant } from "@/platform/tenancy/context";
import { withOwnerTx, withTenantTx } from "@/platform/data";
import { logger } from "@/lib/logger";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  inTenant,
} from "../helpers/db";

const event = (name: string, over: Partial<MetricEvent> = {}): MetricEvent => ({
  name,
  timestamp: new Date().toISOString(),
  values: { latencyMs: 12 },
  tags: { provider: "db" },
  ...over,
});

async function rowsFor(tenantId: string): Promise<Array<{ name: string }>> {
  const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
    tx.query<{ name: string }>(
      "select name from ai_metrics where tenant_id = $1::uuid order by name",
      [tenantId]
    )
  );
  return rows;
}

dbDescribe("PostgresMetricsSink", () => {
  const sinks: PostgresMetricsSink[] = [];
  const make = (): PostgresMetricsSink => {
    const s = new PostgresMetricsSink();
    sinks.push(s);
    return s;
  };

  beforeAll(connectTestDatabase);
  afterEach(() => {
    jest.restoreAllMocks();
    for (const s of sinks.splice(0)) s.destroy();
  });
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  runMetricsSinkContract({
    makeSink: async () => inTenant(make(), await createTestTenant()),
  });

  runTenantIsolationContract({
    name: "ai_metrics",
    makeStore: make,
    createTenant: createTestTenant,
    write: async (sink, key) => {
      sink.record(event(key));
      await sink.flush();
    },
    read: async (sink, key) => {
      const r = await sink.query({ name: key });
      return r.length > 0 ? r : null;
    },
    // Without a tenant the sink neither throws nor writes: see the no-tenant tests below.
    failsClosedWithoutTenant: false,
  });

  it("round-trips every field and filters by name, time, tags and limit (newest first)", async () => {
    const tenant = await createTestTenant();
    const sink = inTenant(make(), tenant);
    sink.record(
      event("q.a", {
        timestamp: "2026-10-01T00:00:00.000Z",
        traceId: "trace-1",
        values: { inputTokens: 10, estimatedCostUsd: 0.25 },
        tags: { model: "m1", tier: "fast" },
      })
    );
    sink.record(
      event("q.a", { timestamp: "2026-10-02T00:00:00.000Z", tags: { model: "m2" } })
    );
    sink.record(
      event("q.a", { timestamp: "2026-10-03T00:00:00.000Z", tags: { model: "m1" } })
    );
    sink.record(event("q.b", { timestamp: "2026-10-04T00:00:00.000Z" }));
    await sink.flush();

    const all = await sink.query({});
    expect(all.map((e) => e.timestamp)).toEqual([
      "2026-10-04T00:00:00.000Z",
      "2026-10-03T00:00:00.000Z",
      "2026-10-02T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
    ]);
    expect(all[3]).toEqual({
      name: "q.a",
      timestamp: "2026-10-01T00:00:00.000Z",
      traceId: "trace-1",
      values: { inputTokens: 10, estimatedCostUsd: 0.25 },
      tags: { model: "m1", tier: "fast" },
    });
    expect(all[0].traceId).toBeUndefined();

    expect((await sink.query({ name: "q.a" })).length).toBe(3);
    expect(
      (await sink.query({ name: "q.a", since: "2026-10-02T00:00:00.000Z" })).map(
        (e) => e.timestamp
      )
    ).toEqual(["2026-10-03T00:00:00.000Z", "2026-10-02T00:00:00.000Z"]);
    expect((await sink.query({ tags: { model: "m1" } })).length).toBe(2);
    expect((await sink.query({ tags: { model: "m1", tier: "fast" } })).length).toBe(1);
    expect((await sink.query({ limit: 1 })).map((e) => e.name)).toEqual(["q.b"]);
    expect((await sink.query({ limit: 0 })).length).toBe(4); // 0 = no limit, as before
    expect(await sink.query({ name: "q.none" })).toEqual([]);
  });

  it("a flush outside any tenant (the timer) writes each event in the tenant it was recorded in", async () => {
    const [a, b] = [await createTestTenant(), await createTestTenant()];
    const sink = make();
    a.run(() => sink.record(event("timer.a")));
    b.run(() => sink.record(event("timer.b1")));
    b.run(() => sink.record(event("timer.b2")));
    await runWithoutTenant(() => sink.flush());
    expect(await rowsFor(a.id)).toEqual([{ name: "timer.a" }]);
    expect(await rowsFor(b.id)).toEqual([{ name: "timer.b1" }, { name: "timer.b2" }]);
  });

  it("flushes a full batch on its own, without joining the caller's transaction", async () => {
    const [a, b] = [await createTestTenant(), await createTestTenant()];
    const sink = make();
    for (let i = 0; i < 49; i++) b.run(() => sink.record(event("batch.b")));
    // The 50th is recorded inside tenant A's open transaction: the flush it starts must run on
    // its own connection, not join (or be refused by) A's transaction.
    const warn = jest.spyOn(logger, "warn");
    await a.run(() =>
      withTenantTx(async () => {
        sink.record(event("batch.a"));
      })
    );
    for (let i = 0; i < 100 && (await rowsFor(b.id)).length < 49; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await rowsFor(b.id)).length).toBe(49);
    expect(await rowsFor(a.id)).toEqual([{ name: "batch.a" }]);
    expect(warn).not.toHaveBeenCalledWith("Metrics flush failed", expect.anything());
  });

  it("drops a metric recorded with no tenant: not thrown, not written, counted and logged", async () => {
    const tenant = await createTestTenant();
    const sink = make();
    const warn = jest.spyOn(logger, "warn");
    runWithoutTenant(() => {
      expect(() => sink.record(event("platform.boot"))).not.toThrow();
    });
    for (let i = 0; i < 99; i++)
      runWithoutTenant(() => sink.record(event("platform.boot")));
    expect(sink.droppedWithoutTenant).toBe(100);
    // The first drop and the 100th are logged, not each one.
    const logged = warn.mock.calls.filter(([m]) => /outside any tenant/.test(String(m)));
    expect(
      logged.map(
        ([, meta]) => (meta as { droppedWithoutTenant: number }).droppedWithoutTenant
      )
    ).toEqual([1, 100]);
    await runWithoutTenant(() => sink.flush());
    await expect(
      tenant.run(() => sink.query({ name: "platform.boot" }))
    ).resolves.toEqual([]);
    const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query("select 1 from ai_metrics where name = $1", ["platform.boot"])
    );
    expect(rows).toEqual([]);
  });

  it("query with no tenant returns [] rather than throwing", async () => {
    const sink = make();
    const warn = jest.spyOn(logger, "warn");
    await expect(runWithoutTenant(() => sink.query({}))).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith("Metrics query failed", expect.anything());
  });

  it("a write the database refuses is logged and dropped, never thrown; other tenants' events still land", async () => {
    const [a, b] = [await createTestTenant(), await createTestTenant()];
    const sink = make();
    const warn = jest.spyOn(logger, "warn");
    a.run(() => sink.record(event("   "))); // ai_metrics_name_not_blank refuses it
    b.run(() => sink.record(event("ok.b")));
    await expect(runWithoutTenant(() => sink.flush())).resolves.toBeUndefined();
    expect(await rowsFor(a.id)).toEqual([]);
    expect(await rowsFor(b.id)).toEqual([{ name: "ok.b" }]);
    expect(warn).toHaveBeenCalledWith(
      "Metrics flush failed",
      expect.objectContaining({ tenantId: a.id, droppedCount: 1 })
    );
  });

  it("the factory builds it when a database is configured", () => {
    const sink = createMetricsSink();
    expect(sink).toBeInstanceOf(PostgresMetricsSink);
    (sink as PostgresMetricsSink).destroy();
  });
});
