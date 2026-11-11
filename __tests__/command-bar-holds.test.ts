/**
 * __tests__/command-bar-holds.test.ts — Two-person control for command-bar actions, end to end
 * (audit X-10, B-10, C-14, RR-19)
 *
 * Before: no command-bar action was ever held (declared consequential, below the gating line),
 * an approved command-bar hold never ran, and any safety approver could clear any runtime hold.
 * Here, with the real pipeline, proposal store, admin guard, approval route and roles: an action
 * on the governed list is held; only an independent admin who holds the action's own permission
 * can approve it; it then runs once, as its requester re-verified at that moment.
 */

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

const mockList = jest.fn();
jest.mock("@/platform/auth/platform-config", () => ({
  ...jest.requireActual("@/platform/auth/platform-config"),
  getConfigOrThrow: (key: string) => mockList(key),
  getConfig: async (_key: string, fallback: unknown) => fallback,
}));

// The handlers' own rules and SQL are tested on their own; here, what ran, as whom, with what.
const ran: { tool: string; admin: string; input: unknown }[] = [];
jest.mock("@/app/api/admin/ai/handlers", () => {
  const actual = jest.requireActual("@/app/api/admin/ai/handlers");
  const record =
    (tool: string) => async (input: unknown, admin: { userId: string } | string) => {
      ran.push({
        tool,
        admin: typeof admin === "string" ? admin : admin.userId,
        input,
      });
      return { success: true, result: `${tool} done` };
    };
  return {
    ...actual,
    handleChangeUserRole: record("change_user_role"),
    handleAssignPermissions: record("assign_permissions"),
    handleSuspendAgent: record("suspend_agent"),
    handlePurgeUserData: record("purge_user_data"),
  };
});

import { NextRequest } from "next/server";
import { authAs, CALLERS, type CallerName } from "@/__tests__/helpers/test-identities";
import { fakeData } from "./helpers/fake-data";
import {
  InMemoryProposalStore,
  setProposalStore,
} from "@/platform/agents/proposal-store";
import {
  InMemoryTrajectoryStore,
  setTrajectoryStore,
} from "@/platform/agents/trajectory-store";
import { POST as execute } from "@/app/api/admin/ai/execute/route";
import { approveHeldAction } from "@/platform/agents/gating";
import { POST as decide } from "@/app/api/admin/approvals/[id]/route";
import { GET as listApprovals } from "@/app/api/admin/approvals/route";
import { PATCH } from "@/app/api/admin/users/route";
import {
  COMMAND_BAR_HANDLERS,
  COMMAND_BAR_HOLDS,
  DEFAULT_DUAL_CONTROL_ACTIONS,
  isDualControlledAction,
  runCommandBarAction,
} from "@/app/api/admin/ai/command-bar";
import type { AdminToolId } from "@/app/api/admin/ai/tool-permissions";
import { decisionWords } from "@/platform/errors/recorded-words";

// hostile:id-spelling n/a: requester and approver are compared by sameId (the id-equality guard holds every comparison to it); a requester spelled otherwise is no-eligible-approver.test's case

let proposals: InMemoryProposalStore;

/**
 * The account "u@x.y" names, and its role (rebase P-1: a held role change records the account by
 * id and its role then — an address no account has is refused, never held).
 */
const HELD_USER = "00000000-0000-4000-9000-0000000000bb";
const HELD_USER_ROLE = "00000000-0000-4000-9000-00000000f0bb";
const HELD_MOD_ROLE = "00000000-0000-4000-9000-00000000f0bc";

