/**
 * @jest-environment node
 */
/**
 * __tests__/db/erasure-steps.db.test.ts — today's erasure statements on a trajectory's steps,
 * re-pointed to step rows, erase what the document form erased, step for step (platform TASK-230,
 * ADR-059; design 56e-3b §2.5, T4; reviews TA-b-4, SA-6; confirmation C-8)
 *
 * What it refuses: a re-pointed erasure statement that leaves an id or an address the document form
 * removed, loses a member or a value, rewrites a step without moving its trajectory's version, or
 * leaves the counters off the rows
 *
 * The same fixtures — the design's p5 cases, 56e-3a's escape cases (an id after \u0006, \n, \\,
 * \", in capitals), a key collision split over two steps — are written twice: as rows (the real
 * schema, rewritten by the platform's own register statements as app_tenant) and as one document
 * per run in a scratch copy of the old table (rewritten by 56e-3a's statements, kept here as they
 * stood). The address rewrite numbers colliding keys within the value it is given — the whole run
 * before, each step now — so a key's `#n[-12 hex]` suffixes may differ (review TA-b-4); every
 * other thing is compared: each step's members (keys with their suffixes stripped), their count
 * and their values, and that nothing names the account or its address.
 */

import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { withTenantTx } from "@/platform/data";
import { ADDRESS_REPLACEMENTS } from "@/platform/auth/gdpr-deletion";
import { USER_DATA_TABLES } from "@/platform/auth/user-data";
import { AUDIT_TEXT_KEYS } from "@/platform/auth/audit-details";
import { PURGE_REASONS } from "@/platform/gdpr/types";
import { NOTE_ERASED } from "@/platform/errors/recorded-text";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";

// ── 56e-3a's document form (platform/auth/user-data.ts and gdpr-deletion.ts as they stood before
//    TASK-230), the comparison's reference. Built from the same constants.
const TEXT = `array[${AUDIT_TEXT_KEYS.map((k) => `'${k}'`).join(", ")}]`;
const REASONS = `array[${PURGE_REASONS.map((r) => `'${r}'`).join(", ")}]::text[]`;
const NOTE = `jsonb_build_object('key', '${NOTE_ERASED.key}')`;
const LIKE = `'%' || replace(replace(replace($1::text, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'`;
const KEYS = `(case when s.step->>'action' = 'purge_user_data' and s.step->'input'->>'reason' = any(${REASONS}) then array_remove(${TEXT}, 'reason') else ${TEXT} end)`;
const SOLE = `(select id from app_sessions where meta->'participants' @> jsonb_build_array(jsonb_build_object('actorId', $1::text)) and jsonb_array_length(meta->'participants') = 1)`;
const HELD_P = `(select p.id::text from proposals p where p.trajectory_id = a.id::text and jsonb_path_exists(p.payload, '$.** ? (@ == $u)', jsonb_build_object('u', $1::text)))`;
const DOC = {
  soft: "update agent_trajectories set steps = jsonb_erase_address_text(steps, $1::text, $2::text) where jsonb_may_mention_text(steps, $1::text)",
  held: `update agent_trajectories a set steps = (select coalesce(jsonb_agg(case when s.step->'output' ? 'note' and s.step->>'proposalId' in ${HELD_P} then jsonb_set(s.step, '{output,note}', ${NOTE}) else s.step end order by s.n), '[]'::jsonb) from jsonb_array_elements(a.steps) with ordinality as s(step, n)) where jsonb_typeof(a.steps) = 'array' and exists (select 1 from jsonb_array_elements(a.steps) s(step) where s.step->'output' ? 'note' and s.step->>'proposalId' in ${HELD_P})`,
  free: `update agent_trajectories a set steps = (select coalesce(jsonb_agg(case when jsonb_typeof(s.step->'input') = 'object' and jsonb_path_exists(s.step->'input', '$.** ? (@ == $u)', jsonb_build_object('u', $1::text)) and (s.step->'input') ?| ${KEYS} then jsonb_set(s.step, '{input}', (s.step->'input') - ${KEYS}) else s.step end order by s.n), '[]'::jsonb) from jsonb_array_elements(a.steps) with ordinality as s(step, n)) where jsonb_typeof(a.steps) = 'array' and a.steps::text ilike ${LIKE}`,
  move: `update agent_trajectories a set steps = (select coalesce(jsonb_agg(case when s.step->'actor'->>'actorId' = $1::text then s.step || jsonb_build_object('input', '{}'::jsonb, 'output', '{}'::jsonb) else s.step end order by s.n), '[]'::jsonb) from jsonb_array_elements(a.steps) with ordinality as s(step, n)) where a.subject_kind = 'session' and jsonb_typeof(a.steps) = 'array' and a.steps @> jsonb_build_array(jsonb_build_object('actor', jsonb_build_object('actorId', $1::text)))`,
  ids: `update agent_trajectories set steps = jsonb_erase_id_text(steps, $1::text), scope_id = case when scope_id = $1::text then 'erased' else scope_id end where (steps::text ilike ${LIKE} or scope_id = $1::text) and (steps::text ~* $1::text or scope_id = $1::text) and not coalesce(scope_type = 'user' and scope_id = $1, false) and not (subject_kind = 'session' and subject_id in ${SOLE})`,
};

