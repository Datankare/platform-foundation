/**
 * @jest-environment node
 */
/**
 * platform/data/__tests__/tx.test.ts — a transaction's lifetime, on a scripted pool (ADR-053 D4)
 *
 * The pool hands out recording clients, so each test sees exactly which statements reached which
 * connection. The real-database version of the leak (one pooled connection, two tenants) is
 * __tests__/db/tx-lifetime.db.test.ts.
 */

import {
  DataScopeError,
  OWNER_SNAPSHOT_IDLE_TIMEOUT_MS,
  closeDataPools,
  setDataPoolFactory,
  withOwnerSnapshot,
  withOwnerTx,
  withTenantTx,
  type Tx,
} from "@/platform/data";
import { runWithTenant } from "@/platform/tenancy/context";
import type { Pool } from "pg";

const A = "aaaaaaaa-0000-4000-8000-0000000000aa";
const B = "bbbbbbbb-0000-4000-8000-0000000000bb";

/** Every statement, with the connection it reached. */
let log: { client: number; text: string; values?: unknown[] }[] = [];
let connects = 0;

function fakePool(): Pool {
  return {
    connect: async () => {
      const id = ++connects;
      return {
        query: async (text: string, values?: unknown[]) => {
          log.push({ client: id, text, values });
          // A commit takes a moment, as a real one does: the window the next test aims at.
          if (text === "commit") await new Promise((r) => setTimeout(r, 30));
          return { rows: [{ ok: 1 }], rowCount: 1 };
        },
        release: () => undefined,
        on: () => undefined,
        off: () => undefined,
      };
    },
    end: async () => undefined,
  } as unknown as Pool;
}

const asA = <T>(fn: () => Promise<T>) =>
  runWithTenant({ tenantId: A, mode: "shared" }, fn);
const asB = <T>(fn: () => Promise<T>) =>
  runWithTenant({ tenantId: B, mode: "shared" }, fn);
const tick = () => new Promise((r) => setTimeout(r, 5));

const saved = { ...process.env };

beforeEach(async () => {
  process.env = {
    ...saved,
    DATABASE_URL: "postgresql://app_tenant:x@localhost/none",
    DATABASE_OWNER_URL: "postgresql://postgres:x@localhost/none",
    DATABASE_SSL: "disable",
  };
  log = [];
  connects = 0;
  await setDataPoolFactory(() => fakePool());
});

afterAll(async () => {
  await closeDataPools();
  process.env = saved;
});

describe("a transaction handle after its transaction ended", () => {
  it("refuses every query and sends nothing to the connection", async () => {
    let leaked: Tx | undefined;
    await asA(() =>
      withTenantTx(async (tx) => {
        leaked = tx;
      })
    );
    const before = log.length;
    await expect(leaked!.query("select 1")).rejects.toBeInstanceOf(DataScopeError);
    expect(log.length).toBe(before);
  });

  it("refuses a query issued while commit is under way", async () => {
    let late: Promise<unknown> | undefined;
    await asA(() =>
      withTenantTx(async (tx) => {
        // Runs after fn has returned, while the commit is in flight.
        setTimeout(() => {
          late = tx.query("delete from users");
          late.catch(() => undefined); // asserted below
        }, 10);
      })
    );
    expect(late).toBeDefined();
    await expect(late).rejects.toBeInstanceOf(DataScopeError);
    expect(log.some((l) => /delete from users/.test(l.text))).toBe(false);
  });

  it("is refused after a rollback too", async () => {
    let leaked: Tx | undefined;
    await expect(
      asA(() =>
        withTenantTx(async (tx) => {
          leaked = tx;
          throw new Error("boom");
        })
      )
    ).rejects.toThrow("boom");
    await expect(leaked!.query("select 1")).rejects.toBeInstanceOf(DataScopeError);
  });
});

describe("work scheduled in a transaction's scope that outlives it", () => {
  it("opens its own transaction in its own tenant instead of joining the ended one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let deferred: Promise<unknown> | undefined;
    await asA(() =>
      withTenantTx(async () => {
        deferred = gate.then(() =>
          withTenantTx((tx) => tx.query("select 'deferred' as what"))
        );
      })
    );
    // Tenant B's transaction now holds a connection.
    await asB(() =>
      withTenantTx(async (tx) => {
        release();
        await tick();
        await tx.query("select 'b' as what");
      })
    );
    await deferred;
    const deferredStmt = log.find((l) => /deferred/.test(l.text))!;
    const bStmt = log.find((l) => /'b'/.test(l.text))!;
    // Its own connection, begun and scoped to A — never B's, never A's ended one.
    expect(deferredStmt.client).not.toBe(bStmt.client);
    expect(deferredStmt.client).not.toBe(1);
    const own = log.filter((l) => l.client === deferredStmt.client).map((l) => l.text);
    expect(own[0]).toBe("begin");
    const scope = log.find(
      (l) => l.client === deferredStmt.client && /app\.tenant_id/.test(l.text)
    );
    expect(scope?.values?.[0]).toBe(A);
  });

  it("may open another kind once the outer one has ended", async () => {
    let deferred: Promise<unknown> | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await asA(() =>
      withTenantTx(async () => {
        deferred = gate.then(() => withOwnerTx("operator", async () => "owner"));
      })
    );
    release();
    await expect(deferred).resolves.toBe("owner");
  });

  it("still joins while the outer transaction is open", async () => {
    await asA(() =>
      withTenantTx(async (outer) => {
        await withTenantTx((inner) => inner.query("select 'inner'"));
        await outer.query("select 'outer'");
      })
    );
    expect(connects).toBe(1);
  });
});

describe("an owner snapshot's idle bound", () => {
  const idleSetting = () =>
    log.find((l) => /idle_in_transaction_session_timeout/.test(l.text))?.values?.[1];

  it("defaults to OWNER_SNAPSHOT_IDLE_TIMEOUT_MS — never unbounded", async () => {
    await withOwnerSnapshot("tenant-lifecycle", (tx) => tx.query("select 1"));
    expect(OWNER_SNAPSHOT_IDLE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(idleSetting()).toBe(String(OWNER_SNAPSHOT_IDLE_TIMEOUT_MS));
    expect(log[0].text).toBe("begin isolation level repeatable read read only");
  });

  it("takes a bound per call, and refuses zero (unbounded) or absurd ones", async () => {
    await withOwnerSnapshot("tenant-lifecycle", (tx) => tx.query("select 1"), {
      idleTimeoutMs: 1234,
    });
    expect(idleSetting()).toBe("1234");
    for (const bad of [0, -1, 1.5, 2 * 60 * 60_000]) {
      await expect(
        withOwnerSnapshot("tenant-lifecycle", async () => 1, { idleTimeoutMs: bad })
      ).rejects.toThrow(RangeError);
    }
  });

  it("other transactions are bounded by the statement timeout", async () => {
    await withOwnerTx("operator", (tx) => tx.query("select 1"));
    expect(idleSetting()).toBe("10000");
  });
});
