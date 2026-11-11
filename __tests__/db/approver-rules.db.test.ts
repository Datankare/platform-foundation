/**
 * @jest-environment node
 */
// hostile:store-down n/a: the decision route's store failures are held-lost-commit.test.ts's
/**
 * An approver satisfies the change's own rules — every held action × every catalog role as
 * approver, on Postgres (TASK-194, audits C-2 and C-6)
 *
 * The decision route asked an approver only for the action's page permission. The role rules
 * (platform/auth/role-governance.ts) ran for the requester alone, at resume: an admin, who holds
 * admin_manage_users but not config_manage_safety, could approve a super_admin's held change of a
 * user to safety_approver — a change they could not make themselves (auth.grant_exceeds_own). The
 * same for the catalog actions, and an account's erasure (now always held, C-6) for its rules.
 *
 * For each held action and each real role as the approver, a fresh hold is made by a super_admin
 * and the approver approves it through POST /api/admin/approvals/[id]. The oracle is written here
 * from the rules themselves — the permissions of the roles involved, from the migrations' catalog
 * (helpers/test-identities ROLE_PERMISSIONS), and the protected and self rules — never from the
 * functions under test: approved and applied exactly when the approver holds the page permission
 * and the rules pass for them; refused with the rule's code when only the rules fail.
 *
 * Round 1 (TASK-194): a restriction on the approver's own account is refused for every approver
 * (A3, admin.self_target — block/unblock held through admin.dual_control_actions here); a
 * safety_approver may approve a super_admin's erasure (A2, migration 061); the approvals list
 * carries the server-built summary of each held action (A1) and an erasure's request is recorded
 * when it is made (A1); a second erasure request for an account with one open is refused (A6).
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-test",
}));
jest.mock("@/platform/auth/middleware", () =>
  require("@/__tests__/helpers/db-admin").mockTenantMiddleware()
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
// The erasure's pipeline is the platform's; its own suites prove what it erases. Here: it ran.
jest.mock("@/platform/gdpr", () => ({
  createPlatformPurgePipeline: jest.fn(() => ({
    execute: jest.fn(async (r: { userId: string }) => ({
      purgeId: "pg",
      userId: r.userId,
      status: "completed",
      steps: [{ handler: "db", success: true, deletedCount: 1 }],
      requestedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      totalDeleted: 1,
    })),
  })),
}));

import { NextRequest } from "next/server";
import { withOwnerTx } from "@/platform/data";
import { runWithTenant } from "@/platform/tenancy/context";
import {
  getTrajectoryStore,
  setTrajectoryStore,
} from "@/platform/agents/trajectory-store";
import { PostgresTrajectoryStore } from "@/platform/agents/postgres-trajectory-store";
import { getProposalStore, setProposalStore } from "@/platform/agents/proposal-store";
import { PostgresProposalStore } from "@/platform/agents/postgres-proposal-store";
import { POST as decidePOST } from "@/app/api/admin/approvals/[id]/route";
import { GET as gdprGET, POST as gdprPOST } from "@/app/api/admin/gdpr/route";
import { POST as executePOST } from "@/app/api/admin/ai/execute/route";
import { listPendingApprovals } from "@/platform/admin/pending-approvals";
import { USER_DATA_TABLES } from "@/platform/auth/user-data";
import { hardPurgeUser, softDeleteUser } from "@/platform/auth/gdpr-deletion";
import {
  COMMAND_BAR_ACTOR_ID,
  COMMAND_BAR_HOLDS,
  DEFAULT_DUAL_CONTROL_ACTIONS,
  isErasureHoldConflict,
  DUAL_CONTROL_ACTIONS_KEY,
  runCommandBarAction,
  APPROVER_RULES,
} from "@/app/api/admin/ai/command-bar";
import {
  ADMIN_TOOL_PERMISSIONS,
  type AdminToolId,
} from "@/app/api/admin/ai/tool-permissions";
import { PROTECTED_ROLES, type VerifiedAdmin } from "@/platform/auth/role-governance";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  DB_ENABLED,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";
import {
  asCallerIn,
  createCatalog,
  dropCatalog,
  insertUser,
  newRun,
  seededRoleId,
  suiteCaller,
  catalogName,
} from "../helpers/db-admin";
import { ROLE_PERMISSIONS, type TestIdentity } from "../helpers/test-identities";

const RUN = newRun();
let t: TestTenant;
let requester: TestIdentity;
const approvers: Record<string, TestIdentity> = {};
const roleIds: Record<string, string> = {};

/** A permission every non-staff role holds, and one only safety roles do. */
const ORDINARY = "can_play";
const SAFETY = "config_manage_safety";

const single = <T>(fn: () => Promise<T>) =>
  runWithTenant({ tenantId: t.id, mode: "single" }, fn);

const verified = (who: TestIdentity): VerifiedAdmin => ({
  userId: who.userId,
  sub: who.sub,
  roleName: who.roleName,
  permissions: who.permissions,
});

const has = (who: TestIdentity, perms: readonly string[]) =>
  perms.every((p) => who.permissions.includes(p));

interface Case {
  readonly tool: AdminToolId;
  readonly label: string;
  /** Make the fixtures and the held payload, fresh for each approver. */
  readonly payload: (n: string) => Promise<Record<string, unknown>>;
  /** Whether the rules (beyond the page permission) allow `approver` this change. */
  readonly rulesAllow: (approver: TestIdentity) => boolean;
}

