#!/usr/bin/env node
/**
 * scripts/check-test-database-copies.mjs — no per-worker database outlives the test passes
 * (TASK-223)
 *
 *   TEST_DATABASE_OWNER_URL=postgresql://…/replay node scripts/check-test-database-copies.mjs
 *
 * Each jest worker of a Layer 1 pass works on its own copy of the replayed database
 * (__tests__/helpers/db-workers.ts, TASK-218); the run that made the copies drops them in its
 * teardown and fails if one is left (TASK-223). A run killed before its teardown cannot; this is
 * the check that sees it: every database named as a copy of TEST_DATABASE_OWNER_URL's database —
 * `<database>_w…`, or `t_<hash>_w…` for a long name, a test's scratch database beside a copy
 * included — is listed, and any one fails the step. CI runs it after the last Layer 1 pass;
 * scripts/test-db.sh after its own.
 *
 * The prefixes are computed as copyPrefixes() computes them (__tests__/db-isolation.test.ts
 * compares the two). Exit: 0 none; 1 some left (named); 2 not configured or unreachable.
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";

/** What every copy of `base` begins with (copyPrefixes in __tests__/helpers/db-workers.ts). */
export function copyPrefixes(base) {
  const h = createHash("sha256").update(base).digest("hex").slice(0, 12);
  return /^[a-z_][a-z0-9_]*$/.test(base) ? [`${base}_w`, `t_${h}_w`] : [`t_${h}_w`];
}

/** The copies of `ownerUrl`'s database still on its server, by name. */
export async function leftCopies(ownerUrl) {
  const url = new URL(ownerUrl);
  const base = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!base) throw new Error("TEST_DATABASE_OWNER_URL names no database");
  url.pathname = "/postgres";
  const c = new pg.Client({ connectionString: url.toString() });
  await c.connect();
  try {
    const { rows } = await c.query(
      `select d.datname as name, coalesce(shobj_description(d.oid, 'pg_database'), '') as mark
         from pg_database d
        where exists (select 1 from unnest($1::text[]) p where starts_with(d.datname::text, p))
        order by d.datname`,
      [copyPrefixes(base)]
    );
    return { base, rows };
  } finally {
    await c.end();
  }
}

async function main() {
  const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
  if (!ownerUrl) {
    console.error("check-test-database-copies: TEST_DATABASE_OWNER_URL is not set");
    process.exit(2);
  }
  let found;
  try {
    found = await leftCopies(ownerUrl);
  } catch (e) {
    console.error(
      `check-test-database-copies: cannot read the server's databases: ${e.message}`
    );
    process.exit(2);
  }
  if (found.rows.length === 0) {
    console.log(`check-test-database-copies: no per-worker copy of ${found.base} left`);
    return;
  }
  console.error(
    `check-test-database-copies: ${found.rows.length} per-worker database(s) of ${found.base} outlived the test passes — a run did not drop its copies (killed before its teardown, or a test's scratch database left beside one):`
  );
  for (const r of found.rows)
    console.error(`  ${r.name}${r.mark ? `  (${r.mark})` : ""}`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
