/**
 * __tests__/no-conflict-markers.test.ts
 *
 * Sprint 7 — gate guard: no committed merge-conflict markers.
 *
 * The standard quality gate is blind to conflict markers in files nothing
 * imports or tests (docs especially): tsc/eslint/jest never read them, and
 * prettier happily formats marker lines as markdown (a ">>>>>>>" line is a
 * blockquote). Sprint 7 shipped exactly this failure: a merge commit landed
 * with markers in docs/ENGINEERING_LEARNINGS.md and the gate stayed green.
 *
 * This test walks the repo (excluding build/dependency dirs) and fails on any
 * line opening with a git conflict marker. Detection uses "<<<<<<< ",
 * ">>>>>>> " and "||||||| " (diff3) — NOT a bare "=======", which is
 * legitimate markdown setext syntax; a real conflict always includes the
 * unambiguous markers.
 *
 * The marker strings are constructed at runtime so this file never matches
 * itself.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "coverage",
  "dist",
  "build",
  "out",
  "playwright-report",
  "test-results",
]);

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".css",
  ".html",
  ".sql",
  ".sh",
  ".txt",
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;

// Constructed so this file does not match itself.
const MARKERS = ["<".repeat(7) + " ", ">".repeat(7) + " ", "|".repeat(7) + " "];

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      yield* walk(join(dir, entry.name));
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(extensionOf(entry.name))) {
      yield join(dir, entry.name);
    }
  }
}

describe("repository hygiene", () => {
  it("contains no committed merge-conflict markers", () => {
    const offenders: string[] = [];

    for (const path of walk(ROOT)) {
      if (statSync(path).size > MAX_FILE_BYTES) continue;
      const content = readFileSync(path, "utf8");
      if (!MARKERS.some((m) => content.includes(m))) continue;

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (MARKERS.some((m) => lines[i].startsWith(m))) {
          offenders.push(`${relative(ROOT, path)}:${i + 1} ${lines[i].slice(0, 40)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