const post = (url: string, body: unknown, caller: CallerName) =>
  new NextRequest(`http://localhost${url}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...authAs(caller) },
  });

async function hold(caller: CallerName, tool: string, input: Record<string, unknown>) {
  const res = await execute(
    post("/api/admin/ai/execute", { actions: [{ tool, input }] }, caller)
  );
  const answer = await res.json();
  // A key the action's schema does not name is refused with the plan's body, before any step
  // (TASK-203, N-31): a coded 400, the key named by its path in the body.
  if (res.status === 400 && answer.results === undefined)
    return { success: false, code: answer.code, params: answer.params } as {
      success: boolean;
      held?: boolean;
      proposalId?: string;
      error?: string;
    };
  return answer.results[0] as {
    success: boolean;
    held?: boolean;
    proposalId?: string;
    error?: string;
  };
}

const approve = (id: string, caller: CallerName) =>
  decide(
    post(
      `/api/admin/approvals/${id}`,
      { decision: "approve", source: "runtime" },
      caller
    ),
    {
      params: Promise.resolve({ id }),
    }
  );

beforeEach(() => {
  ran.length = 0;
  fakeData().reset();
  proposals = new InMemoryProposalStore();
  setProposalStore(proposals);
  setTrajectoryStore(new InMemoryTrajectoryStore());
  mockList.mockResolvedValue([...DEFAULT_DUAL_CONTROL_ACTIONS]);
  // verifiedAdminById reads the requester's sub from users.
  fakeData().answer = (sql, values) => {
    if (/select cognito_sub from users where id = \$1::uuid/.test(sql)) {
      const identity = Object.values(CALLERS).find((c) => c.userId === values[0]);
      return identity ? [{ cognito_sub: identity.sub }] : [];
    }
    if (
      /select id, cognito_sub, role_id from users where (?:email|id) = \$1/.test(sql) &&
      (values[0] === "u@x.y" || values[0] === HELD_USER)
    ) {
      return [{ id: HELD_USER, cognito_sub: null, role_id: HELD_USER_ROLE }];
    }
    // The held user's account and roles, which the summary and the approver's role rules read
    // (checkChangeUserRole applies the rules to both roles; an account or role not found is the
    // run's to report, never the approver's rule).
    if (/select id, email, role_id from users where id = \$1::uuid/.test(sql)) {
      return values[0] === HELD_USER
        ? [{ id: HELD_USER, email: "u@x.y", role_id: HELD_USER_ROLE }]
        : [];
    }
    if (/from roles where id = \$1::uuid/.test(sql) && values[0] === HELD_USER_ROLE) {
      return [{ id: HELD_USER_ROLE, name: "free", is_default: true }];
    }
    if (/from roles where name = \$1/.test(sql) && values[0] === "moderator") {
      return [{ id: HELD_MOD_ROLE, name: "moderator", is_default: false }];
    }
    if (/from permissions p/.test(sql) && values[0] === HELD_MOD_ROLE) {
      return [{ code: "can_access_admin" }, { code: "can_moderate" }];
    }
    if (/from permissions p/.test(sql) && values[0] === HELD_USER_ROLE) {
      return [{ code: "can_play" }];
    }
    return undefined;
  };
});

describe("holding (C-14)", () => {
  it("holds an action on the governed list instead of running it", async () => {
    const result = await hold("admin", "change_user_role", {
      user_identifier: "u@x.y",
      new_role: "moderator",
    });
    expect(result).toMatchObject({
      success: false,
      held: true,
      proposalId: expect.any(String),
    });
    expect(ran).toEqual([]);
    const proposal = await proposals.getById(result.proposalId!);
    expect(proposal).toMatchObject({
      status: "proposed",
      label: "change_user_role",
      actor: { actorId: "command-bar", onBehalfOf: CALLERS.admin.userId },
      // The account by id and its role then (rebase P-1), never the address typed.
      payload: {
        user_identifier: HELD_USER,
        new_role: "moderator",
        held_current_role_id: HELD_USER_ROLE,
      },
    });
  });

  // Rebase N-2 discarded a caller's held_current_role_id, keeping the server's snapshot; since
  // round 11 (item 2) it is refused — round 12 (nit 1): as the server's to set,
  // request.field_not_accepted — nothing held, nothing run, so a caller's snapshot is never kept.
  it("refuses a caller's held_current_role_id when the change would be held (rebase N-2; round 11)", async () => {
    const result = await hold("admin", "change_user_role", {
      user_identifier: "u@x.y",
      new_role: "moderator",
      held_current_role_id: "00000000-0000-4000-9000-00000000dead",
    });
    expect(result).toMatchObject({
      success: false,
      code: "request.field_not_accepted",
      params: { field: "actions[0].input.held_current_role_id" },
    });
    expect(result.held).toBeUndefined();
    expect(await proposals.query({})).toEqual([]);
  });

  it("refuses a caller's held_current_role_id when the change would run at once too (rebase N-2; round 11)", async () => {
    mockList.mockResolvedValue([]);
    const result = await hold("super_admin", "change_user_role", {
      user_identifier: "u@x.y",
      new_role: "moderator",
      held_current_role_id: "00000000-0000-4000-9000-00000000dead",
    });
    expect(result).toMatchObject({ success: false, code: "request.field_not_accepted" });
    expect(ran).toEqual([]);
  });

  it("refuses a key outside the action's schema — held or not — nothing held, nothing run (round 10, I-A)", async () => {
    const held = await hold("admin", "change_user_role", {
      user_identifier: "u@x.y",
      new_role: "moderator",
      why: "she posted her address",
    });
    expect(held).toMatchObject({
      success: false,
      code: "request.unknown_input",
      // A key no tool names is refused with the plan's body (TASK-203, N-31), naming every
      // tool's keys; one another tool names reaches the action's own check (below).
      params: {
        field: "actions[0].input.why",
        allowed: expect.arrayContaining(["user_identifier", "new_role"]),
      },
    });
    expect(held.held).toBeUndefined();
    const now = await hold("super_admin", "suspend_agent", {
      agent_id: "agent:x",
      note: "free text",
    });
    expect(now).toMatchObject({ success: false, code: "request.unknown_input" });
    expect(ran).toEqual([]);
    expect(await proposals.query({})).toEqual([]);
  });

  it("never holds a policy whose default approver is not a person (round 12, I-2)", async () => {
    const res = await hold("super_admin", "set_approval_policy", {
      default_approver: "agent",
      rules: [{ max_risk: "ordinary", required_approver: "agent" }],
    });
    expect(res).toMatchObject({
      success: false,
      code: "request.invalid_value",
      params: { field: "default_approver", allowed: ["user"] },
    });
    expect(res.held).toBeUndefined();
    expect(ran).toEqual([]);
    expect(await proposals.query({})).toEqual([]);
  });

  it("refuses a key nested in a rule of a list — nothing held, nothing run (round 11, item 3)", async () => {
    const res = await hold("super_admin", "set_approval_policy", {
      default_approver: "user",
      rules: [
        { max_risk: "ordinary", required_approver: "agent" },
        { max_risk: "restricted", required_approver: "user", note: "about her" },
      ],
    });
    expect(res).toMatchObject({
      success: false,
      code: "request.unknown_input",
      params: {
        field: "actions[0].input.rules[1].note",
        allowed: ["max_risk", "effects", "required_approver"],
      },
    });
    // An object given where the schema names a string is no input either: none of its keys is.
    const shaped = await hold("admin", "change_user_role", {
      user_identifier: "u@x.y",
      new_role: { name: "moderator", why: "free text" },
    });
    expect(shaped).toMatchObject({
      code: "request.unknown_input_none",
      params: { field: "actions[0].input.new_role.name" },
    });
    expect((shaped as { params?: object }).params).not.toHaveProperty("allowed");
    expect(ran).toEqual([]);
    expect(await proposals.query({})).toEqual([]);
  });

  it("every action that can be held or run checks its input against its schema (round 10, I-A)", async () => {
    for (const tool of Object.keys(COMMAND_BAR_HANDLERS) as AdminToolId[]) {
      // search refuses any key that is not a filter of its table in its own parser (TASK-189);
      // it is never held.
      if (tool === "search") continue;
      const outcome = await runCommandBarAction({
        tool,
        input: { planted_key: "free text" },
        admin: {
          userId: CALLERS.super_admin.userId,
          sub: CALLERS.super_admin.sub,
          roleName: "super_admin",
          permissions: CALLERS.super_admin.permissions,
        },
        trajectoryId: `t-${tool}`,
        stepIndex: 0,
      });
      expect([tool, outcome]).toEqual([
        tool,
        {
          kind: "ran",
          result: expect.objectContaining({
            code: "request.unknown_input",
            params: expect.objectContaining({ field: "planted_key" }),
          }),
        },
      ]);
    }
    expect(ran).toEqual([]);
    expect(await proposals.query({})).toEqual([]);
  });

  it("refuses, never holds, an erasure whose reason is not a listed one (round 9, I-3)", async () => {
    const r = await hold("super_admin", "purge_user_data", {
      userId: "00000000-0000-4000-9000-0000000000dd",
      reason: "she posted her address",
    });
    expect(r).toMatchObject({
      success: false,
      code: "request.invalid_value",
      params: { field: "reason" },
    });
    expect(r.held).toBeUndefined();
    expect(await proposals.query({ labels: ["purge_user_data"] })).toEqual([]);
  });

  it("refuses, never holds, a role change for an account that is not found (rebase P-1)", async () => {
    const result = await hold("admin", "change_user_role", {
      user_identifier: "nobody@x.y",
      new_role: "moderator",
    });
    expect(result).toMatchObject({
      success: false,
      error: "admin.target_not_found",
      code: "admin.target_not_found",
    });
    expect(result.held).toBeUndefined();
    expect(await proposals.query({ statuses: ["proposed"] })).toEqual([]);
  });

  it("runs an action that is not on the list at once", async () => {
    const result = await hold("super_admin", "suspend_agent", { agent_id: "a" });
    expect(result.success).toBe(true);
    expect(ran).toEqual([
      {
        tool: "suspend_agent",
        admin: CALLERS.super_admin.userId,
        input: { agent_id: "a" },
      },
    ]);
  });

  it("[hostile:store-down] holds every write when the list cannot be read, and never a read (fail closed)", async () => {
    mockList.mockRejectedValue(new Error("db down"));
    await expect(isDualControlledAction("block_user_feature")).resolves.toBe(true);
    await expect(isDualControlledAction("search")).resolves.toBe(false);
    mockList.mockResolvedValue("not a list");
    await expect(isDualControlledAction("update_password_policy")).resolves.toBe(true);
  });

  // Review 10 H1: a config write is held by its key's rules (the config writer), never the list —
  // even when the list cannot be read, or names it.
  it("never holds a config-writing action at the action level", async () => {
    for (const list of [
      Promise.reject(new Error("db down")),
      Promise.resolve("not a list"),
      Promise.resolve(["register_agent", "suspend_agent", "set_agent_scope"]),
    ]) {
      list.catch(() => undefined);
      mockList.mockReturnValue(list);
      for (const tool of [
        "register_agent",
        "suspend_agent",
        "set_agent_scope",
        "set_agent_ttl",
        "set_capability_mapping",
      ] as const) {
        await expect(isDualControlledAction(tool)).resolves.toBe(false);
      }
    }
  });
});

describe("approving (X-10, B-10, RR-19)", () => {
  let id: string;
  beforeEach(async () => {
    id = (
      await hold("admin", "change_user_role", {
        user_identifier: "u@x.y",
        new_role: "moderator",
      })
    ).proposalId!;
  });

  it("is listed with the action's own permission", async () => {
    const res = await listApprovals(
      new NextRequest("http://localhost/api/admin/approvals", {
        headers: authAs("super_admin"),
      })
    );
    const { approvals } = await res.json();
    expect(approvals).toEqual([
      expect.objectContaining({
        id,
        label: "change_user_role",
        requiredPermission: "admin_manage_users",
        requester: CALLERS.admin.userId,
      }),
    ]);
  });

  it.each(["safety_approver", "moderator"] as const)(
    "[hostile:role] refuses %s, who could not make the change themselves (B-10)",
    async (caller) => {
      const res = await approve(id, caller);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        code: "approvals.permission_required",
        params: { permission: "admin_manage_users" },
      });
      expect(ran).toEqual([]);
    }
  );

  it("[hostile:self] refuses the requester approving their own action", async () => {
    const res = await approve(id, "admin");
    expect(res.status).toBe(409);
    expect(ran).toEqual([]);
  });

  it("runs it on an independent approval, once, as its requester (RR-19)", async () => {
    const res = await approve(id, "super_admin");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "approved", applied: true });
    expect(ran).toEqual([
      {
        tool: "change_user_role",
        admin: CALLERS.admin.userId,
        // TASK-193 (B-4): the held change carries the user's role as it was when requested, and
        // runs only while that still holds; rebase P-1: the account by id.
        input: {
          user_identifier: HELD_USER,
          new_role: "moderator",
          held_current_role_id: HELD_USER_ROLE,
        },
      },
    ]);
    expect((await proposals.getById(id))?.status).toBe("executed");

    // The same approval cannot run it again.
    const again = await approve(id, "super_admin");
    expect(again.status).toBe(409);
    expect(ran).toHaveLength(1);
  });

  it("records the decision with the authority that ran it", async () => {
    await approve(id, "super_admin");
    expect(fakeData().audit[0]).toMatchObject({
      actor_id: CALLERS.super_admin.userId,
      details: expect.objectContaining({
        type: "approval_decision",
        authority: "command-bar",
        label: "change_user_role",
        requiredPermission: "admin_manage_users",
      }),
    });
  });

  it("does not run it when its requester no longer may — and runs it on a later approval once they may", async () => {
    const original = CALLERS.admin.sub;
    // The requester cannot be found (removed, or no longer an admin in this tenant).
    fakeData().answer = () => [];
    const res = await approve(id, "super_admin");
    // Round 16, R-b: said as what it is — the requester lacks the permission (it answered
    // approvals.run_failed, 503, "try again"), with the approval kept for when they hold it.
    // Round 17, I-3: the requester's standing, named as theirs (auth.permission_denied read as
    // the approver's own): an account no longer an administrator here is "removed".
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "approvals.requester_lacks_permission",
      params: { permission: "admin_manage_users", reason: "removed" },
      message: expect.stringMatching(
        /^The account that requested this is no longer an administrator here/
      ),
      approvalKept: true,
    });
    expect(ran).toEqual([]);
    expect((await proposals.getById(id))?.status).toBe("approved");

    fakeData().answer = (sql, values) =>
      /select cognito_sub from users/.test(sql) && values[0] === CALLERS.admin.userId
        ? [{ cognito_sub: original }]
        : undefined;
    const retry = await approve(id, "super_admin");
    expect(retry.status).toBe(200);
    expect(ran).toHaveLength(1);
  });

  // Round 17, I-3: a requester who is still here but no longer holds the permission — said as
  // theirs, with the permission, never as the approver's.
  it("a requester who lost the permission: approvals.requester_lacks_permission, reason lacks", async () => {
    // The requester's account is still an administrator, without admin_manage_users.
    const requester = CALLERS.admin as { permissions: readonly string[] };
    const had = requester.permissions;
    requester.permissions = had.filter((p) => p !== "admin_manage_users");
    let res: Response;
    try {
      res = await approve(id, "super_admin");
    } finally {
      requester.permissions = had;
    }
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({
      code: "approvals.requester_lacks_permission",
      params: { permission: "admin_manage_users", reason: "lacks" },
      approvalKept: true,
    });
    expect(body.message).toBe(
      "The account that requested this no longer holds admin_manage_users: it runs once they hold it again, or reject it."
    );
    expect(ran).toEqual([]);
  });

  // Review 7 M7: an approved hold whose run failed could neither be rejected nor expire.
  const rejectAs = (holdId: string, caller: CallerName, note?: string) =>
    decide(
      post(
        `/api/admin/approvals/${holdId}`,
        { decision: "reject", source: "runtime", ...(note ? { note } : {}) },
        caller
      ),
      { params: Promise.resolve({ id: holdId }) }
    );
  const listed = async () => {
    const res = await listApprovals(
      new NextRequest("http://localhost/api/admin/approvals", {
        headers: authAs("super_admin"),
      })
    );
    return ((await res.json()).approvals as { id: string }[]).map((a) => a.id);
  };
  const failTheRun = async () => {
    fakeData().answer = () => [];
    expect((await approve(id, "super_admin")).status).toBe(409);
    expect((await proposals.getById(id))?.status).toBe("approved");
  };

  it("an approved hold whose run failed is rejected by an authorized admin, recorded (M7)", async () => {
    await failTheRun();
    // Not by one who could not make the change.
    expect((await rejectAs(id, "moderator")).status).toBe(403);
    expect((await proposals.getById(id))?.status).toBe("approved");
    const audited = fakeData().audit.length;
    const res = await rejectAs(id, "super_admin", "target gone");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ decision: "reject", withdrawn: true });
    const after = (await proposals.getById(id))!;
    expect(after.status).toBe("rejected");
    expect(after.decidedBy).toBe(CALLERS.super_admin.userId);
    expect(after.decisionNote).toBe("target gone");
    expect(decisionWords(after)).toMatch(
      new RegExp(
        `^Approved by ${CALLERS.super_admin.userId} at .+, never run; withdrawn: target gone$`
      )
    );
    expect(fakeData().audit.slice(audited)[0]).toMatchObject({
      actor_id: CALLERS.super_admin.userId,
      details: expect.objectContaining({ type: "approval_decision", decision: "reject" }),
    });
    expect(await listed()).not.toContain(id);
    // Rejected: a later approval runs nothing.
    expect((await approve(id, "super_admin")).status).toBe(409);
    expect(ran).toEqual([]);
  });

  it("an approved hold never run lapses after the approval period (M7)", async () => {
    await failTheRun();
    expect(await listed()).toContain(id);
    const now = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(now + 8 * 24 * 60 * 60 * 1000);
    try {
      expect(await listed()).not.toContain(id);
      const res = await approve(id, "super_admin");
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("approvals.expired");
      const after = (await proposals.getById(id))!;
      expect(after.status).toBe("rejected");
      expect(after.decidedBy).toBe("system:approval-expiry");
      expect(decisionWords(after)).toMatch(
        /never run; withdrawn: expired: not run within 7 days/
      );
      expect(ran).toEqual([]);
      // Review 8 L5: the withdrawal is recorded, by the system, before it is made.
      const lapse = fakeData().audit.filter(
        (a: { details?: { type?: string } }) => a.details?.type === "approval_withdrawn"
      );
      expect(lapse[0]).toMatchObject({
        actor_id: null,
        details: expect.objectContaining({
          reason: "expired",
          holdId: id,
          agent: "system:approval-expiry",
          foundBy: CALLERS.super_admin.userId,
          outcome: "attempted",
        }),
      });
      // Nothing failed: the attempt is the whole record (audited() adds one only on failure).
      expect(lapse).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("an approved hold within its period is still listed and may be approved again", async () => {
    await failTheRun();
    const clock = jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 6 * 24 * 60 * 60 * 1000);
    try {
      expect(await listed()).toContain(id);
    } finally {
      clock.mockRestore();
    }
  });

  it("refuses to run another payload under the approval of this one", async () => {
    await approveHeldAction({ proposalId: id, decidedBy: CALLERS.super_admin.userId });
    const approved = (await proposals.getById(id))!;
    const result = await COMMAND_BAR_HOLDS.resume({
      ...approved,
      payload: { ...approved.payload, new_role: "super_admin" },
    });
    expect(result.kind).toBe("failed");
    expect(ran).toEqual([]);
    // The approval is still unused: the held action itself can still run.
    expect((await proposals.getById(id))?.status).toBe("approved");
  });

  it("refuses to run an action under another action's approval", async () => {
    await approveHeldAction({ proposalId: id, decidedBy: CALLERS.super_admin.userId });
    const approved = (await proposals.getById(id))!;
    const result = await COMMAND_BAR_HOLDS.resume({
      ...approved,
      label: "assign_permissions",
    });
    expect(result.kind).toBe("failed");
    expect(ran).toEqual([]);
  });
});

describe("whose holds the command bar owns (review 7 L5)", () => {
  // Removing any one clause of COMMAND_BAR_HOLDS.owns — the actor id, the agent role, the label —
  // fails here: an agent that only claims the command bar's actor id (another role), or the right
  // agent with a label that is no command-bar action, is not the command bar's to decide or run.
  const proposal = (actor: Record<string, unknown>, label = "change_user_role") =>
    ({
      proposalId: "p",
      operationId: "op_t_0",
      sessionId: "t",
      trajectoryId: "t",
      label,
      status: "proposed",
      actor,
      effects: ["stateWrite"],
      effectiveRisk: "restricted",
      payload: {},
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }) as unknown as Parameters<typeof COMMAND_BAR_HOLDS.owns>[0];
  const bar = { actorType: "agent", actorId: "command-bar", agentRole: "command-bar" };

  it("owns the command bar's own hold of a command-bar action", () => {
    expect(COMMAND_BAR_HOLDS.owns(proposal(bar))).toBe(true);
  });

  it.each([
    [
      "another agent role under the command bar's actor id",
      { ...bar, agentRole: "conductor" },
    ],
    ["no agent role", { actorType: "agent", actorId: "command-bar" }],
    ["the command bar's role under another actor id", { ...bar, actorId: "conductor-1" }],
  ])("does not own a hold by %s", (_name, actor) => {
    expect(COMMAND_BAR_HOLDS.owns(proposal(actor))).toBe(false);
  });

  it("does not own the command bar's hold of a label that is no command-bar action", () => {
    expect(COMMAND_BAR_HOLDS.owns(proposal(bar, "publish"))).toBe(false);
  });

  it("an impostor's hold is not decided through the approvals route", async () => {
    const impostor = await proposals.create({
      operationId: "op_impostor_0",
      sessionId: "s",
      trajectoryId: "s",
      label: "change_user_role",
      actor: {
        actorType: "agent",
        actorId: "command-bar",
        agentRole: "conductor",
        onBehalfOf: CALLERS.admin.userId,
      },
      effects: ["stateWrite"],
      effectiveRisk: "restricted",
      payload: { user_identifier: "u@x.y", new_role: "super_admin" },
    });
    const res = await approve(impostor.proposalId, "super_admin");
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("approvals.hold_not_found");
    expect(ran).toEqual([]);
  });
});

describe("a duplicate erasure hold (TASK-199)", () => {
  const ACCOUNT = "00000000-0000-4000-9000-0000000000cc";
  // Requested for a safety approver, who holds admin_purge_user_data (round 18: requested for an
  // admin, who does not, the approved erasure never ran — approvals.requester_lacks_permission).
  const erasure = (n: number) =>
    proposals.create({
      operationId: `op_dup_${n}`,
      sessionId: `dup-${n}`,
      trajectoryId: `dup-${n}`,
      label: "purge_user_data",
      actor: {
        actorType: "agent",
        actorId: "command-bar",
        agentRole: "command-bar",
        onBehalfOf: CALLERS.safety_approver.userId,
      },
      effects: ["stateWrite"],
      effectiveRisk: "restricted",
      // One held before 061's index, or under a draft index's spelling: two for one account.
      payload: {
        userId: n === 1 ? ACCOUNT : ACCOUNT.toUpperCase(),
        reason: "admin-action",
      },
    });

  it("an undecided duplicate is rejected by the system, recorded, never approved; the older one stands", async () => {
    const kept = await erasure(1);
    await new Promise((r) => setTimeout(r, 5));
    const duplicate = await erasure(2);
    const res = await approve(duplicate.proposalId, "super_admin");
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("admin.erasure_pending");
    expect((await proposals.getById(duplicate.proposalId))?.status).toBe("rejected");
    expect((await proposals.getById(kept.proposalId))?.status).toBe("proposed");
    expect(ran).toEqual([]);
    const recorded = fakeData().audit.filter(
      (a) => a.details.type === "approval_withdrawn" && a.details.reason === "duplicate"
    );
    expect(recorded.map((a) => a.details)).toEqual([
      expect.objectContaining({
        holdId: duplicate.proposalId,
        holdIds: [kept.proposalId],
        decision: "undecided",
        foundBy: CALLERS.super_admin.userId,
      }),
    ]);
  });

  // Round 5, item 2: an undecided (indeterminate) duplicate. Approving it again would run a
  // second erasure while the older hold is open; it is withdrawn instead, once verified.
  const undecided = async (n: number) => {
    const hold = await erasure(n);
    await proposals.decide(hold.proposalId, "approved", CALLERS.super_admin.userId, "ok");
    expect(await proposals.claim(hold.proposalId)).toBeDefined();
    proposals.recoverStaleRuns(Date.now() + 1000);
    expect((await proposals.getById(hold.proposalId))?.status).toBe("indeterminate");
    return hold;
  };
  const decideAs = (
    id: string,
    decision: string,
    caller: CallerName,
    extra: Record<string, unknown> = {}
  ) =>
    decide(
      post(
        `/api/admin/approvals/${id}`,
        { decision, source: "runtime", ...extra },
        caller
      ),
      { params: Promise.resolve({ id }) }
    );

  it("an undecided duplicate is not approved again while the older hold is open: nothing runs (round 5, item 2)", async () => {
    const kept = await erasure(1);
    await new Promise((r) => setTimeout(r, 5));
    const duplicate = await undecided(2);
    const res = await decideAs(duplicate.proposalId, "reapprove", "super_admin");
    expect(res.status).toBe(409);
    // Its own code (round 8, item 1): what to do with this hold, not a new request's answer.
    expect((await res.json()).code).toBe("approvals.duplicate_undecided");
    expect((await proposals.getById(duplicate.proposalId))?.status).toBe("indeterminate");
    expect((await proposals.getById(kept.proposalId))?.status).toBe("proposed");
    expect(ran).toEqual([]);
  });

  it("an undecided hold verified not applied is withdrawn: rejected, never run, recorded (round 5, item 2)", async () => {
    await erasure(1);
    await new Promise((r) => setTimeout(r, 5));
    const duplicate = await undecided(2);
    const res = await decideAs(duplicate.proposalId, "withdraw", "super_admin", {
      note: "checked: no rows were erased",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ decision: "withdraw", status: "rejected" });
    const now = await proposals.getById(duplicate.proposalId);
    expect(now).toMatchObject({
      status: "rejected",
      decidedBy: CALLERS.super_admin.userId,
    });
    expect(ran).toEqual([]);
    expect(
      fakeData().audit.filter((a) => a.details.type === "approval_decision")
    ).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({
          holdId: duplicate.proposalId,
          decision: "withdraw",
          // Round 6, P-2: the decider's note, and who had approved the run.
          note: "checked: no rows were erased",
          approvedBy: CALLERS.super_admin.userId,
        }),
      }),
    ]);
  });

  it("withdraw is a decision on an undecided run only, by an independent decider holding the permission (round 5, item 2)", async () => {
    const open = await erasure(1);
    const onProposed = await decideAs(open.proposalId, "withdraw", "super_admin");
    expect(onProposed.status).toBe(409);
    expect((await onProposed.json()).code).toBe("approvals.decision_conflict");
    const held = await undecided(2);
    // The requester (the safety approver the command bar acted for) may not decide it.
    const own = await decideAs(held.proposalId, "withdraw", "safety_approver");
    expect(own.status).toBe(409);
    expect((await own.json()).code).toBe("approvals.self_approval");
    // Nor one without the hold's permission.
    const weak = await decideAs(held.proposalId, "withdraw", "moderator");
    expect(weak.status).toBe(403);
    expect((await weak.json()).code).toBe("approvals.permission_required");
    expect((await proposals.getById(held.proposalId))?.status).toBe("indeterminate");
    // Rejecting it as if it never ran stays refused: withdraw is the verified decision.
    const rejected = await decideAs(held.proposalId, "reject", "super_admin");
    expect((await rejected.json()).code).toBe("approvals.indeterminate");
  });

  it("an older hold that has lapsed is no hold to duplicate: the live one is approved (round 2, 1)", async () => {
    // The older hold was asked for past any approval period (default 7 days): it can never be
    // approved, so the live one is not its duplicate.
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const iso = jest.spyOn(Date.prototype, "toISOString").mockReturnValueOnce(old);
    let lapsed: Awaited<ReturnType<typeof erasure>>;
    try {
      lapsed = await erasure(1);
    } finally {
      iso.mockRestore();
    }
    expect(lapsed.createdAt).toBe(old);
    const live = await erasure(2);
    const res = await approve(live.proposalId, "super_admin");
    // Approved and run (round 18: the requester holds the permission, so the erasure runs —
    // the hold is executed, its action recorded once).
    expect(res.status).toBe(200);
    expect((await proposals.getById(live.proposalId))?.status).toBe("executed");
    expect(ran.map((r) => r.tool)).toEqual(["purge_user_data"]);
    expect(fakeData().audit.filter((a) => a.details.reason === "duplicate")).toEqual([]);
  });
});

describe("a plan stops at a held action", () => {
  it("does not run the actions after it", async () => {
    const res = await execute(
      post(
        "/api/admin/ai/execute",
        {
          actions: [
            { tool: "assign_permissions", input: { role_name: "r", add: ["can_play"] } },
            { tool: "suspend_agent", input: { agent_id: "a" } },
          ],
        },
        "super_admin"
      )
    );
    // Accepted and waiting: 202, as every route that can hold answers (round 11, item 1).
    expect(res.status).toBe(202);
    const { results } = await res.json();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ tool: "assign_permissions", held: true });
    expect(ran).toEqual([]);
  });
});

describe("PATCH /api/admin/users — the page is not a weaker second path (X-10)", () => {
  const TARGET = "00000000-0000-4000-9000-0000000000aa";
  const FREE_ROLE = "00000000-0000-4000-9000-00000000f001";
  const MOD_ROLE = "00000000-0000-4000-9000-00000000f002";

  beforeEach(() => {
    const base = fakeData().answer;
    fakeData().answer = (sql, values) => {
      if (/from users where id = \$1::uuid and deleted_at is null/.test(sql)) {
        return values[0] === TARGET
          ? [{ id: TARGET, cognito_sub: "target-sub", role_id: FREE_ROLE }]
          : base(sql, values);
      }
      if (/from roles where id = \$1::uuid/.test(sql)) {
        return values[0] === FREE_ROLE
          ? [{ id: FREE_ROLE, name: "free", is_default: true }]
          : values[0] === MOD_ROLE
            ? [{ id: MOD_ROLE, name: "moderator", is_default: false }]
            : [];
      }
      if (/from permissions p/.test(sql)) {
        return values[0] === MOD_ROLE
          ? [{ code: "can_access_admin" }, { code: "can_moderate" }]
          : [{ code: "can_play" }];
      }
      return base(sql, values);
    };
  });

  const patch = (caller: CallerName) =>
    PATCH(
      new NextRequest("http://localhost/api/admin/users", {
        method: "PATCH",
        body: JSON.stringify({ userId: TARGET, roleId: MOD_ROLE }),
        headers: { "content-type": "application/json", ...authAs(caller) },
      })
    );

  it("holds a role change under dual control, as the command bar does", async () => {
    const res = await patch("super_admin");
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ held: true, proposalId: expect.any(String) });
    expect(
      fakeData().statements.some((s) => /update users set role_id/.test(s.sql))
    ).toBe(false);
    expect(await proposals.getById(body.proposalId)).toMatchObject({
      label: "change_user_role",
      payload: { user_identifier: TARGET, new_role: "moderator" },
    });
  });

  it("changes the role directly when the action is not under dual control", async () => {
    mockList.mockResolvedValue([]);
    const res = await patch("super_admin");
    expect(res.status).toBe(200);
  });
});
