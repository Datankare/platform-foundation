/**
 * @jest-environment node
 */
/**
 * __tests__/db/data-layer.test.ts — platform/data against a real Postgres (ADR-053 D4, D8)
 *
 * Runs where a replayed database is available (CI's migration-replay job; locally after
 * scripts/migration-replay.sh): TEST_DATABASE_URL signs in as app_tenant, TEST_DATABASE_OWNER_URL
 * as the owner. Without them the suite is skipped — and CI fails if it was skipped there
 * (REQUIRE_DB_TESTS=1).
 */

import {
  DataScopeError,
  DataUnavailableError,
  closeDataPools,
  setDataPoolFactory,
  withOwnerSnapshot,
  withOwnerTx,
  withPlatformTx,
  withTenantTx,
} from "@/platform/data";
import { poolConfig } from "@/platform/data/pool";
import {
  TenantContextError,
  runWithTenant,
  runWithoutTenant,
} from "@/platform/tenancy/context";
import { Pool } from "pg";

const URL = process.env.TEST_DATABASE_URL;
const OWNER = process.env.TEST_DATABASE_OWNER_URL;
const enabled = Boolean(URL && OWNER);
const d = enabled ? describe : describe.skip;

const A = "aaaaaaaa-0000-4000-8000-0000000000aa";
const B = "bbbbbbbb-0000-4000-8000-0000000000bb";
const UA = "aaaaaaaa-2222-4222-8222-2222222222aa";
const UB = "bbbbbbbb-2222-4222-8222-2222222222bb";
const saved = { ...process.env };

if (process.env.REQUIRE_DB_TESTS === "1" && !enabled) {
  throw new Error(
    "REQUIRE_DB_TESTS=1 but TEST_DATABASE_URL / TEST_DATABASE_OWNER_URL are not set"
  );
}

const asA = <T>(fn: () => Promise<T>) =>
  runWithTenant({ tenantId: A, mode: "shared" }, fn);
const asB = <T>(fn: () => Promise<T>) =>
  runWithTenant({ tenantId: B, mode: "shared" }, fn);

