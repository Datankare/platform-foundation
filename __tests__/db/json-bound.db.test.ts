/**
 * @jest-environment node
 */
/**
 * __tests__/db/json-bound.db.test.ts — every stored JSON value is bounded, whoever writes it
 * (platform TASK-229, migration 074, ADR-058; design 56e-3a §2.2, T1)
 *
 * What it refuses: a jsonb column that accepts a value over the bound, or an accepted write that costs more
 * than the bound's built-in test
 *
 * The bound: 128 levels; every number 0 or 1e-18 <= |n| < 1e21; 8 MiB of text as printed; a
 * value whose stored size is over 4 x 8 MiB + 64 KiB refused without printing. Each is driven
 * here at its edge, for the owner and for app_tenant (23514 json_bound, never 42501: NF-2), in
 * replica mode, and through a copied (toasted, compressed) value. The work an accepted write
 * costs is asserted in this test's own transaction counters (pg_stat_get_xact_*, review TB-x-4),
 * never by time: an update of another column reads no toast block (review B-4), and an accepted
 * write calls no function of ours (review B-11, DB-7) — each with its mutant.
 *
 * On UPDATE "unchanged" means the same stored toast pointer, never jsonb equality (code review
 * A-1: 0 equals 0e-16383, so plain zeros could be updated to zeros that print 16 385 characters
 * each); the refusal names the column the write changed (A-19); the stored-size pre-test is in
 * the installed trigger and refuses an INSERT (A-20).
 *
 * Every change made here is rolled back (one transaction per case), so the worker's database is
 * as the replay left it.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { Client } from "pg";
import { withTenantTx } from "@/platform/data";
import {
  DATABASE_JSON_MAX_DEPTH,
  DATABASE_JSON_MAX_TEXT,
  JSON_NUMBER_MAX_MAGNITUDE,
  JSON_NUMBER_MIN_MAGNITUDE,
} from "@/platform/errors/json-limits";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  DB_ENABLED,
  type TestTenant,
} from "../helpers/db";

let owner: Client;
let t: TestTenant;
if (DB_ENABLED) {
  beforeAll(async () => {
    await connectTestDatabase();
    owner = new Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
    await owner.connect();
    t = await createTestTenant();
  });
  afterAll(async () => {
    await owner?.end();
    await dropTestTenants();
    await disconnectTestDatabase();
  });
}

/** Run `fn` in a transaction on the owner's session, always rolled back. */
async function rolledBack<R>(fn: () => Promise<R>): Promise<R> {
  await owner.query("begin");
  try {
    return await fn();
  } finally {
    await owner.query("rollback");
  }
}

/** The outcome of one statement in its own savepoint: "ok", or the error's code and constraint. */
async function attempt(sql: string, values: unknown[] = []): Promise<string> {
  await owner.query("savepoint a");
  try {
    await owner.query(sql, values);
    await owner.query("release savepoint a");
    return "ok";
  } catch (err) {
    await owner.query("rollback to savepoint a");
    const e = err as { code?: string; constraint?: string };
    return `${e.code ?? "?"}${e.constraint ? ` ${e.constraint}` : ""}`;
  }
}

/** A value nested `depth` levels (arrays). */
const nested = (depth: number) => `${"[".repeat(depth)}${"]".repeat(depth)}`;

/** Insert `literal` (SQL text of a jsonb expression) as ai_metrics.values of a fresh row. */
const metric = (literal: string) =>
  attempt(
    `insert into public.ai_metrics (name, "timestamp", "values", tags, tenant_id)
     values ('t1', now(), jsonb_build_object('v', ${literal}), '{}'::jsonb, $1::uuid)`,
    [t.id]
  );

dbDescribe("the bound's numbers are the application's (one source each)", () => {
  it("depth, text limit and number range as 074 writes them", async () => {
    const { rows } = await owner.query<{
      depth: string;
      num: string;
      lim: string;
      steps: string;
    }>(
      `select public.json_bound_depth_path()::text as depth, public.json_bound_number_path()::text as num,
              public.json_bound_limit('public.audit_log'::regclass, 'details')::text as lim,
              public.json_bound_limit('public.agent_trajectories'::regclass, 'steps')::text as steps`
    );
    expect(rows[0].depth).toContain(`$.**{${DATABASE_JSON_MAX_DEPTH}}`);
    expect(Number(rows[0].lim)).toBe(DATABASE_JSON_MAX_TEXT);
    expect(rows[0].steps).toBe("0");
    expect(rows[0].num).toContain(`>= ${BigInt(JSON_NUMBER_MAX_MAGNITUDE).toString()}`);
    expect(rows[0].num).toContain(`< 0.${"0".repeat(17)}1`);
    expect(JSON_NUMBER_MIN_MAGNITUDE).toBe(1e-18);
  });
});

