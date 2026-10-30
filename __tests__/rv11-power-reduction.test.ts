/**
 * __tests__/rv11-power-reduction.test.ts — The kill switch needs no second admin (review 11 M-2)
 *
 * Suspending an agent was a write to agent.trusted_agents, a dual-controlled key: it waited for a
 * second safety admin. A change that provably only removes power — a suspension, a narrower scope,
 * a shorter token lifetime, a capability mapping removed — is now applied at once by the one
 * admin making it (who holds the key's tier permission, config_manage_safety), audited and
 * alerted. The proof is a strict diff of the governed value: any change it cannot prove a
 * reduction — a mixed diff that reduces one thing and widens another included — is held as before.
 * And the operator's emergency path suspends every agent of a tenant at once.
 *
 * The real command bar, config handlers, pipeline and proposal store; the config store faked as in
 * r10-one-hold. The compare-and-set against the stored value runs on Postgres in
 * db/rv11-runs-and-chains.
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

const DUAL_KEYS = ["agent.trusted_agents", "agent.capability_features"];
const store = new Map<string, unknown>();
let twoPerson = false;
const writes: { key: string; value: unknown; comment: string; options?: unknown }[] = [];
jest.mock("@/platform/auth/platform-config", () => {
  const actual = jest.requireActual("@/platform/auth/platform-config");
  return {
    ...actual,
    getConfigOrThrow: async (key: string) => {
      if (key === "config.dual_control_keys") return DUAL_KEYS;
      if (key === "config.require_two_person_approval") return twoPerson;
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
    setConfigWithHistory: async (
      key: string,
      value: unknown,
      _actor: string,
      comment: string,
      _source?: unknown,
      _entry?: unknown,
      _target?: unknown,
      options?: unknown
    ) => {
      writes.push({ key, value, comment, options });
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
import { writeGovernedConfig } from "@/platform/admin/governed-config";
import { dispatchConfigTool } from "@/platform/admin/config-handlers";
import { everyAgentSuspended, powerReduction } from "@/platform/admin/power-reduction";
import { suspendAllAgents } from "@/platform/admin/agent-kill-switch";

const operator = identityFor("super_admin", { name: "rv11_operator" });
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

const REGISTRY = () => [
  ["agent:a", { owner: "o", scopes: ["x", "y"], status: "active", maxTokenTtl: 300 }],
  ["agent:b", { owner: "o", scopes: ["x"], status: "active", maxTokenTtl: 300 }],
  ["agent:s", { owner: "o", scopes: ["x"], status: "suspended", maxTokenTtl: 300 }],
];
const MAPPING = () => [
  ["summarize", ["translate"]],
  ["publish", ["post", "share"]],
];

/** Audit records written, by type. */
const auditTypes = () => fakeData().audit.map((a) => a.details.type as string);

beforeEach(() => {
  twoPerson = false;
  store.clear();
  writes.length = 0;
  fakeData().reset();
  proposals = new InMemoryProposalStore();
  setProposalStore(proposals);
  setTrajectoryStore(new InMemoryTrajectoryStore());
  store.set("agent.trusted_agents", REGISTRY());
  store.set("agent.capability_features", MAPPING());
});

