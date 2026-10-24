/**
 * @jest-environment node
 */
/**
 * Layered configuration and two-person approval on Postgres (ADR-053 D5)
 *
 * Each run adds its own test keys to platform_config (random names, removed afterwards), so it
 * never changes a default another suite reads.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-test",
}));
// The audit log is another module's (and its own suite's); here it records nothing and lets the
// change proceed, as a working log does.
jest.mock("@/platform/auth/audit", () => {
  class AuditWriteError extends Error {}
  return {
    AuditWriteError,
    audited: jest.fn((_entry: unknown, fn: () => unknown) => fn()),
  };
});

import { randomUUID } from "node:crypto";
import { withOwnerTx } from "@/platform/data";
import { runWithTenant, runWithoutTenant } from "@/platform/tenancy/context";
import {
  clearConfigCache,
  clearTenantConfig,
  getConfig,
  getConfigBoolean,
  getConfigHistory,
  getConfigNumber,
  getConfigOrThrow,
  getConfigString,
  getEnhancedConfig,
  getPermissionTier,
  listConfig,
  listEnhancedConfig,
  setConfigWithHistory,
} from "@/platform/auth/platform-config";
import {
  approveAndApply,
  approveChange,
  countPendingApprovals,
  getApproval,
  listApprovals,
  rejectChange,
  requestApproval,
} from "@/platform/admin/config-approval";
import { audited, AuditWriteError } from "@/platform/auth/audit";
import {
  DB_ENABLED,
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";

const RUN = randomUUID().slice(0, 8);
const OPEN = `test.${RUN}.open`; // tenant_overridable
const LOCKED = `test.${RUN}.locked`; // governs the platform
const NUM = `test.${RUN}.num`;
const KEYS = [OPEN, LOCKED, NUM];

let a: TestTenant;
let b: TestTenant;
let ua: string, ua2: string, ua3: string, ub: string, ub2: string;
const single = <T>(t: TestTenant, fn: () => T) =>
  runWithTenant({ tenantId: t.id, mode: "single" }, fn);

const SUITE = "layered configuration (ADR-053 D5)";

// Once per file, as before; nothing connects when the database is absent.
if (DB_ENABLED) {
  beforeAll(async () => {
    await connectTestDatabase();
    await withOwnerTx("operator", async (tx) => {
      await tx.query(
        `insert into platform_config
           (key, value, default_value, description, category, value_type, permission_tier, tenant_overridable, min_value, max_value)
         values
           ($1, '"base"', '"base"', 'open test key', $4, 'string', 'standard', true, null, null),
           ($2, 'false', 'false', 'locked test key', $4, 'boolean', 'safety', false, null, null),
           ($3, '5', '5', 'numeric test key', $4, 'number', 'standard', true, '"1"', '"10"')`,
        [OPEN, LOCKED, NUM, `test-${RUN}`]
      );
    });
    a = await createTestTenant();
    b = await createTestTenant();
    ua = await a.user("admin");
    ua2 = await a.user("reviewer");
    ua3 = await a.user("third");
    ub = await b.user("admin");
    ub2 = await b.user("reviewer");
  });
  afterAll(async () => {
    await withOwnerTx("operator", async (tx) => {
      await tx.query("delete from platform_config_history where config_key = any($1)", [
        KEYS,
      ]);
      await tx.query("delete from config_pending_approvals where config_key = any($1)", [
        KEYS,
      ]);
      await tx.query("delete from tenant_config_overrides where key = any($1)", [KEYS]);
      await tx.query("delete from platform_config where key = any($1)", [KEYS]);
    });
    await dropTestTenants();
    await disconnectTestDatabase();
  });
  beforeEach(() => {
    clearConfigCache();
    (audited as jest.Mock).mockImplementation((_e: unknown, fn: () => unknown) => fn());
  });
}

dbDescribe(`${SUITE} reads`, () => {
  it("a tenant without its own value reads the platform default; outside a tenant, the default", async () => {
    await expect(a.run(() => getConfig(OPEN))).resolves.toBe("base");
    await expect(runWithoutTenant(() => getConfig(OPEN))).resolves.toBe("base");
    await expect(a.run(() => getConfig("test.missing.key", "dflt"))).resolves.toBe(
      "dflt"
    );
    await expect(a.run(() => getConfigOrThrow("test.missing.key"))).rejects.toThrow(
      /not found/
    );
  });

  it("typed reads coerce as before", async () => {
    await expect(a.run(() => getConfigNumber(NUM))).resolves.toBe(5);
    await expect(a.run(() => getConfigBoolean(LOCKED))).resolves.toBe(false);
    await expect(a.run(() => getConfigString(NUM))).resolves.toBe("5");
  });

  it("parses JSON-text min/max (Gotcha #6) and reports metadata", async () => {
    const e = await a.run(() => getEnhancedConfig(NUM));
    expect(e).toMatchObject({
      valueType: "number",
      minValue: 1,
      maxValue: 10,
      tenantOverridable: true,
      overridden: false,
      platformValue: 5,
    });
    await expect(a.run(() => getPermissionTier(LOCKED))).resolves.toBe("safety");
    await expect(a.run(() => getPermissionTier("test.missing.key"))).resolves.toBe(
      "safety"
    );
    await expect(a.run(() => getEnhancedConfig("test.missing.key"))).resolves.toBeNull();
  });

  it("lists entries with filters done in code", async () => {
    const all = await a.run(() => listEnhancedConfig({ category: `test-${RUN}` }));
    expect(all.map((e) => e.key).sort()).toEqual([...KEYS].sort());
    const safety = await a.run(() =>
      listEnhancedConfig({ category: `test-${RUN}`, permissionTier: "safety" })
    );
    expect(safety.map((e) => e.key)).toEqual([LOCKED]);
    const searched = await a.run(() => listEnhancedConfig({ query: "NUMERIC test" }));
    expect(searched.map((e) => e.key)).toEqual([NUM]);
    const odd = await a.run(() => listEnhancedConfig({ query: "x' or 1=1 --" }));
    expect(odd).toEqual([]);
    const plain = await a.run(() => listConfig(`test-${RUN}`));
    expect(plain).toHaveLength(3);
  });
});

dbDescribe(`${SUITE} a tenant's own values (shared deployment)`, () => {
  it("a tenant administrator sets a tenant-settable key for its tenant only", async () => {
    const r = await a.run(() =>
      setConfigWithHistory(OPEN, "a-value", ua, "set for A", "admin_ui", undefined, {
        scope: "tenant",
        operator: false,
      })
    );
    expect(r).toEqual({ success: true, historyWriteFailed: false });
    await expect(a.run(() => getConfig(OPEN))).resolves.toBe("a-value");
    clearConfigCache();
    await expect(b.run(() => getConfig(OPEN))).resolves.toBe("base");
    await expect(runWithoutTenant(() => getConfig(OPEN))).resolves.toBe("base");
    const e = await a.run(() => getEnhancedConfig(OPEN));
    expect(e).toMatchObject({
      value: "a-value",
      overridden: true,
      platformValue: "base",
    });
  });

  it("caches per tenant: A's value is never served to B", async () => {
    await a.run(() => getConfig(OPEN)); // A's value cached
    await expect(b.run(() => getConfig(OPEN))).resolves.toBe("base");
  });

  it("refuses a tenant administrator a key that governs the platform — in code and in the database", async () => {
    const r = await a.run(() =>
      setConfigWithHistory(LOCKED, true, ua, "try", "admin_ui", undefined, {
        scope: "tenant",
        operator: false,
      })
    );
    expect(r.success).toBe(false);
    // Even past the code check, row-level security refuses it.
    const entry = await a.run(() => getEnhancedConfig(LOCKED));
    const forced = await a.run(() =>
      setConfigWithHistory(
        LOCKED,
        true,
        ua,
        "forced",
        "admin_ui",
        { ...entry!, tenantOverridable: true },
        { scope: "tenant", operator: false }
      )
    );
    expect(forced.success).toBe(false);
    await expect(a.run(() => getConfig(LOCKED))).resolves.toBe(false);
  });

  it("an operator may set any key for a tenant", async () => {
    const r = await b.run(() =>
      setConfigWithHistory(LOCKED, true, ub, "op", "admin_ui", undefined, {
        scope: "tenant",
        operator: true,
      })
    );
    expect(r.success).toBe(true);
    await expect(b.run(() => getConfig(LOCKED))).resolves.toBe(true);
    clearConfigCache();
    await expect(a.run(() => getConfig(LOCKED))).resolves.toBe(false);
  });

  it("only an operator changes a shared deployment's platform default", async () => {
    const refused = await a.run(() =>
      setConfigWithHistory(NUM, 6, ua, "x", "admin_ui", undefined, {
        scope: "platform",
        operator: false,
      })
    );
    expect(refused.success).toBe(false);
    const ok = await a.run(() =>
      setConfigWithHistory(NUM, 7, ua, "op default", "admin_ui", undefined, {
        scope: "platform",
        operator: true,
      })
    );
    expect(ok.success).toBe(true);
    await expect(b.run(() => getConfig(NUM))).resolves.toBe(7);
  });

  it("validates against the key's metadata before anything is written", async () => {
    const r = await a.run(() =>
      setConfigWithHistory(NUM, 99, ua, "too big", "admin_ui", undefined, {
        scope: "tenant",
        operator: false,
      })
    );
    expect(r.success).toBe(false);
    expect(r.validationErrors?.[0]).toMatch(/exceeds maximum 10/);
  });

  it("changes nothing when the audit record cannot be written", async () => {
    (audited as jest.Mock).mockRejectedValueOnce(
      new (AuditWriteError as unknown as new (m: string) => Error)("down")
    );
    const r = await a.run(() =>
      setConfigWithHistory(NUM, 3, ua, "no audit", "admin_ui", undefined, {
        scope: "tenant",
        operator: false,
      })
    );
    expect(r).toMatchObject({ success: false });
    clearConfigCache();
    await expect(a.run(() => getConfig(NUM))).resolves.toBe(7);
  });

  it("records history visible to the tenant whose change it is, and hides the operators' default changes", async () => {
    const histA = await a.run(() => getConfigHistory({ configKey: OPEN }));
    expect(histA[0]).toMatchObject({
      newValue: "a-value",
      previousValue: "base",
      scope: "tenant",
    });
    const histB = await b.run(() => getConfigHistory({ configKey: OPEN }));
    expect(histB).toEqual([]);
    // The operator's change to the shared default (made from A's request) is not A's to read.
    const numA = await a.run(() => getConfigHistory({ configKey: NUM }));
    expect(numA.some((h) => h.scope === "platform")).toBe(false);
    const limited = await a.run(() => getConfigHistory({ limit: 1 }));
    expect(limited).toHaveLength(1);
    const future = await a.run(() =>
      getConfigHistory({ configKey: OPEN, since: "2999-01-01T00:00:00Z" })
    );
    expect(future).toEqual([]);
  });

  it("clearing a tenant's value restores the default", async () => {
    const r = await a.run(() => clearTenantConfig(OPEN, ua, "back to default", false));
    expect(r.success).toBe(true);
    await expect(a.run(() => getConfig(OPEN))).resolves.toBe("base");
    const again = await a.run(() => clearTenantConfig(OPEN, ua, "noop", false));
    expect(again.success).toBe(true);
    const locked = await b.run(() => clearTenantConfig(LOCKED, ub, "x", false));
    expect(locked.success).toBe(false);
  });
});

dbDescribe(`${SUITE} a single-tenant deployment`, () => {
  it("its administrators change the platform default, as before tenancy, and see the history", async () => {
    const r = await single(a, () =>
      setConfigWithHistory(LOCKED, true, ua, "single admin", "admin_ui")
    );
    expect(r.success).toBe(true);
    await expect(single(a, () => getConfig(LOCKED))).resolves.toBe(true);
    const hist = await single(a, () => getConfigHistory({ configKey: LOCKED }));
    expect(hist[0]).toMatchObject({ scope: "platform", newValue: true });
  });
});

dbDescribe(`${SUITE} two-person approval`, () => {
  it("holds one request per key, refuses self-approval, approves once", async () => {
    const requester = ua;
    const reviewer = ua2;
    const req = await a.run(() =>
      requestApproval({
        configKey: NUM,
        currentValue: 7,
        proposedValue: 8,
        requestedBy: requester,
        changeComment: "please",
        scope: "tenant",
      })
    );
    expect(req.success).toBe(true);
    expect(req.record).toMatchObject({
      proposedValue: 8,
      status: "pending",
      scope: "tenant",
    });
    const dup = await a.run(() =>
      requestApproval({
        configKey: NUM,
        currentValue: 7,
        proposedValue: 9,
        requestedBy: requester,
        changeComment: "again",
        scope: "tenant",
      })
    );
    expect(dup.success).toBe(false);
    // One open request per key AND scope: a change to the platform default is another target.
    const other = await a.run(() =>
      requestApproval({
        configKey: NUM,
        currentValue: 7,
        proposedValue: 9,
        requestedBy: requester,
        changeComment: "the default",
        scope: "platform",
      })
    );
    expect(other.success).toBe(true);
    await a.run(() => rejectChange(other.record!.id, requester, "withdrawn"));
    // B neither sees nor decides A's request.
    await expect(b.run(() => getApproval(req.record!.id))).resolves.toBeNull();
    await expect(b.run(() => countPendingApprovals())).resolves.toBe(0);
    const bDecides = await b.run(() => approveChange(req.record!.id, ub, "x"));
    expect(bDecides.errorCode).toBe("approvals.hold_not_found");

    const self = await a.run(() => approveChange(req.record!.id, requester, "mine"));
    expect(self.errorCode).toBe("approvals.self_approval");
    await expect(a.run(() => countPendingApprovals())).resolves.toBe(1);

    const ok = await a.run(() => approveChange(req.record!.id, reviewer, "fine"));
    expect(ok).toMatchObject({
      success: true,
      record: { status: "approved", reviewedBy: reviewer },
    });
    const twice = await a.run(() => approveChange(req.record!.id, ua3, "late"));
    expect(twice.errorCode).toBe("approvals.decision_conflict");
    const listed = await a.run(() =>
      listApprovals({ configKey: NUM, status: "approved" })
    );
    expect(listed.map((r) => r.id)).toContain(req.record!.id);
  });

  it("a 'reset' approval records its action; a reset of a platform default is refused", async () => {
    const req = await a.run(() =>
      requestApproval({
        configKey: OPEN,
        currentValue: "mine",
        proposedValue: "base",
        requestedBy: ua,
        changeComment: "back to default",
        scope: "tenant",
        action: "reset",
      })
    );
    expect(req.record).toMatchObject({ action: "reset", scope: "tenant" });
    await expect(a.run(() => getApproval(req.record!.id))).resolves.toMatchObject({
      action: "reset",
    });
    await a.run(() => rejectChange(req.record!.id, ua, "withdrawn"));
    // The database refuses a reset whose target is the platform default.
    const bad = await a.run(() =>
      requestApproval({
        configKey: OPEN,
        currentValue: "x",
        proposedValue: "base",
        requestedBy: ua,
        changeComment: "nonsense",
        scope: "platform",
        action: "reset",
      })
    );
    expect(bad.success).toBe(false);
  });

  it("concurrent approvals: exactly one wins", async () => {
    const req = await a.run(() =>
      requestApproval({
        configKey: OPEN,
        currentValue: "base",
        proposedValue: "race",
        requestedBy: ua,
        changeComment: "race",
        scope: "tenant",
      })
    );
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        a.run(() => approveChange(req.record!.id, i % 2 ? ua2 : ua3, "go"))
      )
    );
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(
      results.filter((r) => r.errorCode === "approvals.decision_conflict")
    ).toHaveLength(5);
  });

  it("reopens an approval whose change cannot be applied", async () => {
    const req = await a.run(() =>
      requestApproval({
        configKey: LOCKED,
        currentValue: false,
        proposedValue: true,
        requestedBy: ua,
        changeComment: "reopen me",
      })
    );
    const out = await a.run(() =>
      approveAndApply(req.record!.id, ua2, "ok", async () => ({
        success: false,
        error: "cannot",
      }))
    );
    expect(out).toMatchObject({ success: false, applyError: "cannot" });
    await expect(a.run(() => getApproval(req.record!.id))).resolves.toMatchObject({
      status: "pending",
      reviewedBy: null,
    });
    const rejected = await a.run(() => rejectChange(req.record!.id, ua2, "no"));
    expect(rejected.record?.status).toBe("rejected");
  });

  it("lets a requester cancel their own request, and applies the stored value as it is", async () => {
    const req = await b.run(() =>
      requestApproval({
        configKey: OPEN,
        currentValue: "base",
        proposedValue: ["a", 1],
        requestedBy: ub,
        changeComment: "cancel me",
        scope: "tenant",
      })
    );
    const cancelled = await b.run(() => rejectChange(req.record!.id, ub, "never mind"));
    expect(cancelled.record).toMatchObject({ status: "rejected", reviewedBy: ub });

    const again = await b.run(() =>
      requestApproval({
        configKey: OPEN,
        currentValue: "base",
        proposedValue: { nested: [1, "two"] },
        requestedBy: ub,
        changeComment: "apply me",
        scope: "tenant",
      })
    );
    const apply = jest.fn(async () => ({ success: true }));
    const done = await b.run(() => approveAndApply(again.record!.id, ub2, "ok", apply));
    expect(done.success).toBe(true);
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        proposedValue: { nested: [1, "two"] },
        scope: "tenant",
      })
    );
    const selfApply = jest.fn();
    const third = await b.run(() =>
      requestApproval({
        configKey: OPEN,
        currentValue: "base",
        proposedValue: "x",
        requestedBy: ub,
        changeComment: "self",
      })
    );
    const refused = await b.run(() =>
      approveAndApply(third.record!.id, ub, "mine", selfApply)
    );
    expect(refused.errorCode).toBe("approvals.self_approval");
    expect(selfApply).not.toHaveBeenCalled();
    await b.run(() => rejectChange(third.record!.id, ub, "cleanup"));
  });

  it("expires an approval past its time", async () => {
    const req = await b.run(() =>
      requestApproval({
        configKey: NUM,
        currentValue: 7,
        proposedValue: 2,
        requestedBy: ub,
        changeComment: "old",
      })
    );
    await withOwnerTx("operator", (tx) =>
      tx.query(
        "update config_pending_approvals set expires_at = now() - interval '1 day' where id = $1",
        [req.record!.id]
      )
    );
    const r = await b.run(() => approveChange(req.record!.id, ub2, "late"));
    expect(r.errorCode).toBe("approvals.expired");
    await expect(b.run(() => getApproval(req.record!.id))).resolves.toMatchObject({
      status: "expired",
    });
    await expect(b.run(() => getApproval("not-a-uuid"))).resolves.toBeNull();
    const bad = await b.run(() => approveChange("not-a-uuid", ub2, "x"));
    expect(bad.errorCode).toBe("approvals.hold_not_found");
  });
});