async function newRole(n: string, perms: readonly string[]): Promise<string> {
  const cat = await createCatalog(`${RUN}${n}`, { permissions: [], roles: { r: perms } });
  return cat.roleNames.r;
}

async function newUser(roleName: string): Promise<string> {
  return insertUser(t, { roleId: roleIds[roleName] ?? (await seededRoleId(roleName)) });
}

const CASES: Case[] = [
  ...(["safety_approver", "moderator", "free"] as const).map((newRoleName): Case => ({
    tool: "change_user_role",
    label: `a user free → ${newRoleName}`,
    payload: async () => ({
      user_identifier: await newUser("free"),
      new_role: newRoleName,
    }),
    rulesAllow: (a) =>
      !PROTECTED_ROLES.includes(newRoleName) &&
      has(a, [...ROLE_PERMISSIONS[newRoleName], ...ROLE_PERMISSIONS.free]),
  })),
  {
    tool: "change_user_role",
    label: "the approver's own role → free",
    payload: async () => ({ user_identifier: "SELF", new_role: "free" }),
    rulesAllow: () => false, // no one changes their own role (rule 1)
  },
  ...[ORDINARY, SAFETY].map((perm): Case => ({
    tool: "create_role",
    label: `a role granting ${perm}`,
    payload: async (n) => ({
      name: catalogName(RUN, `new${n}`),
      display_name: "New",
      permissions: [perm],
    }),
    rulesAllow: (a) => has(a, [perm]),
  })),
  ...[ORDINARY, SAFETY].map((perm): Case => ({
    tool: "assign_permissions",
    label: `adding ${perm} to a role`,
    payload: async (n) => ({ role_name: await newRole(n, []), add: [perm], remove: [] }),
    rulesAllow: (a) => has(a, [perm]),
  })),
  {
    tool: "delete_role",
    label: "a role granting config_manage_safety",
    payload: async (n) => ({ role_name: await newRole(n, [SAFETY]) }),
    rulesAllow: (a) => has(a, [SAFETY]),
  },
  {
    tool: "duplicate_role",
    label: "a role granting config_manage_safety",
    payload: async (n) => ({
      source_role: await newRole(n, [SAFETY]),
      new_name: catalogName(RUN, `dup${n}`),
      new_display_name: "Dup",
    }),
    rulesAllow: (a) => has(a, [SAFETY]),
  },
  ...[ORDINARY, SAFETY].map((perm): Case => ({
    tool: "create_entitlement_group",
    label: `a group granting ${perm}`,
    payload: async (n) => ({
      code: catalogName(RUN, `grp${n}`),
      display_name: "G",
      permissions: [perm],
    }),
    rulesAllow: (a) => has(a, [perm]),
  })),
  {
    tool: "set_entitlement_group_active",
    label: "turning on a group granting config_manage_safety",
    payload: async (n) => {
      const cat = await createCatalog(`${RUN}${n}`, {
        permissions: [],
        roles: {},
        groups: { g: { permissions: [SAFETY], active: false } },
      });
      return { group_id: cat.groups.g, is_active: true };
    },
    rulesAllow: (a) => has(a, [SAFETY]),
  },
  ...(["block_user_feature", "unblock_user_feature"] as const).flatMap((tool): Case[] => [
    {
      tool,
      label: "a free user's translate",
      payload: async () => ({ user_id: await newUser("free"), feature: "translate" }),
      rulesAllow: () => true,
    },
    {
      tool,
      label: "the approver's own translate (round 1, A3)",
      payload: async () => ({ user_id: "SELF", feature: "translate" }),
      rulesAllow: () => false, // never one's own account
    },
  ]),
  {
    tool: "purge_user_data",
    label: "erasing a free user",
    payload: async () => ({ userId: await newUser("free"), reason: "admin-action" }),
    rulesAllow: () => true,
  },
  {
    tool: "purge_user_data",
    label: "erasing the approver's own account",
    payload: async () => ({ userId: "SELF", reason: "admin-action" }),
    rulesAllow: () => false, // not one's own account
  },
];

const APPROVER_ROLES = Object.keys(ROLE_PERMISSIONS);

if (DB_ENABLED) {
  beforeAll(async () => {
    await connectTestDatabase();
    t = await createTestTenant();
    // Registers this run's prefix, so the roles and groups approvals create are removed too.
    await createCatalog(RUN, { permissions: [], roles: {} });
    for (const r of ["free", "super_admin", ...APPROVER_ROLES])
      roleIds[r] = await seededRoleId(r);
    // The restrictions are held in this tenant (an operator's choice of the governed list).
    await withOwnerTx("operator", (tx) =>
      tx.query(
        `insert into tenant_config_overrides (tenant_id, key, value)
         values ($1::uuid, $3, $2::jsonb)`,
        [
          t.id,
          JSON.stringify([
            ...DEFAULT_DUAL_CONTROL_ACTIONS,
            "block_user_feature",
            "unblock_user_feature",
          ]),
          DUAL_CONTROL_ACTIONS_KEY,
        ]
      )
    );
    requester = suiteCaller("super_admin", RUN, { name: "requester" });
    await insertUser(t, {
      id: requester.userId,
      roleId: roleIds.super_admin,
      cognitoSub: requester.sub,
    });
    // Another super_admin beside the approvers: a change acting on an approver's own account still
    // has someone else who could approve it, so it is held (TASK-203, N-24) and the approver's
    // own decision is what is tested here.
    await insertUser(t, { roleId: roleIds.super_admin });
    for (const role of APPROVER_ROLES) {
      approvers[role] = suiteCaller(role, RUN, { name: `approver-${role}` });
      await insertUser(t, {
        id: approvers[role].userId,
        roleId: roleIds[role],
        cognitoSub: approvers[role].sub,
      });
    }
  });
  afterAll(async () => {
    await dropTestTenants();
    await dropCatalog();
    await disconnectTestDatabase();
  });
}

