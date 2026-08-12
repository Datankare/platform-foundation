#!/usr/bin/env node
/**
 * scripts/schema-parity.mjs — does every column a store writes actually exist?
 *
 * Run: npm run schema:check
 *
 * TASK-067. Migration 023 shipped a column that did not exist and the suite stayed green,
 * because a conformance kit's PostgREST fake accepts whatever the store sends — it validates
 * the store against itself (Gotcha 66). Four durable stores were then built on that.
 *
 * Both sides are DERIVED from source. Nothing here is hand-maintained, so there is no
 * manifest to drift out of date — which was the alternative design and would have needed its
 * own coverage test to stay honest.
 *
 * Limit, stated rather than implied: this compares source to source. A migration that was
 * never APPLIED still leaves the live database different from what this reads. That is what
 * applied_migrations (migration 025) is for.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const problems = [];

/**
 * Words that start a TABLE constraint rather than a column. Everything else that looks like
 * `identifier identifier` is a column — the type is not matched against a known list, because
 * these migrations use custom ENUM types (screening_direction, moderation_trigger,
 * content_type), array types (TEXT[]) and two-word types (DOUBLE PRECISION). A fixed list
 * missed all of them and reported the columns as nonexistent, which is the false-confidence
 * failure this check exists to prevent, pointing the other way.
 */
const CONSTRAINT_WORDS = new Set([
  "constraint",
  "primary",
  "unique",
  "foreign",
  "check",
  "exclude",
  "like",
  "partition",
]);

/** SQL comments would otherwise be parsed as column declarations. */
function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((ln) => ln.replace(/--.*$/, ""))
    .join("\n");
}

/** Brace/paren matcher: from an opening delimiter, return the index of its partner. */
function matchDelim(src, start, open, close) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on commas that are not nested inside parentheses. */
function topLevelSplit(body) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

/**
 * Blank out RPC calls before any object literal is read.
 *
 * An RPC body carries FUNCTION PARAMETERS (p_agent_id, p_delta_usd), not columns; reading
 * them reports every parameter as a missing column.
 *
 * Written as a scan rather than one regex: the obvious pattern
 * (/fetchWithTimeout\(...`[\s\S]*?\}\);/) can backtrack polynomially, and a linter that
 * catches that is worth listening to in a script that runs over every file in the repo.
 */
function stripRpcCalls(src) {
  const marker = "/rest/v1/rpc/";
  let out = src;
  for (;;) {
    const at = out.indexOf(marker);
    if (at === -1) return out;
    // Back up to the start of the call expression, forward to its closing paren.
    const start = out.lastIndexOf("fetchWithTimeout(", at);
    if (start === -1) return out.slice(0, at) + out.slice(at + marker.length);
    const open = out.indexOf("(", start);
    const close = matchDelim(out, open, "(", ")");
    if (close === -1) return out.slice(0, at) + out.slice(at + marker.length);
    out = out.slice(0, start) + out.slice(close + 1);
  }
}

/** table -> Set(columns), from CREATE TABLE bodies and ALTER ... ADD COLUMN. */
function columnsFromMigrations() {
  const dir = join(ROOT, "supabase/migrations");
  const out = new Map();
  const add = (table, col) => {
    const t = table.split(".").pop();
    if (!out.has(t)) out.set(t, new Set());
    out.get(t).add(col);
  };

  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = stripSqlComments(readFileSync(join(dir, file), "utf-8"));

    const createRx = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_.]+)\s*\(/gi;
    let m;
    while ((m = createRx.exec(sql)) !== null) {
      const open = sql.indexOf("(", m.index + m[0].length - 1);
      const close = matchDelim(sql, open, "(", ")");
      if (close === -1) continue;
      for (const part of topLevelSplit(sql.slice(open + 1, close))) {
        const p = part.trim().replace(/\s+/g, " ");
        if (!p) continue;
        if (CONSTRAINT_WORDS.has(p.split(" ")[0].toLowerCase().replace(/\($/, "")))
          continue;
        const cm = /^([a-z_]\w*)\s+[a-z_][\w ]*/i.exec(p);
        if (cm) add(m[1], cm[1]);
      }
    }

    const alterRx =
      /alter\s+table\s+([a-z_.]+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_]\w*)/gi;
    while ((m = alterRx.exec(sql)) !== null) add(m[1], m[2]);
  }
  return out;
}

/** Keys of an object literal, one per line — the shape every store body uses. */
function objectKeys(src, openBrace) {
  const close = matchDelim(src, openBrace, "{", "}");
  if (close === -1) return [];
  const body = src.slice(openBrace + 1, close);
  return [...body.matchAll(/^\s*([a-z_]\w*)\s*[,:]/gm)].map((m) => m[1]);
}

/**
 * Columns a multi-table store sends to ONE table.
 *
 * Scoped to the region between this table's URL and the end of that call, so a file writing
 * to groups, group_memberships and group_invites attributes each column to the right one
 * instead of pooling them — which would let a real mismatch hide behind another table's
 * column of the same name.
 */
