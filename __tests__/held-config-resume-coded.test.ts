/**
 * @jest-environment node
 */
/**
 * __tests__/held-config-resume-coded.test.ts — an approved held config change whose run fails
 * answers the run's own code, through the real path (TASK-194 round 15, I-1)
 *
 * The command bar holds a change to a dual-controlled key; a second admin approves it through
 * the approvals route; the hold's authority runs it — runApprovedConfigChange → invokeTool → the
 * action pipeline → the config tool → the store. When that run fails, the pipeline releases the
 * approval (ApprovedRunFailedError) and the decision answers. It answered approvals.run_failed
 * for every failure — "approve it again" even for a change already waiting, which fails the same
 * way. Nothing here is mocked between the route and the store: only the store itself (what it
 * answers) and the database (fake-data).
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

const KEY = "agent.trusted_agents";
const store = new Map<string, unknown>();
let twoPerson = false;
/** What the store's write answers: done, or one of its failures. */
let writeAnswer: "ok" | "audit" | "indeterminate" | "stale" | "required" = "ok";
const writes: unknown[] = [];
jest.mock("@/platform/auth/platform-config", () => {
  const actual = jest.requireActual("@/platform/auth/platform-config");
  return {
    ...actual,
    getConfigOrThrow: async (key: string) => {
      if (key === "config.dual_control_keys") return [KEY, "agent.capability_features"];
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
    setConfigWithHistory: async (key: string, value: unknown) => {
      if (writeAnswer === "audit")
        return {
          success: false,
          error: "The audit log is unavailable, so the value was not changed.",
          auditUnavailable: true,
        };
      // Round 21: the value it replaces changed (stale); a required job's key (refused for good).
      if (writeAnswer === "stale")
        return { success: false, error: "changed since it was read", stale: true };
      if (writeAnswer === "required")
        return {
          success: false,
          error: "turns on a required job",
          errorCode: "jobs.schedule_required",
          errorParams: {},
        };
      if (writeAnswer === "indeterminate")
        return {
          success: false,
          error: "The commit was lost: the change may or may not have applied.",
          indeterminate: true,
        };
      writes.push(value);
      store.set(key, value);
      return { success: true };
    },
  };
});

// hostile:role n/a: these routes' role cases are command-bar-holds and r10-one-hold [hostile:role]
// hostile:self n/a: deciding one's own hold is command-bar-holds and r10-one-hold [hostile:self]
// hostile:store-down n/a: a store down on these routes is command-bar-holds and r10-one-hold [hostile:store-down]
// hostile:id-spelling n/a: an id spelled otherwise is admin-usability-routes and approver-rules [hostile:id-spelling]
import { decisionWords } from "@/platform/errors/recorded-words";
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
import { readRefusal } from "@/platform/errors/refusal";
import { refusedDecisionText } from "@/components/admin/decision-outcome";
import { REFUSED_HOLD_ACTOR } from "@/platform/admin/approval-decision";

let proposals: InMemoryProposalStore;
/** Another change to the key already waits for two-person approval. */
let alreadyWaiting = false;

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
  twoPerson = false;
  alreadyWaiting = false;
  writeAnswer = "ok";
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
    if (/from config_pending_approvals where config_key = \$1 and scope = \$2/.test(sql))
      return alreadyWaiting ? [{ status: "pending" }] : [];
    return undefined;
  };
});

describe("an approved held config change that fails answers its run's code (round 15, I-1)", () => {
  it("a change to the key already waiting: 409 approvals.already_pending, the approval kept", async () => {
    const id = await held();
    twoPerson = true;
    alreadyWaiting = true;
    const res = await approve(id);
    const body = await res.json();
    expect({ status: res.status, code: body.code, params: body.params }).toEqual({
      status: 409,
      code: "approvals.already_pending",
      params: { key: KEY },
    });
    expect(body.approvalKept).toBe(true);
    expect((await proposals.getById(id))?.status).toBe("approved");
    expect(writes).toEqual([]);
  });

  it("the audit log unavailable: 503 service.unavailable {audit}, the approval kept", async () => {
    const id = await held();
    writeAnswer = "audit";
    const res = await approve(id);
    const body = await res.json();
    expect({ status: res.status, code: body.code, params: body.params }).toEqual({
      status: 503,
      code: "service.unavailable",
      params: { service: "audit" },
    });
    expect(body.approvalKept).toBe(true);
    expect((await proposals.getById(id))?.status).toBe("approved");
  });

  // Round 16, item 1: a lost commit may stand — the claim is not given back (round 15 released
  // it, approvalKept true): undecided once its lease has passed, approvals.indeterminate now.
  it("a lost commit: 409 approvals.indeterminate, the approval not kept — never re-run", async () => {
    const id = await held();
    writeAnswer = "indeterminate";
    const res = await approve(id);
    const body = await res.json();
    expect({ status: res.status, code: body.code }).toEqual({
      status: 409,
      code: "approvals.indeterminate",
    });
    expect(body.approvalKept).toBe(false);
    expect(body.undecidedWithinMinutes).toBe(75);
    expect((await proposals.getById(id))?.status).toBe("executing");
  });

  it("no answer carries the store's or the pipeline's own text", async () => {
    const id = await held();
    writeAnswer = "audit";
    const text = await (await approve(id)).text();
    expect(text).not.toMatch(/approved, not applied|audit log is unavailable, so/);
  });
});

