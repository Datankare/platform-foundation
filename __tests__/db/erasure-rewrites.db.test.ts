/**
 * @jest-environment node
 */
/**
 * __tests__/db/erasure-rewrites.db.test.ts — today's erasure rewrites lose no value and never match
 * an id across an escape (platform TASK-229, migration 074; design 56e-3a §2.4, T4)
 *
 * What it refuses: an erasure rewrite that drops a member, changes a character outside the id or address,
 * raises on a document, or matches an id an escape's tail spells
 *
 * The soft delete's rewrite is public.jsonb_erase_address_text (052's function with keys compared
 * by length and no stand-ins: reviews A-2, A-4, A-5), the purge's public.jsonb_erase_id_text
 * (every escape set aside before matching, keys numbered where they would merge: A-1, TA-a-1). Each
 * is checked here on the reviewers' own reproductions, against today's forms (052's function and
 * the regexp_replace(<col>::text, id, 'erased', 'gi')::jsonb the purge sent), and with a
 * differential fuzz: reviewer A's generator and oracle (B3-DESIGN-REVIEW-A f1, acknowledged in
 * ADR-058) — control characters planted before ids — over the fixed seeds 11, 22, 33, 44 and the
 * run's FC_SEED. The oracle is a tree walk: every member kept, every scalar equal, every string
 * rewritten by the intended rule, keys equal to the rewritten key or it numbered. The costly
 * numbering path is counted by its debug line (B-3, S7, RA2-15), never by time.
 */

import { Client } from "pg";
import { dbDescribe, DB_ENABLED } from "../helpers/db";

let owner: Client;
const notices: string[] = [];
if (DB_ENABLED) {
  beforeAll(async () => {
    owner = new Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
    await owner.connect();
    owner.on("notice", (n) => notices.push(n.message ?? ""));
  });
  afterAll(async () => {
    await owner?.end();
  });
}

const ID = "3f2b1c4d-0000-4000-8000-00000000abcd";
const one = async <R>(sql: string, values: unknown[] = []): Promise<R> =>
  (await owner.query(sql, values)).rows[0] as R;
const idRewrite = async (doc: unknown, id = ID): Promise<unknown> =>
  (
    await one<{ r: unknown }>(
      "select public.jsonb_erase_id_text($1::jsonb, $2::text) as r",
      [JSON.stringify(doc), id]
    )
  ).r;
const addrRewrite = async (doc: unknown, address: string, id = ID): Promise<unknown> =>
  (
    await one<{ r: unknown }>(
      "select public.jsonb_erase_address_text($1::jsonb, $2::text, $3::text) as r",
      [JSON.stringify(doc), address, id]
    )
  ).r;
/** Today's purge form, for the without-fix comparison. */
const idToday = async (doc: unknown, id = ID): Promise<unknown> =>
  (
    await one<{ r: unknown }>(
      "select regexp_replace($1::jsonb::text, $2::text, 'erased', 'gi')::jsonb as r",
      [JSON.stringify(doc), id]
    )
  ).r;
/** 052's soft-delete form, for the without-fix comparison. */
const addr052 = async (doc: unknown, address: string, id = ID): Promise<unknown> =>
  (
    await one<{ r: unknown }>(
      "select public.jsonb_replace_text_value($1::jsonb, $2::text, $3::text) as r",
      [JSON.stringify(doc), address, id]
    )
  ).r;

