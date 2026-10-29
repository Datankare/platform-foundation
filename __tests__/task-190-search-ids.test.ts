/**
 * __tests__/task-190-search-ids.test.ts — A search result's `id` column is a data control
 * (TASK-190 round 1, S-L1)
 *
 * Round 1's security finder: ids were hidden only on the screen, so a moderator's browser still
 * received every row's id. Now the execute response carries a search's `id` column only for a
 * caller whose server-verified role is admin or super_admin (maySeeIds — requireAdmin's
 * `roleName`, the source GET /api/admin/session reports); for any other role it is left out, and
 * the result line never names a row by it. Only `id`: an audit entry's actor_id and target_id stay
 * (the Audit log page shows them). The recorded step keeps the rows' ids for every caller. Run
 * through runCommandBarAction (what the execute route calls), the tool's own execute and the real
 * search handler, against the fake data layer.
 */

jest.mock("@/platform/data", () => require("./helpers/fake-data").fakeDataModule());
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// The pipeline is not under test here: it runs the tool and returns what the step records.
jest.mock("@/platform/agents/tool-invoker", () => ({
  invokeTool: jest.fn(
    async ({ tool }: { tool: { execute: () => Promise<unknown> } }) => ({
      output: await tool.execute(),
    })
  ),
}));
jest.mock("@/platform/agents/trajectory-store", () => ({
  getTrajectoryStore: jest.fn(() => ({})),
}));
jest.mock("@/platform/agents/proposal-store", () => ({
  getProposalStore: jest.fn(() => ({})),
}));

import { fakeData } from "./helpers/fake-data";
import { invokeTool } from "@/platform/agents/tool-invoker";
import { runCommandBarAction } from "@/app/api/admin/ai/command-bar";
import {
  fitSearchRows,
  searchResultFor,
  searchSummary,
} from "@/app/api/admin/ai/handlers/search";
import { ID_DETAIL_ROLES, maySeeIds } from "@/app/api/admin/ai/search-filters";
import { SEARCHABLE_TABLES } from "@/app/api/admin/ai/tool-permissions";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";

const admin = (roleName: string): VerifiedAdmin => ({
  userId: "00000000-0000-4000-8000-0000000000ad",
  sub: "s",
  roleName,
  // Every table's permission: only the role decides the ids.
  permissions: [...new Set(Object.values(SEARCHABLE_TABLES))],
});

const A1 = "00000000-0000-4000-8000-0000000000a1";
const A2 = "00000000-0000-4000-8000-0000000000a2";
const USERS = [
  {
    id: A1,
    email: "a@x.test",
    display_name: "Alice",
    role: "Moderator",
    status: "active",
    status_until: null,
    email_verified: true,
    created_at: new Date("2026-10-29T09:15:00Z"),
    last_sign_in_at: null,
    total: 2,
  },
  { id: A2, email: "b@x.test", display_name: "Bee", role: "qa_lead", total: 2 },
];
const ACTOR = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const AUDIT = [
  {
    id: A1,
    action: "role_changed",
    actor_id: ACTOR,
    target_id: TARGET,
    created_at: new Date("2026-10-29T09:15:00Z"),
    total: 1,
  },
];

beforeEach(() => {
  fakeData().reset();
  (invokeTool as jest.Mock).mockClear();
  fakeData().answer = (sql) =>
    /from users u/.test(sql) ? USERS : /from audit_log/.test(sql) ? AUDIT : undefined;
});

async function run(roleName: string, input: Record<string, unknown>) {
  const outcome = await runCommandBarAction({
    tool: "search",
    input,
    admin: admin(roleName),
    trajectoryId: "t1",
    stepIndex: 0,
  });
  if (outcome.kind !== "ran") throw new Error("held");
  const step = await (invokeTool as jest.Mock).mock.results[0]!.value;
  return { result: outcome.result, step: step.output as { table: { ids: unknown[] } } };
}

describe("S-L1: the execute response carries `id` only for admin and super_admin", () => {
  it("the roles are the console's 'Show details' roles", () => {
    expect(ID_DETAIL_ROLES).toEqual(["admin", "super_admin"]);
    for (const r of [
      "moderator",
      "safety_approver",
      "free",
      "Admin",
      "",
      null,
      undefined,
    ])
      expect(maySeeIds(r as string)).toBe(false);
  });

  it.each(["admin", "super_admin"])("%s: the id column and every id", async (role) => {
    const { result, step } = await run(role, { table: "users" });
    expect(result.table?.columns[0]).toBe("id");
    expect(result.table?.rows.map((r) => r[0])).toEqual([A1, A2]);
    expect(step.table.ids).toEqual([A1, A2]);
  });

  it.each(["moderator", "safety_approver", "free"])(
    "%s: no id column, no id anywhere in the response; the step still records them",
    async (role) => {
      const { result, step } = await run(role, { table: "users" });
      expect(result.success).toBe(true);
      expect(result.table?.columns).not.toContain("id");
      expect(result.table?.columns[0]).toBe("email");
      expect(result.table?.rows[0]).toHaveLength(result.table!.columns.length);
      expect(result.table?.rows.map((r) => r[0])).toEqual(["a@x.test", "b@x.test"]);
      expect(JSON.stringify(result)).not.toContain(A1);
      expect(JSON.stringify(result)).not.toContain(A2);
      // The step is the audit trail: it keeps the rows' ids whoever ran the search.
      expect(step.table.ids).toEqual([A1, A2]);
    }
  );

  it("only `id`: an audit entry's actor_id and target_id stay for every role", async () => {
    const mod = await run("moderator", { table: "audit_log" });
    expect(mod.result.table?.columns).toEqual([
      "action",
      "actor_id",
      "target_id",
      "created_at",
    ]);
    expect(mod.result.table?.rows[0]).toEqual([
      "role_changed",
      ACTOR,
      TARGET,
      "2026-10-29T09:15:00.000Z",
    ]);
    (invokeTool as jest.Mock).mockClear();
    const adm = await run("admin", { table: "audit_log" });
    expect(adm.result.table?.columns).toEqual([
      "id",
      "action",
      "actor_id",
      "target_id",
      "created_at",
    ]);
  });

  it("a table without an id column, or a refusal, is returned as it is", () => {
    const config = {
      success: true,
      table: { table: "platform_config", columns: ["key", "value"], rows: [["k", "1"]] },
    };
    expect(searchResultFor(config, { roleName: "moderator" })).toBe(config);
    const refused = { success: false, error: "x" };
    expect(searchResultFor(refused, { roleName: "moderator" })).toBe(refused);
  });

  it("the result line names a row left out for size only to a caller who may see its id", () => {
    const rows = [
      [A1, "x".repeat(400)],
      [A2, "y"],
    ];
    const fitted = fitSearchRows(rows, ["id", "description"], 300);
    expect(fitted.omitted).toEqual([A1]);
    expect(searchSummary("roles", 2, fitted, 300)).toContain(A1);
    const hidden = searchSummary("roles", 2, fitted, 300, false);
    expect(hidden).not.toContain(A1);
    expect(hidden).toMatch(/1 row/);
  });
});
