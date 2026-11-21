/**
 * @jest-environment node
 */
/**
 * An erased account's address is replaced only where it is the whole value (review 8 H-C)
 *
 * The reviewer's proof: the soft delete replaced the address as a substring of the document's
 * text, so ann@corp.example's erasure turned another account's held proposal naming
 * joann@corp.example into "jo<ann's id>" — and the hard purge then deleted that proposal as one
 * about ann. Now only a JSON string value equal to the address (ignoring case) is replaced, at any
 * depth; near misses — a prefix, a suffix, a plus-address, the address inside a longer text —
 * are other addresses (or other people's writing) and stay as they were, through the purge.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { withOwnerTx, withTenantTx } from "@/platform/data";
import { hardPurgeUser, softDeleteUser } from "@/platform/auth/gdpr-deletion";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  DB_ENABLED,
  type TestTenant,
} from "../helpers/db";

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

/** Values that are NOT ann@corp.example: each must survive her erasure untouched. */
const NEAR_MISSES = [
  "joann@corp.example", // prefix
  "ann@corp.example.org", // suffix
  "ann+x@corp.example", // plus-addressing
  "write to ann@corp.example today", // inside a longer text
  "xann@corp.example",
];

async function accounts() {
  const ann = await t.user("ann");
  const jo = await t.user("joann");
  await withOwnerTx("tenant-lifecycle", (tx) =>
    tx.query(
      "update users set email = case when id = $1::uuid then 'ann@corp.example' else 'joann@corp.example' end where id in ($1::uuid, $2::uuid)",
      [ann, jo]
    )
  );
  return { ann, jo };
}

async function propose(op: string, payload: unknown, status = "proposed") {
  await sql(
    `insert into proposals (operation_id, session_id, trajectory_id, label, actor_id, actor_role, effective_risk, payload, status)
     values ($1, 's', 't', 'change_user_role', 'command-bar', 'agent', 'restricted', $2::jsonb, $3)`,
    [op, typeof payload === "string" ? payload : JSON.stringify(payload), status]
  );
}

dbDescribe("review 8 H-C: an erased account's address, replaced exactly", () => {
  it("the reviewer's proof: another account's held proposal is neither corrupted nor deleted", async () => {
    const { ann } = await accounts();
    await propose("op-jo", { user_identifier: "joann@corp.example", role: "admin" });
    await t.run(() => softDeleteUser(ann, ann));
    const after = await sql("select payload from proposals where operation_id = 'op-jo'");
    expect(after[0]).toEqual({
      payload: { user_identifier: "joann@corp.example", role: "admin" },
    });
    await t.run(() => hardPurgeUser(ann));
    expect(
      await sql("select payload from proposals where operation_id = 'op-jo'")
    ).toEqual(after);
  });

  it("every near miss stays, in proposals and runs, through the soft delete and the purge", async () => {
    const { ann } = await accounts();
    for (const [i, value] of NEAR_MISSES.entries()) {
      await propose(`near-${i}`, { user_identifier: value, nested: [{ who: value }] });
      await sql(
        `with run as (
           insert into agent_trajectories (trigger, subject_kind, subject_id, scope_type, scope_id)
           values ('near-' || $2::text, 'agent', 'a', 'group', 'g') returning tenant_id, id)
         insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step)
         select run.tenant_id, run.id, 0, jsonb_build_object('input', jsonb_build_object('email', $1::text)) from run`,
        [value, String(i)]
      );
    }
    await t.run(() => softDeleteUser(ann, ann));
    await t.run(() => hardPurgeUser(ann));
    const proposals = await sql(
      "select operation_id, payload from proposals where operation_id like 'near-%' order by operation_id"
    );
    expect(
      proposals.map((r) => (r.payload as { user_identifier: string }).user_identifier)
    ).toEqual(NEAR_MISSES);
    expect(
      proposals.map((r) => (r.payload as { nested: { who: string }[] }).nested[0].who)
    ).toEqual(NEAR_MISSES);
    const runs = await sql(
      "select s.step->'input'->>'email' as email from agent_trajectories a join agent_trajectory_steps s on s.trajectory_id = a.id and s.seq = 0 where a.trigger like 'near-%' order by a.trigger"
    );
    expect(runs.map((r) => r.email)).toEqual(NEAR_MISSES);
  });

  it("the address itself, in any case and at any depth, becomes the id — so the purge finds it", async () => {
    const { ann } = await accounts();
    await propose("exact", { user_identifier: "ann@corp.example" });
    await propose("upper", { user_identifier: "ANN@Corp.Example" });
    await propose("deep", { targets: [{ user: { email: "Ann@corp.example" } }] });
    await propose("decided", { user_identifier: "ann@corp.example" }, "executed");
    // A run's step, a row (migration 076, TASK-230).
    await sql(
      `with run as (
         insert into agent_trajectories (trigger, subject_kind, subject_id, scope_type, scope_id)
         values ('exact', 'agent', 'a', 'group', 'g') returning tenant_id, id)
       insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step)
       select run.tenant_id, run.id, 0, '{"input": {"email": "ANN@corp.example"}}'::jsonb from run`
    );
    await t.run(() => softDeleteUser(ann, ann));
    const soft = await sql(
      "select operation_id, payload from proposals where operation_id in ('exact', 'upper', 'deep') order by operation_id"
    );
    expect(soft).toEqual([
      { operation_id: "deep", payload: { targets: [{ user: { email: ann } }] } },
      { operation_id: "exact", payload: { user_identifier: ann } },
      { operation_id: "upper", payload: { user_identifier: ann } },
    ]);
    expect(
      await sql(
        "select (select coalesce(jsonb_agg(s.step order by s.seq), '[]'::jsonb) from agent_trajectory_steps s where s.tenant_id = a.tenant_id and s.trajectory_id = a.id) as steps from agent_trajectories a where a.trigger = 'exact'"
      )
    ).toEqual([{ steps: [{ input: { email: ann } }] }]);

    await t.run(() => hardPurgeUser(ann));
    // Held actions about her go; the decided one stands with her id replaced; the run stands.
    expect(
      await sql("select operation_id, payload from proposals order by operation_id")
    ).toEqual([{ operation_id: "decided", payload: { user_identifier: "erased" } }]);
    expect(
      await sql(
        "select (select coalesce(jsonb_agg(s.step order by s.seq), '[]'::jsonb) from agent_trajectory_steps s where s.tenant_id = a.tenant_id and s.trajectory_id = a.id) as steps from agent_trajectories a where a.trigger = 'exact'"
      )
    ).toEqual([{ steps: [{ input: { email: "erased" } }] }]);
  });

  // Review 9 L7: a key equal to the address is replaced too (it survived erasure before).
  it("a key equal to the address is replaced; numbers and other kinds of value are left as they were", async () => {
    const { ann } = await accounts();
    // Raw JSON: a number beyond JavaScript's precision is kept exactly (the walk is in SQL).
    await propose(
      "shape",
      '{"ann@corp.example": 1, "n": 1.5, "big": 12345678901234567890, "flag": true, "none": null}'
    );
    await t.run(() => softDeleteUser(ann, ann));
    const [row] = await sql(
      "select payload::text as p from proposals where operation_id = 'shape'"
    );
    expect(row.p).toBe(
      `{"n": 1.5, "big": 12345678901234567890, "flag": true, "none": null, "${ann}": 1}`
    );
  });
});
