/**
 * @jest-environment node
 */
/**
 * __tests__/config-ai-held-reply.test.ts — a held config change, as the real route answers it and
 * the dual-control panel reads it (TASK-194 round 11, item 1)
 *
 * The panel's own request — update_config of config.dual_control_keys, `confirmed: true` — goes
 * through the real route and the real dispatchConfigTool (only the config store and the data
 * layer are faked), so the status and body asserted here are what the panel gets. A held change
 * is accepted, not applied: 202 with `held`, as the users, entitlements, gdpr and command-bar
 * routes answer one. The panel's reader (readConfigAiResult) is given that very Response, so
 * its test cannot pass on a reply the route does not make (the round-10 panel test mocked a 200).
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

const store = new Map<string, unknown>();
const twoPerson = { on: false };
const NUMBER_KEY = "moderation.strike_ban_threshold";
/** A setting that takes one of a list (round 15, I-8). */
const ENUM_KEY = "moderation.default_action";
const writes: string[] = [];
jest.mock("@/platform/auth/platform-config", () => {
  const actual = jest.requireActual("@/platform/auth/platform-config");
  return {
    ...actual,
    getConfigOrThrow: async (key: string) => {
      if (key === "config.require_two_person_approval") return twoPerson.on;
      if (key === "admin.dual_control_actions") return [];
      if (store.has(key)) return store.get(key);
      throw new Error(`no key ${key}`);
    },
    getConfig: async (key: string, fallback: unknown) =>
      store.has(key) ? store.get(key) : fallback,
    // A number setting (round 12, pre-existing 1), else a list; validated for real.
    getEnhancedConfig: async (key: string) => ({
      key,
      value: store.get(key) ?? (key === NUMBER_KEY ? 3 : []),
      platformValue: store.get(key) ?? (key === NUMBER_KEY ? 3 : []),
      overridden: false,
      permissionTier: "safety",
      tenantOverridable: false,
      valueType:
        key === NUMBER_KEY ? "number" : key === ENUM_KEY ? "string_enum" : "json_array",
      allowedValues: key === ENUM_KEY ? ["warn", "ban"] : null,
      description: "",
      category: "config",
      validation: null,
    }),
    getPermissionTier: async () => "safety",
    setConfigWithHistory: async (key: string, value: unknown) => {
      writes.push(key);
      store.set(key, value);
      return { success: true };
    },
  };
});

import { NextRequest } from "next/server";
import { authAs } from "@/__tests__/helpers/test-identities";
import { fakeData } from "./helpers/fake-data";
import {
  InMemoryProposalStore,
  setProposalStore,
} from "@/platform/agents/proposal-store";
import {
  InMemoryTrajectoryStore,
  setTrajectoryStore,
} from "@/platform/agents/trajectory-store";
import { POST } from "@/app/api/admin/config-ai/execute/route";
import { isPending, readConfigAiResult } from "@/components/admin/DualControlKeysPanel";

let proposals: InMemoryProposalStore;

beforeEach(() => {
  twoPerson.on = false;
  store.clear();
  writes.length = 0;
  fakeData().reset();
  proposals = new InMemoryProposalStore();
  setProposalStore(proposals);
  setTrajectoryStore(new InMemoryTrajectoryStore());
  store.set("config.dual_control_keys", ["signups_enabled"]);
});

const panelRequest = () =>
  POST(
    new NextRequest("http://localhost/api/admin/config-ai/execute", {
      method: "POST",
      headers: { "content-type": "application/json", ...authAs("super_admin") },
      body: JSON.stringify({
        toolId: "update_config",
        input: {
          key: "config.dual_control_keys",
          value: ["signups_enabled", "moderation.escalation_sla_hours"],
          changeComment: "Add moderation.escalation_sla_hours to dual control",
          confirmed: true,
        },
      }),
    })
  );

it("answers the panel's held change 202, held, with its proposal — nothing written", async () => {
  const res = await panelRequest();
  const body = await res.clone().json();
  expect({ status: res.status, held: body.held }).toEqual({ status: 202, held: true });
  expect(body.data).toMatchObject({
    pendingApproval: true,
    proposalId: expect.any(String),
  });
  expect(writes).toEqual([]);
  expect(await proposals.getById(body.data.proposalId)).toMatchObject({
    label: "update_config",
  });
});

it("the panel reads that very reply as held, never as a refusal", async () => {
  const result = await readConfigAiResult(await panelRequest());
  expect(result.held).toBe(true);
  expect(result.data?.pendingApproval).toBe(true);
  expect(result.error).toBeUndefined();
});

// Round 12, I-2: a held config change needs a person, whatever the policy's default says — here
// a store that hands the gate a non-person default straight (past the stores' own reading).
it("a held config change still requires a person under a non-person policy default", async () => {
  const { setApprovalPolicyStore, resetApprovalPolicyStore } =
    jest.requireActual("@/platform/agents");
  setApprovalPolicyStore({
    load: async () => ({ version: 2, default: "agent", rules: [] }),
    setRules: async () => {
      throw new Error("not in this test");
    },
  });
  try {
    const res = await panelRequest();
    const body = await res.json();
    expect(body.data).toMatchObject({ pendingApproval: true, requiredApprover: "user" });
  } finally {
    resetApprovalPolicyStore();
  }
});

const write = (input: Record<string, unknown>) =>
  POST(
    new NextRequest("http://localhost/api/admin/config-ai/execute", {
      method: "POST",
      headers: { "content-type": "application/json", ...authAs("super_admin") },
      body: JSON.stringify({ toolId: "update_config", input }),
    })
  );

