/**
 * @jest-environment node
 */
/**
 * __tests__/db/tx-lifetime.db.test.ts — a transaction ends when its work does (ADR-053 D4)
 *
 * With one pooled connection, the connection tenant A's transaction used is the one tenant B's
 * transaction gets next. Work A scheduled that outlives its transaction — a leaked handle, a
 * promise or timer started inside it — must then neither see nor touch B: a leaked handle is
 * refused, and a transaction asked for from A's ended scope is A's own, opened after B's.
 */

import {
  DataScopeError,
  setDataPoolFactory,
  withOwnerSnapshot,
  withOwnerTx,
  withTenantTx,
  type Tx,
} from "@/platform/data";
import { poolConfig } from "@/platform/data/pool";
import { Pool } from "pg";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";

let a: TestTenant;
let b: TestTenant;
let ua: string;
let ub: string;

const devices = async (tenantId: string) =>
  (
    await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query<{ device_id: string }>(
        "select device_id from user_devices where tenant_id = $1::uuid order by device_id",
        [tenantId]
      )
    )
  ).rows.map((r) => r.device_id);

dbDescribe("a transaction's lifetime on a pool of one connection", () => {
  beforeAll(async () => {
    await connectTestDatabase();
    a = await createTestTenant();
    b = await createTestTenant();
    ua = await a.user();
    ub = await b.user();
    // One connection per role: what A's transaction used is what B's gets.
    process.env.DATABASE_POOL_MAX = "1";
    await setDataPoolFactory((role) => new Pool(poolConfig(role)));
  });

  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  beforeEach(async () => {
    for (const [t, u, d] of [
      [a, ua, "a-device"],
      [b, ub, "b-device"],
    ] as const) {
      await t.run(() =>
        withTenantTx(async (tx) => {
          await tx.query("delete from user_devices");
          await tx.query(
            "insert into user_devices (user_id, device_id) values ($1, $2)",
            [u, d]
          );
        })
      );
    }
  });

  it("a handle used after its transaction ended is refused while B's transaction holds the connection", async () => {
    let leaked: Tx | undefined;
    await a.run(() =>
      withTenantTx(async (tx) => {
        leaked = tx;
      })
    );
    await b.run(() =>
      withTenantTx(async (tx) => {
        await tx.query("select 1"); // B now holds the one connection
        await expect(leaked!.query("select device_id from user_devices")).rejects.toThrow(
          DataScopeError
        );
        await expect(leaked!.query("delete from user_devices")).rejects.toThrow(
          DataScopeError
        );
        const mine = await tx.query("select device_id from user_devices");
        expect(mine.rows).toEqual([{ device_id: "b-device" }]);
      })
    );
    expect(await devices(b.id)).toEqual(["b-device"]);
  });

  it("work scheduled in A's transaction that runs while B's is open never joins B's connection", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let deferred: Promise<string[]> | undefined;
    await a.run(() =>
      withTenantTx(async () => {
        // Started inside A's transaction, runs after it: deletes "its" devices and reports them.
        deferred = gate.then(() =>
          withTenantTx(async (tx) => {
            const { rows } = await tx.query<{ device_id: string }>(
              "delete from user_devices returning device_id"
            );
            return rows.map((r) => r.device_id);
          })
        );
      })
    );
    deferred!.catch(() => undefined);
    await b.run(() =>
      withTenantTx(async (tx) => {
        await tx.query("select 1");
        release();
        // Give the deferred work every chance to run inside this transaction.
        await new Promise((r) => setTimeout(r, 300));
        const mine = await tx.query("select device_id from user_devices");
        expect(mine.rows).toEqual([{ device_id: "b-device" }]);
      })
    );
    // It ran afterwards, in its own transaction, as A: A's device only.
    await expect(deferred).resolves.toEqual(["a-device"]);
    expect(await devices(a.id)).toEqual([]);
    expect(await devices(b.id)).toEqual(["b-device"]);
  });

  it("an owner snapshot left idle past its bound loses its connection, and so its snapshot", async () => {
    await expect(
      withOwnerSnapshot(
        "tenant-lifecycle",
        async (tx) => {
          await tx.query("select 1");
          await new Promise((r) => setTimeout(r, 1500));
          return tx.query("select 1");
        },
        { idleTimeoutMs: 300 }
      )
    ).rejects.toBeDefined();
    // The pool recovers: the next owner transaction works.
    await expect(
      withOwnerTx("tenant-lifecycle", (tx) => tx.query("select 1"))
    ).resolves.toBeTruthy();
  });
});