/**
 * Hold `tool` with `input` as the requester; the hold's id — or, when no one else could approve
 * it (TASK-203, N-24), the up-front refusal.
 */
async function holdOrRefusal(
  tool: AdminToolId,
  input: Record<string, unknown>
): Promise<string | { code?: string }> {
  return single(async () => {
    const trajectory = await getTrajectoryStore().create(
      { kind: "agent", id: COMMAND_BAR_ACTOR_ID },
      `approver-rules:${tool}`,
      "platform"
    );
    const outcome = await runCommandBarAction({
      tool,
      input,
      admin: verified(requester),
      trajectoryId: trajectory.trajectory.trajectoryId,
      stepIndex: 0,
    });
    return outcome.kind === "held" ? outcome.proposalId : outcome.result;
  });
}

/** Hold `tool` with `input` as the requester; the hold's id. */
async function hold(tool: AdminToolId, input: Record<string, unknown>): Promise<string> {
  return single(async () => {
    const trajectory = await getTrajectoryStore().create(
      { kind: "agent", id: COMMAND_BAR_ACTOR_ID },
      `approver-rules:${tool}`,
      "platform"
    );
    const outcome = await runCommandBarAction({
      tool,
      input,
      admin: verified(requester),
      trajectoryId: trajectory.trajectory.trajectoryId,
      stepIndex: 0,
    });
    if (outcome.kind !== "held") throw new Error(`${tool} was not held`);
    return outcome.proposalId;
  });
}

