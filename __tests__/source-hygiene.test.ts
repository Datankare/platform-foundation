import fs from "fs";
import path from "path";

/**
 * Source hygiene gate.
 *
 * Two defect classes reached main during Phase 5 Sprint 1 because nothing in CI
 * could see them:
 *
 *  1. `Math.random()` used to mint identifiers (CodeQL high, insecure randomness).
 *     Fixed platform-wide, then reintroduced-by-omission in files that were only
 *     fixed downstream in Playform.
 *  2. Backslash-escaped template placeholders. These are valid TypeScript: they
 *     compile, lint, and format clean, and emit the literal placeholder text at
 *     runtime instead of interpolating. Three existed; only one was ever recorded.
 *     One returned an uninterpolated tool id to API callers.
 *
 * Both are invisible to tsc and eslint, so they get a test instead.
 *
 * NOTE the self-test below. A scanner that silently matches nothing is
 * indistinguishable from a clean tree, and reports success either way. It must
 * prove it can find a control string before its zero-result is trusted.
 */

const REPO_ROOT = path.resolve(__dirname, "..");

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "coverage",
  "dist",
  "build",
  ".turbo",
  ".vercel",
  "out",
]);

const CODE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

// k6 scripts pick test inputs at random; those are not identifiers.
const RANDOM_EXEMPT_DIRS = ["k6"];

const SELF = "__tests__/source-hygiene.test.ts";

interface Hit {
  file: string;
  line: number;
  text: string;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), acc);
    } else if (CODE_EXT.some((ext) => entry.name.endsWith(ext))) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

function scan(
  needle: string,
  opts: { skipComments?: boolean; exemptDirs?: string[] } = {}
): Hit[] {
  const hits: Hit[] = [];
  for (const file of walk(REPO_ROOT)) {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
    if (rel === SELF) continue;
    if (opts.exemptDirs?.includes(rel.split("/")[0])) continue;

    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((text, idx) => {
      if (!text.includes(needle)) return;
      const trimmed = text.trim();
      if (opts.skipComments && (trimmed.startsWith("*") || trimmed.startsWith("//")))
        return;
      hits.push({ file: rel, line: idx + 1, text: trimmed });
    });
  }
  return hits;
}

function format(hits: Hit[]): string {
  return hits.map((h) => `  ${h.file}:${h.line}: ${h.text.slice(0, 140)}`).join("\n");
}

describe("source hygiene", () => {
  it("scanner can find a control string (self-test)", () => {
    // If this fails, every other assertion in this file is meaningless: a broken
    // scanner reports a clean tree. Assert the instrument before the measurement.
    expect(scan("export function generateId").length).toBeGreaterThan(0);
  });

  it("mints no identifiers with Math.random", () => {
    const hits = scan("Math.random", {
      skipComments: true,
      exemptDirs: RANDOM_EXEMPT_DIRS,
    });
    expect(
      hits.length === 0
        ? ""
        : "Math.random is not a source of identifiers. Use generateId() or " +
            `generateSecureId() from platform/agents/utils:\n${format(hits)}`
    ).toBe("");
  });

  it("contains no escaped template placeholders", () => {
    const hits = scan("\\${");
    expect(
      hits.length === 0
        ? ""
        : "Escaped template placeholder emits the literal placeholder text at " +
            `runtime instead of interpolating. Remove the backslash:\n${format(hits)}`
    ).toBe("");
  });
});
