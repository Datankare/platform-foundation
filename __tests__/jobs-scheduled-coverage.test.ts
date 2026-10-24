/**
 * @jest-environment node
 */
/**
 * __tests__/jobs-scheduled-coverage.test.ts — every timed duty is a registered job
 * (ADR-056 D3, TASK-141)
 *
 * The defect this closes: functions documented as scheduled (the escalation reaper, claim
 * release, strike expiry, the GDPR purge, the scheduled agents) that nothing ran. Now a function
 * that runs on a schedule says so with a JSDoc tag — `@scheduled <kind>` — and this test fails:
 *
 *   1. when a tagged function names a kind no job declares (documented as scheduled, never run);
 *   2. when a tagged kind's job has no schedule, or a registered job has none (and is not listed
 *      below as run on demand, with the reason);
 *   3. when a recurring job has no tagged function (a schedule nobody documents);
 *   4. when a recurring job's governed settings — jobs.<kind>.enabled and
 *      jobs.<kind>.interval_minutes — are not seeded by a migration, or the seed's default and
 *      bounds differ from the job's own fallbacks;
 *   5. when a comment outside platform/jobs says something runs as a "cron job", a "scheduled
 *      job" or "on a schedule" without a tag — the way the old duties were described.
 *
 * A module's tags count when the module is registered (test:core runs with none).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  listJobDefinitions,
  listScheduledJobs,
  scheduleKeys,
} from "@/platform/jobs/registry";
import { getModules } from "@/platform/modules";
import { productionSources, read, ROOT } from "./helpers/route-policy";

const { loadManifest, zoneOf } = require("../scripts/module-manifest.cjs");

/** Job kinds run only when code enqueues them (no schedule), each with the reason. */
const ON_DEMAND_KINDS: Readonly<Record<string, string>> = {};

const TAG = /@scheduled\s+([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)/g;
const UNTAGGED_PHRASE =
  /\bcron job\b|\bscheduled job\b|\bruns? on (?:a )?schedule\b|\bon a schedule\b/i;

const manifest = loadManifest();
const registered = new Set(getModules().map((m) => m.id));

/** Comment blocks of a source: each /* … *\/ and each run of // lines. */
function commentBlocks(src: string): string[] {
  const blocks = [...src.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => m[0]);
  let run: string[] = [];
  for (const line of src.split("\n")) {
    const m = /^\s*\/\/(.*)$/.exec(line);
    if (m) run.push(m[1]);
    else if (run.length) {
      blocks.push(run.join("\n"));
      run = [];
    }
  }
  if (run.length) blocks.push(run.join("\n"));
  return blocks;
}

interface Tag {
  readonly kind: string;
  readonly file: string;
}

/** Every @scheduled tag in the production sources of the core and registered modules. */
function tags(): Tag[] {
  const out: Tag[] = [];
  for (const file of productionSources()) {
    const owner: string | null = zoneOf(manifest, file);
    if (owner && !registered.has(owner)) continue;
    for (const block of commentBlocks(read(file))) {
      for (const m of block.matchAll(TAG)) out.push({ kind: m[1], file });
    }
  }
  return out;
}

/** Every migration's text, the core's and every module's (a module's seeds its own keys). */
function migrations(): string {
  const dir = join(ROOT, "supabase", "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf-8"))
    .join("\n");
}

/** The seed row for a key: its value, default, min and max as written. */
function seed(sql: string, key: string): string[] | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(
    `\\(\\s*'${escaped}'\\s*,\\s*'([^']*)'\\s*,\\s*'([^']*)'\\s*,[\\s\\S]*?'jobs'\\s*,\\s*'(\\w+)'\\s*,\\s*(null|'[^']*')\\s*,\\s*(null|'[^']*')`
  ).exec(sql);
  return m ? [m[1], m[2], m[3], m[4], m[5]] : null;
}

const TAGS = tags();
const DEFS = listJobDefinitions();
const SCHEDULED = listScheduledJobs();

