/**
 * __tests__/helpers/data-spy.ts — watch, and break, writes through platform/data in DB tests
 *
 * For suites that prove an action is recorded before it takes effect (Adversarial Validation,
 * practice 6): the real data layer, with every tenant write logged in order as [verb, table],
 * and audit_log inserts refused while `dataSpy.auditDown` is set. Use it as
 *
 *   jest.mock("@/platform/data", () => jest.requireActual("../helpers/data-spy").spiedData());
 *
 * State lives on globalThis so the mock factory and the test share it whatever module instance
 * each one gets.
 */

import { randomUUID } from "node:crypto";

export interface DataSpy {
  /** Tenant writes in the order they ran: ["insert", "audit_log"], ["update", "users"], … */
  writes: [string, string][];
  /** While true, an insert into audit_log fails as an unavailable store would. */
  auditDown: boolean;
}

const KEY = Symbol.for("datankare.tests.dataSpy");
type Holder = { [KEY]?: DataSpy };

export function dataSpy(): DataSpy {
  const g = globalThis as Holder;
  g[KEY] ??= { writes: [], auditDown: false };
  return g[KEY];
}

/** Clear the log and restore the audit store (call in beforeEach). */
export function resetDataSpy(): void {
  const s = dataSpy();
  s.writes = [];
  s.auditDown = false;
}

const WRITE = /^\s*(insert\s+into|update|delete\s+from)\s+(\w+)/i;

/** The platform/data module with withTenantTx observed. */
export function spiedData(): Record<string, unknown> {
  const actual = jest.requireActual(
    "@/platform/data"
  ) as typeof import("@/platform/data");
  return {
    ...actual,
    withTenantTx: <T>(fn: (tx: import("@/platform/data").Tx) => Promise<T>) =>
      actual.withTenantTx((tx) =>
        fn({
          tenantId: tx.tenantId,
          async query(text, values) {
            const m = WRITE.exec(text);
            if (m) {
              const verb = m[1].split(/\s+/)[0].toLowerCase();
              const table = m[2].toLowerCase();
              if (table === "audit_log" && dataSpy().auditDown) {
                throw new Error("audit store down");
              }
              const result = await tx.query(text, values);
              if (result.rowCount > 0) dataSpy().writes.push([verb, table]);
              return result as never;
            }
            return tx.query(text, values) as never;
          },
        })
      ),
  };
}

/** A fresh UUID (ids that are not users, or users not yet provisioned). */
export const uuid = (): string => randomUUID();
