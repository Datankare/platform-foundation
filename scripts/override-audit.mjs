#!/usr/bin/env node
/**
 * TASK-070 — override audit / drift guard.
 *
 * Every key under package.json "overrides" must have a row in an override register — the
 * platform's (docs/SECURITY_DEBT.md, "Dependency Overrides") or the app's own
 * (docs/APP_SECURITY_DEBT.md, the same table, consumer-owned and sync-excluded) — giving its
 * reason and removal condition. Fails if any override is undocumented, so an override can no
 * longer be added without a rationale, and a stale one is visible rather than silent.
 *
 * Audit H-12. Before: a key counted as documented when its name appeared anywhere in the file
 * (`postcss` was "documented" by the word `postcss-loader`, or by prose), and an app could not
 * keep a register of its own — SECURITY_DEBT.md is the platform's and the sync overwrites it.
 * Now a key is documented only by a register row whose first cell is exactly that key.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The register files read, platform first; the app's is optional. */
export const REGISTERS = ["docs/SECURITY_DEBT.md", "docs/APP_SECURITY_DEBT.md"];

/**
 * The override keys a register documents: the first cell of each row of the table under its
 * "Dependency Overrides" heading (backticks allowed). Nothing outside that table counts.
 */
export function documentedOverrides(doc) {
  const keys = new Set();
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => /^#{2,3}\s+Dependency Overrides\b/.test(l));
  if (start === -1) return keys;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,3}\s/.test(line)) break;
    if (!line.startsWith("|")) continue;
    const key = (line.split("|")[1] ?? "").trim().replace(/^`/, "").replace(/`$/, "");
    if (!key) continue;
    if (key === "Override" || /^-+$/.test(key)) continue;
    keys.add(key);
  }
  return keys;
}

/** The override keys no register documents (exact keys). */
export function findUndocumented(overrides, docs) {
  const documented = new Set();
  for (const doc of Array.isArray(docs) ? docs : [docs]) {
    for (const key of documentedOverrides(doc)) documented.add(key);
  }
  return Object.keys(overrides).filter((key) => !documented.has(key));
}

function main() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const overrides = pkg.overrides ?? {};
  const docs = REGISTERS.filter((p) => existsSync(p)).map((p) => readFileSync(p, "utf8"));
  const undocumented = findUndocumented(overrides, docs);
  if (undocumented.length > 0) {
    console.error(
      "Override audit: undocumented overrides (add a row to the Dependency Overrides table in docs/SECURITY_DEBT.md, or in an app, docs/APP_SECURITY_DEBT.md):"
    );
    for (const key of undocumented) console.error(`  ${key}`);
    process.exit(1);
  }
  console.log(
    `Override audit: OK (${Object.keys(overrides).length} overrides, all documented).`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
