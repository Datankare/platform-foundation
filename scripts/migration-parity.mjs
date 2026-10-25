#!/usr/bin/env node
/**
 * scripts/migration-parity.mjs — does a live database have exactly the repository's migrations?
 *
 * Fixes reached a production database only by a manual step that nothing verified (audit X-24):
 * migration 040 was applied by hand to one project and missing from the other's repository.
 * This compares the migration files in supabase/migrations with the database's own record
 * (applied_migrations, which every migration writes) and fails on any difference:
 *   - a file the database has not recorded (not applied, or applied without its record);
 *   - a record with no file (applied from somewhere else, or a file deleted from the repo).
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (read-only use; never printed).
 * Usage: node scripts/migration-parity.mjs [label]
 * Exit: 0 in parity, 1 on drift, 2 when it cannot check.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

const label = process.argv[2] ?? "database";
const url = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error(`${label}: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required`);
  process.exit(2);
}

// The platform's NNN_<name>.sql and an app's NNN<letter>_<app>_<name>.sql (TASK-158): both are
// recorded in applied_migrations under their file names.
const files = readdirSync(join(process.cwd(), "supabase", "migrations"))
  .filter((f) => /^\d+[a-z]?_.*\.sql$/.test(f))
  .sort();
if (files.length < 10) {
  console.error("Found fewer than 10 migration files — run from the repository root.");
  process.exit(2);
}

let rows;
try {
  const res = await fetch(
    `${url}/rest/v1/applied_migrations?select=filename,confidence&limit=10000`,
    {
      headers: { apikey: key, authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    }
  );
  if (!res.ok) {
    console.error(`${label}: applied_migrations could not be read (HTTP ${res.status})`);
    process.exit(2);
  }
  rows = await res.json();
} catch (e) {
  console.error(`${label}: applied_migrations could not be read (${e.name})`);
  process.exit(2);
}

// A database built from the schema baseline (production, and any new instance) records the
// baseline itself — supabase/baseline/000_baseline.sql — beside the migrations it covers. That
// file is known, so its record is not "extra"; it is never required, because a database built
// from the numbered chain (dev) never ran it (TASK-148, first live run 2026-10-23).
let baselineFiles = new Set();
try {
  baselineFiles = new Set(
    readdirSync(join(process.cwd(), "supabase", "baseline")).filter((f) =>
      /^\d+_.*\.sql$/.test(f)
    )
  );
} catch (e) {
  // A repository without the baseline folder knows no baseline file; anything else is "cannot
  // check" (exit 2), never reported as drift.
  if (e.code !== "ENOENT") {
    console.error(`${label}: supabase/baseline could not be read (${e.code ?? e.name})`);
    process.exit(2);
  }
}

const recorded = new Set(rows.map((r) => r.filename));
const onDisk = new Set(files);
const unapplied = files.filter((f) => !recorded.has(f));
const unknown = [...recorded]
  .filter((f) => !onDisk.has(f) && !baselineFiles.has(f))
  .sort();

// A file recorded "absent" is known not applied (its effect is not in this database). It is in
// parity — the record tells the truth — but it is listed, so it is never mistaken for applied.
const absent = rows
  .filter((r) => r.confidence === "absent" && onDisk.has(r.filename))
  .map((r) => r.filename)
  .sort();
if (absent.length) {
  console.log(
    `ℹ ${label}: ${absent.length} migration(s) recorded as known not applied (absent):`
  );
  for (const f of absent) console.log(`    ${f}`);
}

if (unapplied.length === 0 && unknown.length === 0) {
  console.log(`✓ ${label}: all ${files.length} migrations recorded, none extra`);
  process.exit(0);
}
if (unapplied.length) {
  console.error(
    `✗ ${label}: ${unapplied.length} migration(s) in the repository, not recorded:`
  );
  for (const f of unapplied) console.error(`    ${f}`);
}
if (unknown.length) {
  console.error(`✗ ${label}: ${unknown.length} recorded migration(s) with no file:`);
  for (const f of unknown) console.error(`    ${f}`);
}
process.exit(1);