d("platform/data on Postgres", () => {
  beforeAll(async () => {
    process.env = {
      ...saved,
      DATABASE_URL: URL,
      DATABASE_OWNER_URL: OWNER,
      DATABASE_SSL: "disable",
      DATABASE_POOL_MAX: "2",
      // The DB suites' bound (helpers/db.ts), not a short one (TASK-198, D-14): the data layer
      // sets idle_in_transaction_session_timeout to the same value, so 500 ms here killed a
      // session whose worker stalled for half a second on the shared database while jobs.db
      // and rv9 loaded it. The timeout itself is proved below, in one test, with a short value.
      DATABASE_STATEMENT_TIMEOUT_MS: "10000",
    };
    await setDataPoolFactory((role) => new Pool(poolConfig(role)));
    await withOwnerTx("tenant-lifecycle", async (tx) => {
      await tx.query(
        "insert into tenants (id, slug, name) values ($1, 'data-a', 'Data A'), ($2, 'data-b', 'Data B') on conflict do nothing",
        [A, B]
      );
      for (const [u, t] of [
        [UA, A],
        [UB, B],
      ]) {
        await tx.query(
          "insert into users (id, cognito_sub, email, role_id, tenant_id) select $1::uuid, $1::uuid, $1::text || '@x.example', id, $2::uuid from roles where is_default on conflict do nothing",
          [u, t]
        );
      }
    });
  });

  afterAll(async () => {
    await withOwnerTx("tenant-lifecycle", async (tx) => {
      await tx.query("delete from user_devices where tenant_id in ($1, $2)", [A, B]);
      await tx.query("delete from users where tenant_id in ($1, $2)", [A, B]);
      await tx.query("delete from tenants where id in ($1, $2)", [A, B]);
    });
    await closeDataPools();
    process.env = saved;
  });

  it("refuses tenant work with no tenant", async () => {
    await runWithoutTenant(async () => {
      await expect(withTenantTx(async () => 1)).rejects.toThrow(TenantContextError);
    });
  });

  it("each tenant sees only its own rows", async () => {
    const a = await asA(() =>
      withTenantTx((tx) => tx.query<{ id: string }>("select id from users"))
    );
    const b = await asB(() =>
      withTenantTx((tx) => tx.query<{ id: string }>("select id from users"))
    );
    expect(a.rows.map((r) => r.id)).toEqual([UA]);
    expect(b.rows.map((r) => r.id)).toEqual([UB]);
  });

  it("a write lands in the writer's tenant without naming it, and is invisible to the other", async () => {
    await asA(() =>
      withTenantTx((tx) =>
        tx.query("insert into user_devices (user_id, device_id) values ($1, 'kit')", [UA])
      )
    );
    const b = await asB(() =>
      withTenantTx((tx) => tx.query("select 1 from user_devices where device_id = 'kit'"))
    );
    expect(b.rowCount).toBe(0);
    const updated = await asB(() =>
      withTenantTx((tx) =>
        tx.query("update user_devices set device_name = 'x' where device_id = 'kit'")
      )
    );
    expect(updated.rowCount).toBe(0);
    const deleted = await asB(() =>
      withTenantTx((tx) => tx.query("delete from user_devices where device_id = 'kit'"))
    );
    expect(deleted.rowCount).toBe(0);
  });

  it("never carries a tenant into the next transaction on the same connection", async () => {
    // Pool of 2; run many transactions so connections are reused across tenants and kinds.
    for (let i = 0; i < 6; i++) {
      await asA(() => withTenantTx((tx) => tx.query("select 1")));
      const p = await withPlatformTx((tx) =>
        tx.query<{ t: string | null }>("select public.app_current_tenant() as t")
      );
      expect(p.rows[0].t).toBeNull();
      const n = await withPlatformTx((tx) => tx.query("select 1 from users"));
      expect(n.rowCount).toBe(0);
    }
  });

  it("concurrent transactions of two tenants each keep their own", async () => {
    const runs = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        (i % 2 ? asA : asB)(() =>
          withTenantTx(async (tx) => {
            await tx.query("select pg_sleep($1)", [(i % 3) * 0.01]);
            const r = await tx.query<{ t: string }>(
              "select public.app_current_tenant()::text as t"
            );
            const u = await tx.query<{ id: string }>("select id from users");
            return [i % 2 ? A : B, r.rows[0].t, u.rows.map((x) => x.id).join()];
          })
        )
      )
    );
    for (const [want, got, users] of runs) {
      expect(got).toBe(want);
      expect(users).toBe(want === A ? UA : UB);
    }
  });

  it("rolls back everything when the work throws", async () => {
    await expect(
      asA(() =>
        withTenantTx(async (tx) => {
          await tx.query(
            "insert into user_devices (user_id, device_id) values ($1, 'rolled')",
            [UA]
          );
          throw new Error("boom");
        })
      )
    ).rejects.toThrow("boom");
    const r = await asA(() =>
      withTenantTx((tx) =>
        tx.query("select 1 from user_devices where device_id = 'rolled'")
      )
    );
    expect(r.rowCount).toBe(0);
  });

  it("joins an outer transaction of the same kind, and refuses another kind inside", async () => {
    await asA(() =>
      withTenantTx(async (outer) => {
        await outer.query(
          "insert into user_devices (user_id, device_id) values ($1, 'joined')",
          [UA]
        );
        const seen = await withTenantTx((inner) =>
          inner.query("select 1 from user_devices where device_id = 'joined'")
        );
        expect(seen.rowCount).toBe(1); // same transaction: sees the uncommitted row
        await expect(withPlatformTx(async () => 1)).rejects.toThrow(DataScopeError);
        await expect(withOwnerTx("operator", async () => 1)).rejects.toThrow(
          DataScopeError
        );
        await outer.query("delete from user_devices where device_id = 'joined'");
      })
    );
  });

  it("bounds every statement by the timeout", async () => {
    const settings = (run: <T>(fn: () => Promise<T>) => Promise<T>) =>
      run(() =>
        withTenantTx((tx) =>
          tx.query<{ s: string; i: string }>(
            "select current_setting('statement_timeout') as s, current_setting('idle_in_transaction_session_timeout') as i"
          )
        )
      );
    // Every tenant transaction carries the configured bound, for statements and for idling.
    expect((await settings(asA)).rows[0]).toEqual({ s: "10s", i: "10s" });
    // A short statement bound for this test only (TASK-198, D-14), proved with ONE statement, in
    // a transaction whose idle bound is its own and long (round 1, L2): a worker stalled between
    // two statements on the loaded database can then never be killed for idling — only the
    // statement's own 300 ms decides. The same run() sets statement_timeout for every kind of
    // transaction; the tenant kind's setting is read back above.
    const saved = process.env.DATABASE_STATEMENT_TIMEOUT_MS;
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = "300";
    try {
      await expect(
        withOwnerSnapshot(
          "operator",
          async (tx) => {
            const { rows } = await tx.query<{ s: string; i: string }>(
              "select current_setting('statement_timeout') as s, current_setting('idle_in_transaction_session_timeout') as i"
            );
            expect(rows[0]).toEqual({ s: "300ms", i: "10s" });
            await tx.query("select pg_sleep(2)");
          },
          { idleTimeoutMs: 10_000 }
        )
      ).rejects.toMatchObject({ code: "57014" });
    } finally {
      process.env.DATABASE_STATEMENT_TIMEOUT_MS = saved;
    }
    // The connection is usable afterwards, under the suite's bound again.
    await expect(
      asA(() => withTenantTx((tx) => tx.query("select 1")))
    ).resolves.toBeTruthy();
    expect((await settings(asA)).rows[0]).toEqual({ s: "10s", i: "10s" });
  });

  it("takes values only as parameters — a value is never SQL", async () => {
    const hostile = "x'); delete from users; --";
    const r = await asA(() =>
      withTenantTx((tx) => tx.query<{ v: string }>("select $1::text as v", [hostile]))
    );
    expect(r.rows[0].v).toBe(hostile);
    const users = await asA(() => withTenantTx((tx) => tx.query("select 1 from users")));
    expect(users.rowCount).toBe(1);
  });

  it("cannot set another tenant from inside a tenant transaction to read its rows", async () => {
    // app_tenant can change the setting itself — the reason only withTenantTx sets it, and the
    // reason this is proven here: the policy reads the setting at query time, so a bug that set
    // it would cross — and the source check refuses set_config outside platform/data.
    const r = await asA(() =>
      withTenantTx(async (tx) => {
        await tx.query("select set_config('app.tenant_id', $1, true)", [B]);
        return tx.query<{ id: string }>("select id from users");
      })
    );
    expect(r.rows.map((x) => x.id)).toEqual([UB]);
  });

  it("the owner connection only serves listed purposes, and sees across tenants", async () => {
    await expect(withOwnerTx("anything" as never, async () => 1)).rejects.toThrow(
      DataScopeError
    );
    const r = await withOwnerTx("operator", (tx) =>
      tx.query("select 1 from users where tenant_id in ($1, $2)", [A, B])
    );
    expect(r.rowCount).toBe(2);
  });

  it("computes in UTC in every transaction, whatever the session's time zone (TASK-159)", async () => {
    // Connections whose session is in New York — as a database or role default can make it. Set on
    // connect, so it holds whatever the test URLs carry.
    const newYork = (config: ReturnType<typeof poolConfig>) => {
      const pool = new Pool(config);
      pool.on("connect", (client) => {
        void client.query("set time zone 'America/New_York'");
      });
      return pool;
    };
    await setDataPoolFactory((role) => newYork(poolConfig(role)));
    // 30 days from the eve of the US fall-back change: in New York that is 30 days and an hour.
    const span =
      "select extract(epoch from (timestamptz '2026-10-24 12:00:00Z' + interval '30 days') - timestamptz '2026-10-24 12:00:00Z') / 86400 as days, current_setting('TimeZone') as tz";
    try {
      const raw = newYork(poolConfig("owner"));
      try {
        const { rows } = await raw.query(span);
        expect([Number(rows[0].days).toFixed(4), rows[0].tz]).toEqual([
          "30.0417",
          "America/New_York",
        ]);
      } finally {
        await raw.end();
      }
      for (const run of [
        () => asA(() => withTenantTx((tx) => tx.query(span))),
        () => withPlatformTx((tx) => tx.query(span)),
        () => withOwnerTx("tenant-lifecycle", (tx) => tx.query(span)),
      ]) {
        const { rows } = (await run()) as unknown as {
          rows: { days: string; tz: string }[];
        };
        expect([Number(rows[0].days), rows[0].tz]).toEqual([30, "UTC"]);
      }
    } finally {
      await setDataPoolFactory((role) => new Pool(poolConfig(role)));
    }
  });

  it("an unreachable database is DataUnavailableError, never a hang", async () => {
    await setDataPoolFactory(
      () =>
        new Pool({
          connectionString: "postgresql://app_tenant:x@127.0.0.1:1/none",
          connectionTimeoutMillis: 500,
        })
    );
    await expect(asA(() => withTenantTx((tx) => tx.query("select 1")))).rejects.toThrow(
      DataUnavailableError
    );
    await setDataPoolFactory((role) => new Pool(poolConfig(role)));
  });
});
