/**
 * __tests__/no-eligible-approver.test.ts — a dual-controlled request no one else could approve is
 * refused up front, never held to lapse (N-24, N-85, TASK-203); and an erasure request's refusal
 * record is never swallowed (N-28)
 *
 * Every path that holds an action for a second person — the command bar (and the pages that hold
 * through it: the erasure, a role change), a held setting, a configuration approval, an operator's
 * tenant deletion and erasure attestation — asks who else could approve it first: an account in good
 * standing (the eligible-approvers statement, faked here: fakeData().approvers; its SQL is
 * __tests__/db/eligible-approvers.db.test.ts's) holding every permission the approval needs, not
 * the requester (by any of its ids) nor the account the action acts on, and passing the action's own
 * rule. None: `approvals.no_eligible_approver`, naming the action and what its approver needs;
 * nothing held. Unreadable: refused (fail closed). The rules themselves are unchanged.
 */

// hostile:store-down: the staff read failing ("fail") is each path's own case below.
jest.mock("@/platform/auth/middleware", () =>
  require("@/__tests__/helpers/test-identities").mockMiddleware()
);
jest.mock("@/platform/auth/permissions-cache", () =>
  require("@/__tests__/helpers/test-identities").mockPermissionsCache()
);
jest.mock("@/platform/auth/account-status-guard", () =>
  require("@/__tests__/helpers/test-identities").mockAccountStatus()
);
jest.mock("@/platform/rate-limit", () =>
  require("@/__tests__/helpers/test-identities").mockRateLimit()
);
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));
jest.mock("@/platform/data", () => require("./helpers/fake-data").fakeDataModule());
const mockAlert = jest.fn();
jest.mock("@/platform/observability/alert", () => ({
  raiseAlert: (a: unknown) => mockAlert(a),
}));
const mockList = jest.fn();
jest.mock("@/platform/auth/platform-config", () => ({
  ...jest.requireActual("@/platform/auth/platform-config"),
  getConfigOrThrow: (key: string) => mockList(key),
  getConfig: async (_key: string, fallback: unknown) => fallback,
  getPermissionTier: async () => "safety",
}));
jest.mock("@/app/api/admin/ai/handlers/purge", () => ({
  ...jest.requireActual("@/app/api/admin/ai/handlers/purge"),
  // The account and its role (none protected); the rule is the real one.
  checkPurgeUserData: async () => null,
}));

import { NextRequest } from "next/server";
import { authAs, CALLERS, type CallerName } from "@/__tests__/helpers/test-identities";
import { FAKE_SECOND_APPROVER, fakeData, type FakeStaffRow } from "./helpers/fake-data";
import {
  InMemoryProposalStore,
  setProposalStore,
} from "@/platform/agents/proposal-store";
import {
  InMemoryTrajectoryStore,
  setTrajectoryStore,
} from "@/platform/agents/trajectory-store";
import { POST as erasure } from "@/app/api/admin/gdpr/route";
import {
  DEFAULT_DUAL_CONTROL_ACTIONS,
  runCommandBarAction,
} from "@/app/api/admin/ai/command-bar";
import {
  configChangeWithoutApprover,
  requestApproval,
} from "@/platform/admin/config-approval";
import { secondOperatorRefusal } from "@/platform/tenancy/admin";
import { requestErasureAttestation } from "@/platform/gdpr/erasure-attestation";
import { runWithTenant } from "@/platform/tenancy/context";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";

const TENANT = "00000000-0000-4000-8000-000000000001";
const TARGET = "00000000-0000-4000-9000-0000000000dd";
let proposals: InMemoryProposalStore;

const asAdmin = (name: CallerName & keyof typeof CALLERS): VerifiedAdmin => ({
  userId: CALLERS[name].userId,
  sub: CALLERS[name].sub,
  roleName: name,
  permissions: [...CALLERS[name].permissions],
});
const row = (over: Partial<FakeStaffRow>): FakeStaffRow => ({
  ...FAKE_SECOND_APPROVER,
  ...over,
});
const inTenant = <T>(fn: () => Promise<T>) =>
  runWithTenant({ tenantId: TENANT, mode: "single" }, fn);

const ask = (caller: CallerName, body: Record<string, unknown>) =>
  erasure(
    new NextRequest("http://localhost/api/admin/gdpr", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...authAs(caller) },
    })
  );