dbDescribe("T1: every edge of the bound, for the owner", () => {
  it.each([
    // Inside {"v": …}: 127 arrays are 128 levels in all, 128 arrays 129.
    ["depth 128", `'${nested(127)}'::jsonb`, "ok"],
    ["depth 129", `'${nested(128)}'::jsonb`, "23514 json_bound"],
    ["0", "'[0, -0, 0.0]'::jsonb", "ok"],
    ["1e-18 (the smallest)", "'[1e-18, -1e-18]'::jsonb", "ok"],
    ["9.99e-19", "'[9.99e-19]'::jsonb", "23514 json_bound"],
    ["just under 1e21", "'[999999999999999999999]'::jsonb", "ok"],
    ["1e21", "'[1e21]'::jsonb", "23514 json_bound"],
    ["-1e21", "'[-1e21]'::jsonb", "23514 json_bound"],
    [
      "numexp 1e131071 (22 bytes, 131 072 printed)",
      "'[1e131071]'::jsonb",
      "23514 json_bound",
    ],
    ["subnormal 5e-324", "'[5e-324]'::jsonb", "23514 json_bound"],
    ["a string is never a number", `'["1e-30", "1e30"]'::jsonb`, "ok"],
  ])("%s: %s", async (_label, literal, want) => {
    await rolledBack(async () => expect(await metric(literal)).toBe(want));
  });

  it("8 MiB of text accepted; one byte more refused by the print term (CONFIRM: T / T+1)", async () => {
    await rolledBack(async () => {
      // jsonb_build_object('v', <array>) prints {"v": [...]}: the array is sized so the whole
      // value prints exactly 8 388 608 bytes, then one byte more.
      const build = (extra: number) =>
        `(select jsonb_agg(left(repeat(md5(g::text), 4), 100)) from generate_series(1, 80659) g) || to_jsonb(repeat('y', ${61 + extra}))`;
      const { rows } = await owner.query<{ n: string }>(
        `select octet_length(jsonb_build_object('v', ${build(0)})::text)::text as n`
      );
      expect(Number(rows[0].n)).toBe(DATABASE_JSON_MAX_TEXT);
      expect(await metric(build(0))).toBe("ok");
      expect(await metric(build(1))).toBe("23514 json_bound");
    });
  }, 60_000);

  it("(E1) zeros written with a scale: 500 x 0e-16383 accepted, 600 refused 23514 by the print term", async () => {
    // jsonb keeps a zero's display scale, and the number rule lets every zero through: 0e-16383 is
    // 8 bytes sent and prints "0." and 16 383 zeros (CONFIRM CA3-1). 500 print ~8.2 MB (within
    // T); 600 print ~9.8 MB — refused by the print term, 23514, never a later 54000.
    await rolledBack(async () => {
      const zeros = (n: number) =>
        `('[' || repeat('0e-16383,', ${n - 1}) || '0e-16383]')::jsonb`;
      expect(await metric(zeros(500))).toBe("ok");
      expect(await metric(zeros(600))).toBe("23514 json_bound");
      const { rows } = await owner.query<{ why: string }>(
        `select public.json_bound_reason(${zeros(600)}, 8388608) as why`
      );
      expect(rows[0].why).toBe("it is longer than 8388608 bytes as text");
    });
  }, 60_000);

  it("over the stored-size pre-test (P): refused without printing", async () => {
    await rolledBack(async () => {
      const { rows } = await owner.query<{ why: string }>(
        `select public.json_bound_reason((select jsonb_agg(0) from generate_series(1, 2900000)), 8388608) as why`
      );
      expect(rows[0].why).toMatch(
        /^it is \d+ bytes as stored, so longer than 8388608 bytes as text$/
      );
    });
  }, 60_000);

  it("over the stored-size pre-test (P) through an INSERT: refused 23514 by the installed trigger's own first term (code review A-20)", async () => {
    await rolledBack(async () => {
      const big = "(select jsonb_agg(0) from generate_series(1, 2900000))";
      // The installed trigger tests "values" with the pre-test first, as json_bound_term writes it.
      const { rows } = await owner.query<{ def: string }>(
        "select pg_get_triggerdef(oid) as def from pg_trigger where tgrelid = 'public.ai_metrics'::regclass and tgname = 'zz_json_bound_ins'"
      );
      const first = `(pg_column_size((new."values" || '[]'::jsonb)) > ${4 * DATABASE_JSON_MAX_TEXT + 65536})`;
      expect(rows[0].def).toContain(
        `((new."values" IS NOT NULL) AND (${first} OR jsonb_path_exists(new."values",`
      );
      // That term alone refuses this value (it is true of it), and the INSERT is refused 23514.
      const { rows: term } = await owner.query<{ over: boolean }>(
        `select ${first.replace(/new\."values"/g, "v")} as over from (select ${big} as v) x`
      );
      expect(term[0].over).toBe(true);
      await owner.query("savepoint a");
      const err = await owner
        .query(
          `insert into public.ai_metrics (name, "timestamp", "values", tags, tenant_id)
           values ('t1', now(), ${big}, '{}'::jsonb, $1::uuid)`,
          [t.id]
        )
        .then(
          () => null,
          (e: { code: string; constraint: string; message: string }) => e
        );
      await owner.query("rollback to savepoint a");
      expect(err).toMatchObject({ code: "23514", constraint: "json_bound" });
      expect(err?.message).toMatch(/it is \d+ bytes as stored, so longer than 8388608/);
    });
  }, 60_000);

  it("the refusal names the column and the reason (check_violation, constraint json_bound)", async () => {
    await rolledBack(async () => {
      await owner.query("savepoint a");
      const err = await owner
        .query(
          `insert into public.ai_metrics (name, "timestamp", "values", tags, tenant_id)
           values ('t1', now(), '{}'::jsonb, '[1e-30]'::jsonb, $1::uuid)`,
          [t.id]
        )
        .then(
          () => null,
          (e: { code: string; constraint: string; column: string; message: string }) => e
        );
      await owner.query("rollback to savepoint a");
      expect(err).toMatchObject({
        code: "23514",
        constraint: "json_bound",
        column: "tags",
      });
      expect(err?.message).toContain(
        "holds a number other than 0 or 1e-18 <= |n| < 1e21"
      );
    });
  });

  it("on UPDATE a changed value is tested, and in replica mode too (ENABLE ALWAYS)", async () => {
    await rolledBack(async () => {
      await owner.query(
        `insert into public.ai_metrics (id, name, "timestamp", "values", tags, tenant_id)
         values ('00000000-0000-4000-8000-0000000000a1', 't1', now(), '{}'::jsonb, '{}'::jsonb, $1::uuid)`,
        [t.id]
      );
      expect(
        await attempt(
          `update public.ai_metrics set "values" = '{"v": [5e-324]}' where id = '00000000-0000-4000-8000-0000000000a1'`
        )
      ).toBe("23514 json_bound");
      await owner.query("set local session_replication_role = replica");
      expect(await metric(`'${nested(129)}'::jsonb`)).toBe("23514 json_bound");
    });
  });

  it("(code review A-1) plain zeros held in line cannot be updated to zeros written with a scale: refused 23514; the jsonb-equality mutant stores 9.8 MB", async () => {
    await rolledBack(async () => {
      const id = "00000000-0000-4000-8000-0000000000a2";
      // ai_metrics.values is an object: the zeros are its one member.
      const scaled = `jsonb_build_object('v', ('[' || repeat('0e-16383,', 599) || '0e-16383]')::jsonb)`;
      const plain = `jsonb_build_object('v', (select jsonb_agg(0) from generate_series(1, 600)))`;
      await owner.query(
        `insert into public.ai_metrics (id, name, "timestamp", "values", tags, tenant_id)
         values ($2::uuid, 't1', now(), ${plain}, '{}'::jsonb, $1::uuid)`,
        [t.id, id]
      );
      // The stored value is in line (no toast pointer) and equals the new one as jsonb.
      const { rows } = await owner.query<{ inline: boolean; equal: boolean }>(
        `select pg_column_toast_chunk_id("values") is null as inline, "values" = ${scaled} as equal
           from public.ai_metrics where id = $1::uuid`,
        [id]
      );
      expect(rows[0]).toEqual({ inline: true, equal: true });
      expect(
        await attempt(
          `update public.ai_metrics set "values" = ${scaled} where id = '${id}'`
        )
      ).toBe("23514 json_bound");
      // One number too: 1 to 1.000…0 is the same jsonb value; it is tested (and, printing 16 386
      // characters, accepted — the test ran, the bound is 8 MiB).
      expect(
        await attempt(
          `update public.ai_metrics set "values" = ('{"a": 1.' || repeat('0', 16383) || '}')::jsonb where id = '${id}'`
        )
      ).toBe("ok");
      // The mutant: the term as it was — an in-line value "unchanged" when equal as jsonb.
      const { rows: ddl } = await owner.query<{ upd: string }>(
        "select (public.json_bound_ddl('public.ai_metrics'::regclass))[2] as upd"
      );
      const mutant = ddl[0].upd
        .replace("CREATE TRIGGER", "CREATE OR REPLACE TRIGGER")
        .replace(
          /\(pg_column_toast_chunk_id\(new\.("?\w+"?)\) IS NULL\)\)/g,
          "((pg_column_toast_chunk_id(new.$1) IS NULL) AND (new.$1 IS DISTINCT FROM old.$1)))"
        );
      expect(mutant).not.toBe(
        ddl[0].upd.replace("CREATE TRIGGER", "CREATE OR REPLACE TRIGGER")
      );
      await owner.query(mutant);
      await owner.query(
        "alter table public.ai_metrics enable always trigger zz_json_bound_upd"
      );
      await owner.query(
        `update public.ai_metrics set "values" = ${plain} where id = '${id}'`
      );
      expect(
        await attempt(
          `update public.ai_metrics set "values" = ${scaled} where id = '${id}'`
        )
      ).toBe("ok");
      const { rows: stored } = await owner.query<{ printed: number }>(
        `select octet_length("values"::text) as printed from public.ai_metrics where id = $1::uuid`,
        [id]
      );
      expect(stored[0].printed).toBeGreaterThan(DATABASE_JSON_MAX_TEXT);
    });
  }, 60_000);

  it("(code review A-19) on UPDATE the refusal names the column the write changed, not an older value over the bound beside it", async () => {
    await rolledBack(async () => {
      const id = "00000000-0000-4000-8000-0000000000a3";
      // A row stored before the bound: "values" holds a number out of range.
      await owner.query(
        "alter table public.ai_metrics disable trigger zz_json_bound_ins"
      );
      await owner.query(
        `insert into public.ai_metrics (id, name, "timestamp", "values", tags, tenant_id)
         values ($2::uuid, 't1', now(), '{"v": [1e30]}'::jsonb, '{}'::jsonb, $1::uuid)`,
        [t.id, id]
      );
      await owner.query(
        "alter table public.ai_metrics enable always trigger zz_json_bound_ins"
      );
      const refused = async (set: string) => {
        await owner.query("savepoint a");
        const err = await owner
          .query(`update public.ai_metrics set ${set} where id = '${id}'`)
          .then(
            () => null,
            (e: { code: string; column: string; message: string }) => e
          );
        await owner.query("rollback to savepoint a");
        return err;
      };
      // The write changes tags to a value too deep: tags is named, with its own reason.
      const changed = await refused(`tags = '${nested(129)}'::jsonb`);
      expect(changed).toMatchObject({ code: "23514", column: "tags" });
      expect(changed?.message).toContain("nested deeper than 128 levels");
      // A write that changes no jsonb column is refused too (the old value is held in line and
      // tested on every update of its row, until json_bound_convert): the old column is named.
      const untouched = await refused("name = 't1b'");
      expect(untouched).toMatchObject({ code: "23514", column: "values" });
    });
  });

  it("(code review A-22) the soft delete's largest growth of an application-legal value stays within the bound: 1 MiB compact of a 3-character address as key and value, the keys numbered with the document's digest", async () => {
    // What the soft delete makes of the most adverse 1 MiB the application may store: every
    // member is `"a@b":"a@b"` in objects of the four case variants of the key (an address that
    // short passes no sign-up), and one planted "<id>#1" key forces the digest form —
    // `"<id>#<n>-<12 hex>": "<id>"`, 99 bytes from 12.5. Measured 7.95 x compact: inside 8 MiB
    // by about 50 KB. (An array of addresses grows 6.67 x; numbered keys without values 7.36 x.)
    await rolledBack(async () => {
      const id = "3f2b1c4d-0000-4000-8000-00000000abcd";
      await owner.query("create table public.t1_grow (doc jsonb)");
      await owner.query(
        "select public.json_bound_install(array['public.t1_grow'::regclass])"
      );
      await owner.query(
        `insert into public.t1_grow
         select jsonb_build_array(jsonb_build_object('${id}#1', 0, 'a@b', 'a@b', 'A@b', 'a@b', 'a@B', 'a@b', 'A@B', 'a@b'))
                || (select jsonb_agg('{"a@b":"a@b","A@b":"a@b","a@B":"a@b","A@B":"a@b"}'::jsonb)
                      from generate_series(1, 20969))`
      );
      const { rows: before } = await owner.query<{ compact: number }>(
        "select octet_length(replace(replace(doc::text, ', ', ','), ': ', ':')) as compact from public.t1_grow"
      );
      // The application's own limit, to the last object that fits.
      expect(before[0].compact).toBeLessThanOrEqual(1_048_576);
      expect(before[0].compact).toBeGreaterThan(1_048_576 - 64);
      expect(
        await attempt(
          `update public.t1_grow set doc = public.jsonb_erase_address_text(doc, 'a@b', '${id}')`
        )
      ).toBe("ok");
      const { rows: after } = await owner.query<{ printed: number; left: number }>(
        "select octet_length(doc::text) as printed, (doc::text ~* '\\ma@b\\M')::int as left from public.t1_grow"
      );
      expect(after[0].left).toBe(0);
      expect(after[0].printed).toBeLessThanOrEqual(DATABASE_JSON_MAX_TEXT);
      expect(after[0].printed).toBeGreaterThan(8_300_000);
    });
  }, 120_000);

  it("a stored (toasted, compressed) value copied by INSERT … SELECT is measured decompressed", async () => {
    await rolledBack(async () => {
      // 9.4 MB of repetitive text compresses to a little stored value: the copy is refused on its
      // printed size, never passed on its stored one.
      await owner.query("create temp table t1_src (v jsonb) on commit drop");
      await owner.query(
        "insert into t1_src select jsonb_build_object('v', (select jsonb_agg(repeat('a', 900)) from generate_series(1, 10400)))"
      );
      const { rows } = await owner.query<{ stored: number; printed: number }>(
        "select pg_column_size(v) as stored, octet_length(v::text) as printed from t1_src"
      );
      expect(rows[0].stored).toBeLessThan(1_000_000);
      expect(rows[0].printed).toBeGreaterThan(DATABASE_JSON_MAX_TEXT);
      expect(
        await attempt(
          `insert into public.ai_metrics (name, "timestamp", "values", tags, tenant_id)
           select 't1', now(), v, '{}'::jsonb, $1::uuid from t1_src`,
          [t.id]
        )
      ).toBe("23514 json_bound");
    });
  }, 60_000);
});

