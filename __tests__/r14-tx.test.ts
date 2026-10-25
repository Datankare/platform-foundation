/**
 * __tests__/r14-tx.test.ts — Review 14 L-2: a commit lost with its connection keeps its invalidation
 *
 * Ported from the reviewer's proof (review 14): a transaction that changed a stamped key and lost
 * its commit's answer with the connection (08006 — it may have committed) dropped the key's
 * invalidation with its other commit hooks, so other instances could serve the old value of a
 * change that stands. Now:
 *
 *   - onCommit hooks marked idempotent (the config and permission invalidations) run on an
 *     indeterminate outcome too; others still run only after a commit;
 *   - audited() records `indeterminate` (never `failed`) when the act's OWN transaction loses its
 *     commit — thrown (CommitOutcomeUnknownError) or reported (`indeterminate: true`);
 *   - setConfigWithHistory and clearTenantConfig, which commit their own transaction, answer
 *     `indeterminate` for a lost commit (not "failed") and publish the invalidation all the same.
 *
 * On a fake connection pool (setDataPoolFactory), so which commit fails is exact.
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
  CommitOutcomeUnknownError,
  DataUnavailableError,
  isCommitOutcomeUnknown,
  onCommit,
  withTenantTx,
} from "@/platform/data";
import { audited } from "@/platform/auth/audit";
import {
  clearConfigCache,
  clearTenantConfig,
  publishConfigInvalidation,
  setConfigWithHistory,
} from "@/platform/auth/platform-config";
import { runWithTenant } from "@/platform/tenancy/context";

const TENANT = Object.freeze({
  tenantId: "00000000-0000-4000-8000-0000000000e4",
  mode: "shared" as const,
});
const ACTOR = "00000000-0000-4000-8000-0000000000a4";
const KEY = "agent.trusted_agents";

/**
 * The commit that fails: of the first transaction (after `armed`) whose statements match `when`,
 * answered with `code`. The audit records' own transactions commit normally.
 */
let failCommit: null | { when: RegExp; code: string; message: string } = null;
const audits: Record<string, unknown>[] = [];
/** The stored entry the config readers are answered with. */
let overridden = false;

const ROW = () => ({
  key: KEY,
  value: [["agent:a", { owner: ACTOR, scopes: ["x"], status: "active" }]],
  platform_value: [["agent:a", { owner: ACTOR, scopes: ["x"], status: "active" }]],
  overridden,
  description: "registry",
  category: "agents",
  updated_at: "2026-10-24T00:00:00.000Z",
  default_value: [],
  value_type: "json_array",
  min_value: null,
  max_value: null,
  allowed_values: null,
  permission_tier: "safety",
  tenant_overridable: true,
});

