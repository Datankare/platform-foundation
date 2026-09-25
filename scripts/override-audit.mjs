#!/usr/bin/env node
/**
 * TASK-070 — override audit / drift guard.
 *
 * Every key under package.json "overrides" must appear in the override register in
 * docs/SECURITY_DEBT.md (a recorded reason and removal condition). Fails if any override is
 * undocumented, so an override can no longer be added without a rationale, and a stale one is
 * visible rather than silent.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function findUndocumented(overrides, doc) {
  return Object.keys(overrides).filter((key) => !doc.includes(key));
}

function main() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const overrides = pkg.overrides ?? {};
  const doc = readFileSync("docs/SECURITY_DEBT.md", "utf8");
  const undocumented = findUndocumented(overrides, doc);
  if (undocumented.length > 0) {
    console.error(
      "Override audit: undocumented overrides (add to the register in docs/SECURITY_DEBT.md):"
    );
    for (const key of undocumented) console.error(`  ${key}`);
    process.exit(1);
  }
  console.log(
    `Override audit: OK (${Object.keys(overrides).length} overrides, all documented).`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
