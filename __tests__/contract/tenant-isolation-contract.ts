/**
 * __tests__/contract/tenant-isolation-contract.ts — the cross-tenant isolation kit (ADR-053 D8)
 * Not a *.test.ts: each store's suite runs it.
 *
 * One store instance serves every tenant, as in production. Data written under tenant A is
 * invisible, unmodifiable and undeletable under tenant B; the same key in two tenants is two
 * records; and a durable store does nothing at all without a tenant.
 */

import { TenantContextError, runWithoutTenant } from "@/platform/tenancy/context";

export interface IsolationTenant {
  run<T>(fn: () => T): T;
}

export interface TenantIsolationFixtures<S> {
  readonly name: string;
  readonly makeStore: () => S | Promise<S>;
  readonly createTenant: () => Promise<IsolationTenant>;
  /** Write a record identified by `key`. */
  readonly write: (store: S, key: string) => Promise<void>;
  /** The record for `key`, or null when the current tenant has none. */
  readonly read: (store: S, key: string) => Promise<unknown | null>;
  /** Change the record for `key` if visible. */
  readonly update?: (store: S, key: string) => Promise<void>;
  /** Remove the record for `key` (or everything the tenant has). */
  readonly remove?: (store: S, key: string) => Promise<void>;
  /** Default true: with no tenant, every operation throws TenantContextError. */
  readonly failsClosedWithoutTenant?: boolean;
}

let counter = 0;
const nextKey = (name: string) => `${name}-iso-${Date.now().toString(36)}-${counter++}`;

export function runTenantIsolationContract<S>(fx: TenantIsolationFixtures<S>): void {
  describe(`tenant isolation: ${fx.name} (ADR-053 D8)`, () => {
    let store: S;
    let a: IsolationTenant;
    let b: IsolationTenant;

    beforeEach(async () => {
      store = await fx.makeStore();
      a = await fx.createTenant();
      b = await fx.createTenant();
    });

    it("a record written under A is visible under A and invisible under B", async () => {
      const key = nextKey(fx.name);
      await a.run(() => fx.write(store, key));
      expect(await a.run(() => fx.read(store, key))).not.toBeNull();
      expect(await b.run(() => fx.read(store, key))).toBeNull();
    });

    it("the same key in two tenants is two records", async () => {
      const key = nextKey(fx.name);
      await a.run(() => fx.write(store, key));
      await b.run(() => fx.write(store, key));
      const fromA = await a.run(() => fx.read(store, key));
      const fromB = await b.run(() => fx.read(store, key));
      expect(fromA).not.toBeNull();
      expect(fromB).not.toBeNull();
      if (fx.remove) {
        await b.run(() => fx.remove!(store, key));
        expect(await b.run(() => fx.read(store, key))).toBeNull();
        expect(await a.run(() => fx.read(store, key))).not.toBeNull();
      }
    });

    if (fx.update) {
      it("B cannot change A's record", async () => {
        const key = nextKey(fx.name);
        await a.run(() => fx.write(store, key));
        const before = await a.run(() => fx.read(store, key));
        await b.run(async () => {
          try {
            await fx.update!(store, key);
          } catch {
            // Refusing is as good as matching nothing.
          }
        });
        expect(await a.run(() => fx.read(store, key))).toEqual(before);
      });
    }

    if (fx.remove) {
      it("B cannot delete A's record", async () => {
        const key = nextKey(fx.name);
        await a.run(() => fx.write(store, key));
        await b.run(async () => {
          try {
            await fx.remove!(store, key);
          } catch {
            // Refusing is as good as matching nothing.
          }
        });
        expect(await a.run(() => fx.read(store, key))).not.toBeNull();
      });
    }

    if (fx.failsClosedWithoutTenant !== false) {
      it("does nothing without a tenant", async () => {
        const key = nextKey(fx.name);
        await runWithoutTenant(async () => {
          await expect(fx.write(store, key)).rejects.toThrow(TenantContextError);
          await expect(fx.read(store, key)).rejects.toThrow(TenantContextError);
        });
      });
    }
  });
}