dbDescribe(
  "T1: app_tenant and a role with INSERT only are refused with 23514, never 42501 (NF-2, B-7)",
  () => {
    it("app_tenant (the application's own role): 128 written, 129 and 1e25 refused json_bound", async () => {
      const write = (values: string) =>
        t
          .run(() =>
            withTenantTx((tx) =>
              tx.query(
                `insert into ai_metrics (name, "timestamp", "values", tags) values ('t1', now(), $1::jsonb, '{}'::jsonb)`,
                [values]
              )
            )
          )
          .then(
            () => "ok",
            (e: { code?: string; constraint?: string }) =>
              `${e.code} ${e.constraint ?? ""}`.trim()
          );
      expect(await write(JSON.stringify({ v: JSON.parse(nested(127)) }))).toBe("ok");
      expect(await write(JSON.stringify({ v: JSON.parse(nested(128)) }))).toBe(
        "23514 json_bound"
      );
      expect(await write('{"v": 1e25}')).toBe("23514 json_bound");
    });

    it("an adopter's role with INSERT only writes within the bound and is refused 23514 past it", async () => {
      await rolledBack(async () => {
        // An adopter's own table, bounded as a later migration bounds one (json_bound_install).
        await owner.query("create table public.t1_adopter (doc jsonb)");
        await owner.query(
          "select public.json_bound_install(array['public.t1_adopter'::regclass])"
        );
        await owner.query("create role t1_inserter nologin");
        await owner.query("grant usage on schema public to t1_inserter");
        await owner.query("grant insert on public.t1_adopter to t1_inserter");
        await owner.query("set local role t1_inserter");
        const put = (doc: string) =>
          attempt("insert into public.t1_adopter (doc) values ($1::jsonb)", [doc]);
        expect(await put(nested(128))).toBe("ok");
        expect(await put(nested(129))).toBe("23514 json_bound");
        expect(await put("[1e-30]")).toBe("23514 json_bound");
        await owner.query("reset role");
      });
    });
  }
);

