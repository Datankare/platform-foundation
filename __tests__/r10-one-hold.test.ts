/**
 * __tests__/r10-one-hold.test.ts — One hold per change, and an approval a failure does not burn
 * (review 10 H1, H2, H3)
 *
 * The reviewer's proofs (review10/__tests__/r10/approval.test.ts), now asserting the fixed
 * behaviour, with the real pipeline, proposal store, approvals route and config handlers:
 *
 *   H1  A command-bar agent or capability action was held at the action level (admin_manage_agents
 *       to approve) and its approval carried a capability that let the write skip the key's own
 *       hold — so an approver WITHOUT config_manage_safety cleared a change to a safety-tier,
 *       dual-controlled key. The capability is gone: those actions are config writes, never held
 *       as actions; the key's hold is the one hold, and its rules decide who may clear it.
 *   H3  A claim was not bound to what its approval covered (it wrote config.dual_control_keys = []
 *       unheld). No claim exists any more; the settings that govern holding are always held.
 *   H2  The approval was consumed before the run: a transient failure answered "try again" and
 *       the retry was refused (409). The run claims the approval and gives it back when it fails.
 *
 * And the invariant that keeps H1 from recurring, checked statically: no action is both on
 * admin.dual_control_actions (the code's default and 052's seed) and a config write; every
 * handler that writes governed config is declared as one.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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

const DUAL_KEYS = ["agent.trusted_agents", "agent.capability_features"];
const store = new Map<string, unknown>();
let twoPerson = false;
let failWrite = 0;
const writes: { key: string; value: unknown; comment: string }[] = [];
jest.mock("@/platform/auth/platform-config", () => {
  const actual = jest.requireActual("@/platform/auth/platform-config");
  return {
    ...actual,
    getConfigOrThrow: async (key: string) => {
      // Deliberately without admin.dual_control_actions: the settings that govern holding are
      // held by their own rule, not by being listed.
      if (key === "config.dual_control_keys") return DUAL_KEYS;
      if (key === "config.require_two_person_approval") return twoPerson;
      // The reviewer's list: the config-writing actions named on it (ignored now).
      if (key === "admin.dual_control_actions")
        return ["set_capability_mapping", "register_agent", "set_agent_scope"];
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
    setConfigWithHistory: async (
      key: string,
      value: unknown,
      _actor: string,
      comment: string
    ) => {
      if (failWrite > 0) {
        failWrite--;
        return { success: false, error: "db blip" };
      }
      writes.push({ key, value, comment });
      store.set(key, value);
      return { success: true };
    },
  };
});

import { NextRequest } from "next/server";
import {
  authAs,
  CALLERS,
  identityFor,
  ROLE_PERMISSIONS,
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
import { handleSetCapabilityMapping } from "@/app/api/admin/ai/handlers/mapping";
import {
  COMMAND_BAR_CONFIG_WRITES,
  COMMAND_BAR_HANDLERS,
  DEFAULT_DUAL_CONTROL_ACTIONS,
  isDualControlledAction,
} from "@/app/api/admin/ai/command-bar";
import { ADMIN_TOOL_PERMISSIONS } from "@/app/api/admin/ai/tool-permissions";
import * as handlers from "@/app/api/admin/ai/handlers";
import { writeGovernedConfig } from "@/platform/admin/governed-config";
import { ALWAYS_DUAL_CONTROLLED } from "@/platform/admin/config-handlers";

const ROOT = join(__dirname, "..");
const second = identityFor("super_admin", { name: "r10_second_super_admin" });
/** A custom 'agent ops' role: may manage agents, may not approve safety-tier settings. */
const agentOps = identityFor("super_admin", { name: "r10_agent_ops" });
(agentOps as { permissions: readonly string[] }).permissions =
  ROLE_PERMISSIONS.super_admin.filter(
    (p) => p !== "config_manage_safety" && p !== "platform_operate"
  );
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

const approve = (id: string, caller: CallerName | TestIdentity) =>
  decide(
    post(
      `/api/admin/approvals/${id}`,
      { decision: "approve", source: "runtime" },
      caller
    ),
    { params: Promise.resolve({ id }) }
  );

beforeEach(() => {
  twoPerson = false;
  failWrite = 0;
  store.clear();
  // The capability map is read fail closed (review 13 P): it exists, empty.
  store.set("agent.capability_features", []);
  writes.length = 0;
  fakeData().reset();
  proposals = new InMemoryProposalStore();
  setProposalStore(proposals);
  setTrajectoryStore(new InMemoryTrajectoryStore());
  fakeData().answer = (sql, values) => {
    if (/select cognito_sub from users where id = \$1::uuid/.test(sql)) {
      const all = [...Object.values(CALLERS), second, agentOps];
      const identity = all.find((c) => c.userId === values[0]);
      return identity ? [{ cognito_sub: identity.sub }] : [];
    }
    return undefined;
  };
});