dbDescribe("T4: review A's reproductions (A-1, A-2)", () => {
  it("A-1a: the purge keeps both of two keys it makes equal (today's form loses one)", async () => {
    const doc = [
      { note: { erased: 1, actorId: { text: "hi" }, [ID]: 2 } },
      ": see above",
    ];
    const today = (await idToday(doc)) as [{ note: Record<string, unknown> }];
    expect(Object.keys(today[0].note)).toHaveLength(2); // a member lost
    const now = (await idRewrite(doc)) as [{ note: Record<string, unknown> }];
    expect(Object.keys(now[0].note)).toHaveLength(3);
    expect(Object.values(now[0].note).sort()).toEqual(expect.arrayContaining([1, 2]));
    expect(JSON.stringify(now)).not.toContain(ID);
  });

  it.each([
    [
      "A-2a",
      {
        actorId: [
          [{ [ID]: null, "ann@x.com": "keep me" }],
          { [ID]: { "joann@x.com": 1, "ann@x.com": "" } },
          ": ",
        ],
      },
    ],
    [
      "A-2b",
      [
        {
          actor: { actorId: "u1" },
          content: [{ seen_by: { "ann@x.com": "read", "bob@x.com": 1 } }, ": )"],
        },
        { actor: { actorId: "u2" }, content: ["bye"] },
      ],
    ],
    ["A-2c", { a: [{ seen_by: { "ann@x.com": "read", "bob@x.com": 1 } }, ": )"] }],
  ])(
    "%s: the soft delete keeps every value and puts no stand-in in place of the document",
    async (_n, doc) => {
      const now = await addrRewrite(doc, "ann@x.com");
      expect(
        oracle(doc, now, (s) => (asciiLower(s) === "ann@x.com" ? ID : s))
      ).toBeNull();
      expect(JSON.stringify(now)).not.toContain("erasure: ");
    }
  );

  it("[without-fix] 052's function on the same documents: a value lost or a stand-in", async () => {
    const outs = await Promise.all(
      [
        {
          actorId: [
            [{ [ID]: null, "ann@x.com": "keep me" }],
            { [ID]: { "joann@x.com": 1, "ann@x.com": "" } },
            ": ",
          ],
        },
        { a: [{ seen_by: { "ann@x.com": "read", "bob@x.com": 1 } }, ": )"] },
      ].map(async (doc) => ({ doc, r: await addr052(doc, "ann@x.com") }))
    );
    expect(
      outs.some(
        ({ doc, r }) =>
          oracle(doc, r, (s) => (asciiLower(s) === "ann@x.com" ? ID : s)) !== null
      )
    ).toBe(true);
  });
});

dbDescribe(
  "T4: an id is matched only where a string or key really holds it (TA-a-1)",
  () => {
    const X = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    it.each([
      [
        "\\f + the rest of an id that starts with f",
        { n: "\f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", other: "kept" },
        "f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
      ],
      [
        "\\u001f + the rest of an id that starts with 1f",
        { n: "\u001fc2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b" },
        "1fc2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
      ],
      [
        "\\u0006 + the rest of an id that starts with 6",
        { n: "\u0006f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b" },
        X,
      ],
      [
        "a key: \\u0006 + the rest",
        { ["\u0006f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"]: 1 },
        X,
      ],
    ])("kept unchanged: %s", async (_label, doc, id) => {
      expect(await idRewrite(doc, id)).toEqual(doc);
    });

    it.each([
      ["after \\n", { n: `\n${X}` }],
      ["after a backslash", { n: "\\" + X }],
      ["after a quote", { n: `"${X}` }],
      ["after \\u0006", { n: `\u0006${X}` }],
      ["upper case", { n: X.toUpperCase() }],
    ])("a real id is still erased: %s", async (_label, doc) => {
      const r = (await idRewrite(doc, X)) as { n: string };
      expect(r.n.toLowerCase()).not.toContain(X);
      expect(r.n).toMatch(/erased$/);
    });

    it("[without-fix] today's form raises on one and silently turns another into a different character", async () => {
      const err = await owner
        .query(
          "select regexp_replace($1::jsonb::text, $2::text, 'erased', 'gi')::jsonb",
          [
            JSON.stringify({ n: "\f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b" }),
            "f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
          ]
        )
        .then(
          () => null,
          (e: { code: string }) => e.code
        );
      expect(err).toBe("22P02");
      const changed = (await idToday(
        { n: "\u0006f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b" },
        X
      )) as { n: string };
      expect(changed.n).not.toBe("\u0006f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b");
    });
  }
);

dbDescribe("T4: the server's settings change nothing (A-4, A-5, RA2-10)", () => {
  it("(A-4) case is folded for ASCII only: ÀNN@X.COM is another address than ànn@x.com", async () => {
    const doc = { to: "ÀNN@X.COM", cc: "ann@x.com", bcc: "ANN@X.COM" };
    const r = (await addrRewrite(doc, "ànn@x.com")) as Record<string, string>;
    expect(r.to).toBe("ÀNN@X.COM");
    const r2 = (await addrRewrite(doc, "ann@x.com")) as Record<string, string>;
    expect(r2).toEqual({ to: "ÀNN@X.COM", cc: ID, bcc: ID });
  });

  it("(A-5) standard_conforming_strings = off: the same results", async () => {
    const docs = [
      { a: "x\\y", b: `"${ID}"`, ["\\" + ID]: 1 },
      { "ann@x.com": "a\\b", c: ["ann@x.com"] },
    ];
    const want = [await idRewrite(docs[0]), await addrRewrite(docs[1], "ann@x.com")];
    // A session that has the setting off before its first call: PL/pgSQL compiles a function's
    // literals once per session, so a session that already ran them would hide a missing pin.
    const off = new Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
    await off.connect();
    // Its first statement (the connection string may carry its own options, as the time-zone pass's does).
    try {
      await off.query(
        "set escape_string_warning = off; set standard_conforming_strings = off"
      );
      expect(
        (
          await off.query<{ v: string }>(
            "select current_setting('standard_conforming_strings') as v"
          )
        ).rows[0].v
      ).toBe("off");
      const got = [
        (
          await off.query("select public.jsonb_erase_id_text($1::jsonb, $2::text) as r", [
            JSON.stringify(docs[0]),
            ID,
          ])
        ).rows[0].r,
        (
          await off.query(
            "select public.jsonb_erase_address_text($1::jsonb, $2::text, $3::text) as r",
            [JSON.stringify(docs[1]), "ann@x.com", ID]
          )
        ).rows[0].r,
      ];
      expect(got).toEqual(want);
    } finally {
      await off.end();
    }
  });
});