const decideAs = (
  id: string,
  approver: TestIdentity,
  decision: string,
  extra: Record<string, unknown> = {}
) =>
  decidePOST(
    new NextRequest(`http://localhost/api/admin/approvals/${id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...asCallerIn(approver, t, "single"),
      },
      body: JSON.stringify({ decision, source: "runtime", ...extra }),
    }),
    { params: Promise.resolve({ id }) }
  );
const approve = (id: string, approver: TestIdentity) => decideAs(id, approver, "approve");

/** The erasure route, as `who`. */
const gdpr = (method: "POST" | "GET", who: TestIdentity, body?: unknown, query = "") =>
  (method === "POST" ? gdprPOST : gdprGET)(
    new NextRequest(`http://localhost/api/admin/gdpr${query}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...asCallerIn(who, t, "single"),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );

dbDescribe(
  "an approver satisfies the change's own rules (TASK-194, C-2, C-6; Postgres)",
  () => {
    it("covers every action with approver rules, and every catalog role (self-test)", () => {
      expect([...new Set(CASES.map((c) => c.tool))].sort()).toEqual(
        Object.keys(APPROVER_RULES).sort()
      );
      expect(APPROVER_ROLES.length).toBeGreaterThan(5);
    });

    describe.each(CASES.map((c, i) => [`${c.tool}: ${c.label}`, c, i] as const))(
      "%s",
      (_name, c, i) => {
        it.each(APPROVER_ROLES)(
          "approved as %s exactly when the approver may make it",
          async (role) => {
            const approver = approvers[role];
            const payload = await c.payload(`${i}${role.slice(0, 3)}`);
            for (const k of Object.keys(payload))
              if (payload[k] === "SELF") payload[k] = approver.userId;
            const id = await holdOrRefusal(c.tool, payload);
            if (typeof id !== "string") {
              // No account but the requester and the target could approve it (the target here
              // the one super_admin approver): refused up front, nothing held (TASK-203, N-24) —
              // only ever where the rules let no approver make it.
              expect([role, id.code]).toEqual([role, "approvals.no_eligible_approver"]);
              expect(c.rulesAllow(approver)).toBe(false);
              return;
            }
            const res = await approve(id, approver);
            const body = (await res.json()) as { code?: string; applied?: boolean };
            const pagePermission = has(approver, [ADMIN_TOOL_PERMISSIONS[c.tool]]);
            if (!has(approver, ["can_access_admin"])) {
              expect([role, res.status]).toEqual([role, 403]); // not an admin at all
            } else if (!pagePermission) {
              expect([role, res.status, body.code]).toEqual([
                role,
                403,
                "approvals.permission_required",
              ]);
            } else if (!c.rulesAllow(approver)) {
              // Refused by a rule, with the rule's own code — and nothing ran.
              expect([role, res.status]).toEqual([role, 403]);
              expect(body.code).toMatch(
                /^(auth\.(grant_exceeds_own|role_self_change|role_database_only|role_protected|default_role_limited)|admin\.(self_target|operator_only))$/
              );
            } else {
              expect([role, res.status, body.applied]).toEqual([role, 200, true]);
            }
          }
        );
      }
    );

    it("a shared deployment's non-operator admin may not approve a catalog change (operator only)", async () => {
      // The catalog is every tenant's: in a shared deployment only an operator changes it.
      // The admin holds admin_manage_entitlements and can_play — all but the standing.
      const payload = {
        code: catalogName(RUN, "shared"),
        display_name: "S",
        permissions: [ORDINARY],
      };
      const id = await hold("create_entitlement_group", payload);
      const res = await decidePOST(
        new NextRequest(`http://localhost/api/admin/approvals/${id}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...asCallerIn(approvers.admin, t, "shared"),
          },
          body: JSON.stringify({ decision: "approve", source: "runtime" }),
        }),
        { params: Promise.resolve({ id }) }
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe("admin.operator_only");
    });

    // E-56 (server side): Approve and Reject shown to every admin-area holder are refused by the
    // server to one without the hold's permission — a rejection too.
    it("[hostile:role] refuses a moderator either decision on a hold whose permission they lack", async () => {
      const id = await hold("change_user_role", {
        user_identifier: await newUser("free"),
        new_role: "moderator",
      });
      for (const decision of ["approve", "reject"]) {
        const res = await decidePOST(
          new NextRequest(`http://localhost/api/admin/approvals/${id}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...asCallerIn(approvers.moderator, t, "single"),
            },
            body: JSON.stringify({ decision, source: "runtime" }),
          }),
          { params: Promise.resolve({ id }) }
        );
        expect([decision, res.status]).toEqual([decision, 403]);
        expect(((await res.json()) as { code?: string }).code).toBe(
          "approvals.permission_required"
        );
      }
    });

    it("an erasure asked for through POST /api/admin/gdpr is held, never run, until approved", async () => {
      const target = await newUser("free");
      const res = await gdprPOST(
        new NextRequest("http://localhost/api/admin/gdpr", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...asCallerIn(requester, t, "single"),
          },
          body: JSON.stringify({ userId: target, reason: "admin-action" }),
        })
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as { held?: boolean; proposalId?: string };
      expect(body.held).toBe(true);
      const audit = await withOwnerTx("operator", (tx) =>
        tx.query("select 1 from audit_log where target_id = $1::uuid and action = $2", [
          target,
          "gdpr_purge_executed",
        ])
      );
      expect(audit.rows).toEqual([]);
      // The requester cannot approve it themselves.
      const self = await approve(body.proposalId!, requester);
      expect(self.status).toBe(409);
      expect(((await self.json()) as { code?: string }).code).toBe(
        "approvals.self_approval"
      );
      // Another holder of admin_purge_user_data can, and it then runs once.
      const second = suiteCaller("super_admin", RUN, { name: "second-super" });
      await insertUser(t, {
        id: second.userId,
        roleId: roleIds.super_admin,
        cognitoSub: second.sub,
      });
      const ok = await approve(body.proposalId!, second);
      expect(ok.status).toBe(200);
      const ran = await withOwnerTx("operator", (tx) =>
        tx.query(
          "select actor_id from audit_log where target_id = $1::uuid and action = $2",
          [target, "gdpr_purge_executed"]
        )
      );
      expect(ran.rows).toEqual([{ actor_id: requester.userId }]);
    });

    it("records an erasure's request when it is made, and refuses a second one while it is open (A1, A6)", async () => {
      const target = await insertUser(t, {
        roleId: roleIds.free,
        email: `erase-${RUN}@example.test`,
      });
      const first = await gdpr("POST", requester, {
        userId: target,
        reason: "legal-order",
      });
      expect(first.status).toBe(202);
      const { proposalId } = (await first.json()) as { proposalId: string };
      const requested = await withOwnerTx("operator", (tx) =>
        tx.query<{ actor_id: string; reason: string }>(
          `select actor_id, details->>'purgeReason' as reason from audit_log
            where target_id = $1::uuid and details->>'type' = 'gdpr_purge_requested'`,
          [target]
        )
      );
      // The listed reason as a code, purgeReason (rebase P-2), kept when the account's free text
      // is erased (the test after this one).
      expect(requested.rows).toEqual([
        { actor_id: requester.userId, reason: "legal-order" },
      ]);
      // Another admin's request for the same account: refused, the first stands.
      const second = await gdpr("POST", approvers.safety_approver, {
        userId: target,
        reason: "admin-action",
      });
      expect(second.status).toBe(409);
      expect(((await second.json()) as { code?: string }).code).toBe(
        "admin.erasure_pending"
      );
      // The Users screen reads it after a reload.
      const pending = await gdpr("GET", requester, undefined, `?userId=${target}`);
      expect(pending.status).toBe(200);
      expect(
        ((await pending.json()) as { pending?: { proposalId?: string } }).pending
      ).toMatchObject({ proposalId });
      // The approvals list says whose account, why, and that it is not a dry run — nothing else —
      // to a viewer who could decide it (round 2, N2): a safety approver holds
      // admin_purge_user_data since 061; a moderator, who may see the queue, does not.
      const listedFor = async (viewer: TestIdentity) =>
        (
          await single(() => listPendingApprovals([COMMAND_BAR_HOLDS], verified(viewer)))
        ).find((a) => a.id === proposalId);
      expect((await listedFor(approvers.safety_approver))?.summary).toEqual({
        target: { id: target, email: `erase-${RUN}@example.test` },
        reason: "legal-order",
        dryRun: false,
      });
      const toModerator = await listedFor(approvers.moderator);
      expect(toModerator?.label).toBe("purge_user_data");
      expect(toModerator?.summary).toBeUndefined();
      expect(JSON.stringify(toModerator)).not.toContain(`erase-${RUN}@example.test`);
      // A safety approver approves a super_admin's erasure (A2), and it runs.
      const ok = await approve(proposalId, approvers.safety_approver);
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { applied?: boolean }).applied).toBe(true);
      const after = await gdpr("GET", requester, undefined, `?userId=${target}`);
      expect(((await after.json()) as { pending?: unknown }).pending).toBeNull();
    });

    it("an erasure's listed reason survives the erasure of the account's free text (rebase P-2)", async () => {
      const target = await insertUser(t, { roleId: roleIds.free });
      const res = await gdpr("POST", requester, {
        userId: target,
        reason: "legal-order",
      });
      expect(res.status).toBe(202);
      const { proposalId } = (await res.json()) as { proposalId: string };
      const ok = await approve(proposalId, approvers.super_admin);
      expect(ok.status).toBe(200);
      // The account's erasure removes the free text from every record about it (auditText).
      const auditText = USER_DATA_TABLES.find((e) => e.name === "auditText")!;
      await withOwnerTx("operator", (tx) => tx.query(auditText.erase, [target]));
      const kept = await withOwnerTx("operator", (tx) =>
        tx.query<{ action: string; type: string | null; purge_reason: string | null }>(
          `select action::text as action, details->>'type' as type,
                  details->>'purgeReason' as purge_reason
             from audit_log
            where target_id = $1::uuid
              and (details->>'type' = 'gdpr_purge_requested' or action = 'gdpr_purge_executed')
            order by action::text`,
          [target]
        )
      );
      expect(kept.rows).toEqual([
        {
          action: "admin_action",
          type: "gdpr_purge_requested",
          purge_reason: "legal-order",
        },
        { action: "gdpr_purge_executed", type: null, purge_reason: "legal-order" },
      ]);
    });

    it("[hostile:self] lists a held role change with its target and both roles, and an approver never acts on their own account (A1, A3)", async () => {
      const target = await insertUser(t, {
        roleId: roleIds.free,
        email: `promote-${RUN}@example.test`,
      });
      const id = await hold("change_user_role", {
        user_identifier: `promote-${RUN}@example.test`,
        new_role: "moderator",
      });
      const listedFor = async (viewer: TestIdentity) =>
        (
          await single(() => listPendingApprovals([COMMAND_BAR_HOLDS], verified(viewer)))
        ).find((a) => a.id === id);
      expect((await listedFor(approvers.super_admin))?.summary).toEqual({
        target: { id: target, email: `promote-${RUN}@example.test` },
        fromRole: "free",
        toRole: "moderator",
        // What the move grants and takes away (TASK-202, N-61), each a catalog code.
        permissionsGranted: expect.arrayContaining(["can_moderate"]),
        permissionsRemoved: expect.any(Array),
      });
      // Round 2, N2: neither a moderator nor a safety approver (no admin_manage_users) sees whose
      // account a held role change is for — only the label.
      for (const viewer of [approvers.moderator, approvers.safety_approver]) {
        const shown = await listedFor(viewer);
        expect([viewer.name, shown?.label, shown?.summary]).toEqual([
          viewer.name,
          "change_user_role",
          undefined,
        ]);
        expect(JSON.stringify(shown)).not.toContain(`promote-${RUN}@example.test`);
      }
      // No viewer named: no summaries.
      expect(
        (await single(() => listPendingApprovals([COMMAND_BAR_HOLDS]))).find(
          (a) => a.id === id
        )?.summary
      ).toBeUndefined();
      // A held restriction of the approver's own account is refused to every approver.
      const own = await hold("block_user_feature", {
        user_id: approvers.super_admin.userId,
        feature: "translate",
      });
      const res = await approve(own, approvers.super_admin);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe("admin.self_target");
      // Nor rejected by its target (round 6, P-1): no decision on one's own account, either way.
      const rejected = await decideAs(own, approvers.super_admin, "reject");
      expect(rejected.status).toBe(403);
      expect(((await rejected.json()) as { code?: string }).code).toBe(
        "admin.self_target"
      );
      expect((await single(() => getProposalStore().getById(own)))?.status).toBe(
        "proposed"
      );
    });
  }
);

