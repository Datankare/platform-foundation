/**
 * @jest-environment node
 */
/**
 * The operator step for accounts erased before v6.0.0 (review 8 L1):
 * supabase/optional/redact_orphan_addresses.sql, run as documented in docs/MIGRATION_v5_to_v6.md.
 *
 * An account soft-deleted by an earlier version had its address nulled without the replacement
 * the soft delete now makes, and the address is recorded nowhere, so the purge cannot find its
 * mentions. The step lists every whole-value address that is no live account's, and redacts each
 * — whole values only, in its own tenant — and is idempotent.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withOwnerTx, withTenantTx } from "@/platform/data";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  DB_ENABLED,
  type TestTenant,
} from "../helpers/db";

const FILE = readFileSync(
  join(process.cwd(), "supabase/optional/redact_orphan_addresses.sql"),
  "utf8"
);
const LIST = FILE.slice(FILE.indexOf("-- @step list"), FILE.indexOf("-- ── Step 2"));
const REDACT = FILE.slice(FILE.indexOf("-- @step redact"));
/** The redaction for one tenant (tests run beside others' tenants in one database). */
const redactIn = (tenant: string) => {
  const scoped = REDACT.replace(
    "only_tenant constant uuid := null;",
    `only_tenant constant uuid := '${tenant}';`
  );
  expect(scoped).not.toBe(REDACT);
  return scoped;
};

let t: TestTenant;
if (DB_ENABLED) {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });
  beforeEach(async () => {
    t = await createTestTenant();
  });
}
const sql = (text: string, values: unknown[] = []) =>
  t.run(() => withTenantTx(async (tx) => (await tx.query(text, values)).rows));
const listed = async () =>
  (
    await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query<{ tenant_id: string; address: string }>(LIST)
    )
  ).rows
    .filter((r) => r.tenant_id === t.id)
    .map((r) => r.address);

dbDescribe("review 8 L1: addresses of accounts erased before v6.0.0", () => {
  it("lists only addresses of no live account, redacts each as a whole value, and is idempotent", async () => {
    const live = await t.user("live");
    const gone = await t.user("gone");
    await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query(
        `update users set email = case when id = $1::uuid then 'live@corp.example' else null end,
                deleted_at = case when id = $2::uuid then now() else null end
          where id in ($1::uuid, $2::uuid)`,
        [live, gone]
      )
    );
    // What an earlier version left: the erased account's address, in a held action and a run.
    for (const [op, who] of [
      ["about-gone", "Gone@Corp.Example"],
      ["about-live", "live@corp.example"],
      ["text", "write to gone@corp.example"],
    ])
      await sql(
        `insert into proposals (operation_id, session_id, trajectory_id, label, actor_id, actor_role, effective_risk, payload, status)
         values ($1, 's', 't', 'change_user_role', 'command-bar', 'agent', 'restricted', jsonb_build_object('user_identifier', $2::text), 'executed')`,
        [op, who]
      );
    await sql(
      `insert into agent_trajectories (trigger, subject_kind, subject_id, scope_type, scope_id, steps)
       values ('r', 'agent', 'a', 'group', 'g', '[{"input": {"email": "gone@corp.example"}}]'::jsonb)`
    );

    expect(await listed()).toEqual(["gone@corp.example"]);
    await withOwnerTx("tenant-lifecycle", (tx) => tx.query(redactIn(t.id)));

    expect(
      await sql("select operation_id, payload from proposals order by operation_id")
    ).toEqual([
      { operation_id: "about-gone", payload: { user_identifier: "erased" } },
      { operation_id: "about-live", payload: { user_identifier: "live@corp.example" } },
      {
        operation_id: "text",
        payload: { user_identifier: "write to gone@corp.example" },
      },
    ]);
    expect(await sql("select steps from agent_trajectories")).toEqual([
      { steps: [{ input: { email: "erased" } }] },
    ]);
    expect(await listed()).toEqual([]);
    await withOwnerTx("tenant-lifecycle", (tx) => tx.query(redactIn(t.id)));
    expect(await listed()).toEqual([]);
  });
});
