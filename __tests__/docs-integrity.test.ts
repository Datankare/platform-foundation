/**
 * __tests__/docs-integrity.test.ts
 *
 * @guard documentation that drifts from the files: ADR references, counts, env vars, the index
 *
 * The consumer-facing documentation is how anyone adopts, configures, and reasons about the
 * platform, so it being wrong or stale is a real defect — not cosmetic. These assertions run
 * on every commit and are the guardrail that keeps the docs from silently drifting behind the
 * code (which is exactly what happened to TAD and AGENT_ARCHITECTURE before v2.0.0: TAD listed
 * 9 of 35 ADRs and 2 of 38 routes for months because nothing failed when it fell behind).
 *
 * The load-bearing checks: every ADR referenced in the docs exists; the ADR index is complete;
 * ENV_REFERENCE (with the app's APP_ENV_REFERENCE) documents every environment variable the code
 * actually reads; the required
 * adopter docs exist; and the architecture docs carry a recent review date.
 *
 * Each check self-tests first (Gotcha 64): a check that passes by finding nothing is
 * indistinguishable from a clean result, so we establish the parser found something real
 * before trusting any absence it reports.
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import {
  ENVIRONMENT_CONTRACT,
  HARNESS_ONLY_SETTINGS,
  SUPABASE_SELECTORS,
  DATABASE_SELECTORS,
} from "@/platform/providers/environment-contract";
import { getModules } from "@/platform/modules";
import { PLATFORM_VERSION } from "@/platform/version";

const ROOT = process.cwd();
const DOCS = join(ROOT, "docs");
const ADR_DIR = join(DOCS, "adr");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf-8");
}

/**
 * The environment reference: the platform's ENV_REFERENCE.md (synced) plus the consuming app's
 * APP_ENV_REFERENCE.md (consumer-owned), so an app documents its own settings without editing a
 * synced file.
 */
