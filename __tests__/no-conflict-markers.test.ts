/**
 * __tests__/no-conflict-markers.test.ts
 *
 * @guard a committed merge-conflict marker
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

import { closeSync, fstatSync, openSync, readdirSync, readFileSync } from "node:fs";
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

/** The lines of a file that start with a conflict marker. */
function markerLines(path: string, content: string): string[] {
  if (!MARKERS.some((m) => content.includes(m))) return [];
  return content
    .split("\n")
    .flatMap((line, i) =>
      MARKERS.some((m) => line.startsWith(m))
        ? [`${path}:${i + 1} ${line.slice(0, 40)}`]
        : []
    );
}

describe("repository hygiene", () => {
  it("contains no committed merge-conflict markers", () => {
    const offenders: string[] = [];

    for (const path of walk(ROOT)) {
      // Size check and read go through ONE file descriptor (fstat on the open
      // fd, then read from the same fd) so there is no stat-then-read window —
      // CodeQL: potential file system race condition.
      const fd = openSync(path, "r");
      let content: string;
      try {
        if (fstatSync(fd).size > MAX_FILE_BYTES) continue;
        content = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
      offenders.push(...markerLines(relative(ROOT, path), content));
    }

    expect(offenders).toEqual([]);
  });

  it("[self-test] reports a planted conflict, and not a marker inside a line", () => {
    const planted = [
      "a",
      MARKERS[0] + "HEAD",
      "b",
      MARKERS[1] + "branch",
      `x ${MARKERS[0]}`,
    ].join("\n");
    expect(markerLines("lib/planted.ts", planted)).toEqual([
      `lib/planted.ts:2 ${MARKERS[0]}HEAD`,
      `lib/planted.ts:4 ${MARKERS[1]}branch`,
    ]);
  });
});
