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
  COMMAND_BAR_HOLDS,
  DEFAULT_DUAL_CONTROL_ACTIONS,
  isDualControlledAction,
} from "@/app/api/admin/ai/command-bar";

let proposals: InMemoryProposalStore;

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
  const { results } = await res.json();
  return results[0] as {
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
      payload: { user_identifier: "u@x.y", new_role: "moderator" },
    });
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

  it("holds every write when the list cannot be read, and never a read (fail closed)", async () => {
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
    "refuses %s, who could not make the change themselves (B-10)",
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

  it("refuses the requester approving their own action", async () => {
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
        input: { user_identifier: "u@x.y", new_role: "moderator" },
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
    expect(res.status).toBe(503);
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
    expect((await approve(id, "super_admin")).status).toBe(503);
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
    expect(after.decisionNote).toMatch(
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
      expect(after.decisionNote).toMatch(
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
