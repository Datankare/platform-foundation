/**
 * @jest-environment node
 */
/**
 * __tests__/config-approval-apply-coded.test.ts — a two-person config approval whose apply fails
 * answers why, and leaves the approval as that failure means (TASK-194 round 15, P-1)
 *
 * approveAndApply reopened every failed apply and answered service.unavailable {config}: a write
 * whose commit was lost (it may stand) was reopened to be approved — and applied — again; a value
 * its entry now refuses was reopened to fail the same way; the audit log unavailable read as the
 * approval store. Each now follows writeFailure's rules:
 *   - a lost commit: admin.write_indeterminate (503), the approval left approved and unapplied —
 *     the TASK-193 "may have applied" state: recoverUnappliedApprovals reads the change's own
 *     history after the apply lease and marks it applied, or reopens it;
 *   - a value its entry refuses: admin.config_invalid_value (422), the approval withdrawn, as a
 *     stale one is — never reopened to fail again;
 *   - the audit log unavailable: service.unavailable {audit} (503), reopened (nothing changed);
 *   - anything uncoded: admin.action_failed (500), reopened.
 * Through the approvals route (source "config-approval"): only the store's answer and the
 * database are faked.
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
let twoPerson = false;
let writeAnswer: "ok" | "audit" | "indeterminate" | "refused" | "failed" | "stale" = "ok";
const writes: unknown[] = [];
jest.mock("@/platform/auth/platform-config", () => {
  const actual = jest.requireActual("@/platform/auth/platform-config");
  return {
    ...actual,
    getConfigOrThrow: async (key: string) => {
      if (key === "config.dual_control_keys") return [];
      if (key === "config.require_two_person_approval") return twoPerson;
      if (key === "admin.dual_control_actions") return [];
      if (store.has(key)) return store.get(key);
      throw new Error(`no key ${key}`);
    },
    getConfig: async (key: string, fallback: unknown) =>
      store.has(key) ? store.get(key) : fallback,
    getEnhancedConfig: async (key: string) => ({
      key,
      value: store.get(key) ?? 3,
      platformValue: store.get(key) ?? 3,
      overridden: false,
      permissionTier: "safety",
      tenantOverridable: false,
      valueType: "number",
      description: "",
      category: "moderation",
      validation: null,
      allowedValues: null,
    }),
    getPermissionTier: async () => "safety",
    getConfigBoolean: async (_key: string, fallback: boolean) => fallback,
    setConfigWithHistory: async (key: string, value: unknown) => {
      switch (writeAnswer) {
        case "audit":
          return {
            success: false,
            error: "The audit log is unavailable, so the value was not changed.",
            auditUnavailable: true,
          };
        case "indeterminate":
          return {
            success: false,
            error: "The commit was lost: the change may or may not have applied.",
            indeterminate: true,
          };
        case "refused":
          return {
            success: false,
            error: "Value 50 is above maximum 10",
            validationErrors: ["Value 50 is above maximum 10"],
            valueRefusal: { reason: "above_max", max: 10 },
          };
        case "failed":
          return { success: false, error: 'relation "secret_internal" does not exist' };
        case "stale":
          return {
            success: false,
            error: "The setting changed since this change was requested.",
            stale: true,
          };
      }
      writes.push(value);
      store.set(key, value);
      return { success: true };
    },
  };
});

// hostile:role n/a: these routes' role cases are config-routes and r10-one-hold [hostile:role]
// hostile:self n/a: approving one's own request is config-routes and r10-one-hold [hostile:self]
// hostile:store-down n/a: a store down on these routes is config-routes and r10-one-hold [hostile:store-down]
// hostile:id-spelling n/a: an approver id spelled otherwise is approver-rules' case [hostile:id-spelling]
import { renderShown } from "@/platform/errors/shown-text";
import { NextRequest } from "next/server";
import { authAs, CALLERS } from "@/__tests__/helpers/test-identities";
import { fakeData } from "./helpers/fake-data";
import { POST as decide } from "@/app/api/admin/approvals/[id]/route";
import { POST as configAi } from "@/app/api/admin/config-ai/execute/route";
import { readRefusal } from "@/platform/errors/refusal";
import { refusedDecisionText } from "@/components/admin/decision-outcome";

const NUMBER_KEY = "moderation.strike_ban_threshold";
const ID = "00000000-0000-4000-8000-00000000a001";

const row = (status: string) => ({
  id: ID,
  config_key: NUMBER_KEY,
  current_value: 3,
  proposed_value: 50,
  requested_by: CALLERS.super_admin.userId,
  change_comment: "raise",
  impact_summary: null,
  status,
  reviewed_by: status === "pending" ? null : CALLERS.safety_approver.userId,
  review_comment: null,
  reviewed_at: status === "pending" ? null : new Date().toISOString(),
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  created_at: new Date().toISOString(),
  scope: "platform",
  action: "set",
});

const approve = () =>
  decide(
    new NextRequest(`http://localhost/api/admin/approvals/${ID}`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve", source: "config-approval" }),
      headers: { "content-type": "application/json", ...authAs("safety_approver") },
    }),
    { params: Promise.resolve({ id: ID }) }
  );

/** The statements that left the approval somewhere after its review. */
const after = () =>
  fakeData()
    .statements.map((s) => s.sql)
    .filter(
      (sql) =>
        /update config_pending_approvals/.test(sql) && !/reviewed_by = \$3/.test(sql)
    );