dbDescribe(
  "T1: the work an accepted write costs, in this transaction's own counters (TB-x-4)",
  () => {
    /** A table of ours, bounded by json_bound_install, with a 1 MiB value already stored. */
    async function bigRow(): Promise<string> {
      await owner.query(
        "create table public.t1_cost (id int primary key, n int, doc jsonb)"
      );
      await owner.query(
        "select public.json_bound_install(array['public.t1_cost'::regclass])"
      );
      await owner.query(
        "insert into public.t1_cost select 1, 0, (select jsonb_agg(md5(g::text)) from generate_series(1, 30000) g)"
      );
      const { rows } = await owner.query<{ toast: string }>(
        "select reltoastrelid::regclass::text as toast from pg_class where oid = 'public.t1_cost'::regclass"
      );
      return rows[0].toast;
    }
    const blocks = async (toast: string) =>
      Number(
        (
          await owner.query<{ n: string }>(
            "select pg_stat_get_xact_blocks_fetched($1::regclass)::text as n",
            [toast]
          )
        ).rows[0].n
      );

    it("(B-4) an update of another column reads no toast block; the mutant without the unchanged term reads them", async () => {
      await rolledBack(async () => {
        const toast = await bigRow();
        const before = await blocks(toast);
        await owner.query("update public.t1_cost set n = n + 1 where id = 1");
        expect((await blocks(toast)) - before).toBe(0);
        // The mutant: the same test without 074's unchanged-column term.
        await owner.query(
          `create or replace trigger zz_json_bound_upd before update on public.t1_cost for each row
         when (new.doc is not null and octet_length(new.doc::text) > 8388608)
         execute function public.json_bound_refuse('doc', '8388608')`
        );
        const mid = await blocks(toast);
        await owner.query("update public.t1_cost set n = n + 1 where id = 1");
        expect((await blocks(toast)) - mid).toBeGreaterThan(0);
      });
    }, 60_000);

    it("(B-11, DB-7, DA-15) 200 accepted writes call no function of ours and open no subtransaction; the mutant calls one", async () => {
      await rolledBack(async () => {
        await owner.query("set local track_functions = 'all'");
        await owner.query(
          "create table public.t1_calls (id serial primary key, doc jsonb)"
        );
        await owner.query(
          "select public.json_bound_install(array['public.t1_calls'::regclass])"
        );
        const calls = async () =>
          Number(
            (
              await owner.query<{ n: string }>(
                "select coalesce(pg_stat_get_xact_function_calls('public.json_bound_refuse'::regproc), 0)::text as n"
              )
            ).rows[0].n
          );
        for (let i = 0; i < 200; i++)
          await owner.query("insert into public.t1_calls (doc) values ($1::jsonb)", [
            JSON.stringify({ i, v: [1, 0.5, "x"] }),
          ]);
        expect(await calls()).toBe(0);
        const { rows: sub } = await owner.query<{ n: string }>(
          "select (pg_stat_get_backend_subxact(b.id)).subxact_count::text as n from pg_stat_get_backend_idset() b(id) where pg_stat_get_backend_pid(b.id) = pg_backend_pid()"
        );
        expect(Number(sub[0]?.n ?? 0)).toBe(0);
        // The mutant: a PL/pgSQL call in WHEN — every accepted write calls it.
        await owner.query(
          "create function pg_temp.t1_slow(v jsonb) returns boolean language plpgsql as $f$ begin return false; end $f$"
        );
        await owner.query(
          `create or replace trigger zz_json_bound_ins before insert on public.t1_calls for each row
         when (pg_temp.t1_slow(new.doc)) execute function public.json_bound_refuse('doc', '8388608')`
        );
        const { rows } = await owner.query<{ n: string }>(
          "select coalesce(pg_stat_get_xact_function_calls('pg_temp.t1_slow(jsonb)'::regprocedure), 0)::text as n"
        );
        const before = Number(rows[0].n);
        for (let i = 0; i < 20; i++)
          await owner.query("insert into public.t1_calls (doc) values ('{}'::jsonb)");
        const after = Number(
          (
            await owner.query<{ n: string }>(
              "select coalesce(pg_stat_get_xact_function_calls('pg_temp.t1_slow(jsonb)'::regprocedure), 0)::text as n"
            )
          ).rows[0].n
        );
        expect(after - before).toBe(20);
      });
    }, 60_000);
  }
);