// Round 12, I-1: two-person approval (a config approval, not a runtime hold) is pending too — 202,
// read by the panel as pending, never as applied or refused.
it("answers a change pending two-person approval 202, and the panel reads it as pending", async () => {
  twoPerson.on = true;
  fakeData().answer = (sql) =>
    /insert into config_pending_approvals/.test(sql)
      ? [
          {
            id: "apr-1",
            config_key: NUMBER_KEY,
            current_value: 3,
            proposed_value: 5,
            requested_by: "x",
            change_comment: "raise",
            status: "pending",
            created_at: new Date().toISOString(),
          },
        ]
      : undefined;
  const res = await write({
    key: NUMBER_KEY,
    value: 5,
    changeComment: "raise",
    confirmed: true,
  });
  const body = await res.clone().json();
  expect({ status: res.status, requiresApproval: body.data?.requiresApproval }).toEqual({
    status: 202,
    requiresApproval: true,
  });
  expect(body.data.approvalError).toBeUndefined();
  expect(writes).toEqual([]);
  const read = await readConfigAiResult(res);
  expect(read.error).toBeUndefined();
  expect(read.data?.requiresApproval).toBe(true);
});

// Round 12, pre-existing 1: a dual-controlled change is held only with a value its entry takes.
it("refuses a dual-controlled change whose value its entry refuses — never held", async () => {
  store.set("config.dual_control_keys", [NUMBER_KEY]);
  const res = await write({
    key: NUMBER_KEY,
    value: "she lives at 1 Main St",
    changeComment: "c",
    confirmed: true,
  });
  const body = await res.json();
  expect(res.status).toBe(422);
  expect(body.held).toBeUndefined();
  expect(body.data).toMatchObject({ applied: false });
  expect(body.code).toBe("admin.config_invalid_value");
  expect(await proposals.query({})).toEqual([]);
  expect(writes).toEqual([]);
});

// Round 13, I-C; round 14, item 2: that refusal is coded — admin.config_invalid_value with its
// structured reason, as the config page and the command bar answer it — and the panel's reader
// says it (it answered a bare 422, which the panel showed as "Something went wrong"). The entry's
// English reasons are no part of the answer.
it("codes the refusal of a value its entry refuses, and the panel's reader says why", async () => {
  store.set("config.dual_control_keys", [NUMBER_KEY]);
  const input = {
    key: NUMBER_KEY,
    value: "she lives at 1 Main St",
    changeComment: "c",
    confirmed: true,
  };
  const res = await write(input);
  expect(res.status).toBe(422);
  const text = await res.clone().text();
  expect(JSON.parse(text)).toMatchObject({
    code: "admin.config_invalid_value",
    params: { key: NUMBER_KEY, reason: "type", expected: "number" },
    message: `${NUMBER_KEY} takes a number.`,
  });
  expect(text).not.toContain("Value must be a number");
  const read = await readConfigAiResult(await write(input));
  expect(read.error).toBe(`${NUMBER_KEY} takes a number.`);
});

// Round 14, item 12 (pre-existing): a filing the approval store could not make answers its code —
// never the store's own error text, which reached the client as data.approvalError.
it("answers an approval store failure 503 service.unavailable, without the store's text", async () => {
  twoPerson.on = true;
  fakeData().answer = (sql) => {
    if (/insert into config_pending_approvals/.test(sql))
      throw new Error('duplicate key value violates "secret_internal_index"');
    return undefined;
  };
  const res = await write({
    key: NUMBER_KEY,
    value: 5,
    changeComment: "c",
    confirmed: true,
  });
  const text = await res.clone().text();
  const body = JSON.parse(text);
  expect({ status: res.status, code: body.code }).toEqual({
    status: 503,
    code: "service.unavailable",
  });
  expect(text).not.toContain("secret_internal_index");
  for (const field of ["error", "approvalError", "applyError", "validationErrors"])
    expect(body.data ?? {}).not.toHaveProperty(field);
  expect(writes).toEqual([]);
});

// Round 15, I-2: a refused filing — a change to the key already waiting (409), the approval store
// unavailable (503) — is no pending change on the dual-control screen. The route kept
// `requiresApproval` in the body, and the panel's reader read it as pending before it read the
// status.
describe("a refused two-person filing is a refusal on the panel, never pending (round 15, I-2)", () => {
  it.each([
    [
      409,
      "approvals.already_pending",
      (sql: string) =>
        /from config_pending_approvals where config_key/.test(sql)
          ? [{ status: "pending" }]
          : undefined,
    ],
    [
      503,
      "service.unavailable",
      (sql: string) => {
        if (/insert into config_pending_approvals/.test(sql)) throw new Error("db down");
        return undefined;
      },
    ],
  ])("%i %s", async (status, code, answer) => {
    twoPerson.on = true;
    fakeData().answer = answer;
    const res = await write({
      key: NUMBER_KEY,
      value: 5,
      changeComment: "c",
      confirmed: true,
    });
    expect(res.status).toBe(status);
    const body = await res.clone().json();
    expect(body.code).toBe(code);
    expect(body.data?.requiresApproval).toBeUndefined();
    const read = await readConfigAiResult(res);
    expect(isPending(read)).toBe(false);
    expect(read).toMatchObject({ success: false, error: body.message });
  });
});

// Round 15, I-8: a value an enum does not take is refused with its list, worded by the message.
it("refuses a value an enum does not take with its list: admin.config_invalid_value { allowed }", async () => {
  const res = await write({
    key: ENUM_KEY,
    value: "kick",
    changeComment: "c",
    confirmed: true,
  });
  expect(res.status).toBe(422);
  expect(await res.json()).toMatchObject({
    code: "admin.config_invalid_value",
    params: { key: ENUM_KEY, reason: "not_allowed", allowed: ["warn", "ban"] },
    message: `The values ${ENUM_KEY} takes are warn and ban.`,
  });
  expect(writes).toEqual([]);
});