dbDescribe(
  "T4: the numbering path runs only when keys would merge — counted by its debug line (B-3, S7)",
  () => {
    const counted = async (sql: string, values: unknown[]) => {
      notices.length = 0;
      await owner.query("begin");
      try {
        await owner.query("set local client_min_messages = debug");
        await owner.query(sql, values);
      } finally {
        await owner.query("rollback");
      }
      return notices.filter((n) => n.endsWith(": keys numbered")).length;
    };

    it("collision-free documents: no 'keys numbered' line; colliding keys: one", async () => {
      expect(
        await counted("select public.jsonb_erase_id_text($1::jsonb, $2)", [
          JSON.stringify({ a: `x ${ID}`, b: [1, 2] }),
          ID,
        ])
      ).toBe(0);
      expect(
        await counted("select public.jsonb_erase_id_text($1::jsonb, $2)", [
          JSON.stringify({ erased: 1, [ID]: 2 }),
          ID,
        ])
      ).toBe(1);
      expect(
        await counted("select public.jsonb_erase_address_text($1::jsonb, $2, $3)", [
          JSON.stringify({ to: "ann@x.com" }),
          "ann@x.com",
          ID,
        ])
      ).toBe(0);
      expect(
        await counted("select public.jsonb_erase_address_text($1::jsonb, $2, $3)", [
          JSON.stringify({ "ann@x.com": 1, [ID]: 2 }),
          "ann@x.com",
          ID,
        ])
      ).toBe(1);
    });
  }
);

// ───────────────────────────── the differential fuzz (reviewer A's f1) ─────────────────────────────

/** A small seeded generator (mulberry32): the same seed, the same documents on every machine. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  const uuid = () => {
    const h = Array.from({ length: 32 }, () => "0123456789abcdef"[int(0, 15)]).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[int(0, 3)]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  return { next, int, pick, uuid };
}

const SPECIAL = [
  '": "',
  '", "',
  '"',
  "\\",
  '\\"',
  '{"a": 1}',
  "]",
  "[",
  "}",
  ": ",
  ", ",
  "#1",
  "#",
  "-",
  " ",
  "é",
  " ",
  "​",
  "“",
  "«",
  "日本",
  "😀",
  "\t",
  "\n",
];
const CTRL = ["\b", "\f", "\u0001", "\u001f", "\u000b", "\u0002"];

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

const KEY_SUFFIX = /^#\d+(?:-[0-9a-f]{12})?$/;

/** The oracle (reviewer A's check): null when `res` is `orig` rewritten by `t`, else why not. */
function oracle(
  orig: unknown,
  res: unknown,
  t: (s: string) => string,
  path = "$"
): string | null {
  if (orig !== null && typeof orig === "object" && !Array.isArray(orig)) {
    if (res === null || typeof res !== "object" || Array.isArray(res))
      return `${path}: object became another type`;
    const o = orig as Record<string, unknown>;
    const remaining = { ...(res as Record<string, unknown>) };
    if (Object.keys(o).length !== Object.keys(remaining).length)
      return `${path}: ${Object.keys(o).length} members became ${Object.keys(remaining).length}`;
    const pending: [string, unknown, string][] = [];
    for (const [k, v] of Object.entries(o)) {
      const tk = t(k);
      if (tk in remaining && oracle(v, remaining[tk], t, `${path}.${k}`) === null)
        delete remaining[tk];
      else pending.push([k, v, tk]);
    }
    for (const [k, v, tk] of pending) {
      const hit = Object.keys(remaining).find(
        (rk) =>
          rk.startsWith(tk) &&
          KEY_SUFFIX.test(rk.slice(tk.length)) &&
          oracle(v, remaining[rk], t, path) === null
      );
      if (hit === undefined) return `${path}: member ${JSON.stringify(k)} not found`;
      delete remaining[hit];
    }
    return null;
  }
  if (Array.isArray(orig)) {
    if (!Array.isArray(res) || res.length !== orig.length)
      return `${path}: array changed`;
    for (let i = 0; i < orig.length; i++) {
      const e = oracle(orig[i], res[i], t, `${path}[${i}]`);
      if (e) return e;
    }
    return null;
  }
  if (typeof orig === "string")
    return res === t(orig)
      ? null
      : `${path}: ${JSON.stringify(orig)} -> ${JSON.stringify(res)}`;
  if (typeof orig === "number")
    return typeof res === "number" && res === orig ? null : `${path}: number changed`;
  return res === orig ? null : `${path}: ${String(orig)} -> ${String(res)}`;
}