describe("r10 H1: who may clear a write to a safety-tier dual-controlled key — the key's rules", () => {
  it("the reviewer's case: the command bar's change is held under the key's rules; an approver without config_manage_safety cannot clear it", async () => {
    store.set("agent.trusted_agents", []);
    const held = await run("super_admin", "register_agent", {
      agent_id: "agent:evil",
      scopes: ["full-pipeline"],
    });
    // Held — truthfully — and by the key's own hold: an update_config proposal, not an action.
    expect(held).toMatchObject({ success: false, held: true });
    expect(held.result).toMatch(/agent\.trusted_agents is under dual control/);
    const all = await proposals.query({});
    expect(all.map((p) => [p.label, p.status])).toEqual([["update_config", "proposed"]]);
    expect(all[0].payload).toMatchObject({ key: "agent.trusted_agents" });

    const res = await approve(held.proposalId as string, agentOps);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: "approvals.permission_required",
      params: { permission: "config_manage_safety" },
    });
    expect(store.get("agent.trusted_agents")).toEqual([]);
    expect(writes).toEqual([]);
    expect((await proposals.getById(held.proposalId as string))?.status).toBe("proposed");
  });

  it("the same change through the config page is the same hold, with the same rule", async () => {
    store.set("agent.trusted_agents", []);
    const direct = await writeGovernedConfig(CALLERS.super_admin, {
      key: "agent.trusted_agents",
      value: [
        ["agent:evil", { owner: "x", scopes: ["full-pipeline"], status: "active" }],
      ],
      changeComment: "direct",
    });
    expect(direct.kind).toBe("pending");
    const id = direct.kind === "pending" ? direct.result.approval!.proposalId : "";
    expect((await approve(id, agentOps)).status).toBe(403);
    expect(writes).toEqual([]);
  });

  it("safety_approver (config_manage_safety, the safety-key approver) can approve it; it applies once", async () => {
    store.set("agent.trusted_agents", []);
    const held = await run("super_admin", "register_agent", {
      agent_id: "agent:x",
      scopes: ["translate"],
    });
    const res = await approve(held.proposalId as string, "safety_approver");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "approved", applied: true });
    expect(writes).toHaveLength(1);
    expect(store.get("agent.trusted_agents")).toEqual([
      ["agent:x", expect.objectContaining({ scopes: ["translate"] })],
    ]);
    // One hold, used: nothing else was minted, and the approval runs nothing again.
    const all = await proposals.query({});
    expect(all.map((p) => [p.label, p.status])).toEqual([["update_config", "executed"]]);
    expect((await approve(held.proposalId as string, "safety_approver")).status).toBe(
      409
    );
    expect(writes).toHaveLength(1);
  });

  it("the requester cannot approve their own held change", async () => {
    const held = await run("super_admin", "set_capability_mapping", {
      capability: "c",
      features: ["f"],
    });
    const res = await approve(held.proposalId as string, "super_admin");
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("approvals.self_approval");
    expect(writes).toEqual([]);
  });

  it.each([
    ["set_capability_mapping", { capability: "summarize", features: ["translate"] }],
    ["register_agent", { agent_id: "agent:new", scopes: ["translate"] }],
    // suspend_agent is a strict reduction of power, applied at once (review 11 M-2: rv11-hostile);
    // reactivation is the widening that stays held.
    ["suspend_agent", { agent_id: "agent:s", reactivate: true }],
    ["set_agent_scope", { agent_id: "agent:a", scopes: ["y"] }],
    ["set_agent_ttl", { agent_id: "agent:a", max_token_ttl: 120 }],
  ] as const)(
    "%s: held once (the key's hold), applied once on approval",
    async (tool, input) => {
      store.set("agent.trusted_agents", [
        ["agent:a", { owner: "o", scopes: ["x"], status: "active" }],
        ["agent:s", { owner: "o", scopes: ["x"], status: "suspended" }],
      ]);
      const held = await run("super_admin", tool, { ...input });
      expect(held).toMatchObject({ success: false, held: true });
      expect((await proposals.query({})).map((p) => p.label)).toEqual(["update_config"]);
      expect((await approve(held.proposalId as string, second)).status).toBe(200);
      expect(writes).toHaveLength(1);
      expect((await proposals.query({})).map((p) => p.status)).toEqual(["executed"]);
    }
  );

  it("a held write is a held result, never success (review 9 H1a, kept)", async () => {
    const r = await handleSetCapabilityMapping(
      { capability: "c", features: ["f"] },
      CALLERS.super_admin as never
    );
    expect(r).toMatchObject({
      success: false,
      held: true,
      proposalId: expect.any(String),
    });
    expect(writes).toEqual([]);
  });

  it("an approval still waiting on two-person approval is reported pending, never applied", async () => {
    const held = await run("super_admin", "set_capability_mapping", {
      capability: "c",
      features: ["f"],
    });
    twoPerson = true;
    fakeData().answer = (sql, values) => {
      if (/select cognito_sub from users where id = \$1::uuid/.test(sql)) {
        const all = [...Object.values(CALLERS), second];
        const identity = all.find((c) => c.userId === values[0]);
        return identity ? [{ cognito_sub: identity.sub }] : [];
      }
      if (/insert into config_pending_approvals/i.test(sql))
        return [
          {
            id: "ca-1",
            config_key: "agent.capability_features",
            current_value: [],
            proposed_value: [],
            requested_by: CALLERS.super_admin.userId,
            change_comment: "",
            impact_summary: "",
            status: "pending",
            reviewed_by: null,
            review_comment: null,
            reviewed_at: null,
            expires_at: new Date(Date.now() + 86_400_000),
            created_at: new Date(),
            scope: "platform",
            action: "set",
          },
        ];
      return undefined;
    };
    const res = await approve(held.proposalId as string, second);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "approved", applied: false });
    expect(writes).toEqual([]);
  });
});