beforeEach(() => {
  fakeData().reset();
  mockAlert.mockReset();
  proposals = new InMemoryProposalStore();
  setProposalStore(proposals);
  setTrajectoryStore(new InMemoryTrajectoryStore());
  mockList.mockImplementation(async (key: string) =>
    key === "config.dual_control_keys" ? [] : [...DEFAULT_DUAL_CONTROL_ACTIONS]
  );
  // The account exists in the tenant (the route looks it up before anything is held).
  fakeData().answer = (sql) =>
    /select 1 from users where id = \$1::uuid/.test(sql)
      ? [{ "?column?": 1 }]
      : undefined;
});

describe("the erasure request (N-24, N-28)", () => {
  it("held when a second holder exists (the fake's default)", async () => {
    const res = await ask("super_admin", { userId: TARGET, reason: "user-request" });
    expect(res.status).toBe(202);
    expect(await proposals.query({ status: "proposed" })).toHaveLength(1);
  });

  it("no one else: 409 approvals.no_eligible_approver naming the action, nothing held, the request closed as refused", async () => {
    fakeData().approvers = [];
    const res = await ask("super_admin", { userId: TARGET, reason: "user-request" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      code: "approvals.no_eligible_approver",
      params: {
        action: "purge_user_data",
        permissions: ["admin_purge_user_data", "can_access_admin"],
      },
    });
    expect(body.message).toContain("purge_user_data");
    expect(await proposals.query({ status: "proposed" })).toHaveLength(0);
    expect(
      fakeData()
        .audit.filter((a) => a.details.type === "gdpr_purge_requested")
        .map((a) => [a.details.outcome, a.details.code])
    ).toEqual([
      ["attempted", undefined],
      ["refused", "approvals.no_eligible_approver"],
    ]);
  });

  it("[hostile:self] [hostile:id-spelling] the only other holder is the requester under another spelling, or the account erased: refused", async () => {
    fakeData().approvers = [
      row({ id: CALLERS.super_admin.userId.toUpperCase() }),
      row({ id: TARGET, sub: "s2", email: "t@x.org" }),
    ];
    const res = await ask("super_admin", { userId: TARGET, reason: "user-request" });
    expect((await res.json()).code).toBe("approvals.no_eligible_approver");
  });

  it("[hostile:role] a holder without the erasure's permission is not counted", async () => {
    fakeData().approvers = [row({ permissions: ["can_access_admin", "config_view"] })];
    const res = await ask("super_admin", { userId: TARGET, reason: "user-request" });
    expect((await res.json()).code).toBe("approvals.no_eligible_approver");
  });

  it("[hostile:store-down] who could approve cannot be read: 503, nothing held, the request closed", async () => {
    fakeData().approvers = "fail";
    const res = await ask("super_admin", { userId: TARGET, reason: "user-request" });
    expect(res.status).toBe(503);
    expect((await res.json()).params).toEqual({ service: "roles" });
    expect(await proposals.query({ status: "proposed" })).toHaveLength(0);
    expect(fakeData().audit.at(-1)?.details).toMatchObject({
      outcome: "refused",
      code: "service.unavailable",
    });
  });

  it("N-28: a refusal record that cannot be written is alerted, never swallowed", async () => {
    // Two requests at once: the database kept the other's hold (the unique index) — and the audit
    // log fails just then, so the request's "refused" record cannot be written.
    jest.spyOn(proposals, "create").mockImplementationOnce(async () => {
      fakeData().failAudit = true;
      throw Object.assign(new Error("duplicate key"), {
        code: "23505",
        constraint: "proposals_purge_one_open",
      });
    });
    const res = await ask("super_admin", { userId: TARGET, reason: "user-request" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("admin.erasure_pending");
    expect(mockAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "gdpr.request_record_unclosed",
        tags: expect.objectContaining({
          targetId: TARGET,
          code: "admin.erasure_pending",
        }),
      })
    );
  });
});

