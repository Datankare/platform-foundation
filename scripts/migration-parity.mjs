#!/usr/bin/env node
/**
 * scripts/migration-parity.mjs — does a live database have exactly the repository's migrations?
 *
 * Fixes reached a production database only by a manual step that nothing verified (audit X-24):
 * migration 040 was applied by hand to one project and missing from the other's repository.
 * This compares the migration files in supabase/migrations with the database's own record
 * (applied_migrations, which every migration writes) and fails on any difference:
 *   - a file the database has not recorded (not applied, or applied without its record);
 *   - a record with no file (applied from somewhere else, or a file deleted from the repo);
 *   - TASK-197 (audit D-11): a record whose checksum differs from the file's — the migration was
 *     edited after it was applied (052 changed across reviews 8 to 14 and read as in parity).
 *     Migrations from 063 record their own checksum (scripts/migration-checksum.mjs); a record
 *     from before has none, and is counted, not compared.
 *
 * Env: SUPABASE_URL, SUPABASE_SECRET_KEY (read-only use; never printed).
 *
 * TASK-201: the key is a Supabase secret API key (sb_secret_…, created under Settings → API Keys),
 * sent only as the `apikey` header — Supabase: "Send publishable and secret keys on the apikey
 * header, not on Authorization: Bearer" (https://supabase.com/docs/guides/api/api-keys); a secret
 * key is not a JWT, and it reaches the data as the service_role Postgres role. The legacy
 * service_role JWT (SUPABASE_SERVICE_ROLE_KEY) is no longer read: Supabase retires the legacy keys
 * by the end of 2026 (https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys).
 * A run with only the legacy variable stops, naming the new one.
 *
 * Usage: node scripts/migration-parity.mjs [label]
 * Exit: 0 in parity, 1 on drift, 2 when it cannot check.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { migrationChecksum } from "./migration-checksum.mjs";

/** The migration that adds applied_migrations.checksum. */
const CHECKSUM_MIGRATION = "063_applied_migrations_checksum.sql";

/** A Supabase secret API key's form (the value is never printed). */
const SECRET_KEY = /^sb_secret_[\w-]{16,}$/;

const label = process.argv[2] ?? "database";
const url = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const key = process.env.SUPABASE_SECRET_KEY ?? "";
if (!key && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    `${label}: SUPABASE_SERVICE_ROLE_KEY (the legacy service_role JWT) is no longer read — create a secret key (sb_secret_…) in Supabase → Settings → API Keys and set it as SUPABASE_SECRET_KEY`
  );
  process.exit(2);
}
if (!url || !key) {
  console.error(`${label}: SUPABASE_URL and SUPABASE_SECRET_KEY are required`);
  process.exit(2);
}
if (!SECRET_KEY.test(key)) {
  console.error(
    `${label}: SUPABASE_SECRET_KEY is not a Supabase secret key (sb_secret_…) — a legacy JWT or a publishable key is refused`
  );
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

async function readRecords(select) {
  return fetch(`${url}/rest/v1/applied_migrations?select=${select}&limit=10000`, {
    // The apikey header only: a secret key on Authorization: Bearer is parsed as a JWT (TASK-201).
    headers: { apikey: key },
    signal: AbortSignal.timeout(20_000),
  });
}

let rows;
let hasChecksums = true;
try {
  let res = await readRecords("filename,confidence,checksum");
  if (res.status === 400) {
    // A database before 063 has no checksum column (and 063 then shows as not recorded).
    hasChecksums = false;
    res = await readRecords("filename,confidence");
  }
  if (res.status === 401 || res.status === 403) {
    console.error(
      `${label}: the key was refused (HTTP ${res.status}) — SUPABASE_SECRET_KEY must be a current secret key of this project (Supabase → Settings → API Keys)`
    );
    process.exit(2);
  }
  if (!res.ok) {
    console.error(`${label}: applied_migrations could not be read (HTTP ${res.status})`);
    process.exit(2);
  }
  rows = await res.json();
  // Name-only is right only for a database that never ran 063 (review round 1, L4): one that
  // recorded it has the column, so a failed read of it is "cannot check", never a weaker check.
  if (!hasChecksums && rows.some((r) => r.filename === CHECKSUM_MIGRATION)) {
    console.error(
      `${label}: ${CHECKSUM_MIGRATION} is recorded but the checksums could not be read — cannot check`
    );
    process.exit(2);
  }
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

// TASK-197 (audit D-11): what was applied is what the repository holds.
const edited = [];
let unchecked = 0;
for (const r of rows) {
  if (!onDisk.has(r.filename)) continue;
  if (!hasChecksums || r.checksum === null || r.checksum === undefined) {
    unchecked++;
    continue;
  }
  const text = readFileSync(
    join(process.cwd(), "supabase", "migrations", r.filename),
    "utf8"
  );
  if (migrationChecksum(text) !== r.checksum) edited.push(r.filename);
}
edited.sort();
if (unchecked) {
  console.log(
    `ℹ ${label}: ${unchecked} migration(s) recorded without a checksum (before 063): compared by name only`
  );
}

if (unapplied.length === 0 && unknown.length === 0 && edited.length === 0) {
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
if (edited.length) {
  console.error(
    `✗ ${label}: ${edited.length} migration(s) changed since they were applied (checksum differs):`
  );
  for (const f of edited) console.error(`    ${f}`);
}
process.exit(1);
