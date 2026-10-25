/**
 * __tests__/rv12-killswitch.test.ts — A kill switch is never undone by an older approval (review
 * 12 H2), and its neighbours (L3, L4, L7)
 *
 *   H2  every held config change records the value it replaces and is applied only onto it
 *       (compare-and-set): a change made since — the kill switch, a power reduction, another
 *       approved change — makes it stale (approvals.stale, 409, audited, the hold withdrawn).
 *       The kill switch and every unheld reduction withdraw the pending holds on their key.
 *   L3  the kill switch is audited attempted → succeeded | failed; no record, no suspension.
 *   L4  a one-admin reduction is recorded before it is written: audit store down, nothing changes.
 *   L7  mark_executed needs independence like approval; the kill switch exists for a
 *       single-tenant deployment's own administrators (POST /api/admin/agents/suspend).
 *
 * The real command bar, config handlers, pipeline, decision route and proposal store; the config
 * store faked as in rv11-power-reduction — its compare-and-set as the real one's (the real one
 * runs on Postgres in db/rv12 and db/rv11-runs-and-chains).
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
// The operators' route runs its work in the target tenant; here, the one this suite runs in.
jest.mock("@/platform/tenancy/operator-target", () => ({
  inTargetTenant: (_id: string, _request: unknown, work: () => Promise<Response>) =>
    work(),
}));

const DUAL_KEYS = ["agent.trusted_agents", "agent.capability_features"];
const store = new Map<string, unknown>();
const writes: { key: string; value: unknown; options?: unknown }[] = [];
jest.mock("@/platform/auth/platform-config", () => {
  const actual = jest.requireActual("@/platform/auth/platform-config");
  const { canonical } = jest.requireActual("@/platform/admin/power-reduction");
  return {
    ...actual,
    getConfigOrThrow: async (key: string) => {
      if (key === "config.dual_control_keys") return DUAL_KEYS;
      if (key === "config.require_two_person_approval") return false;
      if (key === "admin.dual_control_actions") return [];
      if (store.has(key)) return store.get(key);
      throw new Error(`no key ${key}`);
    },
    getConfig: async (key: string, fallback: unknown) =>
      store.has(key) ? store.get(key) : fallback,
    getEnhancedConfig: async (key: string) => ({
      key,
      value: store.get(key) ?? [],
      platformValue: store.get(key) ?? [],
      overridden: false,
      permissionTier: "safety",
      tenantOverridable: false,
      valueType: "json_array",
      description: "",
      category: "agents",
      validation: null,
    }),
    getPermissionTier: async () => "safety",
    validateConfigValue: () => ({ valid: true, errors: [] }),
    // As the real write: audited first (no record, no change), compare-and-set when asked.
    setConfigWithHistory: async (
      key: string,
      value: unknown,
      actorId: string,
      _comment: string,
      _source?: unknown,
      _entry?: unknown,
      _target?: unknown,
      options?: { expectPrevious?: { value: unknown } }
    ) => {
      const { audited } = jest.requireActual("@/platform/auth/audit");
      try {
        return await audited(
          {
            action: "admin_action",
            actorId,
            details: { type: "config_updated_with_history", key },
          },
          async () => {
            if (
              options?.expectPrevious &&
              canonical(store.get(key)) !== canonical(options.expectPrevious.value)
            ) {
              return {
                success: false,
                error: `"${key}" changed since it was read`,
                stale: true,
              };
            }
            writes.push({ key, value, options });
            store.set(key, value);
            return { success: true };
          }
        );
      } catch {
        return {
          success: false,
          error: "The audit log is unavailable, so the value was not changed.",
        };
      }
    },
  };
});

import { NextRequest } from "next/server";
import {
  authAs,
  identityFor,
  type CallerName,
  type TestIdentity,
} from "@/__tests__/helpers/test-identities";
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
import { POST as decide } from "@/app/api/admin/approvals/[id]/route";
import { POST as suspendRoute } from "@/app/api/admin/agents/suspend/route";
import { POST as operatorSuspendRoute } from "@/app/api/operator/tenants/[id]/agents/suspend/route";
import { suspendAllAgents } from "@/platform/admin/agent-kill-switch";

const operator = identityFor("super_admin", { name: "rv12_operator" });
let proposals: InMemoryProposalStore;

const post = (url: string, body: unknown, caller: CallerName | TestIdentity) =>
  new NextRequest(`http://localhost${url}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...authAs(caller) },
  });

async function run(caller: CallerName, tool: string, input: Record<string, unknown>) {
  const res = await execute(
    post("/api/admin/ai/execute", { actions: [{ tool, input }] }, caller)
  );
  return ((await res.json()).results as Record<string, unknown>[])[0];
}

async function decideAs(
  caller: CallerName,
  id: string,
  decision = "approve"
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await decide(
    post(`/api/admin/approvals/${id}`, { decision, source: "runtime" }, caller),
    { params: Promise.resolve({ id }) } as never
  );
  return { status: res.status, body: await res.json() };
}

const REGISTRY = () => [
  ["agent:a", { owner: "o", scopes: ["x", "y"], status: "active", maxTokenTtl: 300 }],
  ["agent:b", { owner: "o", scopes: ["x"], status: "active", maxTokenTtl: 300 }],
];
const statuses = () =>
  (store.get("agent.trusted_agents") as [string, { status: string }][]).map(
    ([, r]) => r.status
  );
const audits = () => fakeData().audit.map((a) => a.details);

beforeEach(() => {
  store.clear();
  writes.length = 0;
  fakeData().reset();
  proposals = new InMemoryProposalStore();
  setProposalStore(proposals);
  setTrajectoryStore(new InMemoryTrajectoryStore());
  store.set("agent.trusted_agents", REGISTRY());
  store.set("agent.capability_features", [["publish", ["post"]]]);
});

describe("R12-4 a change held before the kill switch cannot undo it", () => {
  it("the kill switch withdraws the older hold; approving it changes nothing (409)", async () => {
    // Yesterday: an admin asks to add scope z to agent:a — a widening, held.
    const held = await run("super_admin", "set_agent_scope", {
      agent_id: "agent:a",
      scopes: ["x", "y", "z"],
    });
    expect(held).toMatchObject({ held: true });
    const [p] = await proposals.query({});
    expect(p.payload.heldPrevious).toEqual({ value: REGISTRY() });
    // Incident: the operator suspends every agent — and the pending hold is withdrawn, audited.
    const outcome = await suspendAllAgents(operator as never, "incident");
    expect(outcome).toMatchObject({ ok: true, withdrawn: [p.proposalId] });
    expect((await proposals.getById(p.proposalId))!.status).toBe("rejected");
    expect(audits()).toContainEqual(
      expect.objectContaining({
        type: "approval_withdrawn",
        reason: "superseded",
        holdIds: [p.proposalId],
        outcome: "attempted",
      })
    );
    // A second admin approves the scope change after the incident: refused, nothing applied.
    const { status } = await decideAs("safety_approver", p.proposalId);
    expect(status).toBe(409);
    expect(statuses()).toEqual(["suspended", "suspended"]);
  });

  it("an older hold whose withdrawal did not land is refused stale: approvals.stale, withdrawn, audited", async () => {
    await run("super_admin", "set_agent_scope", {
      agent_id: "agent:a",
      scopes: ["x", "y", "z"],
    });
    const [p] = await proposals.query({});
    // The withdrawal does not land (a store hiccup)…
    const decideSpy = jest.spyOn(proposals, "decide").mockResolvedValueOnce(undefined);
    expect(await suspendAllAgents(operator as never, "incident")).toMatchObject({
      ok: true,
      withdrawn: [],
    });
    decideSpy.mockRestore();
    expect((await proposals.getById(p.proposalId))!.status).toBe("proposed");
    // …so the approval reaches the change: it was requested against the registry as it was.
    const { status, body } = await decideAs("safety_approver", p.proposalId);
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "approvals.stale" });
    expect(statuses()).toEqual(["suspended", "suspended"]);
    expect((await proposals.getById(p.proposalId))!.status).toBe("rejected");
    expect(audits()).toContainEqual(
      expect.objectContaining({
        type: "approval_withdrawn",
        reason: "stale",
        holdId: p.proposalId,
      })
    );
    // The requester must ask again: approving once more is a conflict, never an apply.
    expect((await decideAs("safety_approver", p.proposalId)).status).toBe(409);
    expect(statuses()).toEqual(["suspended", "suspended"]);
  });

  it("a one-admin reduction followed by approval of an older hold: stale", async () => {
    await run("super_admin", "set_agent_ttl", {
      agent_id: "agent:b",
      max_token_ttl: 900,
    });
    const [older] = await proposals.query({});
    // An unheld reduction withdraws it…
    const withdrawSpy = jest.spyOn(proposals, "decide").mockResolvedValueOnce(undefined);
    const reduced = await run("super_admin", "suspend_agent", { agent_id: "agent:a" });
    withdrawSpy.mockRestore();
    expect(reduced).toMatchObject({ success: true });
    expect(statuses()).toEqual(["suspended", "active"]);
    // …and had it not, the approval would still refuse it: the registry it replaced is gone.
    const { status, body } = await decideAs("safety_approver", older.proposalId);
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "approvals.stale" });
    expect(statuses()).toEqual(["suspended", "active"]);
    expect(
      (store.get("agent.trusted_agents") as [string, { maxTokenTtl: number }][])[1][1]
        .maxTokenTtl
    ).toBe(300);
  });

  it("every unheld power reduction withdraws the pending holds on its key, audited", async () => {
    await run("super_admin", "set_agent_scope", {
      agent_id: "agent:b",
      scopes: ["x", "q"],
    });
    const [p] = await proposals.query({});
    expect(
      await run("super_admin", "suspend_agent", { agent_id: "agent:a" })
    ).toMatchObject({
      success: true,
    });
    expect((await proposals.getById(p.proposalId))!.status).toBe("rejected");
    expect(audits()).toContainEqual(
      expect.objectContaining({
        type: "approval_withdrawn",
        reason: "superseded",
        holdIds: [p.proposalId],
        key: "agent.trusted_agents",
      })
    );
  });

  it("two holds on one key: the first approved applies, the second is stale", async () => {
    await run("super_admin", "set_agent_scope", {
      agent_id: "agent:a",
      scopes: ["x", "y", "z"],
    });
    await run("super_admin", "set_agent_ttl", {
      agent_id: "agent:b",
      max_token_ttl: 600,
    });
    // Picked by content, not by order: both holds can share a millisecond (createdAt ties on a
    // fast machine), so "newest first" does not tell them apart.
    const held = await proposals.query({});
    expect(held).toHaveLength(2);
    const first = held.find((h) => JSON.stringify(h.payload).includes('"z"'))!;
    const second = held.find((h) => h.proposalId !== first.proposalId)!;
    expect(JSON.stringify(second.payload)).toContain("600");
    expect((await decideAs("safety_approver", first.proposalId)).status).toBe(200);
    expect(
      (store.get("agent.trusted_agents") as [string, { scopes: string[] }][])[0][1].scopes
    ).toEqual(["x", "y", "z"]);
    const again = await decideAs("safety_approver", second.proposalId);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "approvals.stale" });
    // The first change stands; the second never applied over it.
    const reg = store.get("agent.trusted_agents") as [string, Record<string, unknown>][];
    expect(reg[0][1].scopes).toEqual(["x", "y", "z"]);
    expect(reg[1][1].maxTokenTtl).toBe(300);
  });

  it("a held change that recorded no previous value is not applied (fail closed)", async () => {
    await run("super_admin", "set_agent_scope", {
      agent_id: "agent:a",
      scopes: ["x", "y", "z"],
    });
    const [p] = await proposals.query({});
    const { heldPrevious: _gone, ...legacy } = p.payload;
    void _gone;
    (p as { payload: Record<string, unknown> }).payload = legacy;
    const { status, body } = await decideAs("safety_approver", p.proposalId);
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "approvals.stale" });
    expect(writes).toEqual([]);
  });

  it("a caller cannot supply the recorded previous value", async () => {
    const { dispatchConfigTool } = await import("@/platform/admin/config-handlers");
    await dispatchConfigTool("update_config", {
      key: "agent.trusted_agents",
      value: [
        ...REGISTRY(),
        ["agent:evil", { owner: "o", scopes: ["*"], status: "active" }],
      ],
      changeComment: "x",
      actorId: identityFor("super_admin").userId,
      confirmed: true,
      heldPrevious: { value: "forged" },
    });
    const [p] = await proposals.query({});
    expect(p.payload.heldPrevious).toEqual({ value: REGISTRY() });
  });
});

describe("R12-L3 the kill switch is audited attempted → succeeded | failed", () => {
  const killRecords = () =>
    audits()
      .filter((d) => d.type === "agents_emergency_suspended")
      .map((d) => d.outcome);

  it("success: attempted, then succeeded", async () => {
    expect(await suspendAllAgents(operator as never, "incident")).toMatchObject({
      ok: true,
    });
    expect(killRecords()).toEqual(["attempted", "succeeded"]);
  });

  it("a failed compare-and-set: attempted, then failed — nothing suspended", async () => {
    const { setConfigWithHistory } = jest.requireMock("@/platform/auth/platform-config");
    const mod = jest.requireMock("@/platform/auth/platform-config");
    const spy = jest
      .spyOn(mod, "setConfigWithHistory")
      .mockImplementationOnce(async (...args: unknown[]) => {
        // Another write lands between the read and the compare-and-set.
        store.set("agent.trusted_agents", [
          ...REGISTRY(),
          ["agent:c", { owner: "o", scopes: [], status: "active" }],
        ]);
        return setConfigWithHistory(...args);
      });
    const outcome = await suspendAllAgents(operator as never, "incident");
    spy.mockRestore();
    expect(outcome.ok).toBe(false);
    expect(killRecords()).toEqual(["attempted", "failed"]);
    expect(statuses()).toEqual(["active", "active", "active"]);
  });

  it("the audit log down: no record, no suspension", async () => {
    fakeData().failAudit = true;
    await expect(suspendAllAgents(operator as never, "incident")).rejects.toThrow(
      /Audit/
    );
    expect(writes).toEqual([]);
    expect(statuses()).toEqual(["active", "active"]);
  });
});

describe("R12-L4 a one-admin reduction is recorded before it is written", () => {
  it("audit store down: the reduction is not applied", async () => {
    fakeData().failAudit = true;
    const r = await run("super_admin", "suspend_agent", { agent_id: "agent:a" });
    expect(r).toMatchObject({ success: false });
    expect(writes).toEqual([]);
    expect(statuses()).toEqual(["active", "active"]);
  });

  it("audit store up: the reduction's record precedes the write and its outcome follows", async () => {
    await run("super_admin", "suspend_agent", { agent_id: "agent:a" });
    const order = audits()
      .filter((d) =>
        ["power_reduction_applied", "config_updated_with_history"].includes(d.type)
      )
      .map((d) => `${d.type}:${d.outcome}`);
    expect(order[0]).toBe("power_reduction_applied:attempted");
    expect(order).toContain("config_updated_with_history:attempted");
    expect(writes).toHaveLength(1);
  });
});

describe("R12-L7 mark_executed needs independence; the kill switch in a single-tenant deployment", () => {
  it("the requester cannot mark their own undecided run executed", async () => {
    await run("super_admin", "set_agent_scope", {
      agent_id: "agent:a",
      scopes: ["x", "y", "z"],
    });
    const [p] = await proposals.query({});
    await proposals.decide(p.proposalId, "approved", "someone-else");
    await proposals.claim(p.proposalId);
    proposals.recoverStaleRuns(Date.now() + 60_000);
    expect((await proposals.getById(p.proposalId))!.status).toBe("indeterminate");
    const own = await decideAs("super_admin", p.proposalId, "mark_executed");
    expect(own.status).toBe(409);
    expect(own.body).toMatchObject({ code: "approvals.self_approval" });
    expect((await proposals.getById(p.proposalId))!.status).toBe("indeterminate");
    const other = await decideAs("safety_approver", p.proposalId, "mark_executed");
    expect(other.status).toBe(200);
    expect((await proposals.getById(p.proposalId))!.status).toBe("executed");
  });

  it("POST /api/admin/agents/suspend: a config_manage_safety holder suspends every agent", async () => {
    const res = await suspendRoute(
      post("/api/admin/agents/suspend", { reason: "incident" }, "safety_approver")
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      suspended: ["agent:a", "agent:b"],
      withdrawn: [],
    });
    expect(statuses()).toEqual(["suspended", "suspended"]);
  });

  it("POST /api/operator/tenants/[id]/agents/suspend answers what the console shows: suspended and withdrawn (TASK-172)", async () => {
    const res = await operatorSuspendRoute(
      post(
        "/api/operator/tenants/t1/agents/suspend",
        { reason: "incident" },
        "super_admin"
      ),
      { params: Promise.resolve({ id: "t1" }) }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      suspended: ["agent:a", "agent:b"],
      withdrawn: [],
    });
    expect(statuses()).toEqual(["suspended", "suspended"]);
    const again = await operatorSuspendRoute(
      post("/api/operator/tenants/t1/agents/suspend", { reason: "again" }, "super_admin"),
      { params: Promise.resolve({ id: "t1" }) }
    );
    expect(await again.json()).toMatchObject({ suspended: [], withdrawn: [] });
    const missing = await operatorSuspendRoute(
      post("/api/operator/tenants/t1/agents/suspend", { reason: "" }, "super_admin"),
      { params: Promise.resolve({ id: "t1" }) }
    );
    expect(missing.status).toBe(400);
  });

  it("refuses an admin without config_manage_safety, and a missing reason", async () => {
    const denied = await suspendRoute(
      post("/api/admin/agents/suspend", { reason: "x" }, "moderator")
    );
    expect(denied.status).toBe(403);
    const missing = await suspendRoute(
      post("/api/admin/agents/suspend", { reason: " " }, "safety_approver")
    );
    expect(missing.status).toBe(400);
    expect(statuses()).toEqual(["active", "active"]);
  });

  it("answers kill_switch_failed for a registry it cannot prove the suspension of", async () => {
    store.set("agent.trusted_agents", [["agent:a", { status: "active" }]]);
    const res = await suspendRoute(
      post("/api/admin/agents/suspend", { reason: "x" }, "safety_approver")
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "admin.kill_switch_failed" });
  });
});
