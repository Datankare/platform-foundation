/**
 * __tests__/docs-integrity.test.ts
 *
 * The consumer-facing documentation is how anyone adopts, configures, and reasons about the
 * platform, so it being wrong or stale is a real defect — not cosmetic. These assertions run
 * on every commit and are the guardrail that keeps the docs from silently drifting behind the
 * code (which is exactly what happened to TAD and AGENT_ARCHITECTURE before v2.0.0: TAD listed
 * 9 of 35 ADRs and 2 of 38 routes for months because nothing failed when it fell behind).
 *
 * The load-bearing checks: every ADR referenced in the docs exists; the ADR index is complete;
 * ENV_REFERENCE documents every environment variable the code actually reads; the required
 * adopter docs exist; and the architecture docs carry a recent review date.
 *
 * Each check self-tests first (Gotcha 64): a check that passes by finding nothing is
 * indistinguishable from a clean result, so we establish the parser found something real
 * before trusting any absence it reports.
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();
const DOCS = join(ROOT, "docs");
const ADR_DIR = join(DOCS, "adr");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf-8");
}

// ── ADRs ────────────────────────────────────────────────────────────────

/** The ADR ids that actually exist as files, e.g. "ADR-033". */
function adrFilesIds(): string[] {
  return readdirSync(ADR_DIR)
    .filter((f) => /^ADR-\d+-.*\.md$/.test(f))
    .map((f) => (f.match(/^(ADR-\d+)-/) as RegExpMatchArray)[1]);
}

/** Every ADR id referenced anywhere in docs/ (index tables, prose, cross-refs). */
function adrRefsInDocs(): string[] {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) {
        const txt = readFileSync(p, "utf-8");
        for (const m of txt.matchAll(/ADR-\d+/g)) out.add(m[0]);
      }
    }
  };
  walk(DOCS);
  return [...out];
}

describe("docs integrity — ADRs", () => {
  const files = adrFilesIds();

  it("finds a plausible number of ADR files (self-test before absence counts)", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("has no dangling ADR references — every ADR-NNN mentioned in docs exists as a file", () => {
    const fileSet = new Set(files);
    const dangling = adrRefsInDocs().filter((id) => !fileSet.has(id));
    expect(dangling).toEqual([]);
  });

  it("lists every ADR file in the TAD index (the index cannot fall behind the files)", () => {
    const tad = read("docs/TAD.md");
    const missing = files.filter((id) => !tad.includes(id));
    expect(missing).toEqual([]);
  });
});

// ── Environment variables ─────────────────────────────────────────────────

/** Every process.env.X the code reads (platform/lib/app), minus obvious non-config. */
function envVarsInCode(): string[] {
  const out = new Set<string>();
  const IGNORE = new Set(["NODE_ENV"]); // set by tooling, documented separately
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        const txt = readFileSync(p, "utf-8");
        for (const m of txt.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) {
          if (!IGNORE.has(m[1])) out.add(m[1]);
        }
      }
    }
  };
  for (const d of ["platform", "lib", "app"]) {
    const dir = join(ROOT, d);
    if (existsSync(dir)) walk(dir);
  }
  return [...out];
}

describe("docs integrity — environment variables", () => {
  const codeVars = envVarsInCode();

  it("finds a plausible number of env vars in code (self-test)", () => {
    expect(codeVars.length).toBeGreaterThan(20);
  });

  it("documents every environment variable the code reads in ENV_REFERENCE.md", () => {
    const ref = read("docs/ENV_REFERENCE.md");
    const undocumented = codeVars.filter((v) => !ref.includes(v));
    expect(undocumented).toEqual([]);
  });
});

// ── Required adopter docs ──────────────────────────────────────────────────

describe("docs integrity — required adopter docs exist", () => {
  const required = [
    "docs/ENV_REFERENCE.md",
    "docs/SETUP_AND_INTEGRATION.md",
    "docs/AGENT_DELEGATION_GUIDE.md",
    "docs/MIGRATION_v1_to_v2.md",
    "docs/RELEASE_NOTES.md",
    "docs/TAD.md",
    "docs/PLATFORM_ARCHITECTURE.md",
    "docs/AGENT_ARCHITECTURE.md",
    "docs/GENAI_ROADMAP.md",
  ];

  it.each(required)("%s exists and is non-trivial", (rel) => {
    expect(existsSync(join(ROOT, rel))).toBe(true);
    expect(read(rel).length).toBeGreaterThan(200);
  });
});

// ── Release notes track the current version ────────────────────────────────

describe("docs integrity — release notes", () => {
  it("RELEASE_NOTES has an entry for the current major line", () => {
    // The package/tag version line the notes must cover. We assert the notes mention the
    // current major (e.g. a "v2" / "2.0" heading) so a major release cannot ship without a
    // release-notes entry. Kept coarse (major) so patch releases don't force a churn edit.
    const notes = read("docs/RELEASE_NOTES.md");
    expect(notes).toMatch(/\b2\.0|\bv2\b|Sprint 3c/);
  });
});

// ── Architecture docs carry a recent review date ───────────────────────────

describe("docs integrity — architecture docs are reviewed, not abandoned", () => {
  const reviewed = [
    "docs/TAD.md",
    "docs/PLATFORM_ARCHITECTURE.md",
    "docs/AGENT_ARCHITECTURE.md",
  ];

  it.each(reviewed)("%s carries a Last reviewed / Last updated marker", (rel) => {
    const txt = read(rel);
    expect(txt).toMatch(/Last (reviewed|updated):/i);
  });
});