/** Reviewer A's documents for one seed: ids with control characters planted ("poison"). */
function corpus(seed: number, nId: number, nAddr: number) {
  const R = rng(seed);
  const mixcase = (s: string) =>
    [...s].map((c) => (R.next() < 0.5 ? c.toUpperCase() : c.toLowerCase())).join("");
  const value = (pool: string[], depth: number): unknown => {
    const r = R.next();
    if (depth <= 0 || r < 0.45) {
      const r2 = R.next();
      if (r2 < 0.55) return R.pick(pool);
      if (r2 < 0.75) return R.pick([0, 1, -1, 2.5, 1e-7, 123456789012, 3.14159]);
      return R.pick([true, false, null]);
    }
    if (r < 0.7) return Array.from({ length: R.int(0, 4) }, () => value(pool, depth - 1));
    return object(pool, depth - 1);
  };
  const object = (pool: string[], depth: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const n = R.int(1, 6);
    for (let i = 0; i < n; i++) out[R.pick(pool)] = value(pool, depth);
    return out;
  };
  const ids: { doc: unknown; id: string }[] = [];
  for (let n = 0; n < nId; n++) {
    const i = R.uuid();
    const up = i.toUpperCase();
    const mc = mixcase(i);
    const pool = [
      i,
      up,
      mc,
      "erased",
      "Erased",
      "ERASED",
      "erased#1",
      "erased#2",
      "erased#1-",
      `x${i}`,
      `${i}y`,
      `pre ${i} post`,
      i + i,
      i.slice(0, -1),
      i.slice(1),
      `erased${i}`,
      `${i}erased`,
      "k",
      "a",
      "b",
      "v",
      `": ${i}`,
      `${i}": "`,
      `"${i}"`,
      "\\" + i,
      `${i}\\`,
    ];
    for (let k = 0; k < 4; k++)
      pool.push(R.pick(SPECIAL) + R.pick([i, up, mc]) + R.pick(SPECIAL));
    for (const c of CTRL) pool.push(c + i.slice(2), c + i.slice(1), `x${c}${i}`);
    ids.push({
      doc: R.next() < 0.85 ? object(pool, R.int(1, 5)) : value(pool, 4),
      id: i,
    });
  }
  const addrs: { doc: unknown; id: string; address: string }[] = [];
  const DOMAINS = ["x.com", "Ex.ample.org", "mail.co", "b.de"];
  const LOCALS = ["ann", "Ann.Lee+news", "bob_o", "zz-top", "a.b.c", "q"];
  for (let n = 0; n < nAddr; n++) {
    const i = R.uuid();
    const a = `${R.pick(LOCALS)}@${R.pick(DOMAINS)}`;
    const [local, dom] = a.split("@");
    const pool = [
      a,
      a.toUpperCase(),
      mixcase(a),
      i,
      i.toUpperCase(),
      `${i}#1`,
      `${i}#2`,
      `${i}#1-`,
      `x${a}`,
      `${a}x`,
      `${local}@${dom.slice(0, -1)}`,
      `mailto:${a}`,
      `${a} `,
      ` ${a}`,
      `<${a}>`,
      "k",
      "a",
      "b",
      `": ${a}`,
      `${a}": "`,
      `"${a}"`,
      `À${a.slice(1)}`,
      a.replace("a", "à"),
      "erased",
    ];
    for (const c of CTRL) pool.push(c + a);
    addrs.push({
      doc: R.next() < 0.85 ? object(pool, R.int(1, 5)) : value(pool, 4),
      id: i,
      address: a,
    });
  }
  return { ids, addrs };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Run one seed through 074's two rewrites (or today's purge form): counts of errors and wrong documents. */
