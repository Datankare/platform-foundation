#!/usr/bin/env node
/**
 * scripts/sprint-check.mjs — is the current sprint actually closeable?
 *
 * Run: npm run sprint:check
 *
 * Exists because "the sprint is complete" was asserted from recollection three times in
 * Phase 5 Sprint 2 and was wrong three times. This does not summarise: it queries the
 * artifacts and prints what it finds, and exits non-zero when anything is outstanding.
 *
 * Read-only. Safe to run at any time.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const outstanding = [];
const unverified = [];

function head(t) {
  console.log("\n" + "=".repeat(74) + "\n" + t + "\n" + "=".repeat(74));
}

function field(body, key) {
  // No regex: this file is generated, and a pattern built by string concatenation inside a
  // generated file is one escaping level too many — the previous version emitted \\* and
  // matched a literal backslash. Splitting the row is unambiguous.
  const line = body.split("\n").find((l) => l.includes(`**${key}**`));
  if (!line) return "";
  const cells = line.split("|").map((c) => c.trim());
  return cells.length > 2 ? cells[2] : "";
}

// ── task register ─────────────────────────────────────────────────────
head("1. Task register");
const tasksPath = join(ROOT, "docs/TASKS.md");
const tasksText = readFileSync(tasksPath, "utf-8");
const entries = [];
for (const m of tasksText.matchAll(
  /### (TASK-\d+) — ([^\n]+)\n([\s\S]*?)(?=\n### |\n## |$)/g
)) {
  entries.push({
    id: m[1],
    title: m[2],
    status: field(m[3], "Status"),
    phase: field(m[3], "Phase"),
    target: field(m[3], "Target"),
  });
}
console.log(`entries: ${entries.length}`);
if (entries.length < 25)
  outstanding.push("task register parsed suspiciously few entries");

const resolved = entries.filter((e) => /^(?:resolved|closed)/i.test(e.status));
console.log(`resolved in place: ${resolved.length}`);

// Scoped to Phase 5: older entries predate the Target field and carry no triage decision.
const noTarget = entries.filter(
  (e) =>
    e.phase.includes("Phase 5") &&
    !/^(?:resolved|closed)/i.test(e.status) &&
    !e.target &&
    !/deliberately|reserved/i.test(e.status)
);
console.log(`open with no Target: ${noTarget.length}`);
for (const e of noTarget) {
  console.log(`  ${e.id}  ${e.title.slice(0, 60)}`);
  outstanding.push(`${e.id} has no Target`);
}

const byDecision = entries.filter((e) => /deliberately|reserved/i.test(e.status));
console.log(`open by decision: ${byDecision.length}`);
for (const e of byDecision) console.log(`  ${e.id}  [${e.status.slice(0, 24)}]`);

// ── dangling references: the phantom-task check ───────────────────────
head("2. Dangling task references");
const known = new Set(entries.map((e) => e.id));
// Tracked ids are not all in TASKS.md: 044 and 049 live in SECURITY_DEBT.md, 013 in
// PHASE3_PLAN.md, 003 in an ADR. A definition line anywhere in docs/ counts.
const defineRx = /^\|[^\n]*?\b(TASK-\d+)\b|^#{2,4}[^\n]*?\b(TASK-\d+)\b/gm;
const resolvedTable = new Set([...tasksText.matchAll(defineRx)].map((m) => m[1] ?? m[2]));
const referenced = new Map();
function scanDocs(dir) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) scanDocs(p);
    else if (name.name.endsWith(".md")) {
      const txt = readFileSync(p, "utf-8");
      for (const m of txt.matchAll(/\bTASK-(\d{3})\b/g)) {
        const id = `TASK-${m[1]}`;
        if (!referenced.has(id)) referenced.set(id, new Set());
        referenced.get(id).add(p.replace(ROOT + "/", ""));
      }
    }
  }
}
scanDocs(join(ROOT, "docs"));
function scanDefs(dir) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) scanDefs(p);
    else if (name.name.endsWith(".md"))
      for (const m of readFileSync(p, "utf-8").matchAll(defineRx))
        resolvedTable.add(m[1] ?? m[2]);
  }
}
scanDefs(join(ROOT, "docs"));
const dangling = [...referenced.keys()].filter(
  (id) => !known.has(id) && !resolvedTable.has(id)
);
console.log(`ids referenced in docs: ${referenced.size}   dangling: ${dangling.length}`);
for (const id of dangling) {
  console.log(`  ${id} referenced in: ${[...referenced.get(id)].join(", ")}`);
  outstanding.push(`${id} referenced but has no entry`);
}

// ── ADR sequence ──────────────────────────────────────────────────────
head("3. ADR sequence");
const adrNums = readdirSync(join(ROOT, "docs/adr"))
  .map((n) => /^ADR-(\d+)/.exec(n))
  .filter(Boolean)
  .map((m) => Number(m[1]))
  .sort((a, b) => a - b);
const adrGaps = [];
for (let n = 1; n <= adrNums.at(-1); n++) if (!adrNums.includes(n)) adrGaps.push(n);
console.log(
  `ADRs: ${adrNums.length}   gap(s) at: ${adrGaps.length ? adrGaps.join(", ") : "none"}`
);
for (const g of adrGaps) {
  const tag = `ADR-${String(g).padStart(3, "0")}`;
  const accounted = tasksText.includes(tag);
  console.log(`  ${tag}: ${accounted ? "accounted for by a task" : "UNACCOUNTED"}`);
  if (!accounted) outstanding.push(`${tag} gap with no task`);
}

// ── migrations ────────────────────────────────────────────────────────
head("4. Migrations");
const migs = readdirSync(join(ROOT, "supabase/migrations"))
  .filter((n) => n.endsWith(".sql"))
  .sort();
const migNums = migs.map((n) => Number(/^(\d+)/.exec(n)[1]));
const dupes = [...new Set(migNums.filter((n, i) => migNums.indexOf(n) !== i))];
console.log(
  `files: ${migs.length}   highest: ${Math.max(...migNums)}   ${dupes.length} duplicate number(s): ${dupes.length ? dupes.join(", ") : "none"}`
);
const notSelfRecording = migs.filter(
  (n) =>
    Number(/^(\d+)/.exec(n)[1]) >= 25 &&
    !readFileSync(join(ROOT, "supabase/migrations", n), "utf-8")
      .toLowerCase()
      .includes("insert into applied_migrations")
);
console.log(`migrations >= 025 not self-recording: ${notSelfRecording.length}`);
for (const n of notSelfRecording) outstanding.push(`${n} does not self-record`);
unverified.push(
  "whether each migration is APPLIED — that needs the database, not the filesystem"
);

// ── docs freshness ────────────────────────────────────────────────────
head("5. Documentation");
for (const rel of [
  "docs/ROADMAP.md",
  "docs/GENAI_ROADMAP.md",
  "docs/SECURITY_DEBT.md",
  "README.md",
]) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) {
    console.log(`  MISSING  ${rel}`);
    outstanding.push(`${rel} missing`);
    continue;
  }
  const txt = readFileSync(p, "utf-8");
  const hasFooter = /_Last updated:/.test(txt) || /_Phase \d/.test(txt);
  console.log(`  ${hasFooter ? "ok  " : "NO FOOTER"}  ${rel}`);
  if (!hasFooter) outstanding.push(`${rel} has no footer timestamp`);
}

// ── verdict ───────────────────────────────────────────────────────────
head("VERDICT");
if (outstanding.length) {
  console.log(`OUTSTANDING — ${outstanding.length} item(s):`);
  for (const o of outstanding) console.log(`  - ${o}`);
} else {
  console.log("Nothing outstanding by these checks.");
}
if (unverified.length) {
  console.log(`\nNot verifiable here (${unverified.length}):`);
  for (const u of unverified) console.log(`  - ${u}`);
}
console.log();
process.exit(outstanding.length ? 1 : 0);
