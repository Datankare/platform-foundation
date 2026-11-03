/**
 * @jest-environment node
 */
/**
 * __tests__/restricted-needs-person-paths.test.ts — restricted ⇒ person, on the config paths that
 * run (TASK-194 round 15, I-6; the half of restricted-needs-person.test.ts that checked the held
 * forms by building them itself)
 *
 * A held config change runs twice through the governed runtime: when it is asked for
 * (dispatchConfigTool — the pipeline holds it) and when its approval is decided
 * (runApprovedConfigChange — the approval lets it through). Each must hand invokeTool the held
 * form, at restricted risk, so only a person's approval clears it. This spies on the real
 * invokeTool — it still runs — and checks the tool each path actually passed.
 */

const mockInvoked: {
  tool: { id: string; declaredRisk: string; effects: readonly string[] };
  approvedProposalId?: string;
}[] = [];
jest.mock("@/platform/agents/tool-invoker", () => {
  const actual = jest.requireActual("@/platform/agents/tool-invoker");
  return {
    ...actual,
    invokeTool: (args: (typeof mockInvoked)[number]) => {
      mockInvoked.push(args);
      return actual.invokeTool(args);
    },
  };
});
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

const KEY = "agent.trusted_agents";
const store = new Map<string, unknown>();
const writes: unknown[] = [];
jest.mock("@/platform/auth/platform-config", () => {
  const actual = jest.requireActual("@/platform/auth/platform-config");
  return {
    ...actual,
    getConfigOrThrow: async (key: string) => {
      if (key === "config.dual_control_keys") return [KEY, "agent.capability_features"];
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
    setConfigWithHistory: async (key: string, value: unknown) => {
      writes.push(value);
      store.set(key, value);
      return { success: true };
    },
  };
});

import { NextRequest } from "next/server";
import {
  authAs,
  CALLERS,
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

import { computeEffectiveRisk } from "@/platform/action-pipeline/risk";

let proposals: InMemoryProposalStore;

const post = (url: string, body: unknown, caller: CallerName | TestIdentity) =>
  new NextRequest(`http://localhost${url}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...authAs(caller) },
  });

async function held(): Promise<string> {
  const res = await execute(
    post(
      "/api/admin/ai/execute",
      {
        actions: [
          {
            tool: "register_agent",
            input: { agent_id: "agent:x", scopes: ["translate"] },
          },
        ],
      },
      "super_admin"
    )
  );
  const result = ((await res.json()).results as Record<string, unknown>[])[0];
  expect(result).toMatchObject({ held: true });
  return result.proposalId as string;
}

const approve = (id: string) =>
  decide(
    post(
      `/api/admin/approvals/${id}`,
      { decision: "approve", source: "runtime" },
      "safety_approver"
    ),
    { params: Promise.resolve({ id }) }
  );

beforeEach(() => {
  store.clear();
  store.set(KEY, []);
  store.set("agent.capability_features", []);
  writes.length = 0;
  fakeData().reset();
  proposals = new InMemoryProposalStore();
  setProposalStore(proposals);
  setTrajectoryStore(new InMemoryTrajectoryStore());
  fakeData().answer = (sql, values) => {
    if (/select cognito_sub from users where id = \$1::uuid/.test(sql)) {
      const identity = Object.values(CALLERS).find((c) => c.userId === values[0]);
      return identity ? [{ cognito_sub: identity.sub }] : [];
    }
    return undefined;
  };
});

/** The effective risk of the tool a call passed, as the pipeline computes it. */
const riskOf = (call: (typeof mockInvoked)[number]) =>
  computeEffectiveRisk({
    type: call.tool.id,
    effects: call.tool.effects as never,
    declaredRisk: call.tool.declaredRisk as never,
    ephemeral: false,
    commutative: false,
  });

describe("the config paths hand invokeTool the held form (round 15, I-6)", () => {
  beforeEach(() => {
    mockInvoked.length = 0;
  });

  it("dispatchConfigTool: the change asked for is held at restricted", async () => {
    await held();
    const asked = mockInvoked.filter((c) => c.tool.id === "update_config");
    expect(asked).toHaveLength(1);
    expect(asked[0].approvedProposalId).toBeUndefined();
    expect(asked[0].tool.declaredRisk).toBe("restricted");
    expect(riskOf(asked[0])).toBe("restricted");
  });

  it("runApprovedConfigChange: the approved run is the held form, at restricted", async () => {
    const id = await held();
    mockInvoked.length = 0;
    expect((await approve(id)).status).toBe(200);
    const ran = mockInvoked.filter((c) => c.tool.id === "update_config");
    expect(ran).toHaveLength(1);
    expect(ran[0].approvedProposalId).toBe(id);
    expect(ran[0].tool.declaredRisk).toBe("restricted");
    expect(riskOf(ran[0])).toBe("restricted");
    expect(writes).toHaveLength(1);
  });
});
