/**
 * The command bar's reply to set_approval_policy comes from the catalog (round 14, item 11:
 * CLAUDE.md "every word on a screen comes from messages/").
 *
 * @not-guard: pins one handler's reply to the catalog by reading that one file; an instance check, not a scan
 */

import { readFileSync } from "fs";
import { join } from "path";

const setRules = jest.fn();
jest.mock("@/platform/agents", () => ({
  ...jest.requireActual("@/platform/agents"),
  getApprovalPolicyStore: () => ({ setRules }),
}));
jest.mock("@/app/api/admin/ai/handlers/shared", () => ({
  ...jest.requireActual("@/app/api/admin/ai/handlers/shared"),
  runAudited: (_entry: unknown, act: () => Promise<unknown>) => act(),
}));

import { handleSetApprovalPolicy } from "@/app/api/admin/ai/handlers/approval";
import { renderMessage } from "@/platform/errors/messages";
import { renderShown, type ShownText } from "@/platform/errors/shown-text";

const KEY = "screens.admin_console.results.approval_policy_updated";
const rule = { max_risk: "ordinary", required_approver: "agent" };

describe("set_approval_policy reply (round 14, item 11)", () => {
  it.each([
    [1, "1 rule"],
    [2, "2 rules"],
  ])("with %i rule(s) is the catalog's sentence", async (n, counted) => {
    setRules.mockResolvedValueOnce({ version: 7, default: "user", rules: [] });
    const res = await handleSetApprovalPolicy({ rules: Array(n).fill(rule) }, "admin-1");
    expect(res.success).toBe(true);
    expect(renderShown(res.result as ShownText)).toBe(
      renderMessage(KEY, { version: 7, rules: n })
    );
    expect(renderShown(res.result as ShownText)).toContain(`version 7, ${counted}`);
    expect(renderShown(res.result as ShownText)).toMatch(
      /approved by a person whatever these rules say/
    );
  });

  it("the handler holds no English sentence of its own", () => {
    const src = readFileSync(
      join(__dirname, "..", "app/api/admin/ai/handlers/approval.ts"),
      "utf8"
    );
    expect(src).not.toMatch(/Approval policy updated/);
    expect(src).toContain(`"${KEY}"`);
  });
});
