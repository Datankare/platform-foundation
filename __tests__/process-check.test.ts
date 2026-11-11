/**
 * @jest-environment node
 */
/**
 * __tests__/process-check.test.ts — scripts/process-check.mjs, the engineering-process check CI
 * runs on every push and pull request (TASK-200, rules 1, 6 and 7)
 *
 * @guard a code change without its task's design check and self-review, or a route test without hostile cases
 *
 * Each case builds a scratch repository, commits into it as a change would, and runs the script as
 * CI runs it (`--base <ref>`): a code or workflow commit that names no task, a task entry whose
 * Design check or Self-review is missing or unanswered, an entry the change does not touch, a
 * route test file without its hostile cases, a merge that carries code of its own, a revert that
 * is no exact inverse, a baseline raised by hand — and what passes: a complete entry, an adopted
 * commit, a true revert, the commits made before the rule, sync and Dependabot commits.
 */
import { execFileSync, spawnSync } from "child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

const SCRIPT = join(process.cwd(), "scripts/process-check.mjs");

const COMPLETE_DESIGN = [
  "**Design check**",
  "",
  "- **Reach:** admins and the operator; agents through the command bar; guests never.",
  "- **Races:** two approvals at once: the row lock serialises them, the second is stale.",
  "- **Dependencies down:** the database down answers service.unavailable, nothing is written.",
  "- **Erasure leftovers:** none: the change stores no personal data in a new place.",
  "- **Screens × responses:** the Users screen handles 200, 403, 409 and 503, each tested.",
  "- **Journeys touched:** journey C (users search), updated in the same change.",
  "- **Weakens a tenant's protection?** No: a value ignored before is still ignored.",
].join("\n");
const COMPLETE_REVIEW = [
  "**Self-review**",
  "",
  "- **Consumers checked:** components/admin/UsersPanel.tsx and the command bar's search handler.",
  "- **Hostile re-read:** read as a tenant admin aiming at another tenant; nothing reaches it.",
].join("\n");

function entry(id: string, blocks: string): string {
  return [
    `### ${id} — Planted`,
    "",
    "| Field | Detail |",
    "| --- | --- |",
    `| **ID** | ${id} |`,
    "",
    "The work.",
    "",
    blocks,
    "",
  ].join("\n");
}