function columnsForTable(src, table) {
  const cols = new Set();
  const urlRx = new RegExp(`/rest/v1/${table}(?![a-z_])`, "g");
  for (const m of src.matchAll(urlRx)) {
    // The enclosing call: back to fetchWithTimeout(, forward to its closing paren.
    const start = src.lastIndexOf("fetchWithTimeout(", m.index);
    if (start === -1) continue;
    const open = src.indexOf("(", start);
    const close = matchDelim(src, open, "(", ")");
    if (close === -1) continue;
    const region = src.slice(open, close + 1);

    for (const b of region.matchAll(/JSON\.stringify\(\s*\{/g)) {
      const o = region.indexOf("{", b.index + b[0].length - 1);
      for (const k of objectKeys(region, o)) cols.add(k);
    }
    for (const b of region.matchAll(/JSON\.stringify\((\w+)\)/g)) {
      const d = new RegExp(`const ${b[1]}\\s*(?::[^=]+)?=\\s*\\{`).exec(src);
      if (!d) continue;
      const o = src.indexOf("{", d.index + d[0].length - 1);
      for (const k of objectKeys(src, o)) cols.add(k);
    }
    for (const f of region.matchAll(
      /[?&]([a-z_]\w*)=(?:eq|gte|lte|lt|gt|in|is|not)\./g
    )) {
      cols.add(f[1]);
    }
    for (const s of region.matchAll(/select=([a-z_,]+)/g)) {
      for (const c of s[1].split(",")) if (c) cols.add(c);
    }
  }
  return cols;
}

/** file -> { table, columns } for every Supabase-backed store. */
function columnsFromStores() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.includes(".test.")) continue;
      const raw = readFileSync(p, "utf-8");
      if (!raw.includes("/rest/v1/")) continue;

      // An RPC call's body carries FUNCTION PARAMETERS (p_agent_id, p_delta_usd), not
      // columns. Blank those calls out before reading any object literal, or every parameter
      // is reported as a missing column.
      const src = stripRpcCalls(raw);

      // The table: a TABLE constant, or the literal path segment.
      let table = /const TABLE\s*=\s*"([a-z_]+)"/.exec(src)?.[1];
      if (!table) {
        const inline = [...src.matchAll(/\/rest\/v1\/([a-z_]+)/g)].map((m) => m[1]);
        const distinct = [...new Set(inline)].filter((t) => t !== "rpc");
        if (distinct.length > 1) {
          // Several tables in one file. Attribute per method rather than skipping the file:
          // a store that is not checked is exactly the gap this exists to close. Each method
          // body is scanned for the table it targets and the columns it sends.
          for (const t of distinct) {
            const cols = columnsForTable(src, t);
            if (cols.size) {
              out.push({
                file: p.replace(ROOT + "/", ""),
                table: t,
                columns: [...cols].sort(),
              });
            }
          }
          continue;
        }
        if (distinct.length === 0) continue;
        table = distinct[0];
      }

      const cols = new Set();

      // JSON.stringify({ ... })
      for (const m of src.matchAll(/JSON\.stringify\(\s*\{/g)) {
        const open = src.indexOf("{", m.index + m[0].length - 1);
        for (const k of objectKeys(src, open)) cols.add(k);
      }
      // JSON.stringify(name) where `const name = { ... }` is declared above
      for (const m of src.matchAll(/JSON\.stringify\((\w+)\)/g)) {
        const d = new RegExp(`const ${m[1]}\\s*(?::[^=]+)?=\\s*\\{`).exec(src);
        if (!d) continue;
        const open = src.indexOf("{", d.index + d[0].length - 1);
        for (const k of objectKeys(src, open)) cols.add(k);
      }
      // PostgREST filters and explicit selects
      for (const m of src.matchAll(/[?&]([a-z_]\w*)=(?:eq|gte|lte|lt|gt|in|is|not)\./g)) {
        cols.add(m[1]);
      }
      for (const m of src.matchAll(/select=([a-z_,]+)/g)) {
        for (const c of m[1].split(",")) if (c) cols.add(c);
      }

      if (cols.size)
        out.push({ file: p.replace(ROOT + "/", ""), table, columns: [...cols].sort() });
    }
  };
  walk(join(ROOT, "platform"));
  return out;
}

// ── report ────────────────────────────────────────────────────────────
console.log("=".repeat(74));
console.log("Schema parity — do the columns stores write exist in the migrations?");
console.log("=".repeat(74));

const migrations = columnsFromMigrations();
const stores = columnsFromStores();

// Self-test before any absence counts (Gotcha 64).
if (migrations.size < 10) {
  console.error(
    `FATAL: parsed only ${migrations.size} tables from migrations — parser suspect`
  );
  process.exit(2);
}
if (stores.length < 4) {
  console.error(`FATAL: found only ${stores.length} stores — parser suspect`);
  process.exit(2);
}
console.log(`\ntables in migrations: ${migrations.size}   stores: ${stores.length}\n`);

let mismatches = 0;
for (const { file, table, columns } of stores) {
  const known = migrations.get(table);
  if (!known) {
    console.log(`  ${table.padEnd(24)} NO MIGRATION CREATES THIS TABLE  (${file})`);
    problems.push(`${file}: writes to '${table}', which no migration creates`);
    mismatches++;
    continue;
  }
  const unknown = columns.filter((c) => !known.has(c));
  if (unknown.length === 0) {
    console.log(`  ${table.padEnd(24)} ok  (${columns.length} columns)`);
  } else {
    console.log(`  ${table.padEnd(24)} ${unknown.length} UNKNOWN: ${unknown.join(", ")}`);
    problems.push(`${file}: '${table}' has no column(s) ${unknown.join(", ")}`);
    mismatches++;
  }
}

console.log("\n" + "=".repeat(74));
if (problems.length) {
  console.log(`PARITY PROBLEMS — ${problems.length}`);
  for (const p of problems) console.log(`  - ${p}`);
} else {
  console.log("Every column every store writes is created by a migration.");
}
console.log();
console.log(
  "Not checked here: whether each migration was APPLIED. This compares source to"
);
console.log("source; the live database can still differ. See applied_migrations (025).");
console.log();
process.exit(mismatches ? 1 : 0);
