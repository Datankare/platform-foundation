/**
 * @jest-environment node
 */
/**
 * __tests__/db/json-columns.db.test.ts — every jsonb column is registered with what keeps it within
 * the stored-JSON bound (platform TASK-229, ADR-058; design 56e-3a §2.6, T7)
 *
 * @guard a jsonb column with no entry in the register, a file whose SQL writes a registered column
 * and is not named in its row, or a registered writer that no longer calls its check
 *
 * The register (platform/errors/json-columns.ts, and the consuming app's own columns in
 * platform/auth/app-json-columns.ts) is compared with the database's catalogue: every jsonb column
 * of every table in public must be listed once, and nothing listed may be missing. It is compared
 * with the source too (code reviews A-10, B-8: the guard only looked for the call's name anywhere
 * in one named file, a comment included): every file under platform/, lib/, app/, components/ and
 * scripts/ is parsed, and each SQL text in it (a string or template literal, concatenations
 * joined) that inserts into or updates a registered table and names one of its jsonb columns
 * makes that file a writer of the column — it must be named in the column's row (`checked`,
 * `built … files`, or `otherWriters` with its reason). A `checked` entry names the file and the
 * call that checks what it writes: the file must still CALL it (a call expression in the code).
 * What this does not read: SQL assembled at run time from pieces, and a column written only
 * through a SQL function; the database's bound is the floor under both.
 * (The two register files are read only here: __tests__/reachable-modules.test.ts lists them
 * as registers read by this guard.)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Client } from "pg";
import * as ts from "typescript";
import {
  namedWriters,
  PLATFORM_JSON_COLUMNS,
  type JsonColumn,
} from "@/platform/errors/json-columns";
import { APP_JSON_COLUMNS } from "@/platform/auth/app-json-columns";
import { dbDescribe, DB_ENABLED } from "../helpers/db";

const ROOT = join(__dirname, "..", "..");
const REGISTER: readonly JsonColumn[] = [...PLATFORM_JSON_COLUMNS, ...APP_JSON_COLUMNS];

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

/** The jsonb columns of the catalogue (tables in public, not partitions). */
const catalogue = async (): Promise<string[]> =>
  (
    await owner.query<{ c: string }>(
      `select c.relname || '.' || a.attname as c
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid
        where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
          and a.attnum > 0 and not a.attisdropped and a.atttypid = 'jsonb'::regtype
        order by 1`
    )
  ).rows.map((r) => r.c);

/** Register entries against catalogue columns: what is missing either way. */
export function registerDrift(
  register: readonly JsonColumn[],
  columns: readonly string[]
) {
  const listed = register.map((r) => r.column);
  return {
    unregistered: columns.filter((c) => !listed.includes(c)),
    notInDatabase: listed.filter((c) => !columns.includes(c)),
    twice: listed.filter((c, i) => listed.indexOf(c) !== i),
  };
}

/** Where application SQL lives: every source file under these (tests apart). */
const SOURCE_DIRS = ["platform", "lib", "app", "components", "scripts"];

/** Every source file under SOURCE_DIRS, from the repository root. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "__tests__") walk(p);
      } else if (/\.(?:ts|tsx|mjs|cjs|js)$/.test(e.name) && !/\.test\./.test(e.name)) {
        out.push(relative(ROOT, p));
      }
    }
  };
  for (const d of SOURCE_DIRS) if (existsSync(join(ROOT, d))) walk(join(ROOT, d));
  return out.sort();
}

/** The registered jsonb columns of each table: { table: [column, …] }. */
const columnsByTable = (register: readonly JsonColumn[]): Record<string, string[]> => {
  const by: Record<string, string[]> = {};
  for (const r of register) {
    const [table, column] = r.column.split(".");
    (by[table] ??= []).push(column);
  }
  return by;
};

/**
 * The registered columns `source` writes in SQL: for each string or template literal (a `+`
 * concatenation taken whole), each `insert into <table>` / `update <table> … set` of a registered
 * table makes the file a writer of every jsonb column of that table named after it in the text.
 */
export function columnsWrittenIn(
  source: string,
  file: string,
  tables: Readonly<Record<string, readonly string[]>>
): string[] {
  if (!/\b(?:insert\s+into|update)\s/i.test(source)) return [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const done = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      let top: ts.Node = node;
      while (
        top.parent &&
        ts.isBinaryExpression(top.parent) &&
        top.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
      )
        top = top.parent;
      if (!done.has(top)) {
        done.add(top);
        const sql = top.getText(sf);
        const write = /\b(insert\s+into|update)\s+(?:only\s+)?(?:public\.)?([a-z_]+)\b/gi;
        for (let m = write.exec(sql); m; m = write.exec(sql)) {
          const table = m[2].toLowerCase();
          const columns = tables[table];
          if (!columns) continue;
          const rest = sql.slice(m.index + m[0].length);
          if (/^update/i.test(m[1]) && !/^\s+(?:as\s+)?(?:[a-z_]+\s+)?set\b/i.test(rest))
            continue;
          for (const c of columns)
            if (new RegExp(`(?<![a-z_.])"?${c}"?(?![a-z_])`, "i").test(rest))
              found.add(`${table}.${c}`);
        }
      }
      if (ts.isStringLiteralLike(node)) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...found].sort();
}

/** Whether `source` calls `call` in its code: a call expression `call(…)` or `x.call(…)`. */
export function callsIn(source: string, file: string, call: string): boolean {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let yes = false;
  const visit = (node: ts.Node): void => {
    if (yes) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        (ts.isIdentifier(callee) && callee.text === call) ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === call)
      ) {
        yes = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return yes;
}