describe("rv11 M-2: a strict reduction is applied by one admin, at once", () => {
  it.each([
    ["suspend_agent", { agent_id: "agent:a" }],
    ["set_agent_scope", { agent_id: "agent:a", scopes: ["x"] }],
    ["set_agent_scope", { agent_id: "agent:a", scopes: [] }],
    ["set_agent_ttl", { agent_id: "agent:a", max_token_ttl: 60 }],
    // Review 12 H1: a required feature added to an existing mapping asks more of every caller.
    [
      "set_capability_mapping",
      { capability: "publish", features: ["post", "share", "verify"] },
    ],
  ] as const)(
    "%s %j: applied at once — no proposal — compare-and-set, audited",
    async (tool, input) => {
      // Even with two-person approval on: a reduction waits for nobody.
      twoPerson = true;
      const r = await run("super_admin", tool, { ...input });
      expect(r).toMatchObject({ success: true });
      expect(await proposals.query({})).toEqual([]);
      expect(writes).toHaveLength(1);
      // The write compares against the value the reduction was proved of.
      expect(writes[0].options).toEqual({
        expectPrevious: {
          value: tool === "set_capability_mapping" ? MAPPING() : REGISTRY(),
        },
      });
      expect(auditTypes()).toContain("power_reduction_applied");
    }
  );

  it("the suspension took effect: the agent is suspended, nothing else changed", async () => {
    await run("super_admin", "suspend_agent", { agent_id: "agent:b" });
    const after = store.get("agent.trusted_agents") as [string, { status: string }][];
    expect(after.map(([id, r]) => [id, r.status])).toEqual([
      ["agent:a", "active"],
      ["agent:b", "suspended"],
      ["agent:s", "suspended"],
    ]);
  });

  it.each([
    ["register_agent", { agent_id: "agent:new", scopes: [] }],
    ["suspend_agent", { agent_id: "agent:s", reactivate: true }],
    ["set_agent_scope", { agent_id: "agent:a", scopes: ["x", "y", "z"] }],
    ["set_agent_scope", { agent_id: "agent:b", scopes: ["y"] }],
    ["set_agent_ttl", { agent_id: "agent:a", max_token_ttl: 600 }],
    ["set_capability_mapping", { capability: "summarize", features: ["x"] }],
    ["set_capability_mapping", { capability: "new", features: ["x"] }],
    // Review 12 H1: a removed mapping is a widening for a consumer that reads an absent
    // capability as needing no features — held, never applied by one admin.
    ["set_capability_mapping", { capability: "publish", remove: true }],
  ] as const)("%s %j: a widening — held as before", async (tool, input) => {
    const r = await run("super_admin", tool, { ...input });
    expect(r).toMatchObject({ success: false, held: true });
    expect(writes).toEqual([]);
    expect((await proposals.query({})).map((p) => p.label)).toEqual(["update_config"]);
  });

  it("hostile mixed diffs — reduce one, widen another — are held whole", async () => {
    const reg = REGISTRY();
    const mixed = [
      [reg[0][0], { ...(reg[0][1] as object), status: "suspended" }],
      [reg[1][0], { ...(reg[1][1] as object), scopes: ["x", "admin"] }],
      reg[2],
    ];
    const mixedTtl = [
      [reg[0][0], { ...(reg[0][1] as object), scopes: ["x"] }],
      [reg[1][0], { ...(reg[1][1] as object), maxTokenTtl: 3600 }],
      reg[2],
    ];
    const suspendAndAdd = [
      ...(everyAgentSuspended(reg) as unknown[]),
      ["agent:new", { owner: "o", scopes: [], status: "suspended" }],
    ];
    const suspendAndReactivate = [
      [reg[0][0], { ...(reg[0][1] as object), status: "suspended" }],
      reg[1],
      [reg[2][0], { ...(reg[2][1] as object), status: "active" }],
    ];
    const suspendAndRetarget = [
      [reg[0][0], { ...(reg[0][1] as object), status: "suspended", owner: "attacker" }],
      reg[1],
      reg[2],
    ];
    for (const value of [
      mixed,
      mixedTtl,
      suspendAndAdd,
      suspendAndReactivate,
      suspendAndRetarget,
    ]) {
      const outcome = await writeGovernedConfig(CALLERS.super_admin as never, {
        key: "agent.trusted_agents",
        value,
        changeComment: "config page",
      });
      expect(outcome.kind).toBe("pending");
    }
    // A mapping removed (publish) and another widened (summarize): held whole.
    const mapping = MAPPING();
    const outcome = await writeGovernedConfig(CALLERS.super_admin as never, {
      key: "agent.capability_features",
      value: [[mapping[0][0], ["translate", "admin"]]],
      changeComment: "config page",
    });
    expect(outcome.kind).toBe("pending");
    expect(writes).toEqual([]);
  });

  it("a caller cannot claim a reduction: a supplied expectPrevious is discarded, and a widening is held", async () => {
    const widened = [
      ...REGISTRY(),
      ["agent:evil", { owner: "o", scopes: ["*"], status: "active" }],
    ];
    const r = await dispatchConfigTool("update_config", {
      key: "agent.trusted_agents",
      value: widened,
      changeComment: "x",
      actorId: CALLERS.super_admin.userId,
      confirmed: true,
      // As if it were the value replaced, and the widened one the reduction of it.
      expectPrevious: {
        value: [
          ...widened,
          ["agent:other", { owner: "o", scopes: [], status: "active" }],
        ],
      },
    });
    expect(r).toMatchObject({ held: true });
    expect(writes).toEqual([]);
    const held = await proposals.query({});
    expect(held).toHaveLength(1);
    expect(held[0].payload).not.toHaveProperty("expectPrevious");
  });

  it("the admin still needs the key's tier permission (config_manage_safety)", async () => {
    const outcome = await writeGovernedConfig(CALLERS.admin as never, {
      key: "agent.trusted_agents",
      value: everyAgentSuspended(REGISTRY()),
      changeComment: "x",
    });
    expect(outcome).toEqual({ kind: "refused", permission: "config_manage_safety" });
    expect(writes).toEqual([]);
  });
});