dbDescribe(
  "a decision's note is erased with the account it is about (round 7, I-1; Postgres)",
  () => {
    // The holds in Postgres, as a deployment keeps them (round 8, item 3: the hold's own note).
    let previous: ReturnType<typeof getProposalStore> | undefined;
    // And the runs in Postgres (round 9, I-2: the trajectory checks below read the database).
    let previousRuns: ReturnType<typeof getTrajectoryStore> | undefined;
    beforeAll(() => {
      previous = setProposalStore(new PostgresProposalStore());
      previousRuns = getTrajectoryStore();
      setTrajectoryStore(new PostgresTrajectoryStore());
    });
    afterAll(() => {
      if (previous) setProposalStore(previous);
      if (previousRuns) setTrajectoryStore(previousRuns);
    });

    it("names the held action's account, and loses the note when that account is erased", async () => {
      const target = await insertUser(t, { roleId: roleIds.free });
      // The requester's free text about the account (round 8, item 3): the restriction's reason.
      const reason = `she posted her address, round8-reason-${RUN}`;
      const id = await hold("block_user_feature", {
        user_id: target,
        feature: "translate",
        reason,
      });
      const note = `the user wrote to support from her home, round7-${RUN}`;
      const res = await decideAs(id, approvers.super_admin, "reject", { note });
      expect(res.status).toBe(200);
      const record = () =>
        withOwnerTx("operator", (tx) =>
          tx.query<{
            target_id: string | null;
            note: string | null;
            erased: boolean | null;
          }>(
            `select target_id::text, details->>'note' as note,
                  (details->>'textErased')::boolean as erased
             from audit_log
            where tenant_id = $1::uuid and details->>'type' = 'approval_decision'
              and details->>'holdId' = $2`,
            [t.id, id]
          )
        );
      expect((await record()).rows).toEqual([{ target_id: target, note, erased: null }]);
      expect((await single(() => softDeleteUser(target, requester.userId))).success).toBe(
        true
      );
      expect((await single(() => hardPurgeUser(target))).success).toBe(true);
      const after = (await record()).rows;
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ note: null, erased: true });
      // Round 8, item 3: nor anywhere else — the hold's decision note and its payload's reason,
      // its run's steps, any audit record.
      for (const needle of [note, reason]) {
        const left = await withOwnerTx("operator", (tx) =>
          tx.query<{ where: string }>(
            `select 'proposals' as where from proposals
              where tenant_id = $1::uuid and to_jsonb(proposals)::text like '%' || $2 || '%'
             union all
             select 'agent_trajectories' from agent_trajectories
              where tenant_id = $1::uuid and to_jsonb(agent_trajectories)::text like '%' || $2 || '%'
             union all
             select 'audit_log' from audit_log
              where tenant_id = $1::uuid and details::text like '%' || $2 || '%'`,
            [t.id, needle]
          )
        );
        expect([needle, left.rows.map((r) => r.where)]).toEqual([needle, []]);
      }
      const kept = await withOwnerTx("operator", (tx) =>
        tx.query<{
          status: string;
          decision_note: string | null;
          decision_shown: unknown;
        }>(
          "select status, decision_note, decision_shown from proposals where id = $1::uuid",
          [id]
        )
      );
      // TASK-208: the placeholder is the catalog's key, the note as written gone.
      expect(kept.rows).toEqual([
        {
          status: "rejected",
          decision_note: null,
          decision_shown: {
            key: "screens.records.note",
            params: { note: { key: "screens.records.note_erased" } },
          },
        },
      ]);
    });
  }
);