const entry = (name: string) => USER_DATA_TABLES.find((e) => e.name === name)!.erase;
const ROWS_SOFT = ADDRESS_REPLACEMENTS.find((s) => s.includes("agent_trajectory_steps"))!;

/** A value with every object's keys stripped of their `#n` / `-<12 hex>` suffixes, as a multiset. */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object")
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => [k.replace(/(#\d+(-[0-9a-f]{12})?)+$/, ""), canon(x)] as const)
      .map((p) => JSON.stringify(p))
      .sort();
  return v;
}

/** Every member of every object, counted (keys with their numbering, so a merge shows). */
function members(v: unknown): number {
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + members(x), 0);
  if (v && typeof v === "object")
    return Object.values(v as Record<string, unknown>).reduce(
      (n: number, x) => n + 1 + members(x),
      0
    );
  return 0;
}

dbDescribe(
  "T4: the erasure on step rows erases what the document form did (TASK-230)",
  () => {
    let t: TestTenant;
    let owner: Client;
    let doc: Client;
    let schema: string;
    const U = "aaaaaaaa-0000-4000-8000-00000000000" + "1";
    const U1 = U.slice(1);
    const ADDRESS = "ann@x.com";
    let run1: string;
    let run2: string;
    let held: string;

    const steps1 = () => [
      {
        action: "change_user_role",
        input: { userId: U, reason: "because ann asked", q: 1 },
        proposalId: held,
        output: { note: "about ann" },
      },
      { output: { msg: ADDRESS, [ADDRESS]: 1, [U]: 2, erased: 3 } },
      { x: `see ${U} here`, to: ADDRESS.toUpperCase() },
      {
        action: "purge_user_data",
        input: { userId: U, reason: "user-request", note: "n" },
      },
      {
        e1: `\u0006${U1}`,
        e2: `\n${U}`,
        e3: "\\" + U,
        e4: `"${U}`,
        e5: `\u0006${U}`,
        e6: U.toUpperCase(),
        [`\u0006${U1}`]: 1,
      },
      { erased: 1, [U]: 2 },
      { [U]: 3, [ADDRESS]: 4 },
    ];
    const steps2 = () => [
      { actor: { actorId: U }, input: { m: 1 }, output: { r: 2 } },
      { actor: { actorId: "v-other" }, input: { m: 3 }, output: { by: U } },
    ];

    beforeAll(async () => {
      await connectTestDatabase();
      owner = new Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
      await owner.connect();
      t = await createTestTenant();
      run1 = randomUUID();
      run2 = randomUUID();
      held = randomUUID();
      await owner.query(
        `insert into app_sessions (tenant_id, id, meta, state)
       values ($1::uuid, 'sess-shared-' || $1::text,
               jsonb_build_object('participants', jsonb_build_array(jsonb_build_object('actorId', $2::text), jsonb_build_object('actorId', 'v-other'))), '{}')`,
        [t.id, U]
      );
      await owner.query(
        `insert into proposals (id, tenant_id, operation_id, session_id, trajectory_id, label, status, actor_id, actor_role, effective_risk, payload)
       values ($1::uuid, $2::uuid, 'op-t4', 's1', $3, 'change_user_role', 'executed', 'admin-1', 'admin', 'low', jsonb_build_object('userId', $4::text))`,
        [held, t.id, run1, U]
      );
      // The rows.
      for (const [id, kind, subject, steps] of [
        [run1, "agent", "a1", steps1()],
        [run2, "session", `sess-shared-${t.id}`, steps2()],
      ] as const) {
        await owner.query(
          `insert into agent_trajectories (id, tenant_id, trigger, subject_kind, subject_id)
         values ($1::uuid, $2::uuid, 't', $3, $4)`,
          [id, t.id, kind, subject]
        );
        await owner.query(
          `insert into agent_trajectory_steps (tenant_id, trajectory_id, seq, step)
         select $1::uuid, $2::uuid, e.n - 1, e.s from jsonb_array_elements($3::jsonb) with ordinality e(s, n) order by e.n`,
          [t.id, id, JSON.stringify(steps)]
        );
      }
      // The document form, in a scratch copy of the old table (search_path puts it first).
      schema = `t4doc_${t.id.replace(/-/g, "").slice(0, 12)}`;
      await owner.query(`create schema ${schema}`);
      await owner.query(
        `create table ${schema}.agent_trajectories (tenant_id uuid, id uuid, subject_kind text, subject_id text, scope_type text, scope_id text, steps jsonb)`
      );
      await owner.query(
        `insert into ${schema}.agent_trajectories (tenant_id, id, subject_kind, subject_id, scope_type, scope_id, steps)
       values ($1::uuid, $2::uuid, 'agent', 'a1', 'platform', null, $4::jsonb),
              ($1::uuid, $3::uuid, 'session', 'sess-shared-' || $1::text, 'platform', null, $5::jsonb)`,
        [t.id, run1, run2, JSON.stringify(steps1()), JSON.stringify(steps2())]
      );
      doc = new Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
      await doc.connect();
      await doc.query(`set search_path to ${schema}, public`);
    });

    afterAll(async () => {
      await doc.end();
      await owner.query(`drop schema if exists ${schema} cascade`);
      await owner.end();
      await dropTestTenants();
      await disconnectTestDatabase();
    });

    it("the fixture is the same in both forms before", async () => {
      const rows = await owner.query(
        "select trajectory_id::text as id, seq, step from agent_trajectory_steps where tenant_id = $1::uuid order by 1, 2",
        [t.id]
      );
      const docs = await doc.query(
        "select id::text as id, n - 1 as seq, s as step from agent_trajectories, jsonb_array_elements(steps) with ordinality e(s, n) order by 1, 2"
      );
      expect(rows.rows).toEqual(docs.rows.map((r) => ({ ...r, seq: Number(r.seq) })));
    });

    it("the soft delete, then the purge's four step statements: the same members, values, nothing left", async () => {
      const versions = async () =>
        Object.fromEntries(
          (
            await owner.query(
              "select id::text as id, version from agent_trajectories where id = any($1::uuid[])",
              [[run1, run2]]
            )
          ).rows.map((r) => [r.id, Number(r.version)])
        );
      const before = await versions();
      // Rows: the platform's own statements, as app_tenant in the tenant.
      await t.run(() => withTenantTx((tx) => tx.query(ROWS_SOFT, [ADDRESS, U])));
      const afterSoft = await versions();
      // (SA-6) a step rewrite moves its trajectory's version.
      expect(afterSoft[run1]).toBeGreaterThan(before[run1]);
      expect(afterSoft[run2]).toBe(before[run2]);
      for (const name of [
        "heldAboutStepNotes",
        "stepFreeText",
        "sessionMoveText",
        "trajectorySteps",
        "trajectoryScopes",
      ])
        await t.run(() => withTenantTx((tx) => tx.query(entry(name), [U])));
      expect((await versions())[run2]).toBeGreaterThan(afterSoft[run2]);
      // Document: 56e-3a's statements.
      await doc.query(DOC.soft, [ADDRESS, U]);
      for (const st of [DOC.held, DOC.free, DOC.move, DOC.ids]) await doc.query(st, [U]);

      const rows = (
        await owner.query(
          "select trajectory_id::text as id, seq, step, step::text as text from agent_trajectory_steps where tenant_id = $1::uuid order by 1, 2",
          [t.id]
        )
      ).rows;
      const docs = (
        await doc.query(
          "select id::text as id, n - 1 as seq, s as step, s::text as text from agent_trajectories, jsonb_array_elements(steps) with ordinality e(s, n) order by 1, 2"
        )
      ).rows;
      expect(rows.map((r) => [r.id, r.seq])).toEqual(
        docs.map((r) => [r.id, Number(r.seq)])
      );
      for (let i = 0; i < rows.length; i++) {
        const where = `${rows[i].id === run1 ? "run 1" : "run 2"}, step ${rows[i].seq}`;
        expect([where, members(rows[i].step)]).toEqual([where, members(docs[i].step)]);
        expect([where, canon(rows[i].step)]).toEqual([where, canon(docs[i].step)]);
        // Nothing names the account or its address — in either form.
        for (const r of [rows[i], docs[i]]) {
          expect([where, new RegExp(U, "i").test(r.text)]).toEqual([where, false]);
          expect([where, r.text.toLowerCase().includes(ADDRESS)]).toEqual([where, false]);
        }
      }
      // 56e-3a's escape cases: the fragment after \u0006 is not the id and stays as it was.
      const escapes = rows.find((r) => r.id === run1 && r.seq === 4)!.step as Record<
        string,
        string
      >;
      expect(escapes.e1).toBe(`\u0006${U1}`);
      expect(escapes[`\u0006${U1}`]).toBe(1 as unknown as string);
      expect([escapes.e2, escapes.e3, escapes.e4, escapes.e5, escapes.e6]).toEqual([
        "\nerased",
        "\\erased",
        '"erased',
        "\u0006erased",
        "erased",
      ]);
      // Counters equal the rows after every rewrite.
      const { rows: off } = await owner.query(
        `select t.id from agent_trajectories t
        where t.id = any($1::uuid[])
          and (t.step_count <> (select count(*) from agent_trajectory_steps s where s.trajectory_id = t.id)
               or t.steps_bytes <> (select coalesce(sum(octet_length(s.step::text)), 0) from agent_trajectory_steps s where s.trajectory_id = t.id))`,
        [[run1, run2]]
      );
      expect(off).toEqual([]);
    });

    it("(C-8) a key numbered twice in the document form and once in rows compares equal once stripped", () => {
      expect(canon({ [`erased#2#5-0123456789ab`]: 1 })).toEqual(canon({ "erased#1": 1 }));
      expect(canon({ erased: 1, "erased#1": 2 })).not.toEqual(canon({ erased: 1 }));
      expect(members({ a: { b: 1 }, c: [{ d: 2 }] })).toBe(4);
    });
  }
);
