/**
 * __tests__/held-summary.test.ts — every account-targeting held action names its target, and
 * the approvals list shows only the allowlisted summary (TASK-194 round 1, A1, A3)
 *
 * An approver saw a held erasure's label, never whose account it erased (A1), and decideApproval
 * could not tell an approver acting on their own account (A3). ACCOUNT_TARGET_FIELD names the
 * input field each account-targeting action carries its account in; a tool whose schema names a
 * user field not registered there fails here. The summary is built from an allowlist: a payload
 * field outside it never reaches the list.
 */

jest.mock("@/platform/data", () => {
  const rows: Record<string, unknown> = {
    "11111111-1111-4111-8111-111111111111": {
      id: "11111111-1111-4111-8111-111111111111",
      email: "target@example.test",
      role_id: "r-free",
    },
  };
  return {
    withTenantTx: async (fn: (tx: unknown) => unknown) =>
      fn({
        query: async (_sql: string, [v]: [string]) => ({
          rows: rows[v]
            ? [rows[v]]
            : v === "target@example.test"
              ? [rows["11111111-1111-4111-8111-111111111111"]]
              : [],
        }),
      }),
  };
});
jest.mock("@/platform/auth/role-lookup", () => ({
  findRole: async () => ({ id: "r-free", name: "free", permissions: [] }),
}));

import {
  ACCOUNT_TARGET_FIELD,
  heldActionSummary,
  heldTargetAccount,
} from "@/app/api/admin/ai/held-summary";
import { PANEL_TOOL_SCHEMAS, SHARED_TOOLS } from "@/app/api/admin/ai/tool-schemas";

const ID = "11111111-1111-4111-8111-111111111111";
const USER_FIELD = /^(?:user_?id|user_identifier|target_user|account_?id)$/i;

describe("held actions name their account (round 1, A1/A3)", () => {
  const tools = [...SHARED_TOOLS, ...Object.values(PANEL_TOOL_SCHEMAS).flat()];

  it("finds the tool schemas (self-test)", () => {
    expect(tools.some((t) => t.name === "change_user_role")).toBe(true);
  });

  it("every tool whose schema names a user field registers it as its target", () => {
    const missing: string[] = [];
    for (const tool of tools) {
      const props = Object.keys(
        (tool.input_schema as { properties?: Record<string, unknown> }).properties ?? {}
      );
      for (const p of props.filter((k) => USER_FIELD.test(k))) {
        if ((ACCOUNT_TARGET_FIELD as Record<string, string>)[tool.name] !== p)
          missing.push(`${tool.name}.${p}`);
      }
    }
    expect(missing).toEqual([]);
    // The erasure has no schema (it is asked for through POST /api/admin/gdpr): registered by hand.
    expect(ACCOUNT_TARGET_FIELD.purge_user_data).toBe("userId");
  });

  it("resolves the target by id or address, and says when it names none or one not found", async () => {
    expect(await heldTargetAccount("purge_user_data", { userId: ID })).toMatchObject({
      id: ID,
    });
    expect(
      await heldTargetAccount("change_user_role", {
        user_identifier: "target@example.test",
      })
    ).toMatchObject({ id: ID, roleName: "free" });
    expect(await heldTargetAccount("create_role", { name: "x" })).toBeUndefined();
    expect(
      await heldTargetAccount("block_user_feature", { user_id: "nobody" })
    ).toBeNull();
    expect(await heldTargetAccount("block_user_feature", {})).toBeNull();
  });

  it("summarises only the allowlisted fields", async () => {
    const summary = await heldActionSummary("purge_user_data", {
      userId: ID,
      reason: "legal-order",
      dryRun: false,
      note: "an injected instruction for the approver",
      secret: "s",
    });
    expect(summary).toEqual({
      target: { id: ID, email: "target@example.test" },
      reason: "legal-order",
      dryRun: false,
    });
    expect(
      await heldActionSummary("change_user_role", {
        user_identifier: ID,
        new_role: "moderator",
        extra: "x",
      })
    ).toEqual({
      target: { id: ID, email: "target@example.test" },
      fromRole: "free",
      toRole: "moderator",
    });
    expect(
      await heldActionSummary("block_user_feature", {
        user_id: "nobody",
        feature: "translate",
      })
    ).toEqual({ target: { notFound: true }, feature: "translate" });
    expect(await heldActionSummary("create_role", { name: "x" })).toBeUndefined();
  });
});

// Round 12, I-2 (d); pre-existing 2: an approver of a held policy change saw only its label.
describe("a held approval-policy change shows its rules and default (round 12)", () => {
  it("lists each rule and the default approver — listed values only", async () => {
    expect(
      await heldActionSummary("set_approval_policy", {
        default_approver: "agent",
        rules: [
          { max_risk: "ordinary", required_approver: "agent" },
          {
            max_risk: "consequential",
            effects: ["externalCall", "free text"],
            required_approver: "<script>",
          },
        ],
      })
    ).toEqual({
      approvalPolicy: {
        rules: [
          { maxRisk: "ordinary", requiredApprover: "agent" },
          {
            maxRisk: "consequential",
            effects: ["externalCall", "?"],
            requiredApprover: "?",
          },
        ],
        defaultApprover: "agent",
      },
    });
  });

  it("says when the default is left as it is, and when there are no rules", async () => {
    expect(await heldActionSummary("set_approval_policy", { rules: [] })).toEqual({
      approvalPolicy: { rules: [] },
    });
  });
});
