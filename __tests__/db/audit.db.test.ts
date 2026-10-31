/**
 * @jest-environment node
 */
/**
 * platform/auth/audit.ts against the replayed database: records are written in the current
 * tenant, the fail-closed contract holds (no record, no action), reads are bounded and mapped,
 * and one tenant never sees another's records (ADR-053 D8).
 */

jest.mock("@/platform/data", () => jest.requireActual("../helpers/data-spy").spiedData());
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { createHash } from "node:crypto";
import {
  AuditWriteError,
  audited,
  auditedResponse,
  auditRowsForUser,
  getAuditLogForUser,
  recordAudit,
  writeAuditLog,
} from "@/platform/auth/audit";
import { withTenantTx } from "@/platform/data";
import { runWithoutTenant } from "@/platform/tenancy/context";
import { runTenantIsolationContract } from "../contract/tenant-isolation-contract";
import { dataSpy, resetDataSpy, uuid } from "../helpers/data-spy";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";

/** A stable UUID for a free-text key (the isolation kit's keys). */
function uuidFor(key: string): string {
  const h = createHash("sha1").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

dbDescribe("platform/auth/audit (Postgres)", () => {
  let t: TestTenant;

  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });
  beforeEach(async () => {
    resetDataSpy();
    t = await createTestTenant();
  });

  it("records every field, the agent in details, in the current tenant", async () => {
    const actor = await t.user("actor");
    const target = uuid();
    await t.run(() =>
      recordAudit({
        action: "role_changed",
        actorId: actor,
        targetId: target,
        agent: "escalation-reaper",
        // TASK-193: the keys role_changed's schema allows (platform/auth/audit-details.ts).
        details: { oldRole: "free", newRole: "admin" },
        ipAddress: "10.0.0.7",
        userAgent: "jest",
      })
    );
    const rows = await t.run(() =>
      withTenantTx((tx) => auditRowsForUser(tx, target, 10))
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "role_changed",
      actor_id: actor,
      target_id: target,
      details: { oldRole: "free", newRole: "admin", agent: "escalation-reaper" },
      ip_address: "10.0.0.7",
      user_agent: "jest",
      tenant_id: t.id,
    });
    expect(typeof rows[0].created_at).toBe("string");
  });

  it("stores empty details and nulls for what was not given", async () => {
    const target = uuid();
    await t.run(() => recordAudit({ action: "login_success", targetId: target }));
    const [row] = await t.run(() =>
      withTenantTx((tx) => auditRowsForUser(tx, target, 10))
    );
    expect(row).toMatchObject({
      actor_id: null,
      details: {},
      ip_address: null,
      user_agent: null,
    });
  });

  it("refuses a placeholder id before writing", async () => {
    await expect(
      t.run(() => recordAudit({ action: "admin_action", actorId: "dev-admin" }))
    ).rejects.toThrow(AuditWriteError);
    expect(dataSpy().writes).toEqual([]);
  });

  it("throws AuditWriteError when the database refuses the row", async () => {
    await expect(
      t.run(() => recordAudit({ action: "no_such_action" as never, targetId: uuid() }))
    ).rejects.toThrow(AuditWriteError);
  });

  it("throws AuditWriteError outside any tenant (nothing is written anywhere)", async () => {
    await runWithoutTenant(async () => {
      await expect(recordAudit({ action: "login_success" })).rejects.toThrow(
        AuditWriteError
      );
    });
  });

  it("writeAuditLog never throws, even when the record cannot be written", async () => {
    dataSpy().auditDown = true;
    await expect(
      t.run(() => writeAuditLog({ action: "guest_nudge_shown" }))
    ).resolves.toBeUndefined();
  });

  describe("audited()", () => {
    it("records the attempt, then runs the action", async () => {
      const target = uuid();
      const order: string[] = [];
      const out = await t.run(() =>
        audited({ action: "admin_action", targetId: target }, async () => {
          order.push(`writes:${dataSpy().writes.length}`);
          return { success: true };
        })
      );
      expect(out).toEqual({ success: true });
      expect(order).toEqual(["writes:1"]);
      const rows = await t.run(() =>
        withTenantTx((tx) => auditRowsForUser(tx, target, 10))
      );
      expect(rows.map((r) => r.details.outcome)).toEqual(["attempted"]);
    });

    it("never runs the action when the attempt cannot be recorded", async () => {
      dataSpy().auditDown = true;
      const act = jest.fn(async () => ({ success: true }));
      await expect(
        t.run(() => audited({ action: "admin_action", targetId: uuid() }, act))
      ).rejects.toThrow(AuditWriteError);
      expect(act).not.toHaveBeenCalled();
    });

    it("adds a failed record when the action reports failure or throws", async () => {
      const target = uuid();
      await t.run(() =>
        audited({ action: "admin_action", targetId: target }, async () => ({
          success: false,
          error: "refused",
        }))
      );
      await expect(
        t.run(() =>
          audited({ action: "admin_action", targetId: target }, async () => {
            throw new Error("boom");
          })
        )
      ).rejects.toThrow("boom");
      const rows = await t.run(() =>
        withTenantTx((tx) => auditRowsForUser(tx, target, 10))
      );
      const outcomes = rows.map((r) => `${r.details.outcome}:${r.details.reason ?? ""}`);
      expect(outcomes.sort()).toEqual(
        ["attempted:", "attempted:", "failed:boom", "failed:refused"].sort()
      );
    });

    it("auditedResponse answers `unavailable` when the record cannot be written", async () => {
      dataSpy().auditDown = true;
      const out = await t.run(() =>
        auditedResponse(
          { action: "admin_action" },
          async () => ({ success: true, response: "done" }),
          () => "unavailable"
        )
      );
      expect(out).toBe("unavailable");
    });
  });

  describe("getAuditLogForUser", () => {
    it("returns records where the user is actor or target, newest first, mapped", async () => {
      const user = await t.user("subject");
      const other = uuid();
      await t.run(async () => {
        await recordAudit({ action: "login_success", actorId: user });
        await recordAudit({ action: "role_changed", actorId: other, targetId: user });
        await recordAudit({ action: "login_failed", actorId: other });
      });
      const entries = await t.run(() => getAuditLogForUser(user));
      expect(entries.map((e) => e.action).sort()).toEqual([
        "login_success",
        "role_changed",
      ]);
      const changed = entries.find((e) => e.action === "role_changed");
      expect(changed).toEqual({
        action: "role_changed",
        actorId: other,
        targetId: user,
        details: {},
        ipAddress: undefined,
        userAgent: undefined,
      });
    });

    it("orders newest first and honours the limit", async () => {
      const user = uuid();
      for (const action of ["login_success", "login_failed", "mfa_enabled"] as const) {
        await t.run(() => recordAudit({ action, targetId: user }));
      }
      const entries = await t.run(() => getAuditLogForUser(user, 2));
      expect(entries.map((e) => e.action)).toEqual(["mfa_enabled", "login_failed"]);
    });

    it.each(["not-a-uuid", "x,actor_id.neq.null", ""])(
      "returns nothing for the crafted id %p, without a query",
      async (id) => {
        await expect(t.run(() => getAuditLogForUser(id))).resolves.toEqual([]);
      }
    );

    it("returns nothing when the log cannot be read", async () => {
      await runWithoutTenant(async () => {
        await expect(getAuditLogForUser(uuid())).resolves.toEqual([]);
      });
    });
  });

  runTenantIsolationContract({
    name: "audit records",
    makeStore: () => null,
    createTenant: createTestTenant,
    write: async (_s, key) => {
      await recordAudit({
        action: "admin_action",
        targetId: uuidFor(key),
        details: { key },
      });
    },
    read: async (_s, key) => {
      const entries = await getAuditLogForUser(uuidFor(key));
      return entries.length > 0 ? entries : null;
    },
    // Audit records are append-only (no update or delete path), and a write outside a tenant is
    // an AuditWriteError rather than a TenantContextError (covered above).
    failsClosedWithoutTenant: false,
  });
});