describe("r10 H3: nothing writes the settings that govern holding without their own hold", () => {
  it("no approval capability exists any more", () => {
    expect(() =>
      jest.requireActual("@/platform/action-pipeline/approval-capability")
    ).toThrow();
  });

  it.each([
    ["config.dual_control_keys", []],
    ["admin.dual_control_actions", []],
    ["config.require_two_person_approval", false],
  ] as const)(
    "%s is held by its own rule (whatever the key list says)",
    async (key, value) => {
      const outcome = await writeGovernedConfig(CALLERS.super_admin, {
        key,
        value,
        changeComment: "x",
      });
      expect(outcome.kind).toBe("pending");
      expect(writes).toEqual([]);
      expect(ALWAYS_DUAL_CONTROLLED).toContain(key);
    }
  );

  it("an approval of an unrelated hold releases nothing else: approving it writes only its own key", async () => {
    store.set("agent.trusted_agents", []);
    const held = await run("super_admin", "register_agent", {
      agent_id: "a",
      scopes: [],
    });
    expect((await approve(held.proposalId as string, second)).status).toBe(200);
    expect(writes.map((w) => w.key)).toEqual(["agent.trusted_agents"]);
    // config.dual_control_keys still cannot be written without its own hold.
    const after = await writeGovernedConfig(CALLERS.super_admin, {
      key: "config.dual_control_keys",
      value: [],
      changeComment: "x",
    });
    expect(after.kind).toBe("pending");
    expect(writes.map((w) => w.key)).toEqual(["agent.trusted_agents"]);
  });
});