dbDescribe(
  "a held role change and an account's spelling (rebase P-1, TASK-199; Postgres)",
  () => {
    it("a held role change records the account, not the address: an address registered again after the erasure is never changed (rebase P-1)", async () => {
      const email = `reused-${RUN}@example.test`;
      const first = await insertUser(t, { roleId: roleIds.free, email });
      const id = await hold("change_user_role", {
        user_identifier: email,
        new_role: "moderator",
      });
      const stored = await single(() => getProposalStore().getById(id));
      expect(stored?.payload).toMatchObject({
        user_identifier: first,
        held_current_role_id: roleIds.free,
      });
      expect(JSON.stringify(stored?.payload)).not.toContain(email);
      // The account is erased (its row soft-deleted, its address cleared) and a new account
      // registers with the same address.
      await withOwnerTx("operator", (tx) =>
        tx.query(
          "update users set deleted_at = now(), email = null where id = $1::uuid",
          [first]
        )
      );
      const newcomer = await insertUser(t, { roleId: roleIds.free, email });
      const res = await approve(id, approvers.super_admin);
      expect(res.status).not.toBe(500);
      const role = async (u: string) =>
        (
          await withOwnerTx("operator", (tx) =>
            tx.query<{ role_id: string }>(
              "select role_id from users where id = $1::uuid",
              [u]
            )
          )
        ).rows[0]?.role_id;
      expect(await role(newcomer)).toBe(roleIds.free);
      expect(await role(first)).toBe(roleIds.free);
    });

    it("a held role change whose account's role changed before approval is answered approvals.stale and withdrawn (round 3, I-1)", async () => {
      const target = await insertUser(t, { roleId: roleIds.free });
      const id = await hold("change_user_role", {
        user_identifier: target,
        new_role: "moderator",
      });
      await withOwnerTx("operator", (tx) =>
        tx.query("update users set role_id = $2::uuid where id = $1::uuid", [
          target,
          roleIds.moderator,
        ])
      );
      const res = await approve(id, approvers.super_admin);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code?: string }).code).toBe("approvals.stale");
      const after = await single(() => getProposalStore().getById(id));
      expect(after?.status).toBe("rejected");
    });

    it("a held role change's summary shows the role it was held against, and says when the account's role changed since (rebase P-1)", async () => {
      const target = await insertUser(t, { roleId: roleIds.free });
      const id = await hold("change_user_role", {
        user_identifier: target,
        new_role: "moderator",
      });
      const summary = async () =>
        (
          await single(() =>
            listPendingApprovals([COMMAND_BAR_HOLDS], verified(approvers.super_admin))
          )
        ).find((a) => a.id === id)?.summary;
      expect(await summary()).toEqual({
        target: { id: target },
        fromRole: "free",
        toRole: "moderator",
        permissionsGranted: expect.arrayContaining(["can_moderate"]),
        permissionsRemoved: expect.any(Array),
      });
      await withOwnerTx("operator", (tx) =>
        tx.query("update users set role_id = $2::uuid where id = $1::uuid", [
          target,
          roleIds.moderator,
        ])
      );
      expect(await summary()).toEqual({
        target: { id: target },
        fromRole: "free",
        toRole: "moderator",
        roleChangedSince: { now: "moderator" },
        permissionsGranted: expect.arrayContaining(["can_moderate"]),
        permissionsRemoved: expect.any(Array),
      });
    });

    it("[hostile:id-spelling] an account id in upper case is the same account at the command bar (TASK-199): the approver's own is refused", async () => {
      const own = await hold("block_user_feature", {
        user_id: approvers.super_admin.userId.toUpperCase(),
        feature: "translate",
      });
      const stored = await single(() => getProposalStore().getById(own));
      expect(stored?.payload.user_id).toBe(approvers.super_admin.userId);
      const res = await approve(own, approvers.super_admin);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe("admin.self_target");
    });
  }
);

