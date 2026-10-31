/**
 * @jest-environment node
 */
/**
 * __tests__/status-lifecycle-registry.test.ts — the status-lifecycle register holds to the code
 * (TASK-193; the register: platform/assurance/status-lifecycle.ts)
 *
 * Every state of every status column is classified there. This test holds each classification to
 * the code: a reaper names a job kind the platform runs and a function that exists, tagged
 * `@scheduled <kind>` (or the job runner itself); a bound is a governed setting a migration seeds,
 * a column, or a constant the code exports; every other kind carries its reason. Its database half
 * (__tests__/db/status-lifecycle.db.test.ts) holds the register to the schema and ages one row in
 * each reaped state.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  NOT_A_LIFECYCLE,
  STATUS_LIFECYCLE,
  type StateLifecycle,
} from "@/platform/assurance/status-lifecycle";
import { CORE_JOBS } from "@/platform/jobs/duties";

const ROOT = process.cwd();
const MIGRATIONS = readdirSync(join(ROOT, "supabase/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(ROOT, "supabase/migrations", f), "utf8"))
  .join("\n");
const KINDS = new Set(CORE_JOBS.map((j) => j.kind));

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "__tests__") sources(p, out);
    } else if (/\.ts$/.test(e.name)) out.push(readFileSync(p, "utf8"));
  }
  return out;
}
const PLATFORM_SOURCES = sources(join(ROOT, "platform"));

const entries: [string, string, StateLifecycle][] = Object.entries(
  STATUS_LIFECYCLE
).flatMap(([column, states]) =>
  Object.entries(states).map(([state, l]): [string, string, StateLifecycle] => [
    column,
    state,
    l,
  ])
);

/** The JSDoc block right before `export … function <name>` in `src`. */
function docOf(src: string, name: string): string | undefined {
  const at = src.search(new RegExp(`export (?:async )?function ${name}\\b`));
  if (at < 0) return undefined;
  const before = src.slice(0, at);
  const open = before.lastIndexOf("/**");
  return open >= 0 ? before.slice(open) : "";
}

describe("the status-lifecycle register (TASK-193)", () => {
  it("covers the columns the audit found without a way out (self-test)", () => {
    expect(Object.keys(STATUS_LIFECYCLE)).toEqual(
      expect.arrayContaining([
        "agent_trajectories.status",
        "proposals.status",
        "config_pending_approvals.status",
        "users.parental_consent_status",
      ])
    );
    expect(entries.length).toBeGreaterThan(40);
  });

  it.each(entries.filter(([, , l]) => "reaper" in l))(
    "%s = %s: its reaper is a job the platform runs, through a function tagged with it",
    (_column, _state, l) => {
      const r = l as Extract<StateLifecycle, { reaper: string }>;
      const [file, fn] = r.fn.split("#");
      expect(existsSync(join(ROOT, file))).toBe(true);
      const doc = docOf(readFileSync(join(ROOT, file), "utf8"), fn);
      expect([r.fn, doc !== undefined]).toEqual([r.fn, true]);
      if (r.reaper === "the job runner") return;
      expect([r.reaper, KINDS.has(r.reaper)]).toEqual([r.reaper, true]);
      expect([r.fn, doc!.includes(`@scheduled ${r.reaper}`)]).toEqual([r.fn, true]);
    }
  );

  it.each(entries.filter(([, , l]) => "reaper" in l))(
    "%s = %s: its bound is a seeded setting, a column or a constant the code exports",
    (_column, _state, l) => {
      const bound = (l as Extract<StateLifecycle, { bound: string }>).bound.split(" ")[0];
      let known: boolean;
      if (/^[A-Z][A-Z0-9_]+$/.test(bound)) {
        known = PLATFORM_SOURCES.some((src) => src.includes(`export const ${bound}`));
      } else if (MIGRATIONS.includes(`'${bound}'`)) {
        known = true; // a governed setting a migration seeds
      } else {
        // A column: `table.column`, or a column of the state's own table.
        const column = bound.includes(".") ? bound.split(".")[1] : bound;
        known = new RegExp(`\\b${column}\\s+(?:timestamptz|timestamp|TIMESTAMPTZ)`).test(
          MIGRATIONS
        );
      }
      expect([bound, known]).toEqual([bound, true]);
    }
  );

  it("every state that is not reaped says why", () => {
    const missing = entries
      .filter(([, , l]) => !("reaper" in l))
      .filter(([, , l]) => {
        const why = "rest" in l ? l.rest : "reason" in l ? l.reason : "";
        return why.trim().length < 10;
      })
      .map(([c, s]) => `${c}=${s}`);
    expect(missing).toEqual([]);
    for (const [column, why] of Object.entries(NOT_A_LIFECYCLE)) {
      expect([column, why.length > 10]).toEqual([column, true]);
    }
  });

  it("a reaped state a person normally ends first says who, and where (review round 1, L6)", () => {
    // The states where a person is expected to act: the reaper is their backstop, not the way out.
    const personFirst = [
      "agent_trajectories.status=paused",
      "agent_trajectories.status=awaiting_retry",
      "agent_trajectories.status=indeterminate",
      "proposals.status=proposed",
      "proposals.status=approved",
      "users.parental_consent_status=pending",
    ];
    const without = personFirst.filter((k) => {
      const [column, state] = k.split("=");
      const l = STATUS_LIFECYCLE[column]?.[state];
      return !l || !("reaper" in l) || (l.waitsOn ?? "").trim().length < 10;
    });
    expect(without).toEqual([]);
    // And no state a crash or a lease leaves claims a person.
    expect(
      (STATUS_LIFECYCLE["agent_trajectories.status"].running as { waitsOn?: string })
        .waitsOn
    ).toBeUndefined();
  });

  it("a deferred state names the finding or task that closes it", () => {
    const deferred = entries.filter(([, , l]) => "deferred" in l);
    for (const [c, s, l] of deferred) {
      expect([
        `${c}=${s}`,
        /\b(?:[A-Z]-\d+|TASK-\d+)\b/.test((l as { deferred: string }).deferred),
      ]).toEqual([`${c}=${s}`, true]);
    }
  });
});