describe("r10 H2: a failure after the claim keeps the approval", () => {
  async function heldChange() {
    store.set("agent.trusted_agents", []);
    const held = await run("super_admin", "register_agent", {
      agent_id: "agent:n",
      scopes: [],
    });
    return held.proposalId as string;
  }

  it("the reviewer's case: a transient write failure answers truthfully, keeps the approval, and the retry applies once", async () => {
    const id = await heldChange();
    failWrite = 1;
    const first = await approve(id, second);
    expect(first.status).toBe(503);
    const body = await first.json();
    expect(body.code).toBe("approvals.run_failed");
    expect(body.message).toMatch(/still approved: approve it again to retry/);
    expect(writes).toEqual([]);
    const kept = await proposals.getById(id);
    expect(kept?.status).toBe("approved");
    expect(kept?.lastRunError).toMatch(/db blip/);

    const again = await approve(id, second);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ applied: true });
    expect(writes).toHaveLength(1);
    expect((await proposals.getById(id))?.status).toBe("executed");
    expect((await approve(id, second)).status).toBe(409);
    expect(writes).toHaveLength(1);
  });

  it("concurrent retries apply once", async () => {
    const id = await heldChange();
    failWrite = 1;
    expect((await approve(id, second)).status).toBe(503);
    const [a, b, c] = await Promise.all([
      approve(id, second),
      approve(id, "safety_approver"),
      approve(id, second),
    ]);
    expect([a.status, b.status, c.status].sort()).toEqual([200, 409, 409]);
    expect(writes).toHaveLength(1);
    expect((await proposals.getById(id))?.status).toBe("executed");
  });

  it("a crashed run's claim is taken back after its lease as undecided: never approved again by the job; a person's fresh approval runs it once (review 11 H-1)", async () => {
    const id = await heldChange();
    await proposals.decide(id, "approved", second.userId);
    // A run claimed it and its process died: executing, never ended.
    expect((await proposals.claim(id))?.status).toBe("executing");
    expect((await approve(id, second)).status).toBe(409);
    expect(writes).toEqual([]);
    // Within its lease, nothing is recovered; after it, its outcome is unknown.
    expect(proposals.recoverStaleRuns(Date.parse("2000-01-01T00:00:00Z"))).toEqual([]);
    const recovered = proposals.recoverStaleRuns(Date.now() + 1);
    expect(recovered.map((p) => p.status)).toEqual(["indeterminate"]);
    // Neither approved nor rejected as if it never ran.
    const plain = await approve(id, second);
    expect(plain.status).toBe(409);
    expect((await plain.json()).code).toBe("approvals.indeterminate");
    expect(writes).toEqual([]);
    // Verified not applied: approved again, explicitly — it runs once.
    const res = await decide(
      post(
        `/api/admin/approvals/${id}`,
        { decision: "reapprove", source: "runtime" },
        second
      ),
      { params: Promise.resolve({ id }) }
    );
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect((await proposals.getById(id))?.status).toBe("executed");
  });
});

describe("r10 invariant: no action is both held as an action and a governed config write", () => {
  const configWrites = Object.keys(COMMAND_BAR_CONFIG_WRITES);
  const seed052 = (): string[] => {
    const sql = readFileSync(
      join(ROOT, "supabase/migrations/052_audit_wave2.sql"),
      "utf8"
    );
    const m = /\('admin\.dual_control_actions',\s*'(\[[^']*\])',\s*'(\[[^']*\])'/.exec(
      sql
    );
    expect(m).not.toBeNull();
    expect(m![1]).toBe(m![2]);
    return JSON.parse(m![1]) as string[];
  };

  it("the code's default list and 052's seed agree, and name no config-writing action", () => {
    expect(seed052()).toEqual([...DEFAULT_DUAL_CONTROL_ACTIONS]);
    for (const tool of [...DEFAULT_DUAL_CONTROL_ACTIONS, ...seed052()]) {
      expect(configWrites).not.toContain(tool);
    }
  });

  it("every config-writing action writes only keys 052 puts under dual control, named in its handler", () => {
    const sql = readFileSync(
      join(ROOT, "supabase/migrations/052_audit_wave2.sql"),
      "utf8"
    );
    for (const [tool, keys] of Object.entries(COMMAND_BAR_CONFIG_WRITES)) {
      expect(Object.keys(ADMIN_TOOL_PERMISSIONS)).toContain(tool);
      for (const key of keys ?? []) expect(sql).toContain(`'${key}'`);
    }
  });

  it("every handler that writes governed config is declared a config write (so it is never held as an action)", () => {
    const dir = join(ROOT, "app/api/admin/ai/handlers");
    const writers = new Set<unknown>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(join(dir, file), "utf8");
      if (
        !/\b(?:writeGovernedConfig|resetGovernedConfig|dispatchConfigTool|setConfigWithHistory)\b/.test(
          src
        )
      )
        continue;
      if (file === "shared.ts") continue; // types and the outcome mapping only
      for (const m of src.matchAll(/export async function (\w+)/g)) {
        writers.add((handlers as Record<string, unknown>)[m[1]]);
      }
    }
    const declaredWriters = Object.entries(COMMAND_BAR_HANDLERS)
      .filter(([, fn]) => writers.has(fn))
      .map(([tool]) => tool)
      .sort();
    expect(declaredWriters.length).toBeGreaterThan(0);
    expect(declaredWriters).toEqual([...configWrites].sort());
  });

  it("at runtime, a config-writing action is never held as an action — even when the list names it", async () => {
    for (const tool of configWrites) {
      await expect(
        isDualControlledAction(tool as keyof typeof COMMAND_BAR_HANDLERS)
      ).resolves.toBe(false);
    }
  });
});
