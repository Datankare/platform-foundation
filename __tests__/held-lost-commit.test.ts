/**
 * @jest-environment node
 */
/**
 * __tests__/held-lost-commit.test.ts — an approved command-bar hold whose write lost its commit
 * is undecided, never approved again blind (TASK-194 round 16, item 1)
 *
 * The write may stand. Releasing the approval (round 15) let "approve" run it a second time. The
 * pipeline now keeps the claim (released: false); the decision answers approvals.indeterminate;
 * once the run's lease has passed the recovery marks it undecided, and a person verifies it and
 * marks it executed or withdraws it. Through the real execute and approvals routes, the hold
 * authority, invokeTool and the pipeline; the database is fake-data (the write's commit "lost").
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
jest.mock("@/platform/auth/platform-config", () => {
  const actual = jest.requireActual("@/platform/auth/platform-config");
  return {
    ...actual,
    getConfigOrThrow: async (key: string) => {
      if (key === "admin.dual_control_actions") return ["set_entitlement_group_active"];
      if (key === "config.dual_control_keys") return [];
      if (key === "config.require_two_person_approval") return false;
      throw new Error(`no key ${key}`);
    },
    getConfig: async (_key: string, fallback: unknown) => fallback,
    getConfigBoolean: async (_key: string, fallback: boolean) => fallback,
  };
});

// hostile:role n/a: these routes' role cases are command-bar-holds and r10-one-hold [hostile:role]
// hostile:self n/a: deciding one's own hold is command-bar-holds and r10-one-hold [hostile:self]
// hostile:store-down n/a: a store down on these routes is command-bar-holds and r10-one-hold [hostile:store-down]
// hostile:id-spelling n/a: an id spelled otherwise is admin-usability-routes and approver-rules [hostile:id-spelling]
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
import { POST as decide } from "@/app/api/admin/approvals/[id]/route";
import { readRefusal } from "@/platform/errors/refusal";
import { refusedDecisionText } from "@/components/admin/decision-outcome";

const GROUP = "00000000-0000-4000-8000-00000000e001";
const second = identityFor("super_admin", { name: "lost_commit_second" });
let proposals: InMemoryProposalStore;
let lose = false;
/** The write fails outright (nothing applied). */
let fail = false;
let writes = 0;

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
            tool: "set_entitlement_group_active",
            input: { group_id: GROUP, is_active: true },
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

const decision = (id: string, d: string) =>
  decide(post(`/api/admin/approvals/${id}`, { decision: d, source: "runtime" }, second), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  lose = false;
  fail = false;
  writes = 0;
  fakeData().reset();
  proposals = new InMemoryProposalStore();
  setProposalStore(proposals);
  setTrajectoryStore(new InMemoryTrajectoryStore());
  fakeData().answer = (sql, values) => {
    if (/select cognito_sub from users where id = \$1::uuid/.test(sql)) {
      const identity = [...Object.values(CALLERS), second].find(
        (c) => c.userId === values[0]
      );
      return identity ? [{ cognito_sub: identity.sub }] : [];
    }
    if (/from entitlement_groups where id = \$1::uuid/.test(sql))
      return [{ id: GROUP, code: "premium" }];
    if (/from entitlement_permissions/.test(sql)) return [];
    if (/update entitlement_groups set is_active/.test(sql)) {
      writes += 1;
      if (lose)
        throw Object.assign(new Error("connection lost during commit"), {
          indeterminate: true,
        });
      if (fail) throw new Error("deadlock detected");
      return [];
    }
    return undefined;
  };
});

describe("a command-bar hold whose write lost its commit (round 16, item 1)", () => {
  it("is not released: approvals.indeterminate, approvalKept false, the run audited indeterminate", async () => {
    const id = await held();
    lose = true;
    const res = await decision(id, "approve");
    const body = await res.clone().json();
    expect({
      status: res.status,
      code: body.code,
      approvalKept: body.approvalKept,
    }).toEqual({
      status: 409,
      code: "approvals.indeterminate",
      approvalKept: false,
    });
    expect((await proposals.getById(id))?.status).toBe("executing");
    // The screen says what happens next — and never offers approving it again, nor the config
    // holds' stale retry.
    const text = refusedDecisionText(
      "set_entitlement_group_active",
      await readRefusal(res),
      body
    );
    expect(text).toMatch(/listed as undecided within 75 minutes/);
    expect(text).not.toMatch(/approve it again|refused as stale/);
    // The write's audit record and the decision's own: indeterminate, never failed (item 2).
    const outcomes = (type: string) =>
      fakeData()
        .audit.map((a) => a.details as Record<string, unknown>)
        .filter((d) => d.type === type)
        .map((d) => d.outcome);
    expect(outcomes("entitlement_toggle")).toEqual(["attempted", "indeterminate"]);
    expect(outcomes("approval_decision")).toEqual(["attempted", "indeterminate"]);
    // The invoker's own record of the run (round 17): undecided, never "approved_run_failed".
    const types = fakeData().audit.map((a) => a.details.type);
    expect(types).toContain("approved_run_indeterminate");
    expect(types).not.toContain("approved_run_failed");
  });

  it("approving it again runs nothing: it is not approved", async () => {
    const id = await held();
    lose = true;
    await decision(id, "approve");
    lose = false;
    const again = await decision(id, "approve");
    expect(again.status).toBe(409);
    expect(writes).toBe(1);
  });

  it.each([
    ["mark_executed", "executed"],
    ["withdraw", "rejected"],
  ])("once undecided (the lease passed), %s decides it", async (d, status) => {
    const id = await held();
    lose = true;
    await decision(id, "approve");
    proposals.recoverStaleRuns(Date.now() + 60_000);
    expect((await proposals.getById(id))?.status).toBe("indeterminate");
    const res = await decision(id, d);
    expect(res.status).toBe(200);
    expect((await proposals.getById(id))?.status).toBe(status);
    expect(writes).toBe(1);
  });

  // Round 16, item 5: the decision's audit reason says what is true of the approval.
  it("a failed run whose claim could not be given back is audited as not kept — never 'approval kept'", async () => {
    const id = await held();
    jest.spyOn(proposals, "release").mockResolvedValue(undefined);
    fail = true;
    const res = await decision(id, "approve");
    expect((await res.json()).approvalKept).toBe(false);
    const record = fakeData()
      .audit.map((a) => a.details as Record<string, unknown>)
      .filter((d) => d.type === "approval_decision" && d.outcome === "failed");
    expect(record).toHaveLength(1);
    // A catalog key (TASK-209), worded by the audit page: "… claim not given back …".
    expect(record[0].reason).toBe("screens.records.audit_run_failed_not_released");
  });

  it("a failed run whose claim was given back is audited 'approval kept'", async () => {
    const id = await held();
    fail = true;
    const res = await decision(id, "approve");
    expect((await res.json()).approvalKept).toBe(true);
    const record = fakeData()
      .audit.map((a) => a.details as Record<string, unknown>)
      .filter((d) => d.type === "approval_decision" && d.outcome === "failed");
    expect(record[0].reason).toBe("screens.records.audit_run_failed_kept");
  });
});
