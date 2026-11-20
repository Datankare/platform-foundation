/**
 * @jest-environment node
 */
/**
 * __tests__/db/json-bound-readiness.db.test.ts — readiness names every way the JSON bound is not in
 * force, and the owner's self-test fires the installed triggers (platform TASK-229, migration 074;
 * design 56e-3a §2.3, T2)
 *
 * What it refuses: a way to switch the bound off, edit it or go round it that readiness does not name
 *
 * public.json_bound_missing() — read by the json-bound probe, the deploy smoke and (from
 * promotion) the health watch — is provoked here line by line: a trigger missing, off, edited or
 * out of date with its table's columns (1: RA2-3, RA2-7, RB2-8); rows written while the triggers
 * were off and on again (2: TA-a-3); a later BEFORE trigger (3: DA-18); a rewrite rule (4); a
 * column the bound cannot hold (5); a refusing function changed — definition, owner or grants
 * (6: TA-a-6); 074 or 075 not recorded (7); the erasure's functions changed (8, the gate's own
 * rows); a function anon or authenticated may run (9: DA-8). The per-table off / install / check
 * round trip and the self-test with a trigger dropped are here too. Every change is rolled back.
 */

import { Client } from "pg";
import { dbDescribe, DB_ENABLED } from "../helpers/db";