beforeEach(() => {
  twoPerson = true;
  writeAnswer = "ok";
  store.clear();
  writes.length = 0;
  fakeData().reset();
  fakeData().answer = (sql, values) => {
    if (/select cognito_sub from users where id = \$1::uuid/.test(sql)) {
      const identity = Object.values(CALLERS).find((c) => c.userId === values[0]);
      return identity ? [{ cognito_sub: identity.sub }] : [];
    }
    if (/from config_pending_approvals where id = \$1::uuid/.test(sql))
      return [row("pending")];
    if (/update config_pending_approvals\s+set status = \$2/.test(sql))
      return [row("approved")];
    // The system's withdrawal finds the approved row (round 16, item 3).
    if (/update config_pending_approvals/.test(sql) && /'rejected'/.test(sql))
      return [{ id: ID }];
    if (/update config_pending_approvals/.test(sql)) return [];
    return undefined;
  };
});

describe("a config approval whose apply fails (round 15, P-1)", () => {
  it("applies when the write does (the harness)", async () => {
    const res = await approve();
    expect(res.status).toBe(200);
    expect(writes).toEqual([50]);
  });

  it("a lost commit: 503 admin.write_indeterminate, left approved and unapplied — never reopened", async () => {
    writeAnswer = "indeterminate";
    const res = await approve();
    expect({ status: res.status, code: (await res.json()).code }).toEqual({
      status: 503,
      code: "admin.write_indeterminate",
    });
    expect(after().filter((s) => /status = 'pending'/.test(s))).toEqual([]);
    expect(after().filter((s) => /status = 'rejected'/.test(s))).toEqual([]);
  });

  it("a value its entry refuses: 422 admin.config_invalid_value with the reason, withdrawn", async () => {
    writeAnswer = "refused";
    const res = await approve();
    const body = await res.json();
    expect({ status: res.status, code: body.code, params: body.params }).toEqual({
      status: 422,
      code: "admin.config_invalid_value",
      params: { key: NUMBER_KEY, reason: "above_max", max: 10 },
    });
    expect(after().filter((s) => /status = 'rejected'/.test(s))).toHaveLength(1);
    expect(after().filter((s) => /status = 'pending'/.test(s))).toEqual([]);
  });

  it("the audit log unavailable: 503 service.unavailable {audit}, reopened", async () => {
    writeAnswer = "audit";
    const res = await approve();
    const body = await res.json();
    expect({ status: res.status, code: body.code, params: body.params }).toEqual({
      status: 503,
      code: "service.unavailable",
      params: { service: "audit" },
    });
    expect(after().filter((s) => /status = 'pending'/.test(s))).toHaveLength(1);
  });

  it("an uncoded failure: 500 admin.action_failed, reopened, its text never answered", async () => {
    writeAnswer = "failed";
    const res = await approve();
    const text = await res.text();
    expect({ status: res.status, code: JSON.parse(text).code }).toEqual({
      status: 500,
      code: "admin.action_failed",
    });
    expect(text).not.toContain("secret_internal");
    expect(after().filter((s) => /status = 'pending'/.test(s))).toHaveLength(1);
  });
});

describe("the config assistant's approve_change answers the same (round 15, P-1)", () => {
  const approveChange = () =>
    configAi(
      new NextRequest("http://localhost/api/admin/config-ai/execute", {
        method: "POST",
        body: JSON.stringify({
          toolId: "approve_change",
          input: { approvalId: ID, reviewComment: "ok" },
        }),
        headers: { "content-type": "application/json", ...authAs("safety_approver") },
      })
    );

  it.each([
    ["indeterminate", 503, "admin.write_indeterminate"],
    ["refused", 422, "admin.config_invalid_value"],
    ["audit", 503, "service.unavailable"],
    ["failed", 500, "admin.action_failed"],
  ] as const)("%s: %i %s", async (answer, status, code) => {
    writeAnswer = answer;
    const res = await approveChange();
    const text = await res.text();
    expect({ status: res.status, code: JSON.parse(text).code }).toEqual({ status, code });
    expect(text).not.toContain("secret_internal");
  });
});