/** Writers the source has that the register does not name: "table.column: file". */
export function unnamedWriters(
  register: readonly JsonColumn[],
  sources: readonly { file: string; text: string }[]
): string[] {
  const tables = columnsByTable(register);
  const named = new Map(register.map((r) => [r.column, new Set(namedWriters(r))]));
  const out: string[] = [];
  for (const { file, text } of sources)
    for (const column of columnsWrittenIn(text, file, tables))
      if (!named.get(column)?.has(file)) out.push(`${column}: ${file}`);
  return out.sort();
}

describe("the register's shape (no database)", () => {
  it("every entry names its maximum and what keeps it", () => {
    for (const r of REGISTER) {
      expect(r.column).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(r.max.length).toBeGreaterThan(3);
      if ("checked" in r.keeper) expect(r.keeper.checked.length).toBeGreaterThan(0);
      else expect(r.keeper.built.length).toBeGreaterThan(10);
      for (const w of r.otherWriters ?? []) expect(w.why.length).toBeGreaterThan(10);
    }
  });

  it("every checked writer's file still makes its call", () => {
    const lost: string[] = [];
    for (const r of REGISTER)
      if ("checked" in r.keeper)
        for (const w of r.keeper.checked)
          if (!callsIn(readFileSync(join(ROOT, w.file), "utf8"), w.file, w.call))
            lost.push(`${r.column}: ${w.file} no longer calls ${w.call}`);
    expect(lost).toEqual([]);
  });

  it("every file whose SQL writes a registered column is named in that column's row", () => {
    const sources = sourceFiles().map((file) => ({
      file,
      text: readFileSync(join(ROOT, file), "utf8"),
    }));
    expect(sources.length).toBeGreaterThan(100);
    expect(unnamedWriters(REGISTER, sources)).toEqual([]);
    // And every file a row names exists.
    const gone = REGISTER.flatMap((r) =>
      namedWriters(r)
        .filter((f) => !existsSync(join(ROOT, f)))
        .map((f) => `${r.column}: ${f}`)
    );
    expect(gone).toEqual([]);
  });

  it("[self-test] a writer file the register does not name is found; a named one is not; a read is not a write", () => {
    const register: JsonColumn[] = [
      {
        column: "notes.body",
        max: "small",
        keeper: {
          checked: [{ file: "platform/notes/store.ts", call: "assertStorableJson" }],
        },
        otherWriters: [{ file: "platform/notes/erase.ts", why: "an erasure's rewrite" }],
      },
    ];
    const sources = [
      {
        file: "platform/notes/store.ts",
        text: 'tx.query("insert into notes (id, body) values ($1, $2::jsonb)", [id, body]);',
      },
      {
        file: "platform/notes/erase.ts",
        text: "tx.query(`update notes set body = jsonb_erase_id_text(body, $1::text) where id = $2`);",
      },
      {
        // The planted case: a second writer, in another file, that no row names.
        file: "platform/notes/import.ts",
        text: 'const sql =\n  "insert into public.notes (id, " +\n  "body) values ($1, $2::jsonb)";',
      },
      {
        file: "platform/notes/read.ts",
        text: 'tx.query("select body from notes where id = $1"); // update notes set body = 1',
      },
      {
        // Writes the table, not its jsonb column.
        file: "platform/notes/touch.ts",
        text: 'tx.query("update notes set updated_at = now() where id = $1");',
      },
    ];
    expect(unnamedWriters(register, sources)).toEqual([
      "notes.body: platform/notes/import.ts",
    ]);
  });

  it("[self-test] a checked file whose call was removed is found, though a comment still names it", () => {
    const withCall =
      'import { assertStorableJson } from "x";\nexport function put(v: unknown) { assertStorableJson(v, "t.c"); }';
    const without =
      'import { assertStorableJson } from "x";\n// assertStorableJson(v, "t.c") was here\nexport function put(v: unknown) { return v; }';
    expect(callsIn(withCall, "a.ts", "assertStorableJson")).toBe(true);
    expect(callsIn(without, "a.ts", "assertStorableJson")).toBe(false);
    // The earlier test — the text "name(" anywhere in the file — passed both.
    expect(without.includes("assertStorableJson(")).toBe(true);
  });

  it("[self-test] the drift check finds a column missing either way, and a duplicate", () => {
    const r = [
      { column: "a.x", max: "small", keeper: { built: "the platform's own fields" } },
      { column: "a.x", max: "small", keeper: { built: "the platform's own fields" } },
      { column: "b.y", max: "small", keeper: { built: "the platform's own fields" } },
    ];
    expect(registerDrift(r, ["a.x", "c.z"])).toEqual({
      unregistered: ["c.z"],
      notInDatabase: ["b.y"],
      twice: ["a.x"],
    });
  });
});

dbDescribe("T7: the register is the catalogue (every jsonb column, once)", () => {
  it("no jsonb column unregistered, nothing registered that the database lacks", async () => {
    expect(registerDrift(REGISTER, await catalogue())).toEqual({
      unregistered: [],
      notInDatabase: [],
      twice: [],
    });
  });

  it("[without-fix] a jsonb column added by a migration with no register entry is found", async () => {
    await owner.query("begin");
    try {
      await owner.query("alter table public.jobs add column t7_extra jsonb");
      expect(registerDrift(REGISTER, await catalogue()).unregistered).toEqual([
        "jobs.t7_extra",
      ]);
    } finally {
      await owner.query("rollback");
    }
  });
});
