/**
 * @jest-environment node
 */
/**
 * platform/admin/__tests__/config-scope.test.ts — where a config change goes (ADR-053 D5)
 */

import {
  OPERATOR_PERMISSION,
  approvedChangeTarget,
  isOperator,
  isSharedDeployment,
  resolveConfigTarget,
} from "../config-scope";
import { runWithTenant, runWithoutTenant } from "@/platform/tenancy/context";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";

const T = "11111111-1111-4111-8111-111111111111";
const shared = <R>(fn: () => R) => runWithTenant({ tenantId: T, mode: "shared" }, fn);
const single = <R>(fn: () => R) => runWithTenant({ tenantId: T, mode: "single" }, fn);
const open = { key: "default_language", tenantOverridable: true };
const locked = { key: "config.dual_control_keys", tenantOverridable: false };

const admin = (permissions: string[]): VerifiedAdmin => ({
  userId: "u",
  sub: "s",
  roleName: "admin",
  permissions,
});

describe("isOperator", () => {
  it("is the platform_operate permission, and the development bypass holds it", () => {
    expect(OPERATOR_PERMISSION).toBe("platform_operate");
    expect(isOperator(admin(["platform_operate"]))).toBe(true);
    expect(isOperator(admin(["config_manage_safety"]))).toBe(false);
    expect(isOperator(admin(["*"]))).toBe(true);
  });
});

describe("a single-tenant deployment", () => {
  it("changes the platform default, whatever was asked, for any key", () => {
    for (const requested of [undefined, "tenant", "platform"] as const) {
      expect(single(() => resolveConfigTarget(false, locked, requested))).toEqual({
        ok: true,
        target: { scope: "platform", operator: false },
      });
    }
    expect(runWithoutTenant(() => isSharedDeployment())).toBe(false);
    expect(single(() => approvedChangeTarget(false, "platform"))).toMatchObject({
      ok: true,
    });
  });
});

describe("a shared deployment", () => {
  it("a tenant administrator sets a tenant-settable key for the tenant", () => {
    expect(shared(() => resolveConfigTarget(false, open))).toEqual({
      ok: true,
      target: { scope: "tenant", operator: false },
    });
  });

  it("refuses a tenant administrator a key that governs the platform", () => {
    expect(shared(() => resolveConfigTarget(false, locked))).toMatchObject({ ok: false });
  });

  it("refuses a tenant administrator the platform default, even of a tenant-settable key", () => {
    expect(shared(() => resolveConfigTarget(false, open, "platform"))).toMatchObject({
      ok: false,
    });
  });

  it("an operator sets any key for the tenant, or the default when asked", () => {
    expect(shared(() => resolveConfigTarget(true, locked))).toEqual({
      ok: true,
      target: { scope: "tenant", operator: true },
    });
    expect(shared(() => resolveConfigTarget(true, locked, "platform"))).toEqual({
      ok: true,
      target: { scope: "platform", operator: true },
    });
  });

  it("only an operator approves a change to the platform default", () => {
    expect(shared(() => approvedChangeTarget(false, "platform"))).toMatchObject({
      ok: false,
    });
    expect(shared(() => approvedChangeTarget(true, "platform"))).toEqual({
      ok: true,
      target: { scope: "platform", operator: true },
    });
    expect(shared(() => approvedChangeTarget(false, "tenant"))).toEqual({
      ok: true,
      target: { scope: "tenant", operator: false },
    });
  });
});