let owner: Client;
if (DB_ENABLED) {
  beforeAll(async () => {
    owner = new Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
    await owner.connect();
  });
  afterAll(async () => {
    await owner?.end();
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

/** What readiness names now. */
const missing = async (): Promise<string[]> =>
  (
    await owner.query<{ m: string }>(
      "select m from public.json_bound_missing() m order by m"
    )
  ).rows.map((r) => r.m);

/** What the erasure's gate names now. */
const gate = async (): Promise<string[]> =>
  (
    await owner.query<{ m: string }>("select m from public.erasure_functions_missing() m")
  ).rows.map((r) => r.m);

dbDescribe(
  "T2: readiness is empty on a replayed database (the replay's own floor)",
  () => {
    it("nothing missing; the gate has no row", async () => {
      expect(await missing()).toEqual([]);
      expect(await gate()).toEqual([]);
    });
  }
);

dbDescribe(
  "T2: line 1 — each table's two triggers present, ALWAYS, exactly as 074 writes them",
  () => {
    it.each([
      [
        "dropped",
        "drop trigger zz_json_bound_ins on public.jobs",
        "public.jobs: trigger zz_json_bound_ins missing",
      ],
      [
        "disabled (the bound is off)",
        "alter table public.jobs disable trigger zz_json_bound_upd",
        "public.jobs: trigger zz_json_bound_upd not enabled ALWAYS (the bound is off)",
      ],
      [
        "enabled only for origin (not ALWAYS)",
        "alter table public.jobs enable trigger zz_json_bound_ins",
        "public.jobs: trigger zz_json_bound_ins not enabled ALWAYS (the bound is off)",
      ],
      [
        "its WHEN edited (RB2-8)",
        `create or replace trigger zz_json_bound_ins before insert on public.jobs for each row
        when (false) execute function public.json_bound_refuse('payload', '8388608');
       alter table public.jobs enable always trigger zz_json_bound_ins`,
        "public.jobs: trigger zz_json_bound_ins not as migration 074 makes it",
      ],
      [
        "replaced by another definition, left enabled for origin only (code review A-18): both said",
        "create or replace trigger zz_json_bound_ins before insert on public.jobs for each row execute function suppress_redundant_updates_trigger()",
        "public.jobs: trigger zz_json_bound_ins not as migration 074 makes it, and not enabled ALWAYS (the bound is off)",
      ],
      [
        "a jsonb column added after it (RA2-3)",
        "alter table public.jobs add column extra jsonb",
        "public.jobs: trigger zz_json_bound_ins not as migration 074 makes it",
      ],
      [
        "a jsonb column renamed (RA2-7)",
        "alter table public.jobs rename column payload to payload2",
        "public.jobs: trigger zz_json_bound_ins not as migration 074 makes it",
      ],
    ])("%s: named", async (_label, change, want) => {
      await rolledBack(async () => {
        await owner.query(change);
        expect(await missing()).toContain(want);
      });
    });
  }
);

dbDescribe(
  "T2: line 2 — rows written while the bound was off and on again (TA-a-3)",
  () => {
    it("disabled then enabled ALWAYS: 'rows not checked' until json_bound_check reads the table", async () => {
      await rolledBack(async () => {
        await owner.query("alter table public.jobs disable trigger zz_json_bound_ins");
        await owner.query(
          "alter table public.jobs enable always trigger zz_json_bound_ins"
        );
        const want =
          "public.jobs: existing rows not checked against the bound (run select public.json_bound_check('public.jobs'))";
        expect(await missing()).toEqual([want]);
        await owner.query("select public.json_bound_check('public.jobs')");
        expect(await missing()).toEqual([]);
      });
    });

    it("[without-fix shape] a mark that named no trigger version would read 'checked' after the toggle", async () => {
      await rolledBack(async () => {
        const { rows: before } = await owner.query<{ m: string }>(
          "select public.json_bound_mark('public.jobs'::regclass) as m"
        );
        await owner.query("alter table public.jobs disable trigger zz_json_bound_ins");
        await owner.query(
          "alter table public.jobs enable always trigger zz_json_bound_ins"
        );
        const { rows: after } = await owner.query<{ m: string }>(
          "select public.json_bound_mark('public.jobs'::regclass) as m"
        );
        expect(after[0].m).not.toBe(before[0].m);
      });
    });
  }
);

dbDescribe("T2: lines 3–5 — what would go round the bound", () => {
  it("(3, DA-18) a BEFORE row trigger that fires after the bound", async () => {
    await rolledBack(async () => {
      await owner.query(
        "create function pg_temp.t2_noop() returns trigger language plpgsql as $f$ begin return new; end $f$"
      );
      await owner.query(
        "create trigger zzz_later before insert on public.jobs for each row execute function pg_temp.t2_noop()"
      );
      expect(await missing()).toContain(
        "public.jobs: trigger zzz_later fires after the bound"
      );
    });
  });

  it("(4) a rewrite rule on a public table", async () => {
    await rolledBack(async () => {
      await owner.query(
        "create rule t2_rule as on insert to public.jobs do instead nothing"
      );
      expect(await missing()).toContain("public.jobs: rewrite rule t2_rule");
    });
  });

  it.each([
    [
      "json in a composite type",
      "create type public.t2_comp as (j json)",
      "alter table public.jobs add column c public.t2_comp",
      "public.jobs.c: type public.t2_comp holds JSON the bound cannot check",
    ],
    [
      "a json array",
      "select 1",
      "alter table public.jobs add column c json[]",
      "public.jobs.c: type json[] holds JSON the bound cannot check",
    ],
    [
      "a generated jsonb column",
      "select 1",
      "alter table public.jobs add column c jsonb generated always as (payload) stored",
      "public.jobs.c: a generated jsonb column is not checked by the bound",
    ],
  ])("(5) %s", async (_label, prep, change, want) => {
    await rolledBack(async () => {
      await owner.query(prep);
      await owner.query(change);
      expect(await missing()).toContain(want);
    });
  });
});

dbDescribe(
  "T2: lines 6–9 — the functions that decide, the records, the grants (TA-a-6, DA-8)",
  () => {
    it.each([
      [
        "json_bound_refuse made security invoker",
        "alter function public.json_bound_refuse() security invoker",
        "public.json_bound_refuse(): not as migration 074 makes it",
      ],
      [
        "json_bound_reason granted to public",
        "grant execute on function public.json_bound_reason(jsonb, bigint) to public",
        "public.json_bound_reason(jsonb,bigint): not as migration 074 makes it",
      ],
      [
        "json_bound_depth_path replaced",
        "create or replace function public.json_bound_depth_path() returns jsonpath language sql immutable set search_path = pg_catalog, pg_temp as $f$ select 'strict $.**{512}?(@.type() == \"object\")'::pg_catalog.jsonpath $f$",
        "public.json_bound_depth_path(): not as migration 074 makes it",
      ],
    ])("(6) %s", async (_label, change, want) => {
      await rolledBack(async () => {
        await owner.query(change);
        expect(await missing()).toContain(want);
      });
    });

    it("(6) an owner change is named", async () => {
      await rolledBack(async () => {
        await owner.query("create role t2_other nologin");
        await owner.query(
          "alter function public.json_bound_number_path() owner to t2_other"
        );
        expect(await missing()).toContain(
          "public.json_bound_number_path(): not as migration 074 makes it"
        );
      });
    });

    it("(7) 075 not recorded", async () => {
      await rolledBack(async () => {
        await owner.query(
          "delete from public.applied_migrations where filename = '075_json_bound_existing_rows.sql'"
        );
        expect(await missing()).toContain(
          "075_json_bound_existing_rows.sql: not recorded"
        );
      });
    });

    it.each([
      [
        "made security definer",
        "alter function public.jsonb_erase_id_text(jsonb, text) security definer",
      ],
      [
        "granted to public",
        "grant execute on function public.jsonb_erase_address_text(jsonb, text, text) to public",
      ],
    ])(
      "(8) an erasure function %s: the gate refuses and readiness names it",
      async (_label, change) => {
        await rolledBack(async () => {
          await owner.query(change);
          const g = await gate();
          expect(g).toHaveLength(1);
          expect(g[0]).toMatch(
            /: not as migration 074 makes it \(definition, owner or grants\)$/
          );
          expect(await missing()).toContain(g[0]);
        });
      }
    );

    it("(8) an erasure function missing: the gate says 'missing'", async () => {
      await rolledBack(async () => {
        await owner.query("drop function public.jsonb_erase_id_text(jsonb, text)");
        expect(await gate()).toEqual(
          ["jsonb_erase_id_text(jsonb,text): missing"].map((s) => `public.${s}`)
        );
      });
    });

    it("(9, DA-8) a bound function anon may run", async () => {
      await rolledBack(async () => {
        const { rows } = await owner.query<{ ok: boolean }>(
          "select to_regrole('anon') is not null as ok"
        );
        if (!rows[0].ok) await owner.query("create role anon nologin");
        await owner.query(
          "grant execute on function public.json_bound_term(text, bigint) to anon"
        );
        expect(await missing()).toContain(
          "public.json_bound_term(text,bigint): executable by anon"
        );
      });
    });
  }
);

dbDescribe("T2: the emergency off, per table, and its repair (TB-a-2, DA-17)", () => {
  it("off → named off; install → 'rows not checked'; check → nothing missing", async () => {
    await rolledBack(async () => {
      const off = await owner.query<{ r: string }>(
        "select public.json_bound_off(array['public.jobs'::regclass]) as r"
      );
      expect(off.rows[0].r).toMatch(/^json bound: OFF on 1 tables/);
      expect(await missing()).toEqual(
        expect.arrayContaining([
          "public.jobs: trigger zz_json_bound_ins not enabled ALWAYS (the bound is off)",
          "public.jobs: trigger zz_json_bound_upd not enabled ALWAYS (the bound is off)",
        ])
      );
      // While off, a value over the bound is written (the switch removes the test and its cost).
      await owner.query(
        `insert into public.jobs (tenant_id, kind, payload, idempotency_key) select id, 'test.t2', '{"v": [1e-30]}'::jsonb, 't2-key' from public.tenants limit 1`
      );
      const inst = await owner.query<{ r: string }>(
        "select public.json_bound_install(array['public.jobs'::regclass]) as r"
      );
      expect(inst.rows[0].r).toMatch(/1 \(re\)made/);
      expect(await missing()).toEqual([
        "public.jobs: existing rows not checked against the bound (run select public.json_bound_check('public.jobs'))",
      ]);
      // The row written while off stops the check, named.
      await owner.query("savepoint a");
      const err = await owner.query("select public.json_bound_check('public.jobs')").then(
        () => null,
        (e: { message: string; code: string }) => e
      );
      await owner.query("rollback to savepoint a");
      expect(err?.code).toBe("23514");
      expect(err?.message).toMatch(
        /^json_bound_check: 1 row\(s\) over the bound \(the first 50 of each table are named\):\n {2}public\.jobs\.payload: it holds a number other than 0 or 1e-18 <= \|n\| < 1e21 — row \([0-9a-f-]{36}\)$/
      );
      // The row is converted, never deleted (code review A-2), and the check then reads clean.
      const conv = await owner.query<{ line: string }>(
        "select line from public.json_bound_convert('public.jobs') line"
      );
      expect(conv.rows.map((r) => r.line)).toEqual([
        'public.jobs: 1 row(s) converted (1 value(s) in their numbers, 0 replaced by the "not kept" marker), 0 row(s) not converted',
        "json bound: 1 row(s) converted, 0 not converted; now run select public.json_bound_check();",
      ]);
      const { rows: kept } = await owner.query<{ payload: unknown }>(
        "select payload from public.jobs where kind = 'test.t2'"
      );
      expect(kept).toEqual([{ payload: { v: [0] } }]);
      await owner.query("select public.json_bound_check('public.jobs')");
      expect(await missing()).toEqual([]);
    });
  });

  it("install on a table the bound does not cover is refused, naming it", async () => {
    await rolledBack(async () => {
      await owner.query("savepoint a");
      const err = await owner
        .query("select public.json_bound_install(array['public.tenants'::regclass])")
        .then(
          () => null,
          (e: { message: string }) => e
        );
      await owner.query("rollback to savepoint a");
      expect(err?.message).toContain("public.tenants is not a table the bound covers");
    });
  });
});

dbDescribe(
  "T2: the owner's self-test fires the INSTALLED triggers (TA-a-5, TB-a-4)",
  () => {
    /** The check-56e3a.sql counts: refused and not refused. */
    const selftest = async () =>
      (
        await owner.query<{ tables: number; refused: number; not_refused: number }>(
          `with s as (select * from public.json_bound_selftest())
         select (select count(*)::int from public.json_bound_tables()) as tables,
                (select count(*)::int from s where outcome like 'refused%') as refused,
                (select count(*)::int from s where outcome not like 'refused%') as not_refused`
        )
      ).rows[0];

    it("every covered table refuses all three probes (refused = 3 x tables)", async () => {
      const s = await selftest();
      expect(s.not_refused).toBe(0);
      expect(s.refused).toBe(3 * s.tables);
    }, 60_000);

    it("[without-fix] a table whose insert trigger is dropped: refused falls by three, named NOT REFUSED", async () => {
      await rolledBack(async () => {
        const whole = await selftest();
        await owner.query("drop trigger zz_json_bound_ins on public.jobs");
        const s = await selftest();
        expect(s.refused).toBe(whole.refused - 3);
        expect(s.not_refused).toBe(3);
      });
    }, 60_000);
  }
);

dbDescribe(
  "T2: line 2 in one transaction, partitions, and the functions that decide what is installed (code review A-5, A-6, A-21)",
  () => {
    const notChecked = (t: string) =>
      `public.${t}: existing rows not checked against the bound (run select public.json_bound_check('public.${t}'))`;

    it("(A-21) installed, checked, then disabled and enabled again in ONE transaction: 'rows not checked'", async () => {
      await rolledBack(async () => {
        await owner.query("create table public.t2_same (id int primary key, doc jsonb)");
        await owner.query(
          "select public.json_bound_install(array['public.t2_same'::regclass])"
        );
        await owner.query("select public.json_bound_check('public.t2_same')");
        expect(await missing()).toEqual([]);
        await owner.query("alter table public.t2_same disable trigger zz_json_bound_ins");
        await owner.query("insert into public.t2_same values (1, '[1e30]')");
        await owner.query(
          "alter table public.t2_same enable always trigger zz_json_bound_ins"
        );
        expect(await missing()).toEqual([notChecked("t2_same")]);
      });
    });

    it("(A-5) a partition is named with its root, repaired through its root, and a table attached with rows is 'not checked'", async () => {
      await rolledBack(async () => {
        await owner.query(
          "create table public.t2_p (id int, doc jsonb) partition by range (id)"
        );
        await owner.query(
          "create table public.t2_p1 partition of public.t2_p for values from (0) to (100)"
        );
        // Before the root is installed: the root is named, the partition with it.
        expect(await missing()).toEqual(
          expect.arrayContaining([
            "public.t2_p: trigger zz_json_bound_ins missing",
            "public.t2_p (its partition public.t2_p1): trigger zz_json_bound_ins missing",
          ])
        );
        await owner.query(
          "select public.json_bound_install(array['public.t2_p'::regclass])"
        );
        await owner.query("select public.json_bound_check('public.t2_p')");
        expect(await missing()).toEqual([]);
        // A table that already holds a row over the bound, attached: its rows were never tested.
        await owner.query("create table public.t2_p3 (id int, doc jsonb)");
        await owner.query("insert into public.t2_p3 values (250, '[1e30]')");
        await owner.query(
          "alter table public.t2_p attach partition public.t2_p3 for values from (200) to (300)"
        );
        expect(await missing()).toEqual([notChecked("t2_p")]);
        await owner.query("savepoint a");
        const err = await owner
          .query("select public.json_bound_check('public.t2_p')")
          .then(
            () => null,
            (e: { code: string; message: string }) => e
          );
        await owner.query("rollback to savepoint a");
        expect(err?.code).toBe("23514");
        expect(err?.message).toContain(
          "public.t2_p3.doc: it holds a number other than 0 or 1e-18 <= |n| < 1e21 — row"
        );
        await owner.query("select public.json_bound_convert('public.t2_p')");
        await owner.query("select public.json_bound_check('public.t2_p')");
        expect(await missing()).toEqual([]);
        // Detached, written, attached again (the same table): its clones are new, so not checked.
        await owner.query("alter table public.t2_p detach partition public.t2_p3");
        await owner.query("insert into public.t2_p3 values (251, '[1e30]')");
        await owner.query(
          "alter table public.t2_p attach partition public.t2_p3 for values from (200) to (300)"
        );
        expect(await missing()).toEqual([notChecked("t2_p")]);
        await owner.query("select public.json_bound_convert('public.t2_p')");
        await owner.query("select public.json_bound_check('public.t2_p')");
        // A partition's clone disabled: named with the root, and the root's install repairs it.
        await owner.query("alter table public.t2_p1 disable trigger zz_json_bound_ins");
        expect(await missing()).toContain(
          "public.t2_p (its partition public.t2_p1): trigger zz_json_bound_ins not enabled ALWAYS (the bound is off)"
        );
        const inst = await owner.query<{ r: string }>(
          "select public.json_bound_install(array['public.t2_p'::regclass]) as r"
        );
        expect(inst.rows[0].r).toMatch(/1 \(re\)made/);
        expect(await missing()).toEqual([notChecked("t2_p")]);
      });
    });

    it("[without-fix shape] (A-5) a mark of the root's own triggers only reads 'checked' after an attach", async () => {
      await rolledBack(async () => {
        await owner.query(
          "create table public.t2_q (id int, doc jsonb) partition by range (id)"
        );
        await owner.query(
          "select public.json_bound_install(array['public.t2_q'::regclass])"
        );
        const mark = async () =>
          (
            await owner.query<{ m: string }>(
              "select public.json_bound_mark('public.t2_q'::regclass) as m"
            )
          ).rows[0].m;
        const before = await mark();
        await owner.query("create table public.t2_q1 (id int, doc jsonb)");
        await owner.query(
          "alter table public.t2_q attach partition public.t2_q1 for values from (0) to (9)"
        );
        expect(await mark()).not.toBe(before);
      });
    });

    it.each([
      [
        "json_bound_limit replaced to answer 0 (the size and number tests off at the next install)",
        "create or replace function public.json_bound_limit(rel regclass, col name) returns bigint language sql immutable set search_path = pg_catalog, pg_temp as $f$ select 0::bigint $f$",
        "public.json_bound_limit(regclass,name): not as migration 074 makes it",
      ],
      [
        "json_bound_term made a definer",
        "alter function public.json_bound_term(text, bigint) security definer",
        "public.json_bound_term(text,bigint): not as migration 074 makes it",
      ],
      [
        "json_bound_ddl granted to public",
        "grant execute on function public.json_bound_ddl(regclass) to public",
        "public.json_bound_ddl(regclass): not as migration 074 makes it",
      ],
      [
        "json_bound_tables replaced to cover nothing",
        "create or replace function public.json_bound_tables() returns setof regclass language sql stable set search_path = pg_catalog, pg_temp as $f$ select null::regclass where false $f$",
        "public.json_bound_tables(): not as migration 074 makes it",
      ],
      [
        "json_bound_mark replaced by a constant",
        "create or replace function public.json_bound_mark(rel regclass) returns text language sql stable set search_path = pg_catalog, pg_temp as $f$ select 'json bound: rows checked'::text $f$",
        "public.json_bound_mark(regclass): not as migration 074 makes it",
      ],
    ])("(6, A-6) %s: named", async (_label, change, want) => {
      await rolledBack(async () => {
        await owner.query(change);
        expect(await missing()).toContain(want);
      });
    });
  }
);

dbDescribe(
  "T2: line 10 — no role of the API holds TRIGGER on a covered table (code review A-7)",
  () => {
    const holders = async () =>
      (
        await owner.query<{ t: string }>(
          `select t::text || ' ' || g.r as t from public.json_bound_tables() t
            cross join (values ('anon'), ('authenticated'), ('service_role')) g(r)
           where to_regrole(g.r) is not null and has_table_privilege(g.r, t, 'TRIGGER') order by 1`
        )
      ).rows.map((r) => r.t);

    it("after the replay none holds it; service_role cannot put its own trigger in place of the bound's", async () => {
      expect(await holders()).toEqual([]);
      await rolledBack(async () => {
        const { rows } = await owner.query<{ ok: boolean }>(
          "select to_regrole('service_role') is not null as ok"
        );
        if (!rows[0].ok) await owner.query("create role service_role nologin");
        await owner.query("grant usage on schema public to service_role");
        await owner.query("set local role service_role");
        await owner.query("savepoint a");
        const err = await owner
          .query(
            "create or replace trigger zz_json_bound_ins before insert on public.ai_metrics for each row execute function suppress_redundant_updates_trigger()"
          )
          .then(
            () => null,
            (e: { code: string }) => e
          );
        await owner.query("rollback to savepoint a");
        await owner.query("reset role");
        expect(err?.code).toBe("42501");
      });
    });

    it("granted again (as a re-applied older migration does): named, the trigger can be replaced; json_bound_install takes it away", async () => {
      await rolledBack(async () => {
        const { rows } = await owner.query<{ ok: boolean }>(
          "select to_regrole('service_role') is not null as ok"
        );
        if (!rows[0].ok) await owner.query("create role service_role nologin");
        await owner.query("grant all on table public.jobs to service_role");
        expect(await missing()).toEqual([
          "public.jobs: service_role holds TRIGGER on it and could replace the bound's triggers (run select public.json_bound_install(array['public.jobs'::regclass]))",
        ]);
        const inst = await owner.query<{ r: string }>(
          "select public.json_bound_install(array['public.jobs'::regclass]) as r"
        );
        // Nothing (re)made: only the privilege is taken away, and no row needs reading again.
        expect(inst.rows[0].r).toBe("json bound: 1 tables covered, 0 (re)made");
        expect(await missing()).toEqual([]);
        expect(await holders()).toEqual([]);
      });
    });

    it("a new table bounded by json_bound_install loses the default grant of TRIGGER", async () => {
      await rolledBack(async () => {
        await owner.query("create table public.t2_new (doc jsonb)");
        await owner.query("grant all on table public.t2_new to service_role");
        await owner.query(
          "select public.json_bound_install(array['public.t2_new'::regclass])"
        );
        expect(await holders()).toEqual([]);
      });
    });
  }
);

dbDescribe(
  "T2: the off switch and the check name what they cannot do (code review A-15, A-16)",
  () => {
    it("(A-15) the check of a table whose insert trigger is gone says to install first", async () => {
      await rolledBack(async () => {
        await owner.query("drop trigger zz_json_bound_ins on public.jobs");
        await owner.query("savepoint a");
        const err = await owner
          .query("select public.json_bound_check('public.jobs')")
          .then(
            () => null,
            (e: { message: string }) => e
          );
        await owner.query("rollback to savepoint a");
        expect(err?.message).toBe(
          "json_bound_check: public.jobs does not carry the bound's two triggers; run select public.json_bound_install(array['public.jobs'::regclass]); first, then this again"
        );
      });
    });

    it("(A-16) off: a table named twice is one table; a trigger of that name in another schema is not ours", async () => {
      await rolledBack(async () => {
        const off = await owner.query<{ r: string }>(
          "select public.json_bound_off(array['public.jobs'::regclass, 'public.jobs'::regclass]) as r"
        );
        expect(off.rows[0].r).toMatch(/^json bound: OFF on 1 tables .*: public\.jobs;/);
        await owner.query("create schema t2_other");
        await owner.query("create table t2_other.x (doc jsonb)");
        await owner.query(
          "create trigger zz_json_bound_ins before insert on t2_other.x for each row execute function suppress_redundant_updates_trigger()"
        );
        await owner.query("savepoint a");
        const err = await owner
          .query("select public.json_bound_off(array['t2_other.x'::regclass])")
          .then(
            () => null,
            (e: { message: string }) => e
          );
        await owner.query("rollback to savepoint a");
        expect(err?.message).toBe(
          "json_bound_off: t2_other.x carries no bound trigger (a table in public that the bound covers is meant)"
        );
        // The whole-database form leaves it alone too.
        await owner.query("select public.json_bound_off()");
        const { rows } = await owner.query<{ e: string }>(
          "select tgenabled::text as e from pg_trigger where tgrelid = 't2_other.x'::regclass and tgname = 'zz_json_bound_ins'"
        );
        expect(rows[0].e).toBe("O");
      });
    });
  }
);

dbDescribe(
  "T2: rows already over the bound are converted, never deleted, and an erasure of one then succeeds (code review A-2)",
  () => {
    const ID = "3f2b1c4d-0000-4000-8000-00000000abcd";
    /** A covered table holding rows written while its bound was off. */
    async function table(): Promise<void> {
      await owner.query(
        "create table public.t2_old (id int primary key, note text, c jsonb, d jsonb)"
      );
      await owner.query(
        "select public.json_bound_install(array['public.t2_old'::regclass])"
      );
      await owner.query("select public.json_bound_off(array['public.t2_old'::regclass])");
      await owner.query(
        `insert into public.t2_old values
           (1, 'numbers', '{"p": 1e-30, "big": 1e25, "arr": [1, {"": -1e-40, "0": 2e21, "ok": 0.5}], "who": "${ID}"}', null),
           (2, 'a scalar', '-1e22', '{"fine": [1, 2]}'),
           (3, 'two columns', '[5e-19]', '{"x": 1e21}'),
           (4, 'too deep', '${"[".repeat(130)}${"]".repeat(130)}', null),
           (5, 'too long', ('[' || repeat('0e-16383,', 599) || '0e-16383]')::jsonb, null),
           (6, 'within the bound', '{"a": [1e-18, 999999999999999999999, 0]}', '"text 1e30"')`
      );
      for (let i = 0; i < 60; i++)
        await owner.query(
          "insert into public.t2_old values ($1, 'many', '[1e30]', null)",
          [100 + i]
        );
      await owner.query(
        "select public.json_bound_install(array['public.t2_old'::regclass])"
      );
    }
    const check = async () => {
      await owner.query("savepoint a");
      const err = await owner
        .query("select public.json_bound_check('public.t2_old')")
        .then(
          () => null,
          (e: { code: string; message: string }) => e
        );
      await owner.query(err ? "rollback to savepoint a" : "release savepoint a");
      return err;
    };

    it("the check names every row over the bound (the first 50, then the count of the rest), not one", async () => {
      await rolledBack(async () => {
        await table();
        const err = await check();
        expect(err?.code).toBe("23514");
        const lines = (err?.message ?? "").split("\n");
        expect(lines[0]).toBe(
          "json_bound_check: 65 row(s) over the bound (the first 50 of each table are named):"
        );
        expect(lines).toHaveLength(52);
        expect(lines[51]).toBe("  public.t2_old — and 15 more rows");
        expect(lines.slice(1, 51)).toHaveLength(50);
        expect(
          lines.slice(1, 51).every((l) => /^ {2}public\.t2_old\.[cd]: it /.test(l))
        ).toBe(true);
        expect(err?.message).toContain(
          "public.t2_old.c: it is nested deeper than 128 levels — row (4)"
        );
        expect(err?.message).toContain(
          "public.t2_old.c: it is longer than 8388608 bytes as text — row (5)"
        );
        expect(err?.message).not.toContain("row (6)");
      });
    }, 60_000);

    it("the conversion: numbers under 1e-18 become 0, numbers of 1e21 or more their digits as a string, too deep or too long the marker; nothing else changes and no row goes", async () => {
      await rolledBack(async () => {
        await table();
        const { rows: lines } = await owner.query<{ line: string }>(
          "select line from public.json_bound_convert('public.t2_old') line"
        );
        expect(lines.map((r) => r.line)).toEqual([
          'public.t2_old: 65 row(s) converted (64 value(s) in their numbers, 2 replaced by the "not kept" marker), 0 row(s) not converted',
          "json bound: 65 row(s) converted, 0 not converted; now run select public.json_bound_check();",
        ]);
        const { rows } = await owner.query<{ id: number; c: unknown; d: unknown }>(
          "select id, c, d from public.t2_old where id < 100 order by id"
        );
        expect(rows).toEqual([
          {
            id: 1,
            c: {
              p: 0,
              big: "10000000000000000000000000",
              arr: [1, { "": 0, "0": "2000000000000000000000", ok: 0.5 }],
              who: ID,
            },
            d: null,
          },
          { id: 2, c: "-10000000000000000000000", d: { fine: [1, 2] } },
          { id: 3, c: [0], d: { x: "1000000000000000000000" } },
          { id: 4, c: { _omitted: { code: "request.json_too_deep" } }, d: null },
          { id: 5, c: { _omitted: { code: "request.json_too_large" } }, d: null },
          { id: 6, c: { a: [1e-18, 999999999999999999999, 0] }, d: "text 1e30" },
        ]);
        const { rows: n } = await owner.query<{ n: number }>(
          "select count(*)::int as n from public.t2_old"
        );
        expect(n[0].n).toBe(66);
        expect(await check()).toBeNull();
        expect(await missing()).toEqual([]);
        // Run again: nothing left to convert.
        const { rows: again } = await owner.query<{ line: string }>(
          "select line from public.json_bound_convert('public.t2_old') line"
        );
        expect(again.map((r) => r.line)).toEqual([
          "json bound: 0 row(s) converted, 0 not converted; now run select public.json_bound_check();",
        ]);
      });
    }, 60_000);

    it("an erasure's rewrite of such a row is refused 23514 json_bound until it is converted, then succeeds", async () => {
      await rolledBack(async () => {
        await table();
        const erase = async () => {
          await owner.query("savepoint a");
          const err = await owner
            .query(
              `update public.t2_old set c = public.jsonb_erase_id_text(c, '${ID}') where c::text ~* '${ID}'`
            )
            .then(
              () => null,
              (e: { code: string; constraint: string }) => e
            );
          await owner.query(err ? "rollback to savepoint a" : "release savepoint a");
          return err;
        };
        expect(await erase()).toMatchObject({ code: "23514", constraint: "json_bound" });
        await owner.query("select public.json_bound_convert('public.t2_old')");
        expect(await erase()).toBeNull();
        const { rows } = await owner.query<{ who: string }>(
          "select c->>'who' as who from public.t2_old where id = 1"
        );
        expect(rows[0].who).toBe("erased");
      });
    }, 60_000);

    it("a row another rule of its table refuses to change is named with that rule's SQLSTATE and left as it was", async () => {
      await rolledBack(async () => {
        await table();
        await owner.query(
          `create function pg_temp.t2_frozen() returns trigger language plpgsql as $f$
           begin if old.id = 3 then raise exception 'frozen' using errcode = 'P0042'; end if; return new; end $f$`
        );
        await owner.query(
          "create trigger a_frozen before update on public.t2_old for each row execute function pg_temp.t2_frozen()"
        );
        const { rows: lines } = await owner.query<{ line: string }>(
          "select line from public.json_bound_convert('public.t2_old') line"
        );
        expect(lines.map((r) => r.line)).toEqual([
          'public.t2_old: row (3) NOT converted — another rule of this table refuses the change (SQLSTATE P0042); it is left as it was and needs a decision (docs/MIGRATION_v5_to_v6.md, "A row over the JSON bound")',
          'public.t2_old: 64 row(s) converted (62 value(s) in their numbers, 2 replaced by the "not kept" marker), 1 row(s) not converted',
          "json bound: 64 row(s) converted, 1 not converted; now run select public.json_bound_check();",
        ]);
        const { rows } = await owner.query<{ c: unknown; d: unknown }>(
          "select c::text as c, d::text as d from public.t2_old where id = 3"
        );
        expect(rows[0]).toEqual({
          c: "[0.0000000000000000005]",
          d: '{"x": 1000000000000000000000}',
        });
        expect((await check())?.message).toContain("row (3)");
      });
    }, 60_000);

    it("[without-fix shape] the same rows deleted, as the guide once allowed, would lose six rows of data", async () => {
      await rolledBack(async () => {
        await table();
        await owner.query("select public.json_bound_convert('public.t2_old')");
        // Every row is still there with its other columns: a conversion, not a deletion.
        const { rows } = await owner.query<{ notes: string[] }>(
          "select array_agg(note order by id) as notes from public.t2_old where id < 100"
        );
        expect(rows[0].notes).toEqual([
          "numbers",
          "a scalar",
          "two columns",
          "too deep",
          "too long",
          "within the bound",
        ]);
      });
    }, 60_000);

    it("app_tenant cannot run the conversion (the tables' owner only)", async () => {
      const { rows } = await owner.query<{ app: boolean; pub: boolean }>(
        `select has_function_privilege('app_tenant', 'public.json_bound_convert(regclass)', 'EXECUTE') as app,
                has_function_privilege('public', 'public.json_bound_convert(regclass)', 'EXECUTE') as pub`
      );
      expect(rows[0]).toEqual({ app: false, pub: false });
    });
  }
);
