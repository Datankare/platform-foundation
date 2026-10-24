/**
 * __tests__/helpers/data-faults.ts — inject query failures into platform/data (DB tests)
 *
 * `jest.mock("@/platform/data", () => require("../helpers/data-faults").withFaults())` gives the
 * real data layer, except that each tenant-transaction query first asks `faults.fail(sql)`: an
 * error it returns is thrown in place of running the query. The real database answers every
 * other query, so a test can fail one statement (the database unreachable, a write refused) and
 * see what the code under test does with it.
 */

import type { Tx } from "@/platform/data";

type DataModule = typeof import("@/platform/data");

export const faults: { fail?: (sql: string) => unknown } = {};

/** Clear every injected fault (afterEach). */
export function clearFaults(): void {
  faults.fail = undefined;
}

/** The real platform/data with fault injection on withTenantTx queries. */
export function withFaults(): DataModule {
  const actual = jest.requireActual<DataModule>("@/platform/data");
  const wrap = (tx: Tx): Tx => ({
    tenantId: tx.tenantId,
    query: (text, values) => {
      const err = faults.fail?.(text);
      return err ? Promise.reject(err) : tx.query(text, values);
    },
  });
  return {
    ...actual,
    withTenantTx: ((fn: (tx: Tx) => Promise<unknown>) =>
      actual.withTenantTx((tx) => fn(wrap(tx)))) as DataModule["withTenantTx"],
  };
}