describe("rv11 M-2: the strict diff", () => {
  const reg = REGISTRY();
  it.each([
    ["suspension", everyAgentSuspended(reg), true],
    ["no change", reg, false],
    ["agent removed", reg.slice(1), false],
    ["duplicate id", [...reg, reg[0]], false],
    ["not pairs", { a: 1 }, false],
    [
      "a field other than the three changed",
      [[reg[0][0], { ...(reg[0][1] as object), note: "x" }], reg[1], reg[2]],
      false,
    ],
    [
      "ttl set where none was",
      [[reg[0][0], { owner: "o", scopes: ["x"], status: "active" }]],
      false,
    ],
    [
      "ttl to zero",
      [[reg[0][0], { ...(reg[0][1] as object), maxTokenTtl: 0 }], reg[1], reg[2]],
      false,
    ],
    [
      "an unknown status",
      [[reg[0][0], { ...(reg[0][1] as object), status: "paused" }], reg[1], reg[2]],
      false,
    ],
  ])("agent.trusted_agents — %s", (_name, after, reduces) => {
    expect(powerReduction("agent.trusted_agents", reg, after).reduces).toBe(reduces);
  });

  it("a reduction names every change it makes", () => {
    const after = [
      [
        reg[0][0],
        { ...(reg[0][1] as object), status: "suspended", scopes: ["x"], maxTokenTtl: 30 },
      ],
      reg[1],
      reg[2],
    ];
    expect(powerReduction("agent.trusted_agents", reg, after)).toEqual({
      reduces: true,
      changes: [
        "suspend agent:a",
        "narrow agent:a (-y)",
        "lower agent:a's token lifetime 300s -> 30s",
      ],
    });
  });

  it("capability mappings: only required features added to existing mappings reduce (review 12 H1)", () => {
    const m = MAPPING();
    expect(
      powerReduction("agent.capability_features", m, [
        [m[0][0], ["translate", "x"]],
        m[1],
      ])
    ).toEqual({ reduces: true, changes: ["require x for summarize"] });
    // A removal, an emptied mapping, all removed, a feature dropped: widenings, held.
    expect(powerReduction("agent.capability_features", m, [m[1]]).reduces).toBe(false);
    expect(
      powerReduction("agent.capability_features", m, [[m[0][0], []], m[1]]).reduces
    ).toBe(false);
    expect(powerReduction("agent.capability_features", m, []).reduces).toBe(false);
    expect(
      powerReduction("agent.capability_features", m, [m[0], [m[1][0], ["post"]]]).reduces
    ).toBe(false);
    expect(powerReduction("agent.capability_features", m, m).reduces).toBe(false);
  });

  it("no other key is ever a reduction", () => {
    expect(powerReduction("config.dual_control_keys", ["a"], []).reduces).toBe(false);
  });
});

describe("rv11 M-2: the operator's kill switch", () => {
  it("suspends every active agent of the tenant at once, compare-and-set, audited — and is a no-op when none is active", async () => {
    const outcome = await suspendAllAgents(operator as never, "incident 42");
    expect(outcome).toEqual({
      ok: true,
      suspended: ["agent:a", "agent:b"],
      withdrawn: [],
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].options).toEqual({ expectPrevious: { value: REGISTRY() } });
    expect(writes[0].comment).toContain("incident 42");
    const registry = store.get("agent.trusted_agents") as [string, { status: string }][];
    expect(registry.length).toBeGreaterThan(0);
    expect(registry.every(([, r]) => r.status === "suspended")).toBe(true);
    expect(auditTypes()).toContain("agents_emergency_suspended");
    // Nothing active: nothing written, the invalidation published again (review 13 L2).
    expect(await suspendAllAgents(operator as never, "again")).toEqual({
      ok: true,
      suspended: [],
      republished: true,
    });
    expect(writes).toHaveLength(1);
  });

  it("refuses a registry it cannot prove the suspension of (malformed), changing nothing", async () => {
    store.set("agent.trusted_agents", [["agent:a", { status: "active" }]]);
    const outcome = await suspendAllAgents(operator as never, "x");
    expect(outcome.ok).toBe(false);
    expect(writes).toEqual([]);
  });
});