describe("the screen is told what became of the approval (round 16, items 3 and 4)", () => {
  /** The statement that withdrew it, and its values. */
  const withdrawal = () =>
    fakeData().statements.find(
      (st) => /update config_pending_approvals/.test(st.sql) && /'rejected'/.test(st.sql)
    );

  it.each([
    ["refused", "refused"],
    ["stale", "stale"],
  ] as const)(
    "%s: withdrawn by the system — recorded in the same transaction — and said so",
    async (answer, reason) => {
      writeAnswer = answer;
      const res = await approve();
      const body = await res.json();
      expect(body.withdrawn).toBe(true);
      expect(body.settling).toBeUndefined();
      // Not the approver's rejection: no reviewer on the row, the system named in its note.
      expect(withdrawal()?.sql).toMatch(/reviewed_by = null/);
      // The system's record, a catalog key and values (TASK-209: it was English), worded so.
      const record = JSON.parse(String(withdrawal()?.values[1]));
      expect(record).toMatchObject({
        key: "screens.records.config_withdrawn",
        params: {
          why: { key: `screens.records.config_${reason}`, params: { key: NUMBER_KEY } },
          approvedBy: CALLERS.safety_approver.userId,
        },
      });
      expect(renderShown(record)).toMatch(
        new RegExp(
          `^withdrawn by the system: ${reason} — "${NUMBER_KEY.replace(/\./g, "\\.")}"`
        )
      );
      const records = fakeData()
        .audit.map((a) => a.details as Record<string, unknown>)
        .filter((d) => d.type === "approval_withdrawn");
      expect(records).toEqual([
        expect.objectContaining({
          reason,
          source: "config-approval",
          holdIds: [ID],
          key: NUMBER_KEY,
          approvedBy: CALLERS.safety_approver.userId,
        }),
      ]);
    }
  );

  it("the withdrawal not written: nothing withdrawn — left to settle, and said so", async () => {
    writeAnswer = "refused";
    const prev = fakeData().answer;
    fakeData().answer = (sql, values) => {
      if (/update config_pending_approvals/.test(sql) && /'rejected'/.test(sql))
        throw new Error("connection reset");
      return prev(sql, values);
    };
    const res = await approve();
    const body = await res.json();
    expect(body.withdrawn).toBeUndefined();
    expect(body.settling).toBe(true);
    expect(
      fakeData().audit.filter((a) => a.details.type === "approval_withdrawn")
    ).toEqual([]);
  });

  // Round 22, I-1: stale, its withdrawal not written — left settling, with the bound. The screen
  // says it is listed again then, and to reject it then — never "if it is still listed" (it is not
  // listed while it settles).
  it("stale, the withdrawal not written: settling with the bound, and the screen says when", async () => {
    writeAnswer = "stale";
    const prev = fakeData().answer;
    fakeData().answer = (sql, values) => {
      if (/update config_pending_approvals/.test(sql) && /'rejected'/.test(sql))
        throw new Error("connection reset");
      return prev(sql, values);
    };
    const res = await approve();
    const body = await res.clone().json();
    expect(body).toMatchObject({
      code: "approvals.stale",
      settling: true,
      settlesWithinMinutes: 75,
    });
    expect(body.withdrawn).toBeUndefined();
    const text = refusedDecisionText("update_config", await readRefusal(res), body);
    expect(text).toMatch(/listed again within 75 minutes; reject it then/);
    expect(text).not.toMatch(/still listed/);
  });

  it("a lost commit: settling, with the bound — the lease, the job's interval and a tick", async () => {
    writeAnswer = "indeterminate";
    const res = await approve();
    const body = await res.json();
    expect(body).toMatchObject({
      code: "admin.write_indeterminate",
      settling: true,
      // APPLY_LEASE_SECONDS (10 min) + config.expire-approvals' interval (60) + a tick (5).
      settlesWithinMinutes: 75,
    });
  });
});

describe("round 17: a lost commit's records and bound, on every path", () => {
  // I-5: the decision's own record of a lost commit is indeterminate, never failed.
  it("the config path's approval_decision is attempted, then indeterminate", async () => {
    writeAnswer = "indeterminate";
    await approve();
    const outcomes = fakeData()
      .audit.map((a) => a.details as Record<string, unknown>)
      .filter((d) => d.type === "approval_decision")
      .map((d) => d.outcome);
    expect(outcomes).toEqual(["attempted", "indeterminate"]);
  });

  // Nit 6: the config assistant's approve_change carries the same bound.
  it("approve_change carries the bound", async () => {
    writeAnswer = "indeterminate";
    const res = await configAi(
      new NextRequest("http://localhost/api/admin/config-ai/execute", {
        method: "POST",
        body: JSON.stringify({
          toolId: "approve_change",
          input: { approvalId: ID, reviewComment: "ok" },
        }),
        headers: { "content-type": "application/json", ...authAs("safety_approver") },
      })
    );
    expect((await res.json()).data).toMatchObject({
      settling: true,
      settlesWithinMinutes: 75,
    });
  });
});