describe("the approvals screen says what to do with each answer (round 15, I-1)", () => {
  /** The panel's words for the route's real answer. */
  async function said(res: Response): Promise<string | undefined> {
    const body = await res.clone().json();
    return refusedDecisionText("update_config", await readRefusal(res), body);
  }

  it("a change already waiting: decide that one first — never 'approve it again to retry'", async () => {
    const id = await held();
    twoPerson = true;
    alreadyWaiting = true;
    const text = await said(await approve(id));
    expect(text).toContain(`A change to ${KEY} is already waiting for approval.`);
    expect(text).toMatch(/approval stands: decide the change that is waiting first/);
    expect(text).not.toMatch(/approve it again to retry/);
  });

  it("the audit log unavailable: the approval stands, approve it again to retry", async () => {
    const id = await held();
    writeAnswer = "audit";
    const text = await said(await approve(id));
    expect(text).toMatch(/approval stands: approve it again to retry/);
  });

  it("a lost commit: listed as undecided; for a config hold, a retry of one that applied is refused as stale", async () => {
    const id = await held();
    writeAnswer = "indeterminate";
    const text = await said(await approve(id));
    expect(text).toMatch(/listed as undecided within 75 minutes/);
    expect(text).toMatch(/refused as stale/);
  });
});

describe("a command-bar action's held form reports its registry code (round 15, I-1)", () => {
  // The tool the command bar's hold resume runs (runtimeToolFor, held) — its reportsFailure is
  // what the pipeline asks of an approved run's result.
  const { runtimeToolFor } = jest.requireActual("@/app/api/admin/ai/command-bar");
  const tool = runtimeToolFor("set_approval_policy", {}, CALLERS.super_admin, true);

  it.each([
    ["service.unavailable", { service: "audit" }],
    ["admin.write_indeterminate", {}],
    ["approvals.already_pending", { key: "k" }],
  ])("%s", (code, params) => {
    expect(tool.reportsFailure({ success: false, error: code, code, params })).toEqual({
      reason: code,
      code,
      params,
    });
  });

  it("an uncoded failure or admin.action_failed is its reason, as before", () => {
    expect(
      tool.reportsFailure({
        success: false,
        error: "admin.action_failed",
        code: "admin.action_failed",
      })
    ).toBe("admin.action_failed");
    expect(tool.reportsFailure({ success: true })).toBeUndefined();
  });
});

describe("a command-bar config write whose commit was lost is audited indeterminate (round 15, I-3)", () => {
  it("suspend_agent (applied at once — a power reduction) with the commit lost", async () => {
    store.set(KEY, [
      ["agent:x", { owner: "o", scopes: ["translate"], status: "active" }],
    ]);
    writeAnswer = "indeterminate";
    const res = await execute(
      post(
        "/api/admin/ai/execute",
        { actions: [{ tool: "suspend_agent", input: { agent_id: "agent:x" } }] },
        "super_admin"
      )
    );
    const result = ((await res.json()).results as Record<string, unknown>[])[0];
    expect(result).toMatchObject({ success: false, code: "admin.write_indeterminate" });
    // The ActionResult's contract (shared.ts): a lost commit is `indeterminate`, audited so by
    // whatever audits the result — never "failed".
    expect(result.indeterminate).toBe(true);
    const records = fakeData()
      .audit.map((a) => a.details as Record<string, unknown>)
      .filter((d) => d.key === KEY);
    expect(records.map((d) => d.outcome)).toEqual(["attempted", "indeterminate"]);
  });
});

// Round 21, I-2 and the stale residual: an approved hold withdrawn because it is stale or refused
// for good is withdrawn by the system — recorded against REFUSED_HOLD_ACTOR, the decider as
// `foundBy`, who had approved it and when — and answered `withdrawn: true`, so the panels reload.
// A withdrawal that does not land says nothing of one (nit 7).
describe("an approved hold withdrawn as stale or refused (round 21)", () => {
  const withdrawnRecord = () =>
    fakeData()
      .audit.filter(
        (a) => (a.details as Record<string, unknown>).type === "approval_withdrawn"
      )
      .map((a) => ({ actor: a.actor_id, ...(a.details as Record<string, unknown>) }));

  it.each([
    ["stale", "approvals.stale", "stale"],
    ["required", "jobs.schedule_required", "refused"],
  ] as const)(
    "%s: withdrawn by the system, recorded with foundBy and the approver, answered withdrawn",
    async (answer, code, reason) => {
      const id = await held();
      writeAnswer = answer;
      const res = await approve(id);
      const body = await res.json();
      expect({ status: res.status, code: body.code, withdrawn: body.withdrawn }).toEqual({
        status: 409,
        code,
        withdrawn: true,
      });
      const after = await proposals.getById(id);
      expect(after).toMatchObject({ status: "rejected", decidedBy: REFUSED_HOLD_ACTOR });
      // The system's why is the catalog's record (TASK-209: it was English in decisionNote).
      expect(after?.decisionNote).toBeUndefined();
      const words = decisionWords(after!) ?? "";
      expect(words).not.toMatch(/withdrawn.*withdrawn/);
      // Any held change's (round 23): a role change is no setting.
      expect(words).not.toMatch(/setting/);
      expect(words).toMatch(
        answer === "stale"
          ? /withdrawn: stale: what it would replace changed since it was requested$/
          : /withdrawn: refused: ".+" turns on a job that is now required/
      );
      expect(withdrawnRecord()).toEqual([
        expect.objectContaining({
          actor: null,
          agent: REFUSED_HOLD_ACTOR,
          reason,
          holdId: id,
          foundBy: CALLERS.safety_approver.userId,
          approvedBy: CALLERS.safety_approver.userId,
          approvedAt: expect.any(String),
        }),
      ]);
    }
  );

  it.each(["stale", "required"] as const)(
    "%s, the withdrawal not landing: no withdrawn said",
    async (answer) => {
      const id = await held();
      writeAnswer = answer;
      jest.spyOn(proposals, "withdraw").mockResolvedValueOnce(undefined);
      const body = await (await approve(id)).json();
      expect(body.withdrawn).toBeUndefined();
    }
  );
});