function fakePool() {
  return {
    async connect() {
      const mine: string[] = [];
      return {
        async query(text: string, values?: unknown[]) {
          mine.push(text);
          if (
            text === "commit" &&
            failCommit &&
            mine.some((t) => failCommit!.when.test(t))
          ) {
            const f = failCommit;
            failCommit = null;
            throw Object.assign(new Error(f.message), { code: f.code });
          }
          if (/insert into audit_log/.test(text)) {
            audits.push(JSON.parse(String(values?.[3] ?? "{}")));
          }
          if (/from platform_config c left join tenant_config_overrides/.test(text)) {
            return { rows: [ROW()], rowCount: 1 };
          }
          if (/select value = \$3::jsonb as same/.test(text)) {
            return { rows: [{ same: true }], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
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

const savedUrl = process.env.DATABASE_URL;
beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://fake/fake"; // hasDatabase(): the pool below answers
  await setDataPoolFactory(() => fakePool() as never);
});
afterAll(async () => {
  await closeDataPools();
  if (savedUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedUrl;
});
beforeEach(() => {
  failCommit = null;
  audits.length = 0;
  overridden = false;
  cacheSet.mockClear();
  clearConfigCache();
});

const inTenant = <T>(fn: () => Promise<T>) => runWithTenant(TENANT, fn);
const LOST = { code: "08006", message: "connection failure" };

describe("R14-L2 an indeterminate commit still publishes the invalidation (the reviewer's case)", () => {
  it("a stamped key changed in a transaction whose commit is lost: published once", async () => {
    failCommit = { when: /update tenant_config_overrides/, ...LOST };
    const err = await inTenant(() =>
      withTenantTx(async (tx) => {
        await tx.query("update tenant_config_overrides set value = '1'");
        await publishConfigInvalidation(KEY);
      })
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(err).toBeInstanceOf(DataUnavailableError); // routes still answer 503
    expect(isCommitOutcomeUnknown(err)).toBe(true);
    expect(cacheSet).toHaveBeenCalledTimes(1);
  });

  it("a commit the server refused (it is known not to have landed): not published", async () => {
    failCommit = {
      when: /update tenant_config_overrides/,
      code: "40001",
      message: "could not serialize access",
    };
    await expect(
      inTenant(() =>
        withTenantTx(async (tx) => {
          await tx.query("update tenant_config_overrides set value = '1'");
          await publishConfigInvalidation(KEY);
        })
      )
    ).rejects.toThrow(/serialize/);
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("a permissions invalidation in a transaction whose commit is lost: published too", async () => {
    const { invalidatePermissions } = await import("@/platform/auth/permissions-cache");
    failCommit = { when: /update users/, ...LOST };
    await expect(
      inTenant(() =>
        withTenantTx(async (tx) => {
          await tx.query("update users set role_id = null");
          await invalidatePermissions("sub-r14");
          // Not before the commit (a token revocation it also writes is not a stamp).
          expect(
            (cacheSet.mock.calls as unknown[][]).filter(
              (c) => c[0] === "permissions:invalidated:sub-r14"
            )
          ).toEqual([]);
        })
      )
    ).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(cacheSet).toHaveBeenCalledWith(
      "permissions:invalidated:sub-r14",
      expect.any(String),
      expect.any(Object)
    );
  });

  it("only hooks marked idempotent run on an unknown outcome", async () => {
    const ran: string[] = [];
    failCommit = { when: /update x/, ...LOST };
    await expect(
      inTenant(() =>
        withTenantTx(async (tx) => {
          await tx.query("update x");
          onCommit(async () => {
            ran.push("plain");
          });
          onCommit(
            async () => {
              ran.push("idempotent");
            },
            { idempotent: true }
          );
        })
      )
    ).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(ran).toEqual(["idempotent"]);
    // Committed: both, in order.
    ran.length = 0;
    await inTenant(() =>
      withTenantTx(async () => {
        onCommit(async () => {
          ran.push("plain");
        });
        onCommit(
          async () => {
            ran.push("idempotent");
          },
          { idempotent: true }
        );
      })
    );
    expect(ran).toEqual(["plain", "idempotent"]);
  });
});

describe("R14-L2 audited(): the act's own transaction loses its commit", () => {
  it("thrown: attempted, then indeterminate — never failed", async () => {
    failCommit = { when: /update y/, ...LOST };
    await expect(
      inTenant(() =>
        audited({ action: "admin_action", details: { type: "r14" } }, () =>
          withTenantTx(async (tx) => {
            await tx.query("update y");
            return { success: true };
          })
        )
      )
    ).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
    expect(audits.map((a) => a.outcome)).toEqual(["attempted", "indeterminate"]);
    expect(audits[1].reason).toMatch(/whether it took effect is unknown/);
  });

  it("reported ({ indeterminate: true }): attempted, then indeterminate", async () => {
    await inTenant(() =>
      audited({ action: "admin_action", details: { type: "r14" } }, async () => ({
        success: false,
        indeterminate: true,
      }))
    );
    expect(audits.map((a) => a.outcome)).toEqual(["attempted", "indeterminate"]);
  });

  it("an ordinary failure is still failed", async () => {
    await expect(
      inTenant(() =>
        audited({ action: "admin_action", details: { type: "r14" } }, async () => {
          throw new Error("refused");
        })
      )
    ).rejects.toThrow("refused");
    expect(audits.map((a) => a.outcome)).toEqual(["attempted", "failed"]);
  });
});

describe("R14-L2 the config writers that commit their own transaction", () => {
  it("setConfigWithHistory: a lost commit is indeterminate, audited so, and still invalidates", async () => {
    failCommit = { when: /insert into tenant_config_overrides/, ...LOST };
    const result = await inTenant(() =>
      setConfigWithHistory(
        KEY,
        [["agent:a", { owner: ACTOR, scopes: [], status: "suspended" }]],
        ACTOR,
        "suspend",
        "admin_ui",
        undefined,
        { scope: "tenant", operator: false }
      )
    );
    expect(result).toMatchObject({ success: false, indeterminate: true });
    expect(result.error).toMatch(/may or may not have been applied/);
    expect(audits.map((a) => a.outcome)).toEqual(["attempted", "indeterminate"]);
    expect(cacheSet).toHaveBeenCalledTimes(1);
  });

  it("setConfigWithHistory: a refused write is failed and publishes nothing", async () => {
    failCommit = {
      when: /insert into tenant_config_overrides/,
      code: "40001",
      message: "could not serialize access",
    };
    const result = await inTenant(() =>
      setConfigWithHistory(KEY, [], ACTOR, "clear", "admin_ui", undefined, {
        scope: "tenant",
        operator: false,
      })
    );
    expect(result).toMatchObject({ success: false });
    expect(result.indeterminate).toBeUndefined();
    expect(audits.map((a) => a.outcome)).toEqual(["attempted", "failed"]);
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("clearTenantConfig: a lost commit is indeterminate, audited so, and still invalidates", async () => {
    overridden = true;
    failCommit = { when: /delete from tenant_config_overrides/, ...LOST };
    const result = await inTenant(() => clearTenantConfig(KEY, ACTOR, "reset", false));
    expect(result).toMatchObject({ success: false, indeterminate: true });
    expect(audits.map((a) => a.outcome)).toEqual(["attempted", "indeterminate"]);
    expect(cacheSet).toHaveBeenCalledTimes(1);
  });
});
