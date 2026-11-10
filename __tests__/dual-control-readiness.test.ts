/**
 * __tests__/dual-control-readiness.test.ts — operator readiness says whether erasure can delete
 * identities, whether the app client's secret is the pool's, and which dual-controlled action has
 * no second approver (N-22, N-52, N-24)
 *
 * The readiness module's three new checks, with the provider and the readers faked, and the rule
 * of `unapprovable` on its own: an action is ready when a second account in good standing holds
 * every permission its approval needs — in each tenant with staff, for a tenant's action; across
 * the deployment, for an operator's — and each one without is named. The SQL that reads the staff
 * is proved against Postgres in __tests__/db/eligible-approvers.db.test.ts.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockProvider: { current: Record<string, unknown> | undefined } = {
  current: undefined,
};
jest.mock("@/platform/auth/config", () => ({
  getAuthProvider: () => {
    if (!mockProvider.current) throw new Error("no provider");
    return mockProvider.current;
  },
}));
const mockDual = jest.fn();
jest.mock("@/platform/admin/dual-control-readiness", () => ({
  ...jest.requireActual("@/platform/admin/dual-control-readiness"),
  checkDualControlReadiness: (...a: unknown[]) => mockDual(...a),
}));
jest.mock("@/platform/data", () => ({
  ...jest.requireActual("@/platform/data"),
  hasDatabase: () => false,
}));

import { checkTenancyReadiness } from "@/platform/tenancy/readiness";
import {
  describeUnapprovable,
  unapprovable,
  type DualControlledAction,
} from "@/platform/admin/dual-control-readiness";
import type { StaffAccount } from "@/platform/admin/eligible-approvers";

const staff = (id: string, permissions: string[], tenantId = "t1"): StaffAccount => ({
  userId: id,
  sub: `sub-${id}`,
  email: `${id}@example.org`,
  roleName: "x",
  permissions,
  tenantId,
});

const PURGE: DualControlledAction = {
  action: "purge_user_data",
  permissions: ["admin_purge_user_data", "can_access_admin"],
  across: "tenant",
};
const ATTEST: DualControlledAction = {
  action: "erasure attestation",
  permissions: ["platform_operate"],
  across: "deployment",
};
const SUPER = [
  "admin_purge_user_data",
  "can_access_admin",
  "platform_operate",
  "admin_manage_roles",
];

describe("unapprovable: two eligible accounts, or the action is named (N-24)", () => {
  it("one super_admin alone: every action is named, with what its approver needs", () => {
    const missing = unapprovable([PURGE, ATTEST], [staff("a", SUPER)]);
    expect(missing).toEqual([
      {
        action: "purge_user_data",
        permissions: ["admin_purge_user_data", "can_access_admin"],
        tenant: "t1",
        eligible: 1,
      },
      { action: "erasure attestation", permissions: ["platform_operate"], eligible: 1 },
    ]);
    expect(describeUnapprovable(missing, true)).toMatch(
      /No second approver for: purge_user_data \(its approver needs admin_purge_user_data, can_access_admin; one account holds them: the requester could not be approved\); erasure attestation/
    );
  });

  it("a super_admin and a safety approver: the erasure is ready, the attestation is not", () => {
    const missing = unapprovable(
      [PURGE, ATTEST],
      [
        staff("a", SUPER),
        staff("b", ["admin_purge_user_data", "can_access_admin", "config_view"]),
      ]
    );
    expect(missing.map((m) => m.action)).toEqual(["erasure attestation"]);
  });

  it("two super_admins: every action ready", () => {
    expect(unapprovable([PURGE, ATTEST], [staff("a", SUPER), staff("b", SUPER)])).toEqual(
      []
    );
    expect(describeUnapprovable([], true)).toMatch(/Every dual-controlled action/);
  });

  it("a tenant's action is weighed within each tenant with staff; an operator's across tenants", () => {
    const missing = unapprovable(
      [PURGE, ATTEST],
      [staff("a", SUPER, "t1"), staff("b", SUPER, "t2")],
      new Map([
        ["t1", "home"],
        ["t2", "acme"],
      ])
    );
    expect(missing.map((m) => [m.action, m.tenant])).toEqual([
      ["purge_user_data", "home"],
      ["purge_user_data", "acme"],
    ]);
  });

  it("an account holding only part of what the approval needs is not counted", () => {
    const missing = unapprovable(
      [PURGE],
      [staff("a", SUPER), staff("b", ["can_access_admin"])]
    );
    expect(missing).toHaveLength(1);
  });

  it("a wildcard holder ('*', the local development bypass) counts as holding everything", () => {
    expect(unapprovable([PURGE], [staff("a", SUPER), staff("b", ["*"])])).toEqual([]);
  });
});

describe("operator readiness: erasure, client secret, dual control (N-22, N-52, N-24)", () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    process.env = {
      ...ENV,
      TENANCY_MODE: "single",
      TENANT_ID: "00000000-0000-4000-8000-000000000001",
    };
    mockDual.mockResolvedValue({ state: "ready", detail: "fine", unapprovable: [] });
  });
  afterAll(() => {
    process.env = ENV;
  });

  const byName = async () =>
    Object.fromEntries((await checkTenancyReadiness()).checks.map((c) => [c.name, c]));

  it("a single deployment checks erasure too: no administrative key is not ready, named", async () => {
    mockProvider.current = {
      checkErasureAccess: async () => ({
        state: "missing",
        reason: "COGNITO_ADMIN_ACCESS_KEY_ID is not set",
      }),
    };
    const c = await byName();
    expect(c.erasure).toEqual({
      name: "erasure",
      state: "not_ready",
      detail: "Erasure cannot delete identities: COGNITO_ADMIN_ACCESS_KEY_ID is not set.",
    });
    expect(c.identity.state).toBe("not_needed");
  });

  it("a refused AdminDeleteUser is not ready; a pool that does not answer is unknown; allowed is ready", async () => {
    mockProvider.current = {
      checkErasureAccess: async () => ({
        state: "denied",
        action: "AdminDeleteUser",
        reason: "the key may not call cognito-idp:AdminDeleteUser",
      }),
    };
    expect((await byName()).erasure.state).toBe("not_ready");
    mockProvider.current = {
      checkErasureAccess: async () => ({
        state: "unknown",
        reason: "ListUsers did not answer",
      }),
    };
    expect((await byName()).erasure.state).toBe("unknown");
    mockProvider.current = { checkErasureAccess: async () => ({ state: "ready" }) };
    expect((await byName()).erasure.state).toBe("ready");
  });

  it("a provider that keeps no identities to erase (the mock) is not_needed", async () => {
    mockProvider.current = {};
    const c = await byName();
    expect(c.erasure.state).toBe("not_needed");
    expect(c.client_secret.state).toBe("not_needed");
  });

  it("a client secret that is not the pool's is not ready; one not checkable is unknown", async () => {
    mockProvider.current = {
      checkClientSecret: async () => ({ state: "mismatch", reason: "differs" }),
    };
    expect((await byName()).client_secret).toMatchObject({ state: "not_ready" });
    mockProvider.current = {
      checkClientSecret: async () => ({ state: "not_checkable", reason: "no key" }),
    };
    expect((await byName()).client_secret.state).toBe("unknown");
    mockProvider.current = { checkClientSecret: async () => ({ state: "ready" }) };
    expect((await byName()).client_secret.state).toBe("ready");
  });

  it("dual control not ready makes the deployment not ready, and says what lacks an approver", async () => {
    mockProvider.current = {};
    mockDual.mockResolvedValue({
      state: "not_ready",
      detail: "No second approver for: purge_user_data (…)",
      unapprovable: [],
    });
    const r = await checkTenancyReadiness();
    expect(r.ready).toBe(false);
    expect(r.checks.find((c) => c.name === "dual_control")).toEqual({
      name: "dual_control",
      state: "not_ready",
      detail: "No second approver for: purge_user_data (…)",
    });
  });

  it("passes the app's own held actions to the dual-control check", async () => {
    mockProvider.current = {};
    const held = async () => [PURGE];
    await checkTenancyReadiness({ heldActions: held });
    expect(mockDual).toHaveBeenLastCalledWith(held);
  });
});
