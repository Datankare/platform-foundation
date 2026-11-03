#!/usr/bin/env node
// scripts/migration-checksum.mjs — the checksum a migration records of itself (TASK-197, D-11)
//
// Parity compared file names only (scripts/migration-parity.mjs), so a migration edited after it
// was applied — 052 changed across reviews 8 to 14 — still read as in parity. From migration 063
// each migration records, in its own applied_migrations insert, the checksum of its file:
//
//   checksum = "sha256:" + sha256 of the file's text, with line endings as LF and every
//              its own stamp — the first 'sha256:<64 hex>' literal of its applied_migrations
//              insert, and only that one — replaced by "sha256:" + 64 zeros (review round 1, L5:
//              any other sha256: text in the file is part of what is hashed)
//
// (the file cannot contain its own hash otherwise). Parity then compares what the database
// recorded with the file in the repository: an edit after application is drift.
//
//   node scripts/migration-checksum.mjs <file.sql>           print the file's checksum
//   node scripts/migration-checksum.mjs --write <file.sql>   stamp it into the file's record
//   node scripts/migration-checksum.mjs --check              every stamped migration matches
//
// __tests__/migration-tracking.test.ts requires a matching stamp in every migration from 063.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "supabase", "migrations");
const ZERO = `sha256:${"0".repeat(64)}`;

/**
 * Where a migration's own stamp is: the first 'sha256:<64 hex>' quoted literal after its
 * `insert into … applied_migrations`. Null when it has none.
 */
function stampSpan(text) {
  const insert = text.search(/insert\s+into\s+(?:public\.)?applied_migrations\b/i);
  if (insert < 0) return null;
  const m = /'(sha256:[0-9a-f]{64})'/.exec(text.slice(insert));
  if (!m) return null;
  const start = insert + m.index + 1;
  return { start, end: start + m[1].length, value: m[1] };
}
/** The first migration that records its checksum. */
export const CHECKSUM_FROM = 63;

/** The checksum of a migration's text (its own stamp left out). */
export function migrationChecksum(text) {
  const lf = text.replace(/\r\n/g, "\n");
  const span = stampSpan(lf);
  const canonical = span ? lf.slice(0, span.start) + ZERO + lf.slice(span.end) : lf;
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/** The stamp a migration's text carries (the first), or null. */
export function recordedStamp(text) {
  return stampSpan(text)?.value ?? null;
}

/** Every migration numbered CHECKSUM_FROM or later, with whether its stamp matches. */
export function stampedMigrations(dir = DIR) {
  return readdirSync(dir)
    .filter(
      (f) => /^\d+[a-z]?_.*\.sql$/.test(f) && Number(f.match(/^\d+/)[0]) >= CHECKSUM_FROM
    )
    .sort()
    .map((file) => {
      const text = readFileSync(join(dir, file), "utf8");
      const stamp = recordedStamp(text);
      const sum = migrationChecksum(text);
      return { file, stamp, checksum: sum, matches: stamp === sum };
    });
}

function main(argv) {
  if (argv[0] === "--check") {
    const bad = stampedMigrations().filter((m) => !m.matches);
    for (const m of bad) {
      console.error(
        `✗ ${m.file}: ${m.stamp ? "its recorded checksum is stale" : "records no checksum"} — run node scripts/migration-checksum.mjs --write supabase/migrations/${m.file}`
      );
    }
    if (bad.length === 0)
      console.log("✓ every migration from 063 records its own checksum");
    return bad.length ? 1 : 0;
  }
  const write = argv[0] === "--write";
  const file = write ? argv[1] : argv[0];
  if (!file) {
    console.error("usage: migration-checksum.mjs [--write] <file.sql> | --check");
    return 2;
  }
  const text = readFileSync(file, "utf8");
  const sum = migrationChecksum(text);
  if (!write) {
    console.log(sum);
    return 0;
  }
  if (!recordedStamp(text)) {
    console.error(
      `✗ ${basename(file)} has no 'sha256:…' placeholder in its applied_migrations insert to stamp`
    );
    return 1;
  }
  // Only the record's own stamp is replaced (L5), whatever else in the file looks like one.
  const span = stampSpan(text);
  writeFileSync(file, text.slice(0, span.start) + sum + text.slice(span.end));
  console.log(`${basename(file)} ${sum}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