dbDescribe("one open erasure per account (TASK-194 rounds 2–3, A6; Postgres)", () => {
  // Round 2, A6: two requests at once — the database keeps one open erasure per account. These
  // two run on the Postgres proposal store (a deployment's), where the index is.
  let previousStore: ReturnType<typeof getProposalStore> | undefined;
  beforeEach(() => {
    if (expect.getState().currentTestName?.includes("(A6 race)"))
      previousStore = setProposalStore(new PostgresProposalStore());
  });
  afterEach(() => {
    if (previousStore) setProposalStore(previousStore);
    previousStore = undefined;
  });

  it("two erasure requests for one account at once: one held, the other erasure_pending (A6 race)", async () => {
    const target = await insertUser(t, { roleId: roleIds.free });
    const [a, b] = await Promise.all([
      gdpr("POST", requester, { userId: target, reason: "admin-action" }),
      gdpr("POST", approvers.super_admin, { userId: target, reason: "admin-action" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const loser = a.status === 409 ? a : b;
    expect(((await loser.json()) as { code?: string }).code).toBe(
      "admin.erasure_pending"
    );
    const open = await withOwnerTx("operator", (tx) =>
      tx.query(
        "select 1 from proposals where tenant_id = $1::uuid and label = 'purge_user_data' and lower(payload->>'userId') = $2 and status in ('proposed','approved','executing','indeterminate')",
        [t.id, target]
      )
    );
    expect(open.rows).toHaveLength(1);
    // No record claims a second request held (round 3): one request open, any other refused.
    const recorded = await withOwnerTx("operator", (tx) =>
      tx.query<{ outcome: string }>(
        `select details->>'outcome' as outcome from audit_log
            where target_id = $1::uuid and details->>'type' = 'gdpr_purge_requested'`,
        [target]
      )
    );
    const outcomes = recorded.rows.map((r) => r.outcome);
    expect(
      outcomes.filter((o) => o === "attempted").length -
        outcomes.filter((o) => o === "refused").length
    ).toBe(1);
  });

  // Round 3, L1: the same account in upper case is the same account.
  it("an upper-case spelling of an account with an open erasure is refused (A6 race)", async () => {
    const target = await insertUser(t, { roleId: roleIds.free });
    const first = await gdpr("POST", requester, {
      userId: target,
      reason: "admin-action",
    });
    expect(first.status).toBe(202);
    const shouted = await gdpr("POST", approvers.super_admin, {
      userId: target.toUpperCase(),
      reason: "admin-action",
    });
    expect(shouted.status).toBe(409);
    expect(((await shouted.json()) as { code?: string }).code).toBe(
      "admin.erasure_pending"
    );
    // And past the route's check, the index compares lower case.
    let refused: unknown;
    try {
      await single(() =>
        getProposalStore().create({
          operationId: `upper-${RUN}`,
          sessionId: "s",
          trajectoryId: `upper-${RUN}`,
          label: "purge_user_data",
          actor: {
            actorId: COMMAND_BAR_ACTOR_ID,
            agentRole: "command-bar",
            onBehalfOf: requester.userId,
          } as never,
          effects: [],
          effectiveRisk: "irreversible" as never,
          payload: { userId: target.toUpperCase(), reason: "admin-action" },
        })
      );
    } catch (err) {
      refused = err;
    }
    expect(isErasureHoldConflict(refused)).toBe(true);
  });

  // Round 3, L6: the command bar's own execute path answers the code, not the database.
  it("the command bar's execute answers admin.erasure_pending for a second erasure (A6 race)", async () => {
    const target = await insertUser(t, { roleId: roleIds.free });
    expect(
      (await gdpr("POST", requester, { userId: target, reason: "admin-action" })).status
    ).toBe(202);
    const res = await executePOST(
      new NextRequest("http://localhost/api/admin/ai/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...asCallerIn(approvers.super_admin, t, "single"),
        },
        body: JSON.stringify({
          actions: [
            {
              tool: "purge_user_data",
              input: { userId: target, reason: "admin-action" },
            },
          ],
        }),
      })
    );
    const body = (await res.json()) as {
      results: { code?: string; error?: string }[];
    };
    expect(body.results[0]).toMatchObject({
      code: "admin.erasure_pending",
      error: "admin.erasure_pending",
    });
    expect(JSON.stringify(body)).not.toMatch(/duplicate key|proposals_purge_one_open/);
  });

  // Rebase I-3: the open hold is the one the index counts; one whose period ran out (holdLapsed)
  // is withdrawn by the system, recorded, and the new request is held — never a 409 for a hold
  // the Approvals list no longer offers, and never pending on the Users screen.
  const withdrawnRecord = (holdId: string) =>
    withOwnerTx("operator", (tx) =>
      tx.query<{ decision: string | null; found_by: string | null }>(
        `select details->>'decision' as decision, details->>'foundBy' as found_by
           from audit_log
          where details->>'type' = 'approval_withdrawn' and details->>'holdId' = $1`,
        [holdId]
      )
    );
  const statusOf = (id: string) =>
    withOwnerTx("operator", (tx) =>
      tx.query<{ status: string }>("select status from proposals where id = $1::uuid", [
        id,
      ])
    ).then((r) => r.rows[0]?.status);

  it("an undecided erasure hold past its period: not pending, and a new request withdraws it and is held — I-3 (A6 race)", async () => {
    const target = await insertUser(t, { roleId: roleIds.free });
    const first = await gdpr("POST", requester, {
      userId: target,
      reason: "admin-action",
    });
    expect(first.status).toBe(202);
    const { proposalId: old } = (await first.json()) as { proposalId: string };
    // Never decided, past any config.approval_expiry_days (at most 365).
    await withOwnerTx("operator", (tx) =>
      tx.query(
        "update proposals set created_at = now() - interval '400 days' where id = $1::uuid",
        [old]
      )
    );
    const pending = await gdpr("GET", requester, undefined, `?userId=${target}`);
    expect(((await pending.json()) as { pending?: unknown }).pending).toBeNull();
    const again = await gdpr("POST", approvers.super_admin, {
      userId: target,
      reason: "admin-action",
    });
    expect(again.status).toBe(202);
    const { proposalId: fresh } = (await again.json()) as { proposalId: string };
    expect(fresh).not.toBe(old);
    expect(await statusOf(old)).toBe("rejected");
    expect((await withdrawnRecord(old)).rows).toEqual([
      { decision: "undecided", found_by: approvers.super_admin.userId },
    ]);
    const now = await gdpr("GET", requester, undefined, `?userId=${target}`);
    expect(
      ((await now.json()) as { pending?: { proposalId?: string } }).pending
    ).toMatchObject({ proposalId: fresh });
  });

  it("an approved erasure hold never run past its period: not pending, and a new request withdraws it and is held — I-3 (A6 race)", async () => {
    const target = await insertUser(t, { roleId: roleIds.free });
    const first = await gdpr("POST", requester, {
      userId: target,
      reason: "admin-action",
    });
    expect(first.status).toBe(202);
    const { proposalId: old } = (await first.json()) as { proposalId: string };
    // Approved long ago and never run (its run not claimed).
    await withOwnerTx("operator", (tx) =>
      tx.query(
        `update proposals set status = 'approved', decided_by = $2,
                decided_at = now() - interval '400 days'
          where id = $1::uuid`,
        [old, approvers.super_admin.userId]
      )
    );
    const pending = await gdpr("GET", requester, undefined, `?userId=${target}`);
    expect(((await pending.json()) as { pending?: unknown }).pending).toBeNull();
    const again = await gdpr("POST", approvers.super_admin, {
      userId: target,
      reason: "admin-action",
    });
    expect(again.status).toBe(202);
    expect(await statusOf(old)).toBe("rejected");
    expect((await withdrawnRecord(old)).rows).toEqual([
      { decision: null, found_by: approvers.super_admin.userId },
    ]);
  });

  it("an open erasure hold within its period still refuses a second request — I-3 (A6 race)", async () => {
    const target = await insertUser(t, { roleId: roleIds.free });
    const first = await gdpr("POST", requester, {
      userId: target,
      reason: "admin-action",
    });
    expect(first.status).toBe(202);
    const { proposalId } = (await first.json()) as { proposalId: string };
    await withOwnerTx("operator", (tx) =>
      tx.query(
        `update proposals set status = 'approved', decided_by = $2, decided_at = now()
          where id = $1::uuid`,
        [proposalId, approvers.super_admin.userId]
      )
    );
    const again = await gdpr("POST", approvers.super_admin, {
      userId: target,
      reason: "admin-action",
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code?: string }).code).toBe(
      "admin.erasure_pending"
    );
    expect(await statusOf(proposalId)).toBe("approved");
  });

  it("the index refuses a second open erasure hold even past the route's check (A6 race)", async () => {
    const target = await insertUser(t, { roleId: roleIds.free });
    const make = (n: number) =>
      single(() =>
        getProposalStore().create({
          operationId: `race-${RUN}-${n}`,
          sessionId: "s",
          trajectoryId: `race-${RUN}-${n}`,
          label: "purge_user_data",
          actor: {
            actorId: COMMAND_BAR_ACTOR_ID,
            agentRole: "command-bar",
            onBehalfOf: requester.userId,
          } as never,
          effects: [],
          effectiveRisk: "irreversible" as never,
          payload: { userId: target, reason: "admin-action" },
        })
      );
    await make(1);
    let refused: unknown;
    try {
      await make(2);
    } catch (err) {
      refused = err;
    }
    expect(isErasureHoldConflict(refused)).toBe(true);
  });
});