describe("a held role change (N-24, N-91: the approver holds every permission of the role)", () => {
  const ROLE_ID = "00000000-0000-4000-9000-00000000f0aa";
  beforeEach(() => {
    fakeData().answer = (sql) => {
      if (/from users where (?:email|id) = \$1/.test(sql))
        return [{ id: TARGET, cognito_sub: "sub-t", role_id: ROLE_ID }];
      if (/from roles where (?:id|name) = \$1/.test(sql))
        return [{ id: ROLE_ID, name: "moderator", is_default: false }];
      if (/select p\.code from permissions p/.test(sql))
        return [{ code: "can_access_admin" }, { code: "moderate_content" }];
      return undefined;
    };
  });
  const changeRole = () =>
    inTenant(() =>
      runCommandBarAction({
        tool: "change_user_role",
        input: { user_identifier: TARGET, new_role: "moderator" },
        admin: asAdmin("super_admin"),
        trajectoryId: "tr-1",
        stepIndex: 0,
      })
    );

  it("an admin holding admin_manage_users but not the role's permissions is no approver: refused", async () => {
    fakeData().approvers = [
      row({
        role_name: "admin",
        permissions: ["can_access_admin", "admin_manage_users"],
      }),
    ];
    const out = await changeRole();
    expect(out).toMatchObject({
      kind: "ran",
      result: { code: "approvals.no_eligible_approver" },
    });
  });

  it("a second super_admin is: held", async () => {
    expect((await changeRole()).kind).toBe("held");
  });
});

describe("a held setting and a configuration approval (N-24)", () => {
  it("names the setting and its tier's permission when no one else holds it", async () => {
    fakeData().approvers = [
      row({ permissions: ["can_access_admin", "config_manage_standard"] }),
    ];
    const refused = await inTenant(() =>
      configChangeWithoutApprover("guest.translate_allowance", "platform", [
        CALLERS.super_admin.userId,
      ])
    );
    expect(refused).toMatchObject({
      errorCode: "approvals.no_eligible_approver",
      errorParams: {
        action: "setting guest.translate_allowance",
        permissions: ["config_manage_safety", "can_access_admin"],
      },
    });
  });

  it("a configuration approval is not filed, coded", async () => {
    fakeData().approvers = [];
    const r = await inTenant(() =>
      requestApproval({
        configKey: "guest.translate_allowance",
        currentValue: 3,
        proposedValue: 5,
        requestedBy: CALLERS.super_admin.userId,
        changeComment: "more",
      })
    );
    expect(r).toMatchObject({
      success: false,
      errorCode: "approvals.no_eligible_approver",
    });
    expect(
      fakeData().statements.some((s) =>
        /insert into config_pending_approvals/.test(s.sql)
      )
    ).toBe(false);
  });

  it("[hostile:store-down] unreadable: not filed (the approval store's own unavailable code)", async () => {
    fakeData().approvers = "fail";
    const r = await inTenant(() =>
      requestApproval({
        configKey: "guest.translate_allowance",
        currentValue: 3,
        proposedValue: 5,
        requestedBy: CALLERS.super_admin.userId,
        changeComment: "more",
      })
    );
    expect(r).toMatchObject({ success: false, errorCode: "service.unavailable" });
  });
});

describe("an operator's request: a second operator, across tenants (N-24, N-85)", () => {
  const operator = { userId: CALLERS.super_admin.userId, admin: asAdmin("super_admin") };

  it("one operator: a tenant deletion and an attestation are refused, naming each", async () => {
    fakeData().approvers = [
      row({ id: CALLERS.super_admin.userId, permissions: ["platform_operate"] }),
    ];
    expect(await secondOperatorRefusal("tenant deletion", operator)).toMatchObject({
      ok: false,
      code: "approvals.no_eligible_approver",
      needs: { action: "tenant deletion", permissions: ["platform_operate"] },
    });
    const r = await requestErasureAttestation(
      operator,
      { tenantId: TENANT, userId: TARGET },
      "deleted_in_old_pool",
      "checked both pools"
    );
    expect(r).toMatchObject({
      ok: false,
      code: "approvals.no_eligible_approver",
      needs: { action: "erasure attestation" },
    });
  });

  it("a second operator in another tenant counts", async () => {
    fakeData().approvers = [
      row({
        id: "a9a9a9a9-0000-4000-8000-0000000000aa",
        tenant_id: "t2",
        permissions: ["platform_operate"],
      }),
    ];
    expect(await secondOperatorRefusal("tenant deletion", operator)).toBeNull();
  });

  it("[hostile:store-down] unreadable: roles.unavailable, nothing asked", async () => {
    fakeData().approvers = "fail";
    expect(await secondOperatorRefusal("tenant deletion", operator)).toMatchObject({
      ok: false,
      code: "roles.unavailable",
    });
  });
});