async function fuzz(seed: number, nId: number, nAddr: number, today = false) {
  const { ids, addrs } = corpus(seed, nId, nAddr);
  await owner.query(
    `create or replace function pg_temp.f1_id(d jsonb, i text, old boolean) returns text language plpgsql as $f$
     begin return (case when old then regexp_replace(d::text, i, 'erased', 'gi')::jsonb else public.jsonb_erase_id_text(d, i) end)::text;
     exception when others then return 'ERR:' || sqlstate; end $f$`
  );
  await owner.query(
    `create or replace function pg_temp.f1_addr(d jsonb, a text, i text) returns text language plpgsql as $f$
     begin return public.jsonb_erase_address_text(d, a, i)::text; exception when others then return 'ERR:' || sqlstate; end $f$`
  );
  const stats = {
    err: 0,
    bad: 0,
    idLeftDecoded: 0,
    addrLeft: 0,
    examples: [] as string[],
  };
  const { rows: idOut } = await owner.query<{ r: string }>(
    "select pg_temp.f1_id(d::jsonb, i, $3) as r from unnest($1::text[], $2::text[]) with ordinality u(d, i, n) order by n",
    [ids.map((x) => JSON.stringify(x.doc)), ids.map((x) => x.id), today]
  );
  idOut.forEach(({ r }, n) => {
    const { doc, id } = ids[n];
    if (r.startsWith("ERR:")) {
      stats.err++;
      return;
    }
    const res = JSON.parse(r);
    const re = new RegExp(escapeRe(id), "gi");
    const e = oracle(doc, res, (s) => s.replace(re, "erased"));
    if (e) {
      stats.bad++;
      if (stats.examples.length < 3) stats.examples.push(`seed ${seed} id ${id}: ${e}`);
    }
    const left = (x: unknown): boolean =>
      typeof x === "string"
        ? x.toLowerCase().includes(id)
        : Array.isArray(x)
          ? x.some(left)
          : x !== null && typeof x === "object"
            ? Object.entries(x).some(([k, v]) => k.toLowerCase().includes(id) || left(v))
            : false;
    if (left(res)) stats.idLeftDecoded++;
  });
  if (!today) {
    const { rows: addrOut } = await owner.query<{ r: string }>(
      "select pg_temp.f1_addr(d::jsonb, a, i) as r from unnest($1::text[], $2::text[], $3::text[]) with ordinality u(d, a, i, n) order by n",
      [
        addrs.map((x) => JSON.stringify(x.doc)),
        addrs.map((x) => x.address),
        addrs.map((x) => x.id),
      ]
    );
    addrOut.forEach(({ r }, n) => {
      const { doc, id, address } = addrs[n];
      if (r.startsWith("ERR:")) {
        stats.err++;
        return;
      }
      const al = asciiLower(address);
      const res = JSON.parse(r);
      const e = oracle(doc, res, (s) => (asciiLower(s) === al ? id : s));
      if (e) {
        stats.bad++;
        if (stats.examples.length < 3)
          stats.examples.push(`seed ${seed} address ${address}: ${e}`);
      }
      const left = (x: unknown): boolean =>
        typeof x === "string"
          ? asciiLower(x) === al
          : Array.isArray(x)
            ? x.some(left)
            : x !== null && typeof x === "object"
              ? Object.entries(x).some(([k, v]) => asciiLower(k) === al || left(v))
              : false;
      if (left(res)) stats.addrLeft++;
    });
  }
  return stats;
}

dbDescribe(
  "T4: reviewer A's differential fuzz with control characters planted (TA-a-1, A-1, A-2)",
  () => {
    const RUN_SEED = Number(process.env.FC_SEED ?? "") || 20261117;

    it.each([11, 22, 33, 44, RUN_SEED])(
      "seed %i: no error, no member lost, no character changed, no id or address left decoded",
      async (seed) => {
        const s = await fuzz(seed, 400, 200);
        expect(s.examples).toEqual([]);
        expect({
          err: s.err,
          bad: s.bad,
          idLeftDecoded: s.idLeftDecoded,
          addrLeft: s.addrLeft,
        }).toEqual({
          err: 0,
          bad: 0,
          idLeftDecoded: 0,
          addrLeft: 0,
        });
      },
      120_000
    );

    it("[without-fix] today's purge form on seed 11: errors and wrong documents", async () => {
      const s = await fuzz(11, 400, 0, true);
      expect(s.err + s.bad).toBeGreaterThan(0);
    }, 120_000);
  }
);