describe("every timed duty is a registered job (ADR-056 D3)", () => {
  it("finds the tags and the jobs (self-test before any absence counts)", () => {
    expect(TAGS.length).toBeGreaterThanOrEqual(9);
    expect(SCHEDULED.length).toBeGreaterThanOrEqual(9);
  });

  it("every function documented as scheduled names a registered job", () => {
    const kinds = new Set(DEFS.map((d) => d.kind));
    expect(TAGS.filter((t) => !kinds.has(t.kind))).toEqual([]);
  });

  it("every documented kind's job has a schedule, and so does every registered job", () => {
    const tagged = new Set(TAGS.map((t) => t.kind));
    const unscheduled = DEFS.filter(
      (d) => !d.schedule && (tagged.has(d.kind) || !ON_DEMAND_KINDS[d.kind])
    ).map((d) => d.kind);
    expect(unscheduled).toEqual([]);
    for (const [kind, reason] of Object.entries(ON_DEMAND_KINDS)) {
      expect({
        kind,
        registered: DEFS.some((d) => d.kind === kind),
        reason: reason.length > 10,
      }).toEqual({ kind, registered: true, reason: true });
    }
  });

  it("every recurring job is documented on the function it runs", () => {
    const tagged = new Set(TAGS.map((t) => t.kind));
    expect(SCHEDULED.filter((d) => !tagged.has(d.kind)).map((d) => d.kind)).toEqual([]);
  });

  it("every recurring job's settings are seeded, with its own defaults and bounds", () => {
    const sql = migrations();
    const problems: string[] = [];
    for (const def of SCHEDULED) {
      const keys = scheduleKeys(def.kind);
      const enabled = seed(sql, keys.enabled);
      const interval = seed(sql, keys.interval);
      if (!enabled) problems.push(`${keys.enabled}: not seeded`);
      else if (enabled[0] !== "true" || enabled[2] !== "boolean") {
        problems.push(`${keys.enabled}: seeded as ${enabled.join(",")}`);
      }
      if (!interval) {
        problems.push(`${keys.interval}: not seeded`);
        continue;
      }
      const s = def.schedule;
      const want = [
        String(s.defaultIntervalMinutes),
        String(s.defaultIntervalMinutes),
        "number",
        `'${s.minIntervalMinutes}'`,
        `'${s.maxIntervalMinutes}'`,
      ];
      if (interval.join("|") !== want.join("|")) {
        problems.push(
          `${keys.interval}: seeded ${interval.join(",")}, job says ${want.join(",")}`
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it("no comment describes a timed duty without its tag", () => {
    const offenders: string[] = [];
    for (const file of productionSources()) {
      if (file.startsWith("platform/jobs/")) continue;
      for (const block of commentBlocks(read(file))) {
        if (UNTAGGED_PHRASE.test(block) && !/@scheduled\s/.test(block))
          offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the scan itself (self-tests)", () => {
  it("reads tags from block and line comments, and finds untagged descriptions", () => {
    const src =
      "/**\n * Sweep.\n *\n * @scheduled a.b-c\n */\nfunction x() {}\n// runs on a schedule\nconst y = 1;";
    const blocks = commentBlocks(src);
    expect(blocks.flatMap((b) => [...b.matchAll(TAG)].map((m) => m[1]))).toEqual([
      "a.b-c",
    ]);
    expect(
      blocks.filter((b) => UNTAGGED_PHRASE.test(b) && !/@scheduled\s/.test(b))
    ).toHaveLength(1);
  });

  it("reads a seed row's value, default, type and bounds", () => {
    const sql =
      "  ('jobs.x.interval_minutes', '15', '15',\n   'text, with commas',\n   'jobs', 'number', '5', '60', 'safety'),";
    expect(seed(sql, "jobs.x.interval_minutes")).toEqual([
      "15",
      "15",
      "number",
      "'5'",
      "'60'",
    ]);
    expect(seed(sql, "jobs.y.interval_minutes")).toBeNull();
  });
});
