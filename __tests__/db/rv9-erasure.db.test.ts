/**
 * @jest-environment node
 */
/**
 * Erasure cannot be blocked by a document, and replaces keys too (review 9 H2, L7)
 *
 * The reviewer's proofs (review9/__tests__/db/rv9-erasure.db.test.ts, rv9/jsonb-depth.sql):
 *   - jsonb_replace_text_value recursed, so another account's proposal nested ~520 deep exceeded
 *     the stack and failed the victim's whole erasure; a 200 000-element document took 4.1 s;
 *   - an address that is an object key ({"invited":{"ann@…":"pending"}}) survived the erasure.
 * Fixed: the function is non-recursive, linear and cannot fail on any jsonb value — proved here on
 * depth 10 000 and on 1 000 000 elements within a stated bound (the call's own time, measured in
 * the database: review 10 L11), and on a document too deep to read back in the caller's stack
 * (redacted to its own type: review 10 L7) — and it replaces a whole string that equals the
 * address as a value or as a key. Free text naming the address is out of scope (documented).
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
const owner = <R>(text: string, values: unknown[] = []) =>
  withOwnerTx(
    "tenant-lifecycle",
    async (tx) => (await tx.query(text, values)).rows as R[]
  );

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

/** One call of the function on a literal document, as text. */
async function replaceIn(
  doc: string,
  target: string,
  replacement = "ID"
): Promise<string> {
  const [row] = await owner<{ r: string }>(
    "select public.jsonb_replace_text_value($1::jsonb, $2::text, $3::text)::text as r",
    [doc, target, replacement]
  );
  return row.r;
}

dbDescribe("rv9 H2: erasure is not blocked by another row's document", () => {
  it.each([600, 10_000])(
    "another account's proposal nested %i deep: the erasure succeeds and replaces it",
    async (depth) => {
      const { ann } = await accounts();
      const deep =
        "[".repeat(depth) + JSON.stringify("ann@corp.example") + "]".repeat(depth);
      await propose("op-deep", deep);
      const r = await t.run(() => softDeleteUser(ann, ann));
      expect(r.success).toBe(true);
      const [user] = await sql("select deleted_at from users where id = $1::uuid", [ann]);
      expect(user.deleted_at).not.toBeNull();
      const [doc] = await sql(
        "select position('ann@corp.example' in payload::text) as at, position($1 in payload::text) as id from proposals where operation_id = 'op-deep'",
        [ann]
      );
      expect(doc).toEqual({ at: 0, id: expect.any(Number) });
      expect(doc.id).toBeGreaterThan(0);
    }
  );
});

/**
 * The function's own time, measured inside the database around the call only (review 10 L11:
 * a wall-clock bound around the round trip, and around generating the document, flaked on a
 * loaded runner). The document is built first, in the same transaction; the bound is generous —
 * an order of magnitude over what is measured — and the work itself is asserted exactly.
 */
async function timedReplace<R>(
  build: string,
  target: string,
  summary: string
): Promise<R & { ms: number }> {
  return withOwnerTx("tenant-lifecycle", async (tx) => {
    await tx.query(`create temp table rv9_doc on commit drop as select (${build}) as d`);
    await tx.query(
      `create or replace function pg_temp.rv9_timed(doc jsonb, target text, out ms float8, out o jsonb)
       language plpgsql as $f$
       declare s timestamptz;
       begin
         s := clock_timestamp();
         o := public.jsonb_replace_text_value(doc, target, 'ID');
         ms := extract(epoch from clock_timestamp() - s) * 1000;
       end $f$`
    );
    const { rows } = await tx.query(
      `select t.ms, ${summary} from rv9_doc, lateral pg_temp.rv9_timed(rv9_doc.d, $1::text) t`,
      [target]
    );
    // A temporary function outlives the transaction on a pooled connection: dropped here.
    await tx.query("drop function pg_temp.rv9_timed(jsonb, text)");
    return rows[0] as R & { ms: number };
  });
}

dbDescribe("rv9 H2: jsonb_replace_text_value cannot fail, in bounded time", () => {
  it("depth 10 000: replaced exactly; the call itself well under its bound (≤ 1 s; ~3 ms measured)", async () => {
    const d = 10_000;
    const row = await timedReplace<{ same: boolean }>(
      `(repeat('[', ${d}) || '"Ann@X.com"' || repeat(']', ${d}))::jsonb`,
      "ann@x.com",
      `t.o::text = repeat('[', ${d}) || '"ID"' || repeat(']', ${d}) as same`
    );
    expect(row.same).toBe(true);
    expect(row.ms).toBeLessThan(1_000);
  });

  it("1 000 000 elements: replaced exactly; the call itself within the stated bound (≤ 30 s; ~3 s measured)", async () => {
    const row = await timedReplace<{ n: number; hits: number; left: number }>(
      `select jsonb_agg(case when i % 1000 = 0 then 'ann@x.com' else 'x' || i end)
         from generate_series(1, 1000000) i`,
      "ann@x.com",
      `jsonb_array_length(t.o) as n,
       (select count(*) from jsonb_array_elements_text(t.o) e where e = 'ID')::int as hits,
       position('ann@x.com' in t.o::text) as left`
    );
    expect({ n: row.n, hits: row.hits, left: row.left }).toEqual({
      n: 1_000_000,
      hits: 1_000,
      left: 0,
    });
    expect(row.ms).toBeLessThan(30_000);
  }, 120_000);

  it("a document too deep to read back in this stack keeps its type and its content: wrapped with a marker, never an error (review 10 L7, review 11 L-2)", async () => {
    // The stack shrunk under the document's own depth: reading the result back must fail here,
    // and the function still answers — the address gone, the value still an array (an object),
    // and its whole content kept, as its text with the address replaced (review 11 L-2: it was
    // replaced by the marker alone, wiping a whole audit record or a whole run's steps).
    const rows = await withOwnerTx("tenant-lifecycle", async (tx) => {
      await tx.query(
        "create temp table rv9_deep on commit drop as select (repeat('[', 10000) || '\"ann@x.com\"' || repeat(']', 10000))::jsonb as d, (repeat('{\"a\": ', 10000) || '\"ann@x.com\"' || repeat('}', 10000))::jsonb as o"
      );
      await tx.query("set local max_stack_depth = '200kB'");
      return (
        await tx.query(
          `select jsonb_typeof(r) as kind, position('ann@x.com' in r::text) as at,
                  jsonb_array_length(r) as n, r->>0 as marker,
                  r->>1 = (repeat('[', 10000) || '"ID"' || repeat(']', 10000)) as kept,
                  jsonb_typeof(ro) as okind, position('ann@x.com' in ro::text) as oat,
                  ro->>'_redacted' as omarker,
                  ro->>'text' = (repeat('{"a": ', 10000) || '"ID"' || repeat('}', 10000)) as okept
             from (select public.jsonb_replace_text_value(d, 'ann@x.com', 'ID') as r,
                          public.jsonb_replace_text_value(o, 'ann@x.com', 'ID') as ro
                     from rv9_deep) x`
        )
      ).rows;
    });
    expect(rows).toEqual([
      {
        kind: "array",
        at: 0,
        n: 2,
        marker: "_redacted: erasure: too deep to rewrite",
        kept: true,
        okind: "object",
        oat: 0,
        omarker: "erasure: too deep to rewrite",
        okept: true,
      },
    ]);
  });
});

