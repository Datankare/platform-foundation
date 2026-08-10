/**
 * __tests__/task-register-integrity.test.ts
 *
 * The task register is the artifact the next sprint plans against, so it being wrong is
 * worse than it being absent. These assertions run on every commit.
 *
 * The load-bearing one is "no dangling references": every TASK-NNN mentioned anywhere in
 * docs/ must have an entry. TASK-069 was cited in three commit messages and in
 * SPRINT2_ASSESSMENT.md before anyone noticed it had never been created — this would have
 * failed the day it was first written down.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();
const TASKS = readFileSync(join(ROOT, "docs/TASKS.md"), "utf-8");

interface Entry {
  id: string;
  title: string;
  body: string;
}

function entries(): Entry[] {
  const out: Entry[] = [];
  const rx = /### (TASK-\d+) — ([^\n]+)\n([\s\S]*?)(?=\n### |\n## |$)/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(TASKS)) !== null) {
    out.push({ id: m[1], title: m[2], body: m[3] });
  }
  return out;
}

function field(body: string, key: string): string {
  const m = body.match(new RegExp(`\\*\\*${key}\\*\\*\\s*\\|\\s*([^|]+)\\|`));
  return m ? m[1].trim() : "";
}

describe("task register integrity", () => {
  const all = entries();

  it("parses a plausible number of entries (self-test before any absence counts)", () => {
    // Gotcha 64: a check that passes by finding nothing is indistinguishable from a clean
    // result. Establish the parser works before trusting anything it reports.
    expect(all.length).toBeGreaterThan(25);
  });

  it("has no duplicate task ids", () => {
    const ids = all.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every entry the required fields", () => {
    const missing = all
      .map((e) => ({
        id: e.id,
        absent: ["Type", "Severity", "Phase", "Status", "Logged"].filter(
          (k) => !field(e.body, k)
        ),
      }))
      .filter((r) => r.absent.length > 0);
    expect(missing).toEqual([]);
  });

  it("matches each entry's ID field to its heading", () => {
    const mismatched = all
      .filter((e) => field(e.body, "ID") && field(e.body, "ID") !== e.id)
      .map((e) => `${e.id} declares ${field(e.body, "ID")}`);
    expect(mismatched).toEqual([]);
  });

  it("gives every Phase 5 task a Target", () => {
    // Phase records where a task was LOGGED; Target records when it is DUE. Conflating them
    // made tasks filed during a sprint read as overdue for it.
    //
    // Scoped to Phase 5: fifteen older entries predate the Target field and carry no triage
    // decision. Asserting on those would fail on day one and teach people to skip the check,
    // which is the failure this test exists to prevent. They gain a Target when triaged.
    const untargeted = all
      .filter((e) => {
        const status = field(e.body, "Status");
        return (
          field(e.body, "Phase").includes("Phase 5") &&
          !/^(?:resolved|closed)/i.test(status) &&
          !/deliberately|reserved/i.test(status) &&
          !field(e.body, "Target")
        );
      })
      .map((e) => e.id);
    expect(untargeted).toEqual([]);
  });

  it("has no dangling task references anywhere in docs/", () => {
    const known = new Set(all.map((e) => e.id));
    // Resolved entries live in the Resolved Items TABLE rather than as headings, and their
    // id shares a cell with descriptive text — so match anywhere in a table row.
    for (const m of TASKS.matchAll(/^\|[^\n]*?\b(TASK-\d+)\b/gm)) known.add(m[1]);
    // And some tasks are tracked outside TASKS.md entirely — TASK-044 and TASK-049 live in
    // SECURITY_DEBT.md, TASK-013 in PHASE3_PLAN.md, TASK-003 in an ADR. That split is itself
    // a finding (TASK-074), but they are tracked, not phantom, so a definition line anywhere
    // in docs/ counts: a table row or a heading that introduces the id rather than merely
    // citing it.
    const defineRx = /^\|[^\n]*?\b(TASK-\d+)\b|^#{2,4}[^\n]*?\b(TASK-\d+)\b/gm;

    const referenced = new Map<string, string[]>();
    const walk = (dir: string): void => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, d.name);
        if (d.isDirectory()) walk(p);
        else if (d.name.endsWith(".md")) {
          const txt = readFileSync(p, "utf-8");
          for (const m of txt.matchAll(/\bTASK-(\d{3})\b/g)) {
            const id = `TASK-${m[1]}`;
            referenced.set(id, [
              ...(referenced.get(id) ?? []),
              p.replace(ROOT + "/", ""),
            ]);
          }
        }
      }
    };
    walk(join(ROOT, "docs"));

    // Second pass: anything DEFINED anywhere in docs/ is tracked, wherever it lives.
    const walkDefs = (dir: string): void => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, d.name);
        if (d.isDirectory()) walkDefs(p);
        else if (d.name.endsWith(".md")) {
          for (const m of readFileSync(p, "utf-8").matchAll(defineRx)) {
            known.add(m[1] ?? m[2]);
          }
        }
      }
    };
    walkDefs(join(ROOT, "docs"));

    const dangling = [...referenced.keys()]
      .filter((id) => !known.has(id))
      .map((id) => `${id} (in ${referenced.get(id)!.join(", ")})`);
    expect(dangling).toEqual([]);
  });

  it("accounts for every gap in the ADR sequence", () => {
    const nums = readdirSync(join(ROOT, "docs/adr"))
      .map((n) => /^ADR-(\d+)/.exec(n))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    const gaps: string[] = [];
    for (let n = 1; n <= nums[nums.length - 1]; n++) {
      if (!nums.includes(n)) {
        const tag = `ADR-${String(n).padStart(3, "0")}`;
        // A gap is acceptable when a task explains it; unexplained, it is a lost decision.
        if (!TASKS.includes(tag)) gaps.push(tag);
      }
    }
    expect(gaps).toEqual([]);
  });
});