function envReference(): string {
  return ["docs/ENV_REFERENCE.md", "docs/APP_ENV_REFERENCE.md"]
    .filter((rel) => existsSync(join(ROOT, rel)))
    .map(read)
    .join("\n");
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

/** The one line that reserves ADR numbers for batches not yet landed (exact form, own line). */
export const RESERVATION_LINE =
  /^Reserved ADR numbers \(batches not yet landed\): (ADR-\d{3}(?:, ADR-\d{3})*)\.$/gm;

/**
 * ADR numbers docs/TASKS.md reserves for a batch not yet landed (TASK-234). Batches land in
 * parallel, so a later number (ADR-061) can exist before earlier ones; task-register-integrity's
 * gap test needs TASKS.md to name each gap, which would otherwise read here as a dangling
 * reference. Only ONE line of the exact form above reserves, and only the numbers on it; each must
 * be a real gap below the last ADR file. A reserved number whose ADR now exists is stale: it is
 * reported (remove it from the line), as an exception that matches nothing is.
 */
export function reservations(
  tasks: string,
  existing: readonly string[]
): { reserved: string[]; problems: string[] } {
  const lines = [...tasks.matchAll(RESERVATION_LINE)];
  const problems: string[] = [];
  if (lines.length > 1) problems.push("more than one reservation line in docs/TASKS.md");
  const last = Math.max(0, ...existing.map((id) => Number(id.slice(4))));
  const reserved: string[] = [];
  for (const id of lines[0]?.[1].split(", ") ?? []) {
    if (existing.includes(id))
      problems.push(`${id} exists now: remove it from the reservation line`);
    else if (Number(id.slice(4)) >= last)
      problems.push(`${id} is not a gap below the last ADR: write the ADR`);
    else reserved.push(id);
  }
  return { reserved: reserved.sort(), problems };
}

describe("docs integrity — ADRs", () => {
  const files = adrFilesIds();

  it("finds a plausible number of ADR files (self-test before absence counts)", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("has no dangling ADR references — every ADR-NNN mentioned in docs exists as a file (or is a reserved gap)", () => {
    const fileSet = new Set(files);
    const r = reservations(read("docs/TASKS.md"), files);
    expect(r.problems).toEqual([]);
    const reserved = new Set(r.reserved);
    const dangling = adrRefsInDocs().filter(
      (id) => !fileSet.has(id) && !reserved.has(id)
    );
    expect(dangling).toEqual([]);
  });

  it("[self-test] only the one structured line reserves; prose, other numbers, stale and non-gap entries do not", () => {
    const existing = ["ADR-056", "ADR-057", "ADR-061"];
    const line =
      "Reserved ADR numbers (batches not yet landed): ADR-058, ADR-059, ADR-060.";
    expect(reservations(`Intro.\n\n${line}\n\nSee ADR-044.`, existing)).toEqual({
      reserved: ["ADR-058", "ADR-059", "ADR-060"],
      problems: [],
    });
    // RB-8's plants: a prose sentence reserves nothing, and names nothing else.
    expect(
      reservations(
        "ADR-058 is reserved for 3a; the decision itself is in ADR-044.",
        existing
      ).reserved
    ).toEqual([]);
    expect(
      reservations(
        "Nothing is reserved for ADR-050 — it was deleted by mistake.",
        existing
      ).reserved
    ).toEqual([]);
    expect(reservations(`  ${line}`, existing).reserved).toEqual([]);
    // Stale: the ADR exists now. Not a gap: above the last ADR.
    expect(
      reservations(
        "Reserved ADR numbers (batches not yet landed): ADR-057, ADR-099.",
        existing
      ).problems
    ).toEqual([
      "ADR-057 exists now: remove it from the reservation line",
      "ADR-099 is not a gap below the last ADR: write the ADR",
    ]);
    expect(reservations(`${line}\n${line}`, existing).problems).toEqual([
      "more than one reservation line in docs/TASKS.md",
    ]);
  });

  it("lists every ADR file in the TAD index (the index cannot fall behind the files)", () => {
    const tad = read("docs/TAD.md");
    const missing = files.filter((id) => !tad.includes(id));
    expect(missing).toEqual([]);
  });
});

describe("docs integrity — README counts match the filesystem (Gotcha 85)", () => {
  // A green docs-integrity run must not be read as "every stated fact is true".
  // The README states counts nothing else validated; pin the two that are pure
  // filesystem facts so they can never silently drift from the tree again.
  const readme = read("README.md");

  it("every ADR count stated in the README equals the ADR file count", () => {
    const n = adrFilesIds().length;
    const stated = [
      ...readme.matchAll(/(\d+)\s+(?:ADRs|Architecture Decision Records)/g),
    ].map((m) => Number(m[1]));
    expect(stated.length).toBeGreaterThan(0); // self-test: the pattern must match
    expect(stated.every((c) => c === n)).toBe(true);
  });

  // TASK-229 (code review B-21): docs/README.md said "57 Architecture Decision Records" with 58
  // files — the root README's count was checked, the docs index's was not.
  it("every ADR count stated in docs/README.md equals the ADR file count", () => {
    const n = adrFilesIds().length;
    const stated = [
      ...read("docs/README.md").matchAll(
        /(\d+)\s+(?:ADRs|Architecture Decision Records)/g
      ),
    ].map((m) => Number(m[1]));
    expect(stated.length).toBeGreaterThan(0);
    expect(stated).toEqual(stated.map(() => n));
  });

  // TASK-229 (code reviews A-13, B-22): comments, tests and migrations cite sections of the
  // batch's design, a document that is not in the repository. docs/JSON_BOUND.md §10 says, for
  // each cited section, what it decided and where the repository writes it: a section cited
  // anywhere without its row there cannot be followed by a reader, and fails here.
  it("every section of the batch design cited in the repository has its row in docs/JSON_BOUND.md §10", () => {
    const CITED = /design 56e-3a[\s*/-]*§(\d+\.\d+)/g;
    const cited = new Map<string, string>();
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(p);
        } else if (/\.(?:md|ts|tsx|sql|sh|mjs|cjs|js|json|yml)$/.test(e.name)) {
          for (const m of readFileSync(p, "utf-8").matchAll(CITED)) {
            if (!cited.has(m[1]!)) cited.set(m[1]!, p.slice(ROOT.length + 1));
          }
        }
      }
    };
    for (const d of [
      "docs",
      "platform",
      "__tests__",
      "scripts",
      "supabase",
      "lib",
      "app",
      "components",
      "e2e",
      "e2e-live",
    ]) {
      if (existsSync(join(ROOT, d))) walk(join(ROOT, d));
    }
    expect(cited.size).toBeGreaterThan(3); // self-test: the citations are found
    expect(cited.has("2.5")).toBe(true); // self-test: one cited across a line break is read
    const table = read("docs/JSON_BOUND.md");
    const without = [...cited].filter(([n]) => !table.includes(`| design 56e-3a §${n} `));
    expect(without).toEqual([]);
  });

  // TASK-194 round 19: PLATFORM_ARCHITECTURE said "52 migrations" when there were 63 — no check
  // read it; round 20: Playform's migration guide said "all 65 migrations recorded". One pattern
  // finds a count however it is worded (round 21, nit 3: the README's check uses it too); the
  // architecture docs and the migration guides state none of their own: they point to the
  // README's, which the check below keeps true.
  const MIGRATION_COUNT = /(\d+)\s+(?:[\w-]+\s+)?migration(?:s| files)\b/g;
  const countsIn = (text: string) => text.match(MIGRATION_COUNT) ?? [];

  it("every migration count stated in the README equals the migration file count", () => {
    const n = readdirSync(join(ROOT, "supabase", "migrations")).filter((f) =>
      f.endsWith(".sql")
    ).length;
    const stated = [...readme.matchAll(MIGRATION_COUNT)].map((m) => Number(m[1]));
    expect(stated.length).toBeGreaterThan(0); // self-test: the pattern must match
    expect(stated.every((c) => c === n)).toBe(true);
    // The capture is the count, however it is worded (round 21, nit 3).
    expect(
      [..."63 SQL migrations; 64 migration files".matchAll(MIGRATION_COUNT)].map(
        (m) => m[1]
      )
    ).toEqual(["63", "64"]);
  });

  it("[self-test] the migration-count pattern finds a count however it is worded", () => {
    expect(countsIn(readme).length).toBeGreaterThan(0); // the README's own
    for (const planted of [
      "63 migrations",
      "63 database migrations",
      "63 SQL migrations",
      "63 migration files",
      "all 65 migrations recorded",
      "73\n migrations",
    ])
      expect(countsIn(planted)).toHaveLength(1);
    for (const clean of ["migration 062", "the migrations in supabase/migrations/"])
      expect(countsIn(clean)).toEqual([]);
  });

  it("the architecture docs and the migration guides state no migration count", () => {
    const guides = readdirSync(DOCS).filter((f) =>
      /^(?:PLAYFORM_)?MIGRATION_.*\.md$/.test(f)
    );
    expect(guides).toContain("MIGRATION_v5_to_v6.md"); // self-test: the guides are read
    const docs = [
      "PLATFORM_ARCHITECTURE.md",
      "TAD.md",
      "AGENT_ARCHITECTURE.md",
      ...guides,
    ]
      .map((f) => join("docs", f))
      .filter((rel) => existsSync(join(ROOT, rel)));
    expect(docs).toContain(join("docs", "PLATFORM_ARCHITECTURE.md"));
    const counted = docs.flatMap((rel) => countsIn(read(rel)).map((m) => `${rel}: ${m}`));
    expect(counted).toEqual([]);
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

  it("documents every environment variable the code reads (ENV_REFERENCE or APP_ENV_REFERENCE)", () => {
    const ref = envReference();
    const undocumented = codeVars.filter((v) => !ref.includes(v));
    expect(undocumented).toEqual([]);
  });

  it("documents every setting the environment contract reads (ADR-050 D2)", () => {
    // The contract reads its settings by name (env[name]), which the process.env scan above
    // cannot see — so its declarations are checked directly.
    const ref = envReference();
    const declared = [
      ...ENVIRONMENT_CONTRACT.flatMap((d) => [d.name, ...d.aliases]),
      ...SUPABASE_SELECTORS,
      ...DATABASE_SELECTORS,
      // The registered modules' provider selectors are read by name too (ADR-054 D4).
      ...getModules().flatMap((m) => m.providers.map((slot) => slot.envVar)),
      ...HARNESS_ONLY_SETTINGS,
      "VERCEL",
    ];
    expect(declared.filter((v) => !ref.includes(`\`${v}\``))).toEqual([]);
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
  it("RELEASE_NOTES has an entry for the platform's current major line", () => {
    // The notes are the platform's, so they track PLATFORM_VERSION — in a consumer,
    // package.json is the app's own version. We assert the notes mention the current major
    // (e.g. a "v2" heading) so a major release cannot ship without a release-notes entry.
    // Kept coarse (major) so patch releases don't force a churn edit.
    const notes = read("docs/RELEASE_NOTES.md");
    const major = Number(PLATFORM_VERSION.split(".")[0]);
    expect(Number.isInteger(major)).toBe(true);
    expect(notes).toMatch(new RegExp(`^## v${major}\\.\\d+\\.\\d+`, "m"));
  });

  it("PLATFORM_VERSION is platform-foundation's package version (bump both together)", () => {
    const pkg = JSON.parse(read("package.json")) as { name: string; version: string };
    // In a consumer the package is the app's: there is nothing to compare, and its version
    // is its own. In platform-foundation the two must agree.
    const expected = pkg.name === "platform-foundation" ? pkg.version : PLATFORM_VERSION;
    expect(PLATFORM_VERSION).toBe(expected);
    expect(PLATFORM_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
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

// ── The documentation index lists every doc ────────────────────────────────

describe("docs integrity — the index covers every document", () => {
  const index = read("docs/README.md");

  /** Every top-level doc under docs/ except the index itself. */
  function topLevelDocs(): string[] {
    return readdirSync(DOCS).filter((f) => f.endsWith(".md") && f !== "README.md");
  }

  it("finds a plausible number of docs (self-test)", () => {
    expect(topLevelDocs().length).toBeGreaterThan(20);
  });

  it("lists every docs/*.md in docs/README.md (add a doc, add its row)", () => {
    const unlisted = topLevelDocs().filter((f) => !index.includes(f));
    expect(unlisted).toEqual([]);
  });
});