dbDescribe(
  "rv9 H2/L7: exactly the whole strings equal to the address — values and keys",
  () => {
    it("the reviewer's document: values and keys replaced; near misses and free text kept", async () => {
      expect(
        JSON.parse(
          await replaceIn(
            '{"a":["Ann@X.com",{"Ann@x.com":"ann@x.com"}],"b":"joann@x.com","c":"mail ann@x.com","d":"x\\"ann@x.com\\""}',
            "ann@x.com"
          )
        )
      ).toEqual({
        a: ["ID", { ID: "ID" }],
        b: "joann@x.com",
        c: "mail ann@x.com",
        d: 'x"ann@x.com"',
      });
    });

    it.each([
      // [document, target, expected]
      [
        '["ÀNN@X.COM", "ànn@x.com", "ann@x.com"]',
        "àNN@x.com",
        '["ID", "ID", "ann@x.com"]',
      ],
      // An escaped quote or backslash in the address, in either case.
      [
        '["q\\"x@y", "Q\\"X@Y", "\\\\\\"q\\"x@y"]',
        'q"x@y',
        '["ID", "ID", "\\\\\\"q\\"x@y"]',
      ],
      ['["a@b\\\\", "a@b\\\\\\\\", "a@b"]', "a@b\\", '["ID", "a@b\\\\\\\\", "a@b"]'],
      // A control character (escaped as \u0001 in jsonb's text).
      ['["\\u0001a@b", "a@b"]', "\u0001A@B", '["ID", "a@b"]'],
      // A replacement that itself needs escaping.
      ['["a@b"]', "a@b", '["R\\"\\\\"]', 'R"\\'],
      // A target with no character outside the text between strings (the full path): a whole
      // string only — never the closing quote, the ", " between, and the next opening quote.
      ['["a", "b", ", ", {", ": ", "}]', ", ", '["a", "b", "ID", {"ID": "ID"}]'],
      ['["true", true, "null", null, 1]', "true", '["ID", true, "null", null, 1]'],
      ['{"k": ": "}', ": ", '{"k": "ID"}'],
    ])("%s, %j → %s", async (doc, target, expected, replacement = "ID") => {
      expect(await replaceIn(doc, target, replacement as string)).toBe(expected);
    });

    it("unchanged when nothing equals the target (and null in, null out)", async () => {
      expect(await replaceIn('{"a": "joann@x.com"}', "ann@x.com")).toBe(
        '{"a": "joann@x.com"}'
      );
      const [row] = await owner<{ r: unknown }>(
        "select public.jsonb_replace_text_value(null, 'a', 'b') as r"
      );
      expect(row.r).toBeNull();
    });

    it("the pre-filter is sound: true wherever the function would replace", async () => {
      const [row] = await owner<{ a: boolean; b: boolean; c: boolean }>(
        `select public.jsonb_may_mention_text('{"K": {"ANN@X.COM": 1}}', 'ann@x.com') as a,
              public.jsonb_may_mention_text('["q\\"x@y"]', 'Q"X@Y') as b,
              public.jsonb_may_mention_text('["nobody@x.com"]', 'ann@x.com') as c`
      );
      expect(row).toEqual({ a: true, b: true, c: false });
    });

    it("an address as an object key does not survive erasure and purge; free text is out of scope", async () => {
      const { ann } = await accounts();
      await propose(
        "op-key",
        { invited: { "ann@corp.example": "pending" }, note: "ping ann@corp.example" },
        "approved"
      );
      await t.run(() => softDeleteUser(ann, ann));
      const soft = await sql(
        "select payload from proposals where operation_id = 'op-key'"
      );
      expect(soft[0].payload.invited).toEqual({ [ann]: "pending" });
      // Free text quoting the address is another person's writing: not found or replaced.
      expect(soft[0].payload.note).toBe("ping ann@corp.example");
      await t.run(() => hardPurgeUser(ann));
      const rows = await sql(
        "select payload from proposals where operation_id = 'op-key'"
      );
      expect(JSON.stringify(rows)).not.toContain('"ann@corp.example"');
    });
  }
);
