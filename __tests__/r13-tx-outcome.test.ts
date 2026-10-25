/**
 * __tests__/r13-tx-outcome.test.ts — Review 13 L5: how a transaction ended, told truthfully
 *
 *   - a commit whose answer is lost with the connection (it may have landed): the rollback hooks
 *     are told "indeterminate", and audited() records `indeterminate` — never `rolled_back`;
 *   - a commit the server refused (a serialization failure), or work that threw: "rolled_back";
 *   - onCommit: a step that must follow the transaction's writes runs after the commit, never on a
 *     rollback, and not when the savepoint it was registered under is rolled back;
 *   - a config invalidation published inside a transaction waits for its commit.
 *
 * On a fake connection pool (setDataPoolFactory), so the commit's failure is exact.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const cacheSet = jest.fn(async () => undefined);
jest.mock("@/platform/cache", () => ({
  getCache: () => ({ set: cacheSet, get: async () => null }),
}));

import { closeDataPools, setDataPoolFactory } from "@/platform/data/pool";
import {
  onCommit,
  onRollback,
  withSavepoint,
  withTenantTx,
  type TxEndOutcome,
} from "@/platform/data";
import { audited } from "@/platform/auth/audit";
import { publishConfigInvalidation } from "@/platform/auth/platform-config";
import { runWithTenant } from "@/platform/tenancy/context";

const TENANT = Object.freeze({
  tenantId: "00000000-0000-4000-8000-0000000000e3",
  mode: "shared" as const,
});

/** How the next commit answers: ok, a lost connection, or a refusal. */
let commitFails: null | { code: string; message: string } = null;
const statements: string[] = [];

function fakePool() {
  return {
    async connect() {
      return {
        async query(text: string, values?: unknown[]) {
          statements.push(text.trim().split(/\s+/).slice(0, 3).join(" "));
          if (text === "commit" && commitFails) {
            const failure = commitFails;
            commitFails = null;
            throw Object.assign(new Error(failure.message), { code: failure.code });
          }
          if (/insert into audit_log/.test(text)) {
            audits.push(JSON.parse(String(values?.[3] ?? "{}")));
          }
          return { rows: [], rowCount: 0 };
        },
        on() {},
        off() {},
        release() {},
      };
    },
    async end() {},
    on() {},
  };
}
const audits: Record<string, unknown>[] = [];

beforeAll(async () => {
  await setDataPoolFactory(() => fakePool() as never);
});
afterAll(async () => {
  await closeDataPools();
});
beforeEach(() => {
  commitFails = null;
  statements.length = 0;
  audits.length = 0;
  cacheSet.mockClear();
});

const inTenant = <T>(fn: () => Promise<T>) => runWithTenant(TENANT, fn);

describe("R13-L5 the rollback hooks are told how the transaction ended", () => {
  async function endedAs(failure: typeof commitFails, throwInside = false) {
    const seen: TxEndOutcome[] = [];
    commitFails = failure;
    await expect(
      inTenant(() =>
        withTenantTx(async () => {
          onRollback(async (o) => {
            seen.push(o);
          });
          if (throwInside) throw new Error("work failed");
        })
      )
    ).rejects.toThrow();
    return seen;
  }

  it("the connection lost during the commit: indeterminate", async () => {
    expect(await endedAs({ code: "08006", message: "connection failure" })).toEqual([
      "indeterminate",
    ]);
    expect(await endedAs({ code: "ECONNRESET", message: "socket hang up" })).toEqual([
      "indeterminate",
    ]);
  });

  it("the commit refused by the server: rolled_back", async () => {
    expect(
      await endedAs({ code: "40001", message: "could not serialize access" })
    ).toEqual(["rolled_back"]);
  });

  it("the work threw: rolled_back", async () => {
    expect(await endedAs(null, true)).toEqual(["rolled_back"]);
  });

  it("a committed transaction runs no rollback hook", async () => {
    const seen: TxEndOutcome[] = [];
    await inTenant(() =>
      withTenantTx(async () => {
        onRollback(async (o) => {
          seen.push(o);
        });
      })
    );
    expect(seen).toEqual([]);
  });
});

describe("R13-L5 audited() inside a transaction whose commit is lost records indeterminate", () => {
  it("attempted, then indeterminate — never rolled_back", async () => {
    await expect(
      inTenant(() =>
        withTenantTx(async () => {
          const r = await audited(
            { action: "admin_action", details: { type: "r13" } },
            async () => ({ success: true })
          );
          // This transaction's own commit (the records' transactions committed already).
          commitFails = {
            code: "57P01",
            message: "terminating connection due to administrator command",
          };
          return r;
        })
      )
    ).rejects.toThrow(/connection failed/);
    expect(audits.map((a) => a.outcome)).toEqual(["attempted", "indeterminate"]);
    expect(audits[1]).toMatchObject({
      reason: expect.stringMatching(/whether it took effect is unknown/),
      attemptId: audits[0].attemptId,
    });
  });

  it("a refused commit: attempted, then rolled_back", async () => {
    await expect(
      inTenant(() =>
        withTenantTx(async () => {
          const r = await audited(
            { action: "admin_action", details: { type: "r13" } },
            async () => ({ success: true })
          );
          // This transaction's own commit (the records' transactions committed already).
          commitFails = {
            code: "23505",
            message: "duplicate key value violates unique constraint",
          };
          return r;
        })
      )
    ).rejects.toThrow();
    expect(audits.map((a) => a.outcome)).toEqual(["attempted", "rolled_back"]);
  });
});

describe("R13-L5 onCommit: after the commit, never on a rollback", () => {
  it("runs after the commit, outside the transaction", async () => {
    const order: string[] = [];
    await inTenant(() =>
      withTenantTx(async () => {
        expect(
          onCommit(async () => {
            order.push("hook");
          })
        ).toBe(true);
        order.push("work");
      })
    );
    expect(order).toEqual(["work", "hook"]);
    expect(statements.indexOf("commit")).toBeGreaterThan(-1);
  });

  it("not on a rollback, nor when its savepoint is rolled back", async () => {
    const ran: string[] = [];
    await expect(
      inTenant(() =>
        withTenantTx(async () => {
          onCommit(async () => {
            ran.push("rolled back tx");
          });
          throw new Error("no");
        })
      )
    ).rejects.toThrow("no");
    await inTenant(() =>
      withTenantTx(async (tx) => {
        onCommit(async () => {
          ran.push("outer");
        });
        await expect(
          withSavepoint(tx, async () => {
            onCommit(async () => {
              ran.push("undone savepoint");
            });
            throw new Error("inner");
          })
        ).rejects.toThrow("inner");
      })
    );
    expect(ran).toEqual(["outer"]);
  });

  it("outside a transaction it registers nothing (the caller runs the step itself)", () => {
    expect(onCommit(async () => {})).toBe(false);
  });

  it("a config invalidation published inside a transaction waits for the commit", async () => {
    await inTenant(() =>
      withTenantTx(async () => {
        expect(await publishConfigInvalidation("agent.trusted_agents")).toBe(true);
        expect(cacheSet).not.toHaveBeenCalled();
      })
    );
    expect(cacheSet).toHaveBeenCalledTimes(1);
    // And never, if it rolls back.
    cacheSet.mockClear();
    await expect(
      inTenant(() =>
        withTenantTx(async () => {
          await publishConfigInvalidation("agent.trusted_agents");
          throw new Error("rolled back");
        })
      )
    ).rejects.toThrow();
    expect(cacheSet).not.toHaveBeenCalled();
  });
});