class Repo {
  readonly dir = mkdtempSync(join(tmpdir(), "process-check-"));
  constructor() {
    this.git("init", "-q", "-b", "develop");
    this.git("config", "user.email", "t@example.com");
    this.git("config", "user.name", "T");
    this.git("config", "commit.gpgsign", "false");
  }
  git(...args: string[]): string {
    return execFileSync("git", args, { cwd: this.dir, encoding: "utf8" }).trim();
  }
  write(files: Record<string, string>): void {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(this.dir, p)), { recursive: true });
      writeFileSync(join(this.dir, p), text);
    }
  }
  /** The rule's own file, as a commit after the rule carries it. */
  withRule(): void {
    mkdirSync(join(this.dir, "scripts"), { recursive: true });
    copyFileSync(SCRIPT, join(this.dir, "scripts/process-check.mjs"));
  }
  commit(subject: string, files: Record<string, string>, remove: string[] = []): string {
    this.write(files);
    for (const p of remove) rmSync(join(this.dir, p), { force: true });
    this.git("add", "-A");
    this.git("commit", "-q", "-m", subject);
    return this.git("rev-parse", "HEAD");
  }
  /** The check over this repository, as CI runs it (`env`: more of the environment). */
  check(base: string, extra: string[] = [], env: Record<string, string> = {}) {
    const r = spawnSync("node", [SCRIPT, "--base", base, ...extra], {
      cwd: this.dir,
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: "", ...env },
    });
    return {
      code: r.status,
      errors: r.stderr
        .split("\n")
        .filter((l) => l.startsWith("::error::"))
        .map((l) => l.slice(9)),
      out: r.stdout,
    };
  }

  done(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** A repository whose base already has the rule and a register. */
function started(): { repo: Repo; base: string } {
  const repo = new Repo();
  repo.withRule();
  const base = repo.commit("chore: start", {
    "docs/TASKS.md":
      "# Task Registry\n\n## Open Items\n\n" +
      entry("TASK-900", "Old.") +
      "\n## Resolved\n",
    "platform/a.ts": "export const a = 1;\n",
  });
  return { repo, base };
}

const ADD_ENTRY = (id: string, blocks: string) =>
  "# Task Registry\n\n## Open Items\n\n" +
  entry("TASK-900", "Old.") +
  "\n" +
  entry(id, blocks) +
  "\n## Resolved\n";

describe("scripts/process-check.mjs (TASK-200)", () => {
  it("[self-test] refuses a code commit that names no task", () => {
    const { repo, base } = started();
    repo.commit("fix: something", { "platform/a.ts": "export const a = 2;\n" });
    const r = repo.check(base);
    expect(r.code).toBe(1);
    expect(r.errors).toEqual([
      expect.stringMatching(/"fix: something" changes code but names no task/),
    ]);
    repo.done();
  });

  it("[self-test] refuses an entry without its blocks, an unanswered field and a placeholder", () => {
    const { repo, base } = started();
    const partial = COMPLETE_DESIGN.replace(/- \*\*Races:\*\*.*\n/, "").replace(
      /(- \*\*Journeys touched:\*\*).*/,
      "$1 TBD"
    );
    repo.commit("fix: a thing (TASK-901)", {
      "platform/a.ts": "export const a = 2;\n",
      "docs/TASKS.md": ADD_ENTRY("TASK-901", partial),
    });
    const r = repo.check(base);
    expect(r.code).toBe(1);
    expect(r.errors).toEqual([
      'TASK-901 "Design check": "Races" is missing',
      'TASK-901 "Design check": "Journeys touched" is not answered (4 words or more, not a placeholder)',
      'TASK-901 has no "Self-review" block',
    ]);
    // A placeholder of four words or more (a shorter answer already fails on its length) — one
    // that starts with a marker, or holds an unfilled template slot — refused; prose that names a
    // marker, or one in a code span, is not (round 6: TASK-200's own entry says "todo" and
    // "`hostile:<tag> n/a`").
    for (const [answer, refused] of [
      ["TBD — will fill in later", true],
      ["to be decided after the review", true],
      ["<describe who reaches it here>", true],
      ["it reaches <who> and nobody else", true],
      ["TODO: write this up properly", true],
      ["n/a for this change entirely", true],
      ["... the change is fine", true],
      ["the change ... is fine overall", false],
      ["a skipped, todo or failing test", false],
      ["the `hostile:<tag> n/a: <reason>` waiver is read", false],
      ["it is to be determined by the owner", false],
      ["none: the change stores no personal data", false],
      ["the todos list page and its store", false],
      ["returns a Promise<void> to every caller", false],
    ] as const) {
      repo.git("reset", "-q", "--hard", base);
      repo.commit("fix: a thing (TASK-901)", {
        "platform/a.ts": "export const a = 2;\n",
        "docs/TASKS.md": ADD_ENTRY(
          "TASK-901",
          `${COMPLETE_DESIGN.replace(/(- \*\*Races:\*\*).*/, `$1 ${answer}`)}\n\n${COMPLETE_REVIEW}`
        ),
      });
      expect([answer, repo.check(base).errors]).toEqual([
        answer,
        refused
          ? [
              'TASK-901 "Design check": "Races" is not answered (4 words or more, not a placeholder)',
            ]
          : [],
      ]);
    }
    repo.done();
  });

  it("[self-test] refuses a task the register does not have, and one the change does not touch", () => {
    const { repo, base } = started();
    repo.commit("fix: a thing (TASK-902, TASK-900)", {
      "app/api/x/route.ts": "export {};\n",
    });
    const r = repo.check(base);
    expect(r.errors).toEqual([
      'TASK-900 has no "Design check" block',
      'TASK-900 has no "Self-review" block',
      "TASK-900: the change does not touch its entry in docs/TASKS.md (record the work there)",
      "TASK-902 is named by a commit but has no entry in docs/TASKS.md (add one, with its Design check and Self-review)",
    ]);
    repo.done();
  });

  it("passes a code commit whose task entry is complete and touched", () => {
    const { repo, base } = started();
    repo.commit("feat: the thing (TASK-903)", {
      "lib/b.ts": "export const b = 1;\n",
      "docs/TASKS.md": ADD_ENTRY("TASK-903", `${COMPLETE_DESIGN}\n\n${COMPLETE_REVIEW}`),
    });
    expect(repo.check(base)).toMatchObject({ code: 0, errors: [] });
    repo.done();
  });

  it("an answer may wrap onto the next lines", () => {
    const { repo, base } = started();
    const wrapped = COMPLETE_DESIGN.replace(
      "- **Reach:** admins and the operator; agents through the command bar; guests never.",
      "- **Reach:**\n  admins and the operator; agents\n  through the command bar."
    );
    repo.commit("feat: the thing (TASK-904)", {
      "lib/b.ts": "export const b = 1;\n",
      "docs/TASKS.md": ADD_ENTRY("TASK-904", `${wrapped}\n\n${COMPLETE_REVIEW}`),
    });
    expect(repo.check(base)).toMatchObject({ code: 0, errors: [] });
    repo.done();
  });

  it("[self-test] a change to docs or tests alone needs no task; a workflow change names one", () => {
    const { repo, base } = started();
    repo.commit("docs: wording", {
      "docs/X.md": "x\n",
      "__tests__/x.test.ts": "it('x', () => {});\n",
    });
    expect(repo.check(base)).toMatchObject({ code: 0, errors: [] });
    const wf = repo.commit("ci: a step", { ".github/workflows/a.yml": "a: 1\n" });
    expect(repo.check(base).errors).toEqual([
      `${wf.slice(0, 7)} "ci: a step" changes the process's own files but names no task: end its subject with (TASK-nnn) — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${wf.slice(0, 7)}"`,
    ]);
    repo.done();
  });

  it("does not judge the commits made before the rule existed", () => {
    const repo = new Repo();
    const base = repo.commit("chore: start", { "docs/TASKS.md": "# Task Registry\n" });
    repo.commit("fix: an old change", { "platform/a.ts": "export const a = 1;\n" });
    // The commit that brings the rule is judged by it.
    repo.withRule();
    repo.commit("ci: the rule", { "platform/a.ts": "export const a = 2;\n" });
    const r = repo.check(base);
    expect(r.errors).toEqual([
      expect.stringMatching(/"ci: the rule" changes code but names no task/),
    ]);
    repo.done();
  });

  it("[self-test] refuses a route test file without its hostile cases, takes tags or a reasoned waiver", () => {
    const { repo, base } = started();
    const routeTest = (cases: string) =>
      `import { POST } from "@/app/api/x/route";\n${cases}\n`;
    repo.commit("test: route tests", {
      "__tests__/x-route.test.ts": routeTest(
        'it("[hostile:role] a guest is refused", () => {});\nit("[hostile:self] own account", () => {});'
      ),
      "__tests__/y-route.test.ts": routeTest(
        [
          'it("[hostile:role] x", () => {});',
          'it("[hostile:self] x", () => {});',
          'it("[hostile:store-down] x", () => {});',
          "// hostile:id-spelling n/a: the route takes no id at all",
        ].join("\n")
      ),
      "__tests__/z-plain.test.ts": 'it("adds", () => {});\n',
    });
    const r = repo.check(base);
    expect(r.errors).toEqual([
      '__tests__/x-route.test.ts drives a route and lacks [hostile:store-down], [hostile:id-spelling] (a test title tag, or a comment "hostile:<tag> n/a: <reason>")',
    ]);
    repo.done();
  });

  it("a waiver needs a reason of four words or more", () => {
    const { repo, base } = started();
    repo.commit("test: route test", {
      "__tests__/w-route.test.ts": [
        'import { GET } from "../app/api/w/route";',
        'it("[hostile:role] x", () => {}); it("[hostile:self] x", () => {});',
        'it("[hostile:store-down] x", () => {});',
        "// hostile:id-spelling n/a: none",
      ].join("\n"),
    });
    expect(repo.check(base).errors).toEqual([
      expect.stringMatching(
        /w-route\.test\.ts drives a route and lacks \[hostile:id-spelling\]/
      ),
    ]);
    repo.done();
  });

  it("[self-test] a waiver's reason is on its own line, and a tag counts only in a running test's title", () => {
    const { repo, base } = started();
    repo.commit("test: route tests", {
      "__tests__/v-route.test.ts": [
        'import { GET } from "@/app/api/v/route";',
        "// hostile:role n/a:",
        'const reasonStolenFromThisLine = "the next line is not a reason";',
        '// it("[hostile:self] commented out", () => {});',
        'it.skip("[hostile:store-down] skipped", () => {});',
        'xit("[hostile:id-spelling] skipped too", () => {});',
        'it.todo("[hostile:role] not written");',
      ].join("\n"),
      "__tests__/u-route.test.ts": [
        "const load = (p: string) => import(`@/app/api/${p}/route`);",
        'describe("[hostile:role] every caller", () => {',
        '  it.each([1])("[hostile:self] %s", () => {});',
        "  test(`[hostile:store-down] ${1}`, () => {});",
        "});",
        "/* hostile:id-spelling n/a: the route takes no id at all */",
      ].join("\n"),
      "__tests__/t-route.test.ts": [
        "const route = await import(`../app/api/t/${name}/route`);",
        'it("no tags", () => {});',
      ].join("\n"),
    });
    expect(repo.check(base).errors).toEqual([
      expect.stringMatching(
        /^__tests__\/t-route\.test\.ts drives a route and lacks \[hostile:role\], \[hostile:self\], \[hostile:store-down\], \[hostile:id-spelling\]/
      ),
      expect.stringMatching(
        /^__tests__\/v-route\.test\.ts drives a route and lacks \[hostile:role\], \[hostile:self\], \[hostile:store-down\], \[hostile:id-spelling\]/
      ),
    ]);
    repo.done();
  });
});

const SYNC = (sha: string) => `chore(sync): inherit platform-foundation main @ ${sha}`;

describe("scripts/process-check.mjs: reverts, helpers and baselines (TASK-200)", () => {
  it("[self-test] a revert passes by touching its entry, removing it or restoring it; reverting the rule does not", () => {
    const { repo, base } = started();
    // A revert that restores the entry exactly as before the reverted commit (an old entry, no blocks).
    const reverted = repo.commit("fix: change (TASK-900)", {
      "platform/a.ts": "export const a = 2;\n",
      "docs/TASKS.md": ADD_ENTRY(
        "TASK-950",
        `${COMPLETE_DESIGN}\n\n${COMPLETE_REVIEW}`
      ).replace("The work.", "The work, changed."),
    });
    const at = repo.git("rev-parse", "HEAD");
    repo.git("revert", "--no-edit", reverted);
    const errorsFor = (from: string) =>
      repo.check(from).errors.filter((e) => /TASK-900/.test(e));
    expect(errorsFor(at)).toEqual([]);
    // A revert that removes the entry a commit added.
    repo.git("reset", "-q", "--hard", base);
    const adds = repo.commit("feat: new (TASK-951)", {
      "platform/a.ts": "export const a = 3;\n",
      "docs/TASKS.md": ADD_ENTRY("TASK-951", `${COMPLETE_DESIGN}\n\n${COMPLETE_REVIEW}`),
    });
    repo.git("revert", "--no-edit", adds);
    expect(repo.check(adds).errors).toEqual([]);
    // A revert that leaves the entry as it was, untouched by the revert: the old rule.
    repo.git("reset", "-q", "--hard", base);
    const other = repo.commit("fix: code only (TASK-900)", {
      "platform/a.ts": "export const a = 4;\n",
    });
    repo.commit(
      'Revert "fix: code only (TASK-900)"\n\nThis reverts commit ' + other + ".",
      {
        "platform/a.ts": "export const a = 1;\n",
      }
    );
    // TASK-900's entry is as it was before `other` (no blocks): restored exactly, so it passes.
    expect(errorsFor(other)).toEqual([]);
    // A "revert" that changes something else is no revert: the old rule applies.
    repo.git("reset", "-q", "--hard", other);
    repo.commit(`Revert "fix: code only (TASK-900)"\n\nThis reverts commit ${other}.`, {
      "platform/a.ts": "export const a = 1;\n",
      "lib/smuggled.ts": "export const s = 1;\n",
    });
    expect(errorsFor(other)).toEqual([
      'TASK-900 has no "Design check" block',
      'TASK-900 has no "Self-review" block',
      "TASK-900: the change does not touch its entry in docs/TASKS.md (record the work there)",
    ]);
    // Reverting the rule itself is no true revert: its task is judged.
    repo.git("reset", "-q", "--hard", base);
    repo.commit(
      'Revert "ci: the rule (TASK-200)"\n\nThis reverts commit ' + base + ".",
      {},
      ["scripts/process-check.mjs"]
    );
    expect(repo.check(base).errors).toEqual([
      "TASK-200 is named by a commit but has no entry in docs/TASKS.md (add one, with its Design check and Self-review)",
    ]);
    repo.done();
  });

  it("[self-test] a test that drives a route through a helper is a route test", () => {
    const { repo } = started();
    const base = repo.commit("test: a helper (TASK-900)", {
      "__tests__/helpers/calls.ts":
        'export { POST } from "@/app/api/x/route";\nimport "@/app/api/x/route";\n',
      "__tests__/helpers/plain.ts": "export const x = 1;\n",
    });
    repo.commit("test: through the helper", {
      "__tests__/through.test.ts":
        'import { POST } from "./helpers/calls";\nit("calls", () => {});\n',
      "__tests__/alias.test.ts":
        'import { POST } from "@/__tests__/helpers/calls";\nit("calls", () => {});\n',
      "__tests__/plain.test.ts":
        'import { x } from "./helpers/plain";\nit("plain", () => {});\n',
    });
    expect(repo.check(base).errors).toEqual([
      expect.stringMatching(/^__tests__\/alias\.test\.ts drives a route and lacks/),
      expect.stringMatching(/^__tests__\/through\.test\.ts drives a route and lacks/),
    ]);
    repo.done();
  });

  it("[self-test] refuses a ratchet baseline loosened by hand", () => {
    const { repo } = started();
    const base = repo.commit("chore: baselines", {
      "body-schema-baseline.json": JSON.stringify({
        count: 3,
        files: { "a.ts": 2, "b.ts": 1 },
      }),
      "fake-fetch-baseline.json": JSON.stringify({
        count: 2,
        files: { "x.test.tsx": { count: 2, reason: "written before the rule here" } },
      }),
      "open-input-register.json": JSON.stringify({
        count: 1,
        entries: { "a.ts#v": "why" },
      }),
      "refusal-coverage-baseline.json": JSON.stringify({
        count: 1,
        gaps: ["a -> /b : c"],
      }),
      "screen-literal-baseline.json": JSON.stringify({ count: 10 }),
      "coverage-baseline.json": JSON.stringify({
        margin: 1,
        baseline: { statements: 90, lines: 90, functions: 90, branches: 80 },
      }),
    });
    // Lowering every one passes.
    repo.commit("chore: lower", {
      "body-schema-baseline.json": JSON.stringify({ count: 2, files: { "a.ts": 2 } }),
      "screen-literal-baseline.json": JSON.stringify({ count: 9 }),
      "coverage-baseline.json": JSON.stringify({
        margin: 0.5,
        baseline: { statements: 91, lines: 90, functions: 90, branches: 80 },
      }),
    });
    expect(repo.check(base)).toMatchObject({ code: 0, errors: [] });
    repo.commit("chore: raise", {
      "body-schema-baseline.json": JSON.stringify({
        count: 4,
        files: { "a.ts": 3, "c.ts": 1 },
      }),
      "fake-fetch-baseline.json": JSON.stringify({
        count: 2,
        files: {
          "x.test.tsx": { count: 2, reason: "r" },
          "y.test.tsx": { count: 0, reason: "r" },
        },
      }),
      "open-input-register.json": JSON.stringify({
        count: 2,
        entries: { "a.ts#v": "why", "a.ts#w": "why not" },
      }),
      "refusal-coverage-baseline.json": JSON.stringify({
        count: 1,
        gaps: ["a -> /b : d"],
      }),
      "screen-literal-baseline.json": JSON.stringify({ count: 11 }),
      "coverage-baseline.json": JSON.stringify({
        margin: 2,
        baseline: { statements: 90, lines: 89.5, functions: 90 },
      }),
    });
    expect(repo.check(base).errors).toEqual([
      "body-schema-baseline.json: count 4, the base has 3 — it only shrinks",
      "body-schema-baseline.json: a.ts 3, the base has 2",
      "body-schema-baseline.json: c.ts added — the base does not list it, and the total rises (4 > 3); fix the new findings instead, or remove the key",
      // y.test.tsx is new at zero: the total does not rise, but no file of the base went with it.
      "fake-fetch-baseline.json: y.test.tsx added — the base does not list it, and no key it could replace went with its file (deleted or renamed in this change); fix the new findings instead, or remove the key",
      "open-input-register.json: count 2, the base has 1 — it only shrinks",
      "open-input-register.json: a.ts#w added — the base does not list it, and the total rises (2 > 1); fix the new findings instead, or remove the key",
      "refusal-coverage-baseline.json: gap added — a -> /b : d",
      "screen-literal-baseline.json: count 11, the base has 10 — it only shrinks",
      "coverage-baseline.json: the lines floor 89.5, the base has 90 — floors only rise",
      "coverage-baseline.json: the branches floor is missing",
      "coverage-baseline.json: the margin 2, the base has 1 — it never rises",
    ]);
    repo.commit("chore: drop one", {}, ["screen-literal-baseline.json"]);
    expect(repo.check(base).errors).toContain(
      "screen-literal-baseline.json: removed — a ratchet baseline stays (lower it to zero instead)"
    );
    repo.done();
  });

  it("[self-test] a file renamed keeps its count under its new name, never more", () => {
    const { repo } = started();
    const body = "export const long = 1;\n".repeat(20);
    const base = repo.commit("chore: baselines", {
      "lib/old.ts": body,
      "components/OldPanel.tsx": body,
      "app/api/old/route.ts": body,
      "body-schema-baseline.json": JSON.stringify({
        count: 2,
        files: { "lib/old.ts": 2 },
      }),
      "refusal-coverage-baseline.json": JSON.stringify({
        count: 2,
        gaps: [
          "components/OldPanel.tsx -> /api/x : a.b",
          "components/Other.tsx -> /api/old : c.d",
        ],
      }),
    });
    repo.git("mv", "lib/old.ts", "lib/new.ts");
    repo.git("mv", "components/OldPanel.tsx", "components/NewPanel.tsx");
    mkdirSync(join(repo.dir, "app/api/new"), { recursive: true });
    repo.git("mv", "app/api/old/route.ts", "app/api/new/route.ts");
    repo.commit("refactor: rename (TASK-900)", {
      "body-schema-baseline.json": JSON.stringify({
        count: 2,
        files: { "lib/new.ts": 2 },
      }),
      "refusal-coverage-baseline.json": JSON.stringify({
        count: 2,
        gaps: [
          "components/NewPanel.tsx -> /api/x : a.b",
          "components/Other.tsx -> /api/new : c.d",
        ],
      }),
    });
    const baselineErrors = () =>
      repo.check(base).errors.filter((e) => /baseline\.json/.test(e));
    expect(baselineErrors()).toEqual([]);
    repo.commit("chore: more under the new name", {
      "body-schema-baseline.json": JSON.stringify({
        count: 2,
        files: { "lib/new.ts": 3 },
      }),
    });
    expect(baselineErrors()).toEqual([
      "body-schema-baseline.json: lib/new.ts 3, the base has 2 (as lib/old.ts)",
    ]);
    repo.done();
  });

  it("[self-test] a revert of a commit off the base is no revert; one of a commit on it is", () => {
    const { repo, base } = started();
    // A side branch: P makes app/x.ts evil, X makes it clean. Not on the range's base.
    repo.git("checkout", "-q", "-b", "side");
    repo.commit("feat: evil", { "app/x.ts": "export const x = 'EVIL';\n" });
    const x = repo.commit("fix: clean", { "app/x.ts": "export const x = 'clean';\n" });
    repo.git("checkout", "-q", "develop");
    repo.commit("feat: x (TASK-900)", { "app/x.ts": "export const x = 'clean';\n" });
    const at = repo.git("rev-parse", "HEAD");
    // No task in its subject: only a true revert may go without one.
    repo.commit(`Revert "side X"\n\nThis reverts commit ${x}.`, {
      "app/x.ts": "export const x = 'EVIL';\n",
    });
    expect(repo.check(at).errors).toEqual([
      expect.stringMatching(/"Revert "side X"" changes code but names no task/),
    ]);
    // The same revert of a commit that is on the base passes.
    repo.git("reset", "-q", "--hard", base);
    repo.git("merge", "-q", "--ff-only", "side");
    const onBase = repo.git("rev-parse", "HEAD");
    repo.git("revert", "--no-edit", x);
    expect(repo.check(onBase).errors).toEqual([]);
    expect(base).not.toBe(onBase);
    repo.done();
  });

  it("[self-test] GitHub's Revert of a merged pull request passes when it undoes the merge exactly", () => {
    const { repo, base } = started();
    repo.git("checkout", "-q", "-b", "feature");
    repo.commit("feat: the feature (TASK-951)", {
      "lib/feature.ts": "export const f = 1;\n",
      "docs/TASKS.md": ADD_ENTRY("TASK-951", `${COMPLETE_DESIGN}\n\n${COMPLETE_REVIEW}`),
    });
    repo.git("checkout", "-q", "develop");
    repo.commit("docs: meanwhile", { "docs/meanwhile.md": "m\n" });
    repo.git(
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "Merge pull request #12 from x/feature",
      "feature"
    );
    const merged = repo.git("rev-parse", "HEAD");
    // git revert -m 1, as the Revert button does: subject `Revert "Merge pull request #12 …"`.
    repo.git("revert", "--no-edit", "-m", "1", merged);
    expect(repo.check(merged)).toMatchObject({ code: 0, errors: [] });
    // The same subject and body over a change that does not undo the merge exactly fails.
    repo.git("reset", "-q", "--hard", merged);
    repo.commit(
      `Revert "Merge pull request #12 from x/feature"\n\nThis reverts commit ${merged}, reversing\nchanges made to ${merged}^.`,
      { "lib/feature.ts": "export const f = 2;\n" }
    );
    expect(repo.check(merged).errors).toEqual([
      expect.stringMatching(/changes code but names no task/),
    ]);
    // A merged pull request that is not on the base: its revert is judged as any commit.
    expect(base).not.toBe(merged);
    repo.done();
  });

  it("[self-test] an octopus merge is judged by what it adds itself", () => {
    const { repo, base } = started();
    for (const b of ["o1", "o2"]) {
      repo.git("checkout", "-q", "-b", b, base);
      repo.commit(`docs: ${b}`, { [`docs/${b}.md`]: `${b}\n` });
    }
    repo.git("checkout", "-q", "develop");
    repo.commit("docs: develop moves on", { "docs/dev.md": "d\n" });
    repo.git("merge", "-q", "--no-commit", "o1", "o2");
    repo.write({ "app/e.ts": "export const e = 1;\n" });
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Merge o1 and o2");
    expect(repo.git("rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(
      4
    );
    expect(repo.check(base).errors).toEqual([
      expect.stringMatching(/"Merge o1 and o2" changes code but names no task/),
    ]);
    repo.done();
  });

  it("[self-test] a route test nested too deep to read is refused cleanly", () => {
    const { repo, base } = started();
    repo.commit("test: deep", {
      "__tests__/deep-route.test.ts":
        'import { GET } from "@/app/api/x/route";\nconst x = ' +
        "`${".repeat(50000) +
        ";\n",
    });
    const r = repo.check(base);
    expect(r.code).toBe(1);
    expect(r.errors).toEqual([
      "__tests__/deep-route.test.ts drives a route and cannot be read for its hostile cases: templates nested deeper than 200",
    ]);
    repo.done();
  });

  it("[self-test] refuses a usage error with exit 2 and the usage line", () => {
    const usage = "usage: node scripts/process-check.mjs --base <ref> [--head <ref>]\n";
    for (const args of [[], ["--head", "HEAD"], ["--pr-title", "x", "--base", "HEAD"]]) {
      const r = spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
      expect([args, r.status, r.stderr]).toEqual([args, 2, usage]);
    }
  });
});

/** An octopus merge of three branches off `base`, each committing `files[i]`, plus `extra` added in the merge. */
function octopus(
  repo: Repo,
  base: string,
  files: Record<string, string>[],
  extra: Record<string, string>
): void {
  files.forEach((f, i) => {
    repo.git("checkout", "-q", "-b", `oct${i}`, base);
    repo.commit(`docs: branch ${i}`, f);
  });
  repo.git("checkout", "-q", "develop");
  repo.commit("docs: develop moves on", { "docs/dev.md": "d\n" });
  repo.git("merge", "-q", "--no-commit", ...files.map((_, i) => `oct${i}`));
  repo.write(extra);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Merge the branches");
  expect(repo.git("rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(
    files.length + 2 // the merge itself, develop, each branch
  );
}

/** An expression over the script's exports (`m`), evaluated as node runs the script; its JSON. */
function exported(expression: string): unknown {
  const r = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `import * as m from ${JSON.stringify(SCRIPT)};\nconsole.log(JSON.stringify(${expression}));`,
    ],
    { encoding: "utf8" }
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

describe("scripts/process-check.mjs: merges and exact reverts (TASK-200)", () => {
  it("[self-test] an octopus merge adding a non-ASCII or a spaced path is judged; a clean one is not", () => {
    for (const path of ["lib/évil.ts", "lib/an evil file.ts"]) {
      const { repo, base } = started();
      octopus(repo, base, [{ "docs/a.md": "a\n" }, { "docs/b.md": "b\n" }], {
        [path]: "export const e = 1;\n",
      });
      expect([path, repo.check(base).errors]).toEqual([
        path,
        [expect.stringMatching(/"Merge the branches" changes code but names no task/)],
      ]);
      repo.done();
    }
    // Clean: each branch adds its own code file; the merge changes nothing itself.
    const { repo, base } = started();
    octopus(
      repo,
      base,
      [{ "docs/a.md": "a\n" }, { "lib/only-here.ts": "export const o = 1;\n" }],
      {}
    );
    expect(
      repo.check(base).errors.filter((e) => e.includes("Merge the branches"))
    ).toEqual([]);
    repo.done();
  });

  it("[self-test] a two-parent evil merge adding a quoted path is judged", () => {
    const { repo, base } = started();
    repo.git("checkout", "-q", "-b", "side", base);
    repo.commit("docs: side", { "docs/side.md": "s\n" });
    repo.git("checkout", "-q", "develop");
    repo.commit("docs: main", { "docs/main.md": "m\n" });
    repo.git("merge", "-q", "--no-commit", "side");
    repo.write({ 'lib/évil "quoted".ts': "export const e = 1;\n" });
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Merge side");
    expect(repo.check(base).errors).toEqual([
      expect.stringMatching(/"Merge side" changes code but names no task/),
    ]);
    repo.done();
  });

  it("[self-test] a git without --remerge-diff refuses a two-parent merge, never guesses", () => {
    const { repo, base } = started();
    repo.git("checkout", "-q", "-b", "side", base);
    repo.commit("docs: side", { "docs/side.md": "s\n" });
    repo.git("checkout", "-q", "develop");
    repo.commit("docs: main", { "docs/main.md": "m\n" });
    repo.git("merge", "-q", "--no-edit", "side");
    // A git that says it is 2.30: every other call goes to the real one.
    const bin = mkdtempSync(join(tmpdir(), "old-git-"));
    const real = execFileSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.30.0"; exit 0; fi\nexec ${real} "$@"\n`,
      { mode: 0o755 }
    );
    const r = repo.check(base, [], { PATH: `${bin}:${process.env.PATH}` });
    expect(r.errors).toEqual([
      expect.stringMatching(
        /"Merge branch 'side'.*": a two-parent merge needs git 2\.36 or later \(--remerge-diff\) to be judged; this is git version 2\.30\.0/
      ),
    ]);
    rmSync(bin, { recursive: true, force: true });
    repo.done();
  });

  it("[self-test] only an exact inverse is a true revert", () => {
    const { repo } = started();
    // A merged pull request changed two files; a later fix changed one of them again.
    repo.git("checkout", "-q", "-b", "pr");
    repo.commit("feat: instrument (TASK-900)", {
      "platform/ai/instrumentation.ts": "export const i = 'v1';\n",
      "lib/helper.ts": "export const h = 1;\n",
    });
    repo.git("checkout", "-q", "develop");
    repo.commit("docs: meanwhile", { "docs/m.md": "m\n" });
    repo.git("merge", "-q", "--no-ff", "-m", "Merge pull request #462 from x/pr", "pr");
    const merged = repo.git("rev-parse", "HEAD");
    const fix = repo.commit("fix: instrumentation (TASK-900)", {
      "platform/ai/instrumentation.ts": "export const i = 'v1 fixed';\n",
    });
    const revertMsg = (sha: string, subject: string) =>
      `Revert "${subject}"\n\nThis reverts commit ${sha}, reversing\nchanges made to ${sha}^.`;
    const noTask = expect.stringMatching(/changes code but names no task/);
    // The probe: files reset to before the old merge, undoing the later fix too.
    repo.commit(revertMsg(merged, "Merge pull request #462 from x/pr"), {}, [
      "platform/ai/instrumentation.ts",
      "lib/helper.ts",
    ]);
    expect(repo.check(fix).errors).toEqual([noTask]);
    // A partial revert of the merge: one of its two files.
    repo.git("reset", "-q", "--hard", fix);
    repo.commit(revertMsg(merged, "Merge pull request #462 from x/pr"), {}, [
      "lib/helper.ts",
    ]);
    expect(repo.check(fix).errors).toEqual([noTask]);
    // An exact revert of the latest change passes.
    repo.git("reset", "-q", "--hard", fix);
    repo.git("revert", "--no-edit", fix);
    expect(repo.check(fix).errors).toEqual([]);
    // GitHub's Revert of a merged pull request no later commit touched passes.
    repo.git("reset", "-q", "--hard", fix);
    repo.git("checkout", "-q", "-b", "pr2", fix);
    repo.commit("feat: other (TASK-900)", { "lib/other.ts": "export const o = 1;\n" });
    repo.git("checkout", "-q", "develop");
    repo.git("merge", "-q", "--no-ff", "-m", "Merge pull request #463 from x/pr2", "pr2");
    const merged2 = repo.git("rev-parse", "HEAD");
    repo.git("revert", "--no-edit", "-m", "1", merged2);
    expect(repo.check(merged2)).toMatchObject({ code: 0, errors: [] });
    repo.done();
  });
});

describe("scripts/process-check.mjs: modes, symlinks and submodules (TASK-200)", () => {
  it("[self-test] an octopus merge that only changes a mode, swaps a file for a symlink, or moves a submodule is judged", () => {
    const gitlink = (repo: Repo, path: string, sha: string) => {
      repo.git("update-index", "--add", "--cacheinfo", `160000,${sha},${path}`);
    };
    const merged = (extra: (repo: Repo) => void) => {
      const { repo, base } = started();
      repo.commit("chore: the module (TASK-900)", { "app/m.ts": "app/target\n" });
      gitlink(repo, "app/sub", base);
      repo.git("commit", "-q", "-m", "chore: a submodule");
      const from = repo.git("rev-parse", "HEAD");
      // Commits that stage only their docs (the submodule is not checked out here).
      const docs = (subject: string, path: string) => {
        repo.write({ [path]: `${path}\n` });
        repo.git("add", "--", path);
        repo.git("commit", "-q", "-m", subject);
      };
      ["o1", "o2"].forEach((b) => {
        repo.git("checkout", "-q", "-b", b, from);
        docs(`docs: ${b}`, `docs/${b}.md`);
      });
      repo.git("checkout", "-q", "develop");
      docs("docs: develop moves on", "docs/dev.md");
      repo.git("merge", "-q", "--no-commit", "o1", "o2");
      extra(repo);
      repo.git("commit", "-q", "-m", "Merge the branches");
      const errors = repo.check(from).errors;
      repo.done();
      return errors;
    };
    const noTask = [
      expect.stringMatching(/"Merge the branches" changes code but names no task/),
    ];
    expect(merged(() => {})).toEqual([]);
    expect(merged((repo) => repo.git("update-index", "--chmod=+x", "app/m.ts"))).toEqual(
      noTask
    );
    expect(
      merged((repo) => {
        rmSync(join(repo.dir, "app/m.ts"));
        symlinkSync("app/target\n", join(repo.dir, "app/m.ts"));
        repo.git("add", "-A");
      })
    ).toEqual(noTask);
    expect(
      merged((repo) => gitlink(repo, "app/sub", repo.git("rev-parse", "HEAD~1")))
    ).toEqual(noTask);
  });

  it("[self-test] a revert that restores the bytes but not the mode is no true revert", () => {
    const { repo } = started();
    const base = repo.commit("feat: x (TASK-900)", {
      "app/x.ts": "export const x = 1;\n",
    });
    const at = repo.commit("feat: x two (TASK-900)", {
      "app/x.ts": "export const x = 2;\n",
    });
    repo.git("revert", "--no-edit", at);
    expect(repo.check(at)).toMatchObject({ code: 0, errors: [] });
    repo.git("reset", "-q", "--hard", at);
    repo.write({ "app/x.ts": "export const x = 1;\n" });
    chmodSync(join(repo.dir, "app/x.ts"), 0o755);
    repo.git("add", "-A");
    repo.git(
      "commit",
      "-q",
      "-m",
      `Revert "feat: x two (TASK-900)"\n\nThis reverts commit ${at}.`
    );
    expect(repo.check(at).errors).toEqual([
      'TASK-900 has no "Design check" block',
      'TASK-900 has no "Self-review" block',
      "TASK-900: the change does not touch its entry in docs/TASKS.md (record the work there)",
    ]);
    expect(base).not.toBe(at);
    repo.done();
  });
});

const COMPLETE_THREAT = [
  "**Threat model**",
  "",
  "- **Boundary:** the route guard between a tenant admin and another tenant's rows.",
  "- **Bypasses:** a forged role claim, a stale session, a request without the tenant header.",
  "- **Forgeries:** a client-set tenant id, refused because the server reads its own session.",
  "- **Legitimate flows:** an admin of the tenant, the operator, an agent through the command bar.",
  "- **Agreed before code:** agreed with the owner in the design thread before the first commit.",
].join("\n");

describe("scripts/process-check.mjs: an app's register, reverted pull requests, subjects (TASK-200)", () => {
  it("[self-test] an app's own register: its entry passes, a sync overwrites TASKS.md, a promotion passes", () => {
    const { repo } = started();
    const appTasks = (entries: string) =>
      `# Playform tasks\n\n## Open Items\n\n${entries}\n## Resolved\n`;
    const base = repo.commit("chore: the app's register", {
      ".github/sync-config.json": JSON.stringify({
        exclude: ["/docs/PLAYFORM_TASKS.md", "/scripts/process-check.app.json"],
      }),
      "scripts/process-check.app.json": JSON.stringify({
        taskRegisters: ["docs/PLAYFORM_TASKS.md"],
      }),
      "docs/PLAYFORM_TASKS.md": appTasks(""),
    });
    repo.commit("feat: the app's own (TASK-5001)", {
      "lib/own.ts": "export const own = 1;\n",
      "docs/PLAYFORM_TASKS.md": appTasks(
        entry("TASK-5001", `${COMPLETE_DESIGN}\n\n${COMPLETE_REVIEW}`)
      ),
    });
    expect(repo.check(base)).toMatchObject({ code: 0, errors: [] });
    // A sync brings platform-foundation's docs/TASKS.md, which knows nothing of TASK-5001.
    const pfTasks =
      "# Task Registry\n\n## Open Items\n\n" +
      entry("TASK-201", "New.") +
      "\n## Resolved\n";
    repo.commit(SYNC("d".repeat(40)), { "docs/TASKS.md": pfTasks });
    const synced = repo.check(base);
    expect(synced).toMatchObject({ code: 0, errors: [] });
    expect(synced.out).toMatch(
      /is a sync from platform-foundation \(by its subject\): not judged here/
    );
    // A task in neither register.
    repo.commit("fix: more (TASK-5002)", { "lib/own.ts": "export const own = 2;\n" });
    expect(repo.check(base).errors).toEqual([
      "TASK-5002 is named by a commit but has no entry in docs/TASKS.md or docs/PLAYFORM_TASKS.md (add one, with its Design check and Self-review)",
    ]);
    repo.done();
  });

  it("[self-test] only the task group a subject ends with names a task; a mention does not", () => {
    const { repo, base } = started();
    const noTask = (subject: string) =>
      expect.stringMatching(
        new RegExp(`"${subject.replace(/[()]/g, "\\$&")}" changes code but names no task`)
      );
    for (const subject of [
      "fix: as TASK-900 said, a thing",
      "fix: a thing (TASK-900) for now",
      "fix: a thing (see TASK-900)",
      "fix: a thing (TASK-900",
    ]) {
      repo.git("reset", "-q", "--hard", base);
      repo.commit(subject, { "lib/x.ts": "export const x = 1;\n" });
      expect([subject, repo.check(base).errors]).toEqual([subject, [noTask(subject)]]);
    }
    for (const subject of [
      "fix: a thing (TASK-903)",
      "fix: a thing (TASK-903) (#12)",
      "fix: as TASK-900 said (TASK-903)",
      "fix: a thing (platform TASK-903)",
    ]) {
      repo.git("reset", "-q", "--hard", base);
      repo.commit(subject, {
        "lib/x.ts": "export const x = 1;\n",
        "docs/TASKS.md": ADD_ENTRY(
          "TASK-903",
          `${COMPLETE_DESIGN}\n\n${COMPLETE_REVIEW}`
        ),
      });
      const r = repo.check(base);
      expect([subject, r.errors, r.out.split("\n")[0]]).toEqual([
        subject,
        [],
        expect.stringMatching(/tasks TASK-903$/),
      ]);
    }
    repo.done();
  });

  it("[self-test] a change to a gate or a security boundary carries its task's Threat model", () => {
    const { repo } = started();
    const base = repo.commit("chore: tiers", {
      "scripts/risk-tiers.json": JSON.stringify({
        high: [{ area: "auth", paths: ["lib/auth/**"] }],
      }),
    });
    const complete = `${COMPLETE_DESIGN}\n\n${COMPLETE_REVIEW}`;
    const cases: [string, Record<string, string>, string, string[]][] = [
      [
        "a high area's path",
        { "lib/auth/guard.ts": "export const g = 1;\n" },
        complete,
        [
          'TASK-905 has no "Threat model" block (the change touches lib/auth/guard.ts, a high-tier path)',
        ],
      ],
      [
        "the check's own files",
        { "scripts/process-check.app.json": "{}\n" },
        complete,
        [
          'TASK-905 has no "Threat model" block (the change touches scripts/process-check.app.json, a high-tier path)',
        ],
      ],
      [
        "CODEOWNERS",
        { ".github/CODEOWNERS": "* @x\n", "lib/x.ts": "export const x = 1;\n" },
        complete,
        [
          'TASK-905 has no "Threat model" block (the change touches .github/CODEOWNERS, a high-tier path)',
        ],
      ],
      [
        "an unanswered field",
        { "lib/auth/guard.ts": "export const g = 2;\n" },
        `${complete}\n\n${COMPLETE_THREAT.replace(/(\*\*Bypasses:\*\*).*/, "$1 TBD")}`,
        [
          'TASK-905 "Threat model": "Bypasses" is not answered (4 words or more, not a placeholder) (the change touches lib/auth/guard.ts, a high-tier path)',
        ],
      ],
      [
        "complete",
        { "lib/auth/guard.ts": "export const g = 3;\n" },
        `${complete}\n\n${COMPLETE_THREAT}`,
        [],
      ],
      [
        "a path of no high area",
        { "lib/plain.ts": "export const p = 1;\n" },
        complete,
        [],
      ],
    ];
    for (const [what, files, blocks, errors] of cases) {
      repo.git("reset", "-q", "--hard", base);
      repo.commit("feat: guarded (TASK-905)", {
        ...files,
        "docs/TASKS.md": ADD_ENTRY("TASK-905", blocks),
      });
      expect([what, repo.check(base).errors]).toEqual([what, errors]);
    }
    // The tiers the merge base has: lowering the tier in the same change does not drop it.
    repo.git("reset", "-q", "--hard", base);
    repo.commit("feat: guarded (TASK-905)", {
      "scripts/risk-tiers.json": JSON.stringify({ high: [] }),
      "lib/auth/guard.ts": "export const g = 4;\n",
      "docs/TASKS.md": ADD_ENTRY("TASK-905", complete),
    });
    expect(repo.check(base).errors).toEqual([
      'TASK-905 has no "Threat model" block (the change touches lib/auth/guard.ts, a high-tier path)',
    ]);
    repo.done();
  });
});

describe("this repository's own task registers (TASK-200)", () => {
  it("[self-test] every register an app names exists, and the sync never overwrites it or its config", () => {
    const problems = (root: string): string[] => {
      const config = join(root, "scripts/process-check.app.json");
      if (!existsSync(config)) return [];
      const registers: unknown = JSON.parse(readFileSync(config, "utf8")).taskRegisters;
      const sync = join(root, ".github/sync-config.json");
      const exclude: string[] = existsSync(sync)
        ? (JSON.parse(readFileSync(sync, "utf8")).exclude ?? [])
        : [];
      const out: string[] = [];
      if (!Array.isArray(registers) || registers.length === 0)
        out.push("no taskRegisters");
      for (const r of Array.isArray(registers) ? registers : []) {
        if (typeof r !== "string" || !/^[\w./-]+\.md$/.test(r))
          out.push(`unreadable ${String(r)}`);
        else {
          if (!existsSync(join(root, r))) out.push(`${r} missing`);
          if (!exclude.includes(`/${r}`))
            out.push(`${r} not excluded from the sync (root-anchored)`);
        }
      }
      if (!exclude.includes("/scripts/process-check.app.json"))
        out.push("scripts/process-check.app.json not excluded from the sync");
      return out;
    };
    expect(problems(process.cwd())).toEqual([]);
    // Planted: an app whose register the sync would overwrite, and one naming a missing register.
    const planted = mkdtempSync(join(tmpdir(), "process-check-registers-"));
    mkdirSync(join(planted, "scripts"), { recursive: true });
    mkdirSync(join(planted, ".github"), { recursive: true });
    writeFileSync(
      join(planted, "scripts/process-check.app.json"),
      JSON.stringify({ taskRegisters: ["docs/APP_TASKS.md"] })
    );
    writeFileSync(
      join(planted, ".github/sync-config.json"),
      JSON.stringify({ exclude: ["docs/APP_TASKS.md"] })
    );
    expect(problems(planted)).toEqual([
      "docs/APP_TASKS.md missing",
      "docs/APP_TASKS.md not excluded from the sync (root-anchored)",
      "scripts/process-check.app.json not excluded from the sync",
    ]);
    rmSync(planted, { recursive: true, force: true });
  });
});

describe("scripts/process-check.mjs: round 6 — flows that must have a way out (TASK-200)", () => {
  it("[self-test] TASK-200's own entry passes its own check (a marker named in prose is no placeholder)", () => {
    const got = exported(
      `m.entryFindings(m.taskEntries((await import("node:fs")).readFileSync(${JSON.stringify(
        join(process.cwd(), "docs/TASKS.md")
      )}, "utf8")).find((e) => e.id === "TASK-200"), [m.THREAT_MODEL])`
    );
    expect(got).toEqual([]);
  });

  it("[self-test] a pushed commit that named no task is adopted by its entry's Commits line", () => {
    const { repo, base } = started();
    const lost = repo.commit("feat: y", { "lib/y.ts": "export const y = 1;\n" });
    const s = lost.slice(0, 7);
    // The remedy is in the finding itself.
    expect(repo.check(base).errors).toEqual([
      `${s} "feat: y" changes code but names no task: end its subject with (TASK-nnn) — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${s}"`,
    ]);
    const adopt = (line: string) =>
      ADD_ENTRY("TASK-910", `${line}\n\n${COMPLETE_DESIGN}\n\n${COMPLETE_REVIEW}`);
    repo.commit("docs: adopt feat: y (TASK-910)", {
      "docs/TASKS.md": adopt(`**Commits:** ${s}`),
    });
    const r = repo.check(base);
    expect(r).toMatchObject({ code: 0, errors: [] });
    expect(r.out).toMatch(
      new RegExp(`${s} names no task in its subject; adopted by TASK-910`)
    );
    // An entry that only mentions the sha, or a hex word inside it or glued to other characters,
    // does not adopt it.
    for (const line of [`**Commits:** ${lost.slice(2, 10)}`, `**Commits:** x${s}`]) {
      repo.git("reset", "-q", "--hard", lost);
      repo.commit("docs: not quite (TASK-910)", { "docs/TASKS.md": adopt(line) });
      expect([line, repo.check(base).errors]).toEqual([
        line,
        [
          expect.stringMatching(
            new RegExp(`^${s} "feat: y" changes code but names no task`)
          ),
        ],
      ]);
    }
    repo.git("reset", "-q", "--hard", lost);
    repo.commit("docs: mention (TASK-910)", {
      "docs/TASKS.md": adopt(`The commit ${s} was pushed.`),
    });
    expect(repo.check(base).errors).toEqual([
      expect.stringMatching(new RegExp(`^${s} "feat: y" changes code but names no task`)),
    ]);
    repo.done();
  });

  it("[self-test] GitHub's Revert of a merged pull request passes after a later edit to the register", () => {
    const { repo, base } = started();
    repo.git("checkout", "-q", "-b", "feature");
    repo.commit("feat: the feature (TASK-901)", {
      "lib/feature.ts": "export const f = 1;\n",
      "docs/TASKS.md": ADD_ENTRY("TASK-901", `${COMPLETE_DESIGN}\n\n${COMPLETE_REVIEW}`),
    });
    repo.git("checkout", "-q", "develop");
    repo.git(
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "Merge pull request #12 from x/feature",
      "feature"
    );
    const merged = repo.git("rev-parse", "HEAD");
    // Another task edits the register after it (the normal case), in another place.
    const register = `${repo.git("show", "HEAD:docs/TASKS.md")}\n`;
    repo.commit("feat: next (TASK-902)", {
      "lib/next.ts": "export const n = 1;\n",
      "docs/TASKS.md": register.replace(
        "## Open Items\n\n",
        `## Open Items\n\n${entry("TASK-902", `${COMPLETE_DESIGN}\n\n${COMPLETE_REVIEW}`)}\n`
      ),
    });
    const at = repo.git("rev-parse", "HEAD");
    // The Revert button: lib/feature.ts back; the register keeps TASK-902 (git merges the hunks).
    repo.git("revert", "--no-edit", "-m", "1", merged);
    const r = repo.check(at);
    expect(r).toMatchObject({ code: 0, errors: [] });
    expect(r.out).toMatch(/is a true revert of \w+, on the base: judged there/);
    expect(base).not.toBe(merged);
    repo.done();
  });

  it("[self-test] an app's (platform TASK-nnn): platform-foundation's entry complete, the app's own entry touched", () => {
    const { repo } = started();
    const appTasks = (body: string) =>
      `# App tasks\n\n## Open Items\n\n${body}\n## Resolved\n`;
    const pfEntry = entry("TASK-200", `${COMPLETE_DESIGN}\n\n${COMPLETE_REVIEW}`);
    // The sync first: platform-foundation's entry arrives in docs/TASKS.md.
    const base = repo.commit("chore: the app, synced", {
      "scripts/process-check.app.json": JSON.stringify({
        taskRegisters: ["docs/APP_TASKS.md"],
      }),
      "docs/APP_TASKS.md": appTasks(""),
      "docs/TASKS.md": ADD_ENTRY("TASK-200", `${COMPLETE_DESIGN}\n\n${COMPLETE_REVIEW}`),
    });
    expect(pfEntry).toContain("TASK-200");
    const own = (body: string) =>
      repo.commit("ci(app): the process (platform TASK-200)", {
        "lib/own.ts": "export const own = 1;\n",
        "docs/APP_TASKS.md": appTasks(body),
      });
    own(entry("TASK-5000", "The app's part of platform TASK-200."));
    expect(repo.check(base)).toMatchObject({ code: 0, errors: [] });
    // No app entry referencing it: the finding says where the work is recorded.
    repo.git("reset", "-q", "--hard", base);
    own(entry("TASK-5000", "Something else."));
    expect(repo.check(base).errors).toEqual([
      `platform TASK-200: the change touches no entry in docs/APP_TASKS.md that references "platform TASK-200" (record the app's work there; sync platform-foundation's entry first)`,
    ]);
    // platform-foundation's entry incomplete (not synced yet): judged.
    repo.git("reset", "-q", "--hard", base);
    repo.commit("chore: an older register (TASK-900)", {
      "docs/TASKS.md": ADD_ENTRY("TASK-200", "Old."),
    });
    const older = repo.git("rev-parse", "HEAD");
    own(entry("TASK-5000", "The app's part of platform TASK-200."));
    expect(repo.check(older).errors).toEqual([
      'TASK-200 has no "Design check" block',
      'TASK-200 has no "Self-review" block',
    ]);
    repo.done();
  });
});

describe("scripts/process-check.mjs: round 7 — the single-owner cut (TASK-200)", () => {
  const COMPLETE = `${COMPLETE_DESIGN}\n\n${COMPLETE_REVIEW}`;
  const THREAT = [
    "**Threat model**",
    "",
    "- **Boundary:** the deploy workflow between a merged change and the production project.",
    "- **Bypasses:** a step skipped by a condition, a secret read by an untrusted script.",
    "- **Forgeries:** a commit pretending to be a release, an artefact from another run.",
    "- **Legitimate flows:** the owner's merge to main deploys; a re-run deploys the same sha.",
    "- **Agreed before code:** yes, with the owner before the workflow was written.",
  ].join("\n");

  it("[self-test] Dependabot's commits (by author) and sync commits (by subject) are not judged", () => {
    const { repo, base } = started();
    repo.write({ ".github/workflows/ci.yml": "uses: a/b@1 # v1\n", "lib/d.ts": "1\n" });
    repo.git("add", "-A");
    // Committed as GitHub commits Dependabot's (web-flow).
    repo.git(
      "-c",
      "user.name=GitHub",
      "commit",
      "-q",
      "--author=dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>",
      "-m",
      "ci: bump a/b from 1 to 2"
    );
    const dep = repo.git("rev-parse", "HEAD");
    const sync = repo.commit(
      `chore(sync): inherit platform-foundation main @ ${"c".repeat(40)}`,
      {
        "lib/s.ts": "s\n",
      }
    );
    const r = repo.check(base);
    expect(r).toMatchObject({ code: 0, errors: [] });
    expect(r.out).toContain(`${dep.slice(0, 7)} is Dependabot's: not judged`);
    expect(r.out).toContain(
      `${sync.slice(0, 7)} is a sync from platform-foundation (by its subject): not judged here`
    );
    // Planted: the same change by a person, or a sync subject without a full sha, is judged.
    const human = repo.commit("ci: bump a/b from 2 to 3", {
      ".github/workflows/ci.yml": "uses: a/b@3 # v3\n",
    });
    const short = repo.commit(
      `chore(sync): inherit platform-foundation main @ ${"c".repeat(12)}`,
      {
        "lib/s.ts": "t\n",
      }
    );
    expect(repo.check(base).errors).toEqual([
      expect.stringMatching(
        new RegExp(
          `^${human.slice(0, 7)} "ci: bump a/b from 2 to 3" changes the process's own files but names no task`
        )
      ),
      expect.stringMatching(
        new RegExp(
          `^${short.slice(0, 7)} "chore\\(sync\\)[^"]*" changes code but names no task`
        )
      ),
    ]);
    repo.done();
  });

  it("[self-test] a commit and its true revert in one range are a net no-op; the remedy is named", () => {
    const { repo, base } = started();
    const feat = repo.commit("feat: f (TASK-970)", {
      "lib/f.ts": "f\n",
      "docs/TASKS.md": ADD_ENTRY("TASK-970", COMPLETE),
    });
    // The revert removes the entry with the code (as git revert does).
    repo.git("revert", "--no-edit", feat);
    expect(repo.check(base)).toMatchObject({ code: 0, errors: [] });
    // Planted: a partial revert in the range is judged, and the finding says what passes.
    repo.git("reset", "-q", "--hard", feat);
    repo.write({ "lib/f.ts": "g\n" });
    repo.git("add", "-A");
    repo.git(
      "commit",
      "-q",
      "-m",
      'Revert "feat: f"',
      "-m",
      `This reverts commit ${feat}.`
    );
    expect(repo.check(base).errors).toEqual([
      expect.stringMatching(
        /needs no task only as the exact inverse of one commit on the base or earlier in the range/
      ),
    ]);
    repo.done();
  });

  it("[self-test] a revert and its reapply of a commit on the base, in one range, are a net no-op (TASK-204 N-18)", () => {
    const { repo } = started();
    const fix = repo.commit("fix: x (TASK-971)", {
      "platform/a.ts": "export const a = 2;\n",
      "docs/TASKS.md": ADD_ENTRY("TASK-971", `${COMPLETE}\n\nChanged.`),
    });
    // The revert names the task (its quoted subject) and leaves the entry; the reapply names none.
    const revertOnly = (sha: string, subject: string, a: string) => {
      repo.write({ "platform/a.ts": `export const a = ${a};\n` });
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", subject, "-m", `This reverts commit ${sha}.`);
      return repo.git("rev-parse", "HEAD");
    };
    const reverted = revertOnly(fix, 'Revert "fix: x (TASK-971)"', "1");
    revertOnly(reverted, 'Reapply "fix: x"', "2");
    // The range changes nothing: the entry is as the base has it, and nothing is asked of it.
    expect(repo.check(fix)).toMatchObject({ code: 0, errors: [] });
    repo.done();
  });

  it("[self-test] an app's (platform TASK-nnn) on a high-tier path: the app's entry carries the Threat model", () => {
    const { repo } = started();
    const appTasks = (body: string) =>
      `# App tasks\n\n## Open Items\n\n${body}\n## Resolved\n`;
    const base = repo.commit("chore: the app, synced", {
      "scripts/process-check.app.json": JSON.stringify({
        taskRegisters: ["docs/APP_TASKS.md"],
      }),
      "docs/APP_TASKS.md": appTasks(entry("TASK-5000", "Old.")),
      "docs/TASKS.md": ADD_ENTRY("TASK-200", COMPLETE),
    });
    const work = (blocks: string) =>
      repo.commit("ci(app): deploy (platform TASK-200)", {
        "lib/own.ts": "export const own = 1;\n",
        ".github/workflows/deploy.yml": "name: deploy\n",
        "docs/APP_TASKS.md": appTasks(
          entry("TASK-5000", `The app's part of platform TASK-200.\n\n${blocks}`)
        ),
      });
    work(COMPLETE);
    expect(repo.check(base).errors).toEqual([
      'TASK-5000 has no "Threat model" block (the change touches .github/workflows/deploy.yml, a high-tier path)',
    ]);
    repo.git("reset", "-q", "--hard", base);
    work(`${COMPLETE}\n\n${THREAT}`);
    expect(repo.check(base)).toMatchObject({ code: 0, errors: [] });
    repo.done();
  });

  it("[self-test] the first promotion: a baseline raised before the rule is its starting point", () => {
    const repo = new Repo();
    const before = repo.commit("chore: before", {
      "screen-literal-baseline.json": JSON.stringify({ count: 3 }),
    });
    repo.commit("chore: more literals", {
      "screen-literal-baseline.json": JSON.stringify({ count: 5 }),
    });
    repo.withRule();
    repo.commit("ci: the rule (TASK-900)", {
      "docs/TASKS.md": ADD_ENTRY("TASK-901", COMPLETE).replace(
        entry("TASK-900", "Old."),
        entry("TASK-900", `${COMPLETE}\n\n${THREAT}`)
      ),
    });
    expect(repo.check(before)).toMatchObject({ code: 0, errors: [] });
    // Planted: a rise after the rule is a finding.
    repo.commit("chore: more again", {
      "screen-literal-baseline.json": JSON.stringify({ count: 6 }),
    });
    expect(repo.check(before).errors).toEqual([
      "screen-literal-baseline.json: count 6, the base has 5 — it only shrinks",
    ]);
    repo.done();
  });

  it("[self-test] the first promotion after its merges: the pushes to staging and main, the pull request staging → main", () => {
    const repo = new Repo();
    const merge = (branch: string, into: string) => {
      repo.git("checkout", "-q", into);
      repo.git("merge", "-q", "--no-ff", "-m", `Merge ${branch} into ${into}`, branch);
      return repo.git("rev-parse", "HEAD");
    };
    repo.commit("chore: root", {
      "screen-literal-baseline.json": JSON.stringify({ count: 3 }),
      "docs/TASKS.md": ADD_ENTRY("TASK-901", COMPLETE),
    });
    repo.git("branch", "staging");
    repo.git("branch", "main");
    repo.commit("feat: before the rule", { "lib/d.ts": "d\n" });
    // An earlier promotion: staging's and main's tips are merge commits develop does not have.
    const staging0 = merge("develop", "staging");
    const main0 = merge("staging", "main");
    repo.git("checkout", "-q", "develop");
    repo.commit("chore: more literals", {
      "screen-literal-baseline.json": JSON.stringify({ count: 5 }),
    });
    repo.withRule();
    repo.commit("ci: the rule (TASK-900)", {
      "docs/TASKS.md": ADD_ENTRY("TASK-901", COMPLETE).replace(
        entry("TASK-900", "Old."),
        entry("TASK-900", `${COMPLETE}\n\n${THREAT}`)
      ),
    });
    const staging1 = merge("develop", "staging");
    const main1 = merge("staging", "main");
    for (const [base, head] of [
      [staging0, staging1], // the push to staging
      [main0, staging1], // the pull request staging → main
      [main0, main1], // the push to main
    ])
      expect(repo.check(base, ["--head", head])).toMatchObject({ code: 0, errors: [] });
    // Planted: after the rule, a baseline lowered and raised again (still below the rule's
    // starting value) is judged against the merge base, the later of the two.
    repo.git("checkout", "-q", "develop");
    const lowered = repo.commit("chore: fewer literals", {
      "screen-literal-baseline.json": JSON.stringify({ count: 2 }),
    });
    repo.commit("chore: more literals again", {
      "screen-literal-baseline.json": JSON.stringify({ count: 4 }),
    });
    expect(repo.check(lowered).errors).toEqual([
      "screen-literal-baseline.json: count 4, the base has 2 — it only shrinks",
    ]);
    repo.done();
  });

  it("[self-test] Reapply, Dependabot amended by hand, a route test missing one tag", () => {
    const { repo } = started();
    // git 2.43+ titles a revert of a revert `Reapply "…"`: a true one needs no task.
    const feat = repo.commit("feat: g (TASK-900)", {
      "lib/g.ts": "g\n",
      "docs/TASKS.md": ADD_ENTRY("TASK-900", COMPLETE).replace(
        entry("TASK-900", "Old.") + "\n",
        ""
      ),
    });
    repo.git("rm", "-q", "lib/g.ts");
    repo.git(
      "commit",
      "-q",
      "-m",
      'Revert "feat: g (TASK-900)"',
      "-m",
      `This reverts commit ${feat}.`
    );
    const unfeat = repo.git("rev-parse", "HEAD");
    repo.write({ "lib/g.ts": "g\n" });
    repo.git("add", "-A");
    repo.git(
      "commit",
      "-q",
      "-m",
      'Reapply "feat: g"',
      "-m",
      `This reverts commit ${unfeat}.`
    );
    expect(repo.check(unfeat)).toMatchObject({ code: 0, errors: [] });
    // Planted: Dependabot's commit amended by a person (it keeps Dependabot as its author) is judged.
    const wf = repo.commit("ci: bump", {
      "lib/w.ts": "w\n",
    });
    repo.write({ "platform/fix.ts": "1\n" });
    repo.git("add", "-A");
    repo.git(
      "commit",
      "-q",
      "--author=dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>",
      "-m",
      "build(deps): bump x from 1 to 2"
    );
    const amended = repo.git("rev-parse", "HEAD");
    expect(repo.check(wf).errors).toEqual([
      expect.stringMatching(
        new RegExp(
          `^${amended.slice(0, 7)} "build\\(deps\\): bump x from 1 to 2" changes code but names no task`
        )
      ),
    ]);
    // Planted: a route test missing exactly one hostile tag.
    const tagged = repo.commit("test: route", {
      "__tests__/x-route.test.ts":
        'import { GET } from "@/app/api/x/route";\n' +
        ["role", "self", "store-down"]
          .map((t) => `it("[hostile:${t}] x", () => {});`)
          .join("\n") +
        "\n",
    });
    expect(repo.check(amended).errors).toEqual([
      '__tests__/x-route.test.ts drives a route and lacks [hostile:id-spelling] (a test title tag, or a comment "hostile:<tag> n/a: <reason>")',
    ]);
    expect(tagged).toBeTruthy();
    repo.done();
  });
});
