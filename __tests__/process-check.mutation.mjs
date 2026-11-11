/**
 * __tests__/process-check.mutation.mjs — the fast suite StrykerJS runs once per mutant of
 * scripts/process-check.mjs (TASK-200, review round 5; stryker.config.mjs)
 *
 * What it holds: every behaviour of the engineering-process check, so a mutant of it fails a case.
 *
 * Node's built-ins only. It imports the script and calls it in-process (checkRange, each exported
 * helper), over git fixtures it builds once and caches under the system's temp directory (keyed
 * by this file's own hash, so a changed suite rebuilds them); the CLI is run as CI runs it, as a
 * child process. It stops at its first failing case: a killed mutant costs
 * one case, not the suite. The jest suite (__tests__/process-check.test.ts) stays the reviewed
 * statement of each rule; this one is its mutation-testing twin, run by Stryker by hand
 * (`npm run test:mutation`) whenever the script changes.
 *
 *   node __tests__/process-check.mutation.mjs
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "scripts", "process-check.mjs");
const m = await import(pathToFileURL(SCRIPT).href);

const cases = [];
/** A case: its name and its body (throws to fail). */
const test = (name, fn) => cases.push([name, fn]);
const eq = assert.deepStrictEqual;

// ── git fixtures, built once and cached ────────────────────────────────────────────────────────

const CACHE = join(
  tmpdir(),
  `process-check-mutation-${createHash("sha256")
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest("hex")
    .slice(0, 16)}`
);
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
/** The script as a fixture's history holds it: only its mark matters (the rule's start). */
const STUB = "// the check\nexport function checkRange() {}\n";

class Repo {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.git("init", "-q", "-b", "develop");
    this.git("config", "commit.gpgsign", "false");
  }
  git(...args) {
    return execFileSync("git", args, {
      cwd: this.dir,
      encoding: "utf8",
      env: GIT_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
  write(files) {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(this.dir, p)), { recursive: true });
      writeFileSync(join(this.dir, p), text);
    }
  }
  commit(subject, files = {}, remove = []) {
    this.write(files);
    for (const p of remove) rmSync(join(this.dir, p), { force: true });
    this.git("add", "-A");
    this.git("commit", "-q", "--allow-empty", "-m", subject);
    return this.git("rev-parse", "HEAD");
  }
  /** Start again from `rev` (a detached head; the next commit builds on it). */
  at(rev) {
    this.git("checkout", "-q", "-f", "--detach", rev);
    this.git("clean", "-q", "-fdx", "-e", ".fixture.json");
  }
}

/**
 * A fixture repository: built by `build(repo)` (which returns the revisions it names) the first time,
 * in a temporary directory renamed into the cache when done; read from the cache afterwards.
 */
function fixture(name, build) {
  const dir = join(CACHE, name);
  const refs = join(dir, ".fixture.json");
  if (!existsSync(refs)) {
    mkdirSync(CACHE, { recursive: true });
    const tmp = mkdtempSync(join(CACHE, `${name}.tmp-`));
    const built = build(new Repo(tmp), tmp);
    writeFileSync(join(tmp, ".fixture.json"), JSON.stringify(built));
    try {
      renameSync(tmp, dir);
    } catch {
      rmSync(tmp, { recursive: true, force: true }); // another runner built it first
    }
  }
  return { dir, ...JSON.parse(readFileSync(refs, "utf8")) };
}

/** checkRange in-process, over a fixture. */
function check(fx, base, head, extra = {}) {
  return m.checkRange({ base, head, cwd: fx.dir, ...extra });
}

/** The script run as CI runs it. */
function cli(args, cwd, env = {}) {
  const r = spawnSync("node", [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_STEP_SUMMARY: "",
      ...env,
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// ── task entries ───────────────────────────────────────────────────────────────────────────────

const DESIGN = [
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
const REVIEW = [
  "**Self-review**",
  "",
  "- **Consumers checked:** components/admin/UsersPanel.tsx and the command bar's search handler.",
  "- **Hostile re-read:** read as a tenant admin aiming at another tenant; nothing reaches it.",
].join("\n");
const THREAT = [
  "**Threat model**",
  "",
  "- **Boundary:** the route guard between a tenant admin and another tenant's rows.",
  "- **Bypasses:** a forged role claim, a stale session, a request without the tenant header.",
  "- **Forgeries:** a client-set tenant id, refused because the server reads its own session.",
  "- **Legitimate flows:** an admin of the tenant, the operator, an agent through the command bar.",
  "- **Agreed before code:** agreed with the owner in the design thread before the first commit.",
].join("\n");
const COMPLETE = `${DESIGN}\n\n${REVIEW}`;
const entry = (id, blocks) =>
  `### ${id} — Planted\n\n| Field | Detail |\n| --- | --- |\n| **ID** | ${id} |\n\nThe work.\n\n${blocks}\n`;
const register = (...entries) =>
  `# Task Registry\n\n## Open Items\n\n${entries.join("\n")}\n## Resolved\n`;
const OLD = entry("TASK-900", "Old.");

test("taskEntries: spans, bodies, and what ends an entry", () => {
  const text = [
    "# Tasks", // 1
    "### TASK-1 — One", // 2
    "a", // 3
    "### TASK-2 — Two", // 4
    "b", // 5
    "## Resolved", // 6
    "c", // 7
    "### TASK-3 — Three", // 8
    "d", // 9
    "_Last updated 2026_", // 10
    "e", // 11
    "### TASK-4 — Four", // 12
    "_Previously updated x_", // 13
    "### Notes", // 14
    "### TASK-5 — Five", // 15
    "f", // 16
  ].join("\n");
  eq(m.taskEntries(text), [
    { id: "TASK-1", start: 2, end: 3, body: "### TASK-1 — One\na" },
    { id: "TASK-2", start: 4, end: 5, body: "### TASK-2 — Two\nb" },
    { id: "TASK-3", start: 8, end: 9, body: "### TASK-3 — Three\nd" },
    { id: "TASK-4", start: 12, end: 12, body: "### TASK-4 — Four" },
    { id: "TASK-5", start: 15, end: 16, body: "### TASK-5 — Five\nf" },
  ]);
  eq(m.taskEntries("### TASK-7 — x"), [
    { id: "TASK-7", start: 1, end: 1, body: "### TASK-7 — x" },
  ]);
  eq(m.taskEntries("### TASK-8 x\n#### TASK-9 — y\n### TASK-10 —x"), []);
  eq(m.taskEntries(" ### TASK-8 — x"), []);
  eq(m.taskEntries("### TASK-1 — a\n# Top\nb"), [
    { id: "TASK-1", start: 1, end: 3, body: "### TASK-1 — a\n# Top\nb" },
  ]);
  eq(m.taskEntries("### TASK-1 — a\nx _Last updated_"), [
    { id: "TASK-1", start: 1, end: 2, body: "### TASK-1 — a\nx _Last updated_" },
  ]);
});

test("blockAnswers: items, wrapped answers, questions, and where a block ends", () => {
  eq(m.blockAnswers("nothing", "Design check"), null);
  eq(m.blockAnswers("**Design check** extra", "Design check"), null);
  const body = [
    "  **Design check**  ",
    "",
    "- **Reach:** one two",
    "  three four",
    "",
    "- **Races:**two",
    "- **Weakens a tenant's protection?** No: never",
    "\t tabbed on",
    "",
    "not an item",
    "- **After:** never read",
  ].join("\n");
  eq(
    [...m.blockAnswers(body, "Design check")],
    [
      ["Reach", "one two three four"],
      ["Races", "two"],
      ["Weakens a tenant's protection?", "No: never tabbed on"],
    ]
  );
  // A line that is neither an item nor indented ends the block.
  eq([...m.blockAnswers("**B**\n- **A:** x\ny\n- **C:** z", "B")], [["A", "x"]]);
  // Blank lines before the first item are skipped; one after it ends the list unless an item follows.
  eq(
    [...m.blockAnswers("**B**\n\n\n- **A:** x\n\n  - **C:** z", "B")],
    [["A", "x - **C:** z"]]
  );
  eq([...m.blockAnswers("**B**\n\n\n- **A:** x\n\n  z", "B")], [["A", "x"]]);
  eq(
    [...m.blockAnswers("**B**\n- **A:** x\n\n- **C:** z", "B")],
    [
      ["A", "x"],
      ["C", "z"],
    ]
  );
  eq([...m.blockAnswers("**B**\n- **A:** x\n\n", "B")], [["A", "x"]]);
  // An indented line before any item ends it; the answer is trimmed.
  eq([...m.blockAnswers("**B**\n  stray\n- **A:** x", "B")], []);
  eq([...m.blockAnswers("**B**\n- **A:**   x  \n   y  ", "B")], [["A", "x y"]]);
  eq([...m.blockAnswers("**B**\n- **A:**\n  y", "B")], [["A", "y"]]);
  eq([...m.blockAnswers("**B**\n- **A*B:** x", "B")], []);
  eq([...m.blockAnswers("**B**\n-  **A:** x", "B")], []);
  eq([...m.blockAnswers("**B**\n - **A:** x", "B")], []);
  eq([...m.blockAnswers("**B**\n- **A:** x\n- **A:** y", "B")], [["A", "y"]]);
});

test("entryFindings: each block and field, answered or not, with a threat model when asked", () => {
  const e = (body) => ({ id: "TASK-1", body });
  eq(m.entryFindings(e(COMPLETE)), []);
  eq(m.entryFindings(e("")), [
    'TASK-1 has no "Design check" block',
    'TASK-1 has no "Self-review" block',
  ]);
  eq(m.entryFindings(e(COMPLETE), [m.THREAT_MODEL]), [
    'TASK-1 has no "Threat model" block',
  ]);
  eq(m.entryFindings(e(`${COMPLETE}\n\n${THREAT}`), [m.THREAT_MODEL]), []);
  eq(m.THREAT_MODEL, {
    name: "Threat model",
    fields: [
      "Boundary",
      "Bypasses",
      "Forgeries",
      "Legitimate flows",
      "Agreed before code",
    ],
  });
  const partial = DESIGN.replace(/- \*\*Races:\*\*.*\n/, "").replace(
    /(- \*\*Journeys touched:\*\*).*/,
    "$1 three short words"
  );
  eq(m.entryFindings(e(`${partial}\n\n${REVIEW}`)), [
    'TASK-1 "Design check": "Races" is missing',
    'TASK-1 "Design check": "Journeys touched" is not answered (4 words or more, not a placeholder)',
  ]);
  const answer = (a) =>
    m.entryFindings(
      e(`${DESIGN.replace(/(- \*\*Reach:\*\*).*/, `$1 ${a}`)}\n\n${REVIEW}`)
    );
  const refused = [
    'TASK-1 "Design check": "Reach" is not answered (4 words or more, not a placeholder)',
  ];
  for (const a of [
    "one two three",
    "TBD — will fill in later",
    "fixme: write this up properly",
    "xxx write this up properly",
    "n/a for this change entirely",
    "N/A for this change entirely",
    "<describe who reaches it here>",
    "<reason> goes here for now",
    "<list the screens here please>",
    "<explain> goes here for now",
    "<name> goes here for now",
    "<fill> goes here for now",
    "<answer> goes here for now",
    "<why> goes here for now",
    "<what> goes here for now",
    "<who> goes here for now",
    "<how> goes here for now",
    "<todo> goes here for now",
    "... the change is fine",
    "…the change is fine here",
    "<why> it is so here",
    "to be decided after the review",
    "to be confirmed by the owner",
    "to be done after the merge",
    "to be written up after this",
    "to be filled in after this",
  ])
    eq([a, answer(a)], [a, refused]);
  for (const a of [
    "one two three four",
    "fill in later TBD",
    "x TODO: write this up",
    "the change ... is fine overall",
    "the change … is fine overall",
    "the change is fine ...",
    "it is to be determined later",
    "`TBD` is a marker named here",
    "the `<reason>` slot of a waiver",
    "a `hostile:<tag> n/a: <reason>` waiver line",
    "skipped, todo or failing tests",
    "none: the change stores nothing",
    "the todos list page and its store",
    "returns a Promise<void> to every caller",
    "a/n/a path is just a path",
    "path/tbd stays a path here",
    "tbd/path stays a path here",
    "tbds are not a word here",
    "wait...for it here now",
    "<b> is markup only here",
    "<describe is not closed here",
    "<describers> are not a slot",
    "to be honest it is fine",
    "to bedecided is not it",
  ])
    eq([a, answer(a)], [a, []]);
});

test("subjectTasks: only the task group a subject ends with", () => {
  const list = [
    ["fix: x (TASK-1)", ["TASK-1"]],
    ["fix: x (TASK-1, TASK-22)", ["TASK-1", "TASK-22"]],
    ["fix: x (TASK-1,TASK-2)", ["TASK-1", "TASK-2"]],
    ["fix: x (TASK-1 , platform TASK-2)", ["TASK-1", "TASK-2"]],
    ["fix: x (TASK-1, TASK-1)", ["TASK-1"]],
    ["fix: x (platform TASK-197)", ["TASK-197"]],
    ["fix: x (platform  TASK-197)", ["TASK-197"]],
    ["fix: x (TASK-1) (#12)", ["TASK-1"]],
    ["fix: x (TASK-1)  (#12)  ", ["TASK-1"]],
    ["fix: x (TASK-1)   ", ["TASK-1"]],
    ["fix: as TASK-9 said (TASK-1)", ["TASK-1"]],
    ["fix: x (TASK-1) and more", []],
    ["fix: x TASK-1", []],
    ["fix: x (see TASK-1)", []],
    ["fix: x (TASK-1", []],
    ["fix: x (TASK-)", []],
    ["fix: x (TASK-1) (#x)", []],
    ["fix: x (TASK-1)(#12)", []],
    ["fix: x (task-1)", []],
    ["fix: x (TASK-1, )", []],
    ["fix: x (platformTASK-1)", []],
    ['Revert "fix: x (TASK-3)"', ["TASK-3"]],
    ['Revert "fix: x (TASK-3)" (#40)', ["TASK-3"]],
    ['Revert "fix: x (TASK-3)"  (#40)', ["TASK-3"]],
    ['Revert "Revert "fix: x (TASK-3)""', ["TASK-3"]],
    ['Revert "fix: x"', []],
    ['Revert "fix: x" (TASK-4)', ["TASK-4"]],
    ['Revert "fix: x (TASK-3)" extra', []],
    ['Revert "fix: x (TASK-3)"(#40)', []],
    ['revert "fix: x (TASK-3)"', []],
    [' Revert "fix: x (TASK-3)"', []],
  ];
  for (const [s, want] of list) eq([s, m.subjectTasks(s)], [s, want]);
});

test("touchedLines: added, changed and the line next to a deletion", () => {
  eq(
    [
      ...m.touchedLines(
        "@@ -1 +1 @@\n@@ -3,2 +4,3 @@\n@@ -9,2 +10,0 @@\n@@ -1,1 +0,0 @@\n x @@ -5 +50 @@"
      ),
    ],
    [1, 4, 5, 6, 10]
  );
  eq([...m.touchedLines("@@ -1,0 +2,2 @@ ctx\n")], [2, 3]);
  eq([...m.touchedLines("@@ -1 +7,1 @@")], [7]);
  eq([...m.touchedLines("@@ -1 +12,0 @@")], [12]);
  eq([...m.touchedLines("@@ -1  +12 @@\n@@ +3 @@\n@@ -a +3 @@")], []);
  eq([...m.touchedLines("")], []);
});

// ── the lexer ──────────────────────────────────────────────────────────────────────────────────

const kinds = (text) => m.lex(text).map((t) => [t.type, t.value]);

test("lex: comments, strings, templates and their code", () => {
  eq(kinds("a // c\nb"), [
    ["ident", "a"],
    ["comment", "// c"],
    ["ident", "b"],
  ]);
  eq(kinds("a // c"), [
    ["ident", "a"],
    ["comment", "// c"],
  ]);
  eq(kinds("/* x\ny */z"), [
    ["comment", "/* x\ny */"],
    ["ident", "z"],
  ]);
  eq(kinds("/* open"), [["comment", "/* open"]]);
  eq(kinds("/**/x"), [
    ["comment", "/**/"],
    ["ident", "x"],
  ]);
  eq(kinds(`"a\\"b" 'c\\'d'`), [
    ["string", 'a"b'],
    ["string", "c'd"],
  ]);
  eq(kinds('"open\nx'), [
    ["string", "open"],
    ["ident", "x"],
  ]);
  eq(kinds('"end\\'), [["string", "end"]]);
  eq(kinds("'a'"), [["string", "a"]]);
  eq(kinds("'a\"b'"), [["string", 'a"b']]);
  eq(
    m.lex("`a${ b + `c${d}e` }f\\`g` h").map((t) => [t.type, t.parts ?? t.value]),
    [
      ["template", ["a", "f`g"]],
      ["ident", "h"],
    ]
  );
  eq(m.lex("`x${ {a: '}'} }y`")[0].parts, ["x", "y"]);
  eq(m.lex('`x${ "}" }y`')[0].parts, ["x", "y"]);
  eq(m.lex("`x${ a // }\n }y`")[0].parts, ["x", "y"]);
  eq(m.lex("`x${ a /* } */ }y`")[0].parts, ["x", "y"]);
  eq(m.lex("`x${ a /* open")[0].parts, ["x", ""]);
  eq(m.lex("`x${ a // open")[0].parts, ["x", ""]);
  eq(m.lex("`x${a")[0].parts, ["x", ""]);
  eq(m.lex("`x${ a / b }y`")[0].parts, ["x", "y"]);
  eq(m.lex("`x$y{z`")[0].parts, ["x$y{z"]);
  eq(m.lex("`open")[0], { type: "template", parts: ["open"], value: "open", start: 0 });
  eq(m.lex("`a\\")[0].parts, ["a"]);
  eq(m.lex("`a${b}c` d"), [
    { type: "template", parts: ["a", "c"], value: "ac", start: 0 },
    { type: "ident", value: "d", start: 9 },
  ]);
  for (const [text, at] of [
    ["x `t`", 2],
    ['x "s"', 2],
    ["x // c", 2],
    ["x /* c */", 2],
    ["x 12", 2],
    ["x y", 2],
    ["x (", 2],
    ["= /r/", 2],
  ])
    eq([text, m.lex(text)[1].start], [text, at]);
  eq(m.lex("ab")[0], { type: "ident", value: "ab", start: 0 });
});

test("lex: a regular expression or a division, by the token before it", () => {
  eq(kinds("a / b / c"), [
    ["ident", "a"],
    ["punct", "/"],
    ["ident", "b"],
    ["punct", "/"],
    ["ident", "c"],
  ]);
  eq(kinds("x = /a\\/[/]b/gi;"), [
    ["ident", "x"],
    ["punct", "="],
    ["regex", "/a\\/[/]b/gi"],
    ["punct", ";"],
  ]);
  eq(kinds("/re/"), [["regex", "/re/"]]);
  eq(kinds("// c\n/re/"), [
    ["comment", "// c"],
    ["regex", "/re/"],
  ]);
  eq(kinds("a // c\n/ 2"), [
    ["ident", "a"],
    ["comment", "// c"],
    ["punct", "/"],
    ["number", "2"],
  ]);
  for (const w of [
    "return",
    "typeof",
    "case",
    "do",
    "else",
    "in",
    "of",
    "new",
    "delete",
    "void",
    "throw",
    "instanceof",
    "yield",
    "await",
  ])
    eq([w, m.lex(`${w} /r/`)[1].type], [w, "regex"]);
  eq(m.lex("value /r/")[1].type, "punct");
  eq(kinds("f() / 2"), [
    ["ident", "f"],
    ["punct", "("],
    ["punct", ")"],
    ["punct", "/"],
    ["number", "2"],
  ]);
  eq(kinds("a[0] / 2")[4], ["punct", "/"]);
  eq(kinds("1.5e3 / 2"), [
    ["number", "1.5e3"],
    ["punct", "/"],
    ["number", "2"],
  ]);
  eq(kinds("x = /[/ 'q'"), [
    ["ident", "x"],
    ["punct", "="],
    ["regex", "/[/ 'q'"],
  ]);
  eq(kinds("x = /a\n'q'"), [
    ["ident", "x"],
    ["punct", "="],
    ["regex", "/a\n"],
    ["string", "q"],
  ]);
  eq(kinds("(/[]/]/)"), [
    ["punct", "("],
    ["regex", "/[]/"],
    ["punct", "]"],
    ["punct", "/"],
    ["punct", ")"],
  ]);
  eq(kinds("(/a/x1)"), [
    ["punct", "("],
    ["regex", "/a/x"],
    ["number", "1"],
    ["punct", ")"],
  ]);
  eq(kinds("$a _b a1$ é Z"), [
    ["ident", "$a"],
    ["ident", "_b"],
    ["ident", "a1$"],
    ["punct", "é"],
    ["ident", "Z"],
  ]);
  eq(kinds("a\t\r\nb"), [
    ["ident", "a"],
    ["ident", "b"],
  ]);
  eq(kinds("9a.b"), [["number", "9a.b"]]);
  eq(kinds("1+2"), [
    ["number", "1"],
    ["punct", "+"],
    ["number", "2"],
  ]);
});

test("lex: templates nested too deep are refused", () => {
  const nested = (n) => "`${".repeat(n) + "x" + "}`".repeat(n);
  assert.doesNotThrow(() => m.lex(nested(201)));
  assert.throws(
    () => m.lex(nested(202)),
    (e) => e instanceof m.LexError
  );
  assert.throws(() => m.lex(nested(202)), {
    message: "templates nested deeper than 200",
  });
});

// ── hostile tags ───────────────────────────────────────────────────────────────────────────────

test("runningTestTitles: running tests only, by their static title", () => {
  const text = [
    'it("one", () => {});',
    "test(`two ${x} three`, () => {});",
    'describe("three", () => { it("four", () => {}); });',
    'it.skip("no1", () => {});',
    'it.todo("no2");',
    'it.failing("no3", () => {});',
    'xit("no4", () => {});',
    'xtest("no5", () => {});',
    'xdescribe("no6", () => { it("no7", () => {}); });',
    'describe.skip("no8", () => { describe("no9", () => { it("no10", () => {}); }); });',
    'it("five", () => {});',
    'it.each([[1], [2]])("six %s", () => {});',
    'test.each`a ${1}`("seven", () => {});',
    'it.only("eight", () => {});',
    'foo.it("no11", () => {});',
    'const it2 = it; x it("no12");',
    '"it(\\"no13\\")";',
    '// it("no14")',
    "it;",
    "it(name, () => {});",
    'describe.each([1])("nine", () => {});',
    'test.skip.each([1])("no15", () => {});',
    'it.concurrent.skip("no16", () => {});',
    'it.each(["x"]);',
  ].join("\n");
  eq(m.runningTestTitles(text), [
    "one",
    "two   three",
    "three",
    "four",
    "five",
    "six %s",
    "seven",
    "eight",
    "nine",
  ]);
  eq(m.runningTestTitles('it.each`x`("a", () => {});'), ["a"]);
  eq(m.runningTestTitles("it.each(1"), []);
  eq(m.runningTestTitles('xit("a"'), []);
  eq(m.runningTestTitles('describe.skip("a", () => {}); it("b", () => {});'), ["b"]);
  eq(m.runningTestTitles('it.skip("a", () => {}) ; it("b")'), ["b"]);
  eq(m.runningTestTitles(")]} it('a')"), ["a"]);
  eq(m.runningTestTitles('it.("a")'), []);
  eq(m.runningTestTitles('it . only ("a")'), ["a"]);
  eq(m.runningTestTitles('it.each.x("a")'), ["a"]);
  eq(m.runningTestTitles('(it("a"))'), ["a"]);
  eq(m.runningTestTitles('describe.skip("a", () => [it("b")]); it("c")'), ["c"]);
});

test("commentLines: comment text without its marks", () => {
  eq(
    m.commentLines(
      "// one\n/* two\n * three\n   four */\n/** five */\n///six\nx = '// no';\n  //   seven  \n/*eight*/"
    ),
    ["one", "two", "three", "four", "five", "six", "seven", "eight"]
  );
  eq(m.commentLines("/*\n*/"), ["", ""]);
  eq(m.commentLines("/* a **/"), ["a"]);
  eq(m.commentLines("// a */ b"), ["a */ b"]);
  eq(
    m.commentLines("//  a"),
    [" a"].map((s) => s.trim())
  );
  eq(m.commentLines("/*a*/ /*  b  */"), ["a", "b"]);
});

test("missingHostileTags: a tag in a running title, or a waiver with its reason", () => {
  const all = m.HOSTILE_TAGS;
  eq(all, ["role", "self", "store-down", "id-spelling"]);
  eq(m.missingHostileTags(""), all);
  eq(
    m.missingHostileTags(
      'it("[hostile:role] a", () => {});\nit("x [hostile:self]", () => {});\nit.skip("[hostile:store-down]");'
    ),
    ["store-down", "id-spelling"]
  );
  eq(
    m.missingHostileTags(
      [
        "// hostile:role n/a: the route takes no role at all",
        "/* hostile:self n/a:\tno user id is ever read here */",
        "// hostile:store-down n/a: too short",
        '"// hostile:id-spelling n/a: inside a string not a comment"',
      ].join("\n")
    ),
    ["store-down", "id-spelling"]
  );
  eq(m.missingHostileTags("// hostile:role n/a: TBD later on now"), all);
  eq(m.missingHostileTags("//  hostile:role n/a: the route takes no role"), all.slice(1));
  eq(m.missingHostileTags("// x hostile:role n/a: the route takes no role"), all);
  eq(m.missingHostileTags("// hostile:role n/a:\n// the route takes no role"), all);
  eq(m.missingHostileTags("// hostile:role n/a:the route takes no role"), all.slice(1));
  eq(
    m.missingHostileTags("// hostile:role n/a:   the route takes no role   "),
    all.slice(1)
  );
  eq(m.missingHostileTags("// hostile:rolex n/a: the route takes no role"), all);
  eq(m.missingHostileTags("// hostile:role na: the route takes no role"), all);
  eq(m.missingHostileTags('it("[hostile:roles]", f)'), all);
  eq(
    m.missingHostileTags(
      "// hostile:role n/a: short\n// hostile:role n/a: the route takes no role"
    ),
    all
  );
});

test("importedHelpers and drivesRoute: a route imported directly or through a helper", () => {
  eq(
    m.importedHelpers(
      [
        'import { a } from "./helpers/calls";',
        "import b from '../helpers/b.ts';",
        'import "../../helpers/c";',
        'const d = require("@/__tests__/helpers/d");',
        'jest.requireActual("./helpers/e/f")',
        'await import("./helpers/g")',
        'import { a2 } from "./helpers/calls";',
        'export { h } from "./helpers/h";',
        '} from "./helpers/i";',
        'import x from "./not-helpers/j";',
        'import y from "helpers/k";',
        '"./helpers/l"',
      ].join("\n")
    ),
    ["calls", "b.ts", "h", "i", "c", "d", "e/f", "g"]
  );
  const route = (spec) => m.drivesRoute(spec, () => null);
  for (const t of [
    'import { GET } from "@/app/api/x/route";',
    "import { GET } from '../app/api/x/[id]/route';",
    'import { GET } from "../../app/api/x/route";',
    "import { GET } from `@/app/api/${n}/route`;",
    'import "@/app/api/x/route";',
    'const r = require("@/app/api/x/route");',
    'const r = jest.requireActual<typeof import("x")>("@/app/api/x/route");',
    'const r = await import("@/app/api/x/route");',
    'export { GET } from "@/app/api/x/route";',
    'import {\n  GET,\n} from "@/app/api/x/route";',
    'x = require( "@/app/api/x/route")',
    'require("@/app/api/x/route")',
  ])
    eq([t, route(t)], [t, true]);
  for (const t of [
    'import { GET } from "@/app/api/x/handler";',
    'import { GET } from "@/lib/api/x/route";',
    '// import { GET } from "@/app/api/x/route"',
    'const s = "@/app/api/x/route";',
    'xrequire("@/app/api/x/route")',
    'import { GET } from "./app/api/x/route";',
    'import("@/app/api/x\n/route")',
    'importx "@/app/api/x/route";',
    'import x from"@/app/api/x/route";',
  ])
    eq([t, route(t)], [t, false]);
  // A test file (rule 3 reads only these): .test.ts and .test.tsx, at the end of the path.
  eq(
    [
      "x.test.js",
      "x.test.tsx",
      "x.test.ts",
      "x.test.ts.bak",
      "x.spec.ts",
      "xtest.ts",
    ].map((f) => m.TEST_FILE.test(`__tests__/${f}`)),
    [false, true, true, false, false, false]
  );
  const helpers = {
    calls: 'import { GET } from "@/app/api/x/route";',
    other: "export {};",
  };
  const via = (text) => m.drivesRoute(text, (n) => helpers[n] ?? null);
  eq(via('import { call } from "./helpers/calls";'), true);
  eq(via('import { o } from "./helpers/other";'), false);
  eq(via('import { o } from "./helpers/missing";'), false);
  eq(
    via('import { o } from "./helpers/other";\nimport { c } from "./helpers/calls";'),
    true
  );
  eq(
    m.drivesRoute('import { c } from "./helpers/calls";', () => null),
    false
  );
});

// ── sync excludes and baselines ────────────────────────────────────────────────────────────────

test("baselineFindings: counts, keys, gaps, a count and coverage floors", () => {
  const f = (kind, base, head, renames, deleted = []) =>
    m.baselineFindings(
      "b.json",
      kind,
      base === null ? null : typeof base === "string" ? base : JSON.stringify(base),
      head === null ? null : typeof head === "string" ? head : JSON.stringify(head),
      renames,
      new Set(deleted)
    );
  eq(f("counts", null, null), []);
  eq(f("counts", null, "{"), []);
  eq(f("count", { count: 1 }, null), [
    "b.json: removed — a ratchet baseline stays (lower it to zero instead)",
  ]);
  eq(f("count", "{", { count: 9 }), []);
  eq(f("count", { count: 1 }, "{"), ["b.json: not valid JSON"]);
  eq(f("count", { count: 1 }, { count: 1 }), []);
  eq(f("count", { count: 1 }, { count: 0 }), []);
  eq(f("count", { count: 1 }, { count: 2 }), [
    "b.json: count 2, the base has 1 — it only shrinks",
  ]);
  eq(f("count", { count: "x" }, { count: 5 }), []);
  for (const bad of [-1, 1.5, "1", null])
    eq(
      [bad, f("count", { count: 1 }, { count: bad })],
      [bad, ['b.json: "count" is not a count']]
    );
  eq(f("count", { count: 1 }, {}), ['b.json: "count" is not a count']);
  // counts
  const base = { count: 3, files: { "a.ts": 2, "b.ts": { count: 1, reason: "r" } } };
  eq(f("counts", base, base), []);
  eq(f("counts", base, { count: 3, files: { "a.ts": 2, "b.ts": 1 } }), []);
  eq(f("counts", base, { count: 3, files: { "a.ts": 3 } }), [
    "b.json: a.ts 3, the base has 2",
  ]);
  eq(f("counts", base, { count: 3, files: { "b.ts": { count: 2 } } }), [
    "b.json: b.ts 2, the base has 1",
  ]);
  // A split: a.ts deleted, its count spread over two new files, nothing rising.
  eq(
    f(
      "counts",
      base,
      { count: 3, files: { "a1.ts": 1, "a2.ts": 1, "b.ts": 1 } },
      undefined,
      ["a.ts"]
    ),
    []
  );
  // The same without a.ts going (SEC-L2): new debt for a fixed key — refused.
  eq(f("counts", base, { count: 3, files: { "a1.ts": 1, "a2.ts": 1, "b.ts": 1 } }), [
    "b.json: a1.ts added — the base does not list it, and no key it could replace went with its file (deleted or renamed in this change); fix the new findings instead, or remove the key",
    "b.json: a2.ts added — the base does not list it, and no key it could replace went with its file (deleted or renamed in this change); fix the new findings instead, or remove the key",
  ]);
  // A file renamed (git's renames) vacates its key too; a deleted file whose key stays does not.
  eq(
    f(
      "counts",
      base,
      { count: 3, files: { "z.ts": 2, "b.ts": 1 } },
      new Map([["a.ts", "y.ts"]])
    ),
    []
  );
  eq(
    f("counts", base, { count: 3, files: { "a.ts": 2, "z.ts": 1 } }, undefined, ["a.ts"]),
    [
      "b.json: z.ts added — the base does not list it, and no key it could replace went with its file (deleted or renamed in this change); fix the new findings instead, or remove the key",
    ]
  );
  eq(f("counts", base, { count: 4, files: { "a1.ts": 2, "a2.ts": 1, "b.ts": 1 } }), [
    "b.json: count 4, the base has 3 — it only shrinks",
    "b.json: a1.ts added — the base does not list it, and the total rises (4 > 3); fix the new findings instead, or remove the key",
    "b.json: a2.ts added — the base does not list it, and the total rises (4 > 3); fix the new findings instead, or remove the key",
  ]);
  eq(f("counts", base, { count: 3, files: { "a.ts": "x", "c.ts": -1, "d.ts": 0 } }), [
    "b.json: a.ts's count is not a count",
    "b.json: c.ts's count is not a count",
    "b.json: d.ts added — the base does not list it, and no key it could replace went with its file (deleted or renamed in this change); fix the new findings instead, or remove the key",
  ]);
  eq(
    f("counts", { count: 1, files: { "a.ts": "x" } }, { count: 1, files: { "a.ts": 5 } }),
    []
  );
  eq(
    f("counts", { count: 1, files: { "a.ts": "x" } }, { count: 1, files: { "c.ts": 1 } }),
    [
      "b.json: c.ts added — the base does not list it, and the total rises (1 > 0); fix the new findings instead, or remove the key",
    ]
  );
  eq(f("counts", { count: 1, files: null }, { count: 1, files: { "c.ts": 1 } }), [
    "b.json: c.ts added — the base does not list it, and the total rises (1 > 0); fix the new findings instead, or remove the key",
  ]);
  eq(f("counts", { count: 1, files: 5 }, { count: 1, files: 7 }), []);
  eq(f("counts", { count: 1, files: { "a.ts": 1 } }, { count: 1, files: null }), []);
  eq(
    f(
      "counts",
      { count: 9, files: { "a.ts": 4 } },
      { count: 9, files: { "a.ts": 2, "b.ts": 2 } }
    ),
    [
      "b.json: b.ts added — the base does not list it, and no key it could replace went with its file (deleted or renamed in this change); fix the new findings instead, or remove the key",
    ]
  );
  eq(
    f(
      "counts",
      { count: 9, files: { "a.ts": 4 } },
      { count: 9, files: { "a1.ts": 2, "b.ts": 2 } },
      undefined,
      ["a.ts"]
    ),
    []
  );
  eq(
    f(
      "counts",
      { count: 9, files: { "a.ts": 4 } },
      { count: 9, files: { "a.ts": 2, "b.ts": 3 } }
    ),
    [
      "b.json: b.ts added — the base does not list it, and the total rises (5 > 4); fix the new findings instead, or remove the key",
    ]
  );
  const renames = new Map([
    ["o2.ts", "n2.ts"],
    ["old.ts", "new.ts"],
  ]);
  eq(
    f(
      "counts",
      { count: 2, files: { "old.ts": 2 } },
      { count: 2, files: { "new.ts": 2 } },
      renames
    ),
    []
  );
  eq(
    f(
      "counts",
      { count: 2, files: { "old.ts": 2 } },
      { count: 2, files: { "new.ts": 3 } },
      renames
    ),
    ["b.json: new.ts 3, the base has 2 (as old.ts)"]
  );
  eq(
    f(
      "counts",
      { count: 2, files: { "old.ts": 2 } },
      { count: 4, files: { "new.ts": 2, "old.ts": 2 } },
      renames
    ),
    [
      "b.json: count 4, the base has 2 — it only shrinks",
      "b.json: new.ts added — the base does not list it, and the total rises (4 > 2); fix the new findings instead, or remove the key",
    ]
  );
  // keys
  const keys = { count: 1, entries: { "a.ts#v": "why" } };
  eq(f("keys", keys, keys), []);
  eq(f("keys", keys, { count: 1, entries: { "a.ts#w": "why" } }), [
    "b.json: a.ts#w added — the base does not list it, and no key it could replace went with its file (deleted or renamed in this change); fix the new findings instead, or remove the key",
  ]);
  eq(
    f("keys", keys, { count: 1, entries: { "b.ts#w": "why" } }, undefined, ["a.ts"]),
    []
  );
  eq(f("keys", keys, { count: 2, entries: { "a.ts#v": "why", "a.ts#w": "x" } }), [
    "b.json: count 2, the base has 1 — it only shrinks",
    "b.json: a.ts#w added — the base does not list it, and the total rises (2 > 1); fix the new findings instead, or remove the key",
  ]);
  eq(
    f(
      "keys",
      { count: 1, entries: { "old.ts#v": "w" } },
      { count: 1, entries: { "new.ts#v": "w" } },
      renames
    ),
    []
  );
  eq(
    f(
      "keys",
      { count: 1, entries: { "old.ts": "w" } },
      { count: 1, entries: { "new.ts": 7 } },
      renames
    ),
    []
  );
  eq(
    f(
      "keys",
      { count: 1, entries: { "old.tsx#v": "w" } },
      { count: 2, entries: { "new.tsx#v": "w", "z#v": 1 } },
      renames
    ),
    [
      "b.json: count 2, the base has 1 — it only shrinks",
      "b.json: new.tsx#v added — the base does not list it, and the total rises (2 > 1); fix the new findings instead, or remove the key",
      "b.json: z#v added — the base does not list it, and the total rises (2 > 1); fix the new findings instead, or remove the key",
    ]
  );
  eq(
    f(
      "keys",
      { count: 1, entries: { "old.ts#v": "w" } },
      { count: 2, entries: { "new.ts#v": "w", "old.ts#v": "w" } },
      renames
    ),
    [
      "b.json: count 2, the base has 1 — it only shrinks",
      "b.json: new.ts#v added — the base does not list it, and the total rises (2 > 1); fix the new findings instead, or remove the key",
    ]
  );
});

test("baselineFindings: gaps and coverage floors", () => {
  const f = (kind, base, head, renames, deleted = []) =>
    m.baselineFindings(
      "b.json",
      kind,
      base === null ? null : typeof base === "string" ? base : JSON.stringify(base),
      head === null ? null : typeof head === "string" ? head : JSON.stringify(head),
      renames,
      new Set(deleted)
    );
  // gaps
  const gaps = { count: 1, gaps: ["components/Old.tsx -> /api/x : a.b"] };
  eq(f("gaps", gaps, gaps), []);
  // Re-keyed only when the old caller went (deleted, or renamed by git).
  eq(f("gaps", gaps, { count: 1, gaps: ["components/New.tsx -> /api/x : a.b"] }), [
    "b.json: gap added — components/New.tsx -> /api/x : a.b",
  ]);
  eq(
    f(
      "gaps",
      gaps,
      { count: 1, gaps: ["components/New.tsx -> /api/x : a.b"] },
      undefined,
      ["components/Old.tsx"]
    ),
    []
  );
  eq(
    f(
      "gaps",
      gaps,
      { count: 1, gaps: ["components/New.tsx -> /api/x : a.b"] },
      new Map([["components/Old.tsx", "components/Moved.tsx"]])
    ),
    []
  );
  eq(f("gaps", gaps, { count: 1, gaps: ["components/Old.tsx -> /api/x : a.c"] }), [
    "b.json: gap added — components/Old.tsx -> /api/x : a.c",
  ]);
  eq(
    f("gaps", gaps, {
      count: 2,
      gaps: ["components/New.tsx -> /api/x : a.b", "components/Old.tsx -> /api/x : a.b"],
    }),
    [
      "b.json: count 2, the base has 1 — it only shrinks",
      "b.json: gap added — components/New.tsx -> /api/x : a.b",
    ]
  );
  eq(
    f(
      "gaps",
      { count: 2, gaps: ["A -> /api/x : a", "B -> /api/x : a"] },
      { count: 2, gaps: ["C -> /api/x : a", "D -> /api/x : a"] },
      undefined,
      ["A", "B"]
    ),
    []
  );
  eq(
    f(
      "gaps",
      { count: 2, gaps: ["A -> /api/x : a", "B -> /api/x : a"] },
      { count: 2, gaps: ["C -> /api/x : a", "D -> /api/x : a"] },
      undefined,
      ["A"]
    ),
    ["b.json: gap added — D -> /api/x : a"]
  );
  eq(
    f(
      "gaps",
      { count: 2, gaps: ["A -> /api/x : a", "B -> /api/y : a"] },
      { count: 2, gaps: ["C -> /api/x : a", "D -> /api/x : a"] },
      undefined,
      ["A", "B"]
    ),
    ["b.json: gap added — D -> /api/x : a"]
  );
  eq(f("gaps", { count: 1, gaps: ["free text"] }, { count: 1, gaps: ["free text 2"] }), [
    "b.json: gap added — free text 2",
  ]);
  eq(f("gaps", { count: 1, gaps: ["free"] }, { count: 1, gaps: ["x -> /a : free"] }), [
    "b.json: gap added — x -> /a : free",
  ]);
  eq(f("gaps", { count: 1, gaps: ["x -> /a : b"] }, { count: 1, gaps: "x" }), [
    'b.json: "gaps" is not a list',
  ]);
  eq(f("gaps", { count: 1, gaps: "x" }, { count: 1, gaps: ["x -> /a : b"] }), [
    "b.json: gap added — x -> /a : b",
  ]);
  const r2 = new Map([
    ["components/OldPanel.tsx", "components/NewPanel.tsx"],
    ["app/api/old/route.ts", "app/api/new/route.ts"],
    ["lib/x.ts", "lib/y.ts"],
  ]);
  eq(
    f(
      "gaps",
      {
        count: 2,
        gaps: [
          "components/OldPanel.tsx -> /api/x : a.b",
          "components/Other.tsx -> /api/old : c.d",
        ],
      },
      {
        count: 2,
        gaps: [
          "components/NewPanel.tsx -> /api/x : a.b",
          "components/Other.tsx -> /api/new : c.d",
        ],
      },
      r2
    ),
    []
  );
  eq(
    f(
      "gaps",
      { count: 1, gaps: ["components/Other.tsx -> /api/old : c.d"] },
      {
        count: 2,
        gaps: [
          "components/Other.tsx -> /api/new : c.d",
          "components/Other.tsx -> /api/new : e.f",
        ],
      },
      r2
    ),
    [
      "b.json: count 2, the base has 1 — it only shrinks",
      "b.json: gap added — components/Other.tsx -> /api/new : e.f",
    ]
  );
  eq(
    f(
      "gaps",
      { count: 1, gaps: ["C -> /api/old : c"] },
      { count: 1, gaps: ["C -> /api/old/x : c"] },
      new Map([["app/api/old/route.tsx", "app/api/old/x/route.tsx"]])
    ),
    []
  );
  eq(
    f(
      "gaps",
      { count: 2, gaps: ["C -> /api/a : c", "Q -> /api/q : q"] },
      { count: 2, gaps: ["C -> /api/b : c", "Q -> /api/q : q"] },
      new Map([["lib/a.ts", "app/api/b/route.ts"]])
    ),
    ["b.json: gap added — C -> /api/b : c"]
  );
  eq(
    f(
      "gaps",
      { count: 2, gaps: ["C -> /api/a : c", "Q -> /api/q : q"] },
      { count: 2, gaps: ["C -> /api/b : c", "Q -> /api/q : q"] },
      new Map([["app/api/a/route.ts", "lib/b.ts"]])
    ),
    ["b.json: gap added — C -> /api/b : c"]
  );
  // floors
  const floors = {
    margin: 1,
    baseline: { statements: 90, lines: 90, functions: 90, branches: 80 },
  };
  eq(f("floors", floors, floors), []);
  eq(
    f("floors", floors, {
      margin: 0.5,
      baseline: { statements: 91, lines: 90, functions: 90, branches: 80 },
    }),
    []
  );
  eq(
    f("floors", floors, {
      margin: 2,
      baseline: { statements: 90, lines: 89.5, functions: Infinity, branches: "80" },
    }),
    [
      "b.json: the lines floor 89.5, the base has 90 — floors only rise",
      "b.json: the functions floor is missing",
      "b.json: the branches floor is missing",
      "b.json: the margin 2, the base has 1 — it never rises",
    ]
  );
  eq(f("floors", floors, { baseline: floors.baseline }), [
    "b.json: the margin is missing",
  ]);
  eq(f("floors", floors, { margin: "1", baseline: floors.baseline }), [
    "b.json: the margin is missing",
  ]);
  eq(
    f(
      "floors",
      { baseline: { lines: "90" } },
      { margin: 5, baseline: { statements: 1, lines: 1, functions: 1, branches: 1 } }
    ),
    []
  );
  eq(f("floors", {}, {}), [
    "b.json: the statements floor is missing",
    "b.json: the lines floor is missing",
    "b.json: the functions floor is missing",
    "b.json: the branches floor is missing",
  ]);
  eq(f("unknown", { count: 1 }, { count: 9 }), []);
  eq(m.BASELINES, {
    "body-schema-baseline.json": "counts",
    "fake-fetch-baseline.json": "counts",
    "open-input-register.json": "keys",
    "refusal-coverage-baseline.json": "gaps",
    "screen-literal-baseline.json": "count",
    "coverage-baseline.json": "floors",
  });
});

// Each assertion here kills a mutant an earlier full run left alive (its line and mutator named).
test("survivors: the paths, subjects and parsers a full Stryker run left untested", () => {
  // CODE_PATH: proxy.ts at the root only; the code roots at the start only.
  for (const [p, want] of [
    ["proxy.ts", true],
    ["docs/proxy.ts", false],
    ["lib/a.ts", true],
    ["xlib/a.ts", false],
  ])
    eq([p, m.CODE_PATH.test(p)], [p, want]);
  // GATE_PATH: each alternative anchored at both ends.
  for (const [p, want] of [
    ["scripts/process-check.app.json", true],
    ["x/scripts/process-check.mjs", false],
    ["scripts/process-check/x.mjs", false],
    ["scripts/risk-tiers.json", true],
    ["x/scripts/risk-tiers.json", false],
    ["scripts/risk-tier/x.json", false],
    [".github/CODEOWNERS", true],
    [".github/CODEOWNERS.bak", false],
    ["x/.github/CODEOWNERS", false],
    [".github/workflows/ci.yml", true],
    [".github/workflows/ci.yml.bak", false],
    [".github/workflows/deploy.yaml", true],
    [".github/workflows/sub/x.yml", false],
    ["x/.github/workflows/ci.yml", false],
  ])
    eq([p, m.GATE_PATH.test(p)], [p, want]);
  // HARD_HIGH: anchored, so a nested copy of a name is not the hard rule's.
  const hard = (p) => m.HARD_HIGH.some((re) => re.test(p));
  for (const [p, want] of [
    [".github/x.yml", true],
    ["docs/.github/x.yml", false],
    ["scripts/risk-tier.mjs", true],
    ["lib/scripts/risk-tier.mjs", false],
    ["scripts/process-check.mjs", true],
    ["lib/scripts/process-check.mjs", false],
    ["REVIEW.md", true],
    ["REVIEW.md.bak", false],
    ["docs/REVIEW.md", false],
    ["CLAUDE.md", true],
    ["CLAUDE.md.bak", false],
    ["docs/CLAUDE.md", false],
    [".gitattributes", true],
    ["lib/.gitattributes", true],
    ["lib/x.gitattributes", false],
  ])
    eq([p, hard(p)], [p, want]);
  // Subjects: each pattern anchored at the subject's start.
  const sha = "a".repeat(40);
  eq(
    m.SYNC_SHA.exec(`chore(sync): inherit platform-foundation main @ ${sha} (#12)`)?.[1],
    sha
  );
  eq(
    m.SYNC_SHA.exec(`chore(sync): inherit platform-foundation main @ ${sha.slice(1)}`),
    null
  );
  eq(
    m.SYNC_SHA.exec(`chore(sync): inherit platform-foundation main @ ${sha} more`),
    null
  );
  eq(m.SYNC_SHA.exec(`chore(sync): inherit platform-foundation main @ ${sha}`)?.[1], sha);
  eq(m.SYNC_SHA.exec(`x chore(sync): inherit platform-foundation main @ ${sha}`), null);
  eq(m.REVERT_SUBJECT.test('Revert "a (TASK-1)"'), true);
  eq(m.REVERT_SUBJECT.test('x Revert "a (TASK-1)"'), false);
  eq(m.subjectRefs("a (TASK-1, platform  TASK-2)"), [
    { id: "TASK-1", platform: false },
    { id: "TASK-2", platform: true },
  ]);
  // answered: a single dot is no ellipsis; a slot is read with its code spans spaced out; a
  // marker after leading space is still the answer's start.
  eq(m.answered(".NET carries the whole load"), true);
  eq(m.answered("... carries the whole load"), false);
  eq(m.answered("  TBD carries the whole load"), false);
  eq(m.answered("Because <why`x`not> here today"), false);
  eq(m.answered(" a b c"), false);
  eq(m.answered("a b c d"), true);
  // Self-review's fields are required.
  const noHostile = entry(
    "TASK-5",
    `${DESIGN}\n\n**Self-review**\n\n- **Consumers checked:** components/admin/UsersPanel.tsx and its search.`
  );
  eq(m.entryFindings(m.taskEntries(noHostile)[0]), [
    'TASK-5 "Self-review": "Hostile re-read" is missing',
  ]);
  // taskEntries: a heading mark mid-line ends nothing.
  eq(m.taskEntries("### TASK-1 — a\nsee ## b"), [
    { id: "TASK-1", start: 1, end: 2, body: "### TASK-1 — a\nsee ## b" },
  ]);
  // blockAnswers: an unindented line ends a block; one space continues it; a whitespace-only
  // line is blank; a blank before an indented non-item ends it.
  const block = (...lines) =>
    Object.fromEntries(m.blockAnswers(["**B**", ...lines].join("\n"), "B"));
  eq(block("- **A:** one", "plain text", "- **C:** two"), { A: "one" });
  eq(block("- **A:** one", " two"), { A: "one two" });
  eq(block("- **A:** one", "   ", "- **C:** two"), { A: "one", C: "two" });
  eq(block("- **A:** one", "", "  more - x"), { A: "one" });
  // touchedLines: multi-digit old counts; an added range is its lines alone.
  eq([...m.touchedLines("@@ -10,12 +5,2 @@")], [5, 6]);
  eq([...m.touchedLines("@@ -1,3 +5,2 @@")], [5, 6]);
  // The lexer: an unterminated string at the end; `//` after a block comment in a template's code.
  eq(kinds('"abc'), [["string", "abc"]]);
  eq(kinds("`a${/* c *//}b`"), [["template", "ab"]]);
  eq(kinds("`a${/* c */}b`"), [["template", "ab"]]);
  // A `*` after any other character starts no comment; a `/*/` is not closed by its own `*/`.
  eq(kinds("a*b"), [
    ["ident", "a"],
    ["punct", "*"],
    ["ident", "b"],
  ]);
  eq(kinds("`${a*b}c`"), [["template", "c"]]);
  eq(kinds("/*/ x */"), [["comment", "/*/ x */"]]);
  eq(kinds("`${/*/ } */}y`"), [["template", "y"]]);
  // A word before a slash makes it a division, unless the word is a keyword.
  eq(
    kinds("a / b / c").map(([t]) => t),
    ["ident", "punct", "ident", "punct", "ident"]
  );
  // A string, even one spelled as a keyword, is no keyword: a slash after it divides.
  eq(
    kinds('"in" / a / b').map(([t]) => t),
    ["string", "punct", "ident", "punct", "ident"]
  );
  // runningTestTitles: no call unless the root is a word followed by `(` or `.member`; comments
  // between are nothing; a string is no root; a skipped describe ends at its own ")" only.
  for (const t of [
    'it+x("t")',
    'it"."x("t")',
    'it."x"("t")',
    "it",
    "it.",
    "it(",
    'it x "t"',
    'it "(" "t"',
    'it + "t"',
    '"it"("t")',
    'foo("t")',
    'it.each[x]("t")',
    "it.each",
    'describe.skip(")", () => { it("in", () => {}); });',
  ])
    eq([t, m.runningTestTitles(t)], [t, []]);
  for (const [t, want] of [
    ['it /* c */ ("t")', ["t"]],
    ['const a = 1;\nit("t", f)', ["t"]],
    ['x;\nit("t", f)', ["t"]],
    ['"."\nit("t", f)', ["t"]],
    // A test inside xit or xtest does not run either.
    [
      'xit("u", () => { it("in", f); });\nxtest("v", () => { it("in2", f); });\nit("t", f)',
      ["t"],
    ],
    ['it.each`a`("t", f)', ["t"]],
    ['it.each("t"', ["t"]],
  ])
    eq([t, m.runningTestTitles(t)], [t, want]);
  // commentLines: a closing mark at the end only, every star of it; leading marks at the start only.
  eq(m.commentLines("/* x **/"), ["x"]);
  eq(m.commentLines("// a */ b"), ["a */ b"]);
  eq(m.commentLines("/*\nx // y\n*/"), ["", "x // y", ""]);
  eq(m.commentLines("/**\n ** x\n */"), ["", "x", ""]);
  // drivesRoute: an import on any line, not only the first.
  for (const t of [
    'const a = 1;\nimport "@/app/api/x/route";',
    'const a = 1;\nrequire("@/app/api/x/route");',
  ])
    eq([t, m.drivesRoute(t, () => null)], [t, true]);
  // Counts: a number, or an object's count; a count is a whole number, not negative.
  eq(
    [m.countOf(3), m.countOf({ count: 2 }), m.countOf(null), m.countOf("3")],
    [3, 2, undefined, undefined]
  );
  eq(
    [m.isCount(0), m.isCount(2), m.isCount(-1), m.isCount(1.5), m.isCount("2")],
    [true, true, false, false, false]
  );
  // routeUrl: app/api's route modules only.
  eq(m.routeUrl("app/api/a/[id]/route.ts"), "/api/a/[id]");
  eq(m.routeUrl("app/api/a/route.tsx"), "/api/a");
  eq(m.routeUrl("xapp/api/a/route.ts"), null);
  eq(m.routeUrl("app/api/a/route.ts.bak"), null);
  // renamedFrom: the key, or its file's part, under the old name.
  const ren = new Map([["a.ts", "b.ts"]]);
  eq(m.renamedFrom("b.ts", ren), "a.ts");
  eq(m.renamedFrom("b.ts#x", ren), "a.ts#x");
  eq(m.renamedFrom("c.ts#x", ren), "c.ts#x");
  eq(m.renamedFrom("x#b.ts#", ren), "x#b.ts#");
  // gapFrom: caller and route under their old names; a route moved from a non-route is itself.
  eq(m.gapFrom("b.ts -> /api/x : 500", ren), "a.ts -> /api/x : 500");
  eq(m.gapFrom("c.ts -> /api/x : 500", ren), "c.ts -> /api/x : 500");
  eq(
    m.gapFrom(
      "c.ts -> /api/y : 500",
      new Map([["app/api/x/route.ts", "app/api/y/route.ts"]])
    ),
    "c.ts -> /api/x : 500"
  );
  eq(
    m.gapFrom("c.ts -> /api/y : 500", new Map([["lib/x.ts", "app/api/y/route.ts"]])),
    "c.ts -> /api/y : 500"
  );
  eq(m.gapFrom("no arrow", ren), "no arrow");
  eq(
    m.gapFrom(
      "c.ts -> /api/z : 500",
      new Map([["app/api/x/route.ts", "app/api/y/route.ts"]])
    ),
    "c.ts -> /api/z : 500"
  );
  // baselineFindings: a side without the map; a key's reason is not a count; a base count that
  // is not one holds nothing; a vacated key does not excuse a rising total.
  const bf = (kind, base, head, renames, deleted) =>
    m.baselineFindings(
      "b.json",
      kind,
      JSON.stringify(base),
      JSON.stringify(head),
      renames,
      deleted
    );
  eq(bf("counts", { count: 0 }, { count: 0, files: {} }), []);
  // A map that is a text is no map, at either side.
  eq(bf("counts", { count: 1, files: "ab" }, { count: 1, files: { 0: 1 } }), [
    "b.json: 0 added — the base does not list it, and the total rises (1 > 0); fix the new findings instead, or remove the key",
  ]);
  eq(bf("counts", { count: 0, files: {} }, { count: 0, files: "ab" }), []);
  eq(bf("counts", { count: 0, files: {} }, { count: 0 }), []);
  eq(
    bf("keys", { count: 1, entries: { "a#x": 3 } }, { count: 1, entries: { "a#x": 5 } }),
    []
  );
  eq(bf("counts", { count: 0, files: { a: -1 } }, { count: 0, files: { a: 0 } }), []);
  eq(bf("counts", { count: 1, files: { a: null } }, { count: 1, files: { a: null } }), [
    "b.json: a's count is not a count",
  ]);
  eq(
    bf(
      "counts",
      { count: 2, files: { "a.ts": 1, "b.ts": 1 } },
      { count: 2, files: { "c.ts": 2, "b.ts": 1 } },
      new Map(),
      new Set(["a.ts"])
    ),
    [
      "b.json: c.ts added — the base does not list it, and the total rises (3 > 2); fix the new findings instead, or remove the key",
    ]
  );
  eq(
    bf(
      "counts",
      { count: 1, files: { "a.ts": 1 } },
      { count: 1, files: { "c.ts": 1 } },
      new Map(),
      new Set(["a.ts"])
    ),
    []
  );
});

test("survivors: git's version, the registers, the risk tiers and the floors a full Stryker run left untested", () => {
  // remergeDiffIn: 2.36 and later, by number, not by digit.
  for (const [v, want] of [
    ["git version 2.36.0", true],
    ["git version 2.35.9", false],
    ["git version 10.1.0", true],
    ["git version 3.0", true],
    ["git version 1.99", false],
    ["git version", false],
  ])
    eq([v, m.remergeDiffIn(v)], [v, want]);
  // registersIn: TASKS.md first, then the app's markdown paths, each a string, once.
  const T = "docs/TASKS.md";
  eq(m.registersIn(null), [T]);
  eq(m.registersIn("not json"), [T]);
  eq(m.registersIn('{"taskRegisters":"docs/A.md"}'), [T]);
  eq(m.registersIn("null"), [T]);
  eq(
    m.registersIn(
      JSON.stringify({
        taskRegisters: [
          "docs/A.md",
          3,
          ["docs/B.md"],
          " docs/C.md",
          "docs/D.md.bak",
          T,
          "docs/A.md",
        ],
      })
    ),
    [T, "docs/A.md"]
  );
  // highTierIn: the hard rule, and the high areas' paths when readable.
  const hi = (text, p) => m.highTierIn(text)(p);
  eq([hi(null, "lib/x.ts"), hi(null, "CLAUDE.md")], [false, true]);
  eq(hi("not json", "lib/x.ts"), false);
  eq(hi("null", "lib/x.ts"), false);
  eq(hi('{"high":[{"paths":["lib/**"]}]}', "lib/x.ts"), true);
  eq(hi('{"high":[null,{"paths":"lib/**"},{"paths":[3]}]}', "lib/x.ts"), false);
  eq(hi('{"high":[{}]}', "Stryker was here"), false);
  // Floors: a value JSON reads as Infinity is missing; so is a margin of it.
  const floorsText = (axis) =>
    `{"margin":1,"baseline":{"statements":90,"lines":90,"functions":90,"branches":${axis}}}`;
  eq(m.baselineFindings("c.json", "floors", floorsText(80), floorsText("1e999")), [
    "c.json: the branches floor is missing",
  ]);
  eq(
    m.baselineFindings(
      "c.json",
      "floors",
      floorsText(80),
      '{"margin":1e999,"baseline":{"statements":90,"lines":90,"functions":90,"branches":80}}'
    ),
    ["c.json: the margin is missing"]
  );
  // A moved caller's gap is re-keyed only with its whole route and code.
  eq(
    m.baselineFindings(
      "g.json",
      "gaps",
      JSON.stringify({ count: 1, gaps: ["a.ts -> /api/x : 500"] }),
      JSON.stringify({ count: 1, gaps: ["b.ts -> /api/x : 501"] }),
      new Map(),
      new Set(["a.ts"])
    ),
    ["g.json: gap added — b.ts -> /api/x : 501"]
  );
  // Gaps: a moved caller's gap is re-keyed only while the gaps do not grow.
  eq(
    m.baselineFindings(
      "g.json",
      "gaps",
      JSON.stringify({ count: 1, gaps: ["a.ts -> /api/x : 500"] }),
      JSON.stringify({ count: 1, gaps: ["b.ts -> /api/x : 500", "c.ts -> /api/y : 1"] }),
      new Map(),
      new Set(["a.ts"])
    ),
    ["g.json: gap added — b.ts -> /api/x : 500", "g.json: gap added — c.ts -> /api/y : 1"]
  );
});

test("ownPaths: what a merge's result changes against every parent", () => {
  const map = (o) => new Map(Object.entries(o));
  eq(
    m.ownPaths(map({ a: "1", b: "2", c: "3", e: "5" }), [
      map({ a: "1", b: "9", c: "8", d: "4", e: "5" }),
      map({ a: "1", b: "2", c: "7", d: "4", f: "6" }),
    ]),
    ["c", "d"]
  );
  eq(m.ownPaths(map({ z: "1", a: "1" }), [map({}), map({})]), ["a", "z"]);
  eq(m.ownPaths(map({}), [map({ d: "1" }), map({ d: "1" })]), ["d"]);
  eq(m.ownPaths(map({}), [map({ d: "1" }), map({})]), []);
});

test("tierPattern: ** any depth, * one segment, the whole path", () => {
  for (const [p, path, want] of [
    ["lib/auth/**", "lib/auth/a/b.ts", true],
    ["lib/auth/**", "lib/auth.ts", false],
    ["lib/*.ts", "lib/a.ts", true],
    ["lib/*.ts", "lib/a/b.ts", false],
    ["lib/a.ts", "lib/a.ts", true],
    ["lib/a.ts", "x/lib/a.ts", false],
    ["lib/a.ts", "lib/a.tsx", false],
    ["lib/a.ts", "lib/axts", false],
    ["a+(b)", "a+(b)", true],
    ["a+(b)", "aab", false],
    ["**/x.ts", "a/b/x.ts", true],
  ])
    eq([p, path, m.tierPattern(p).test(path)], [p, path, want]);
});

// ── the CLI, run as CI runs it ────────────────────────────────────────────────────────────────

test("the CLI: usage errors exit 2 with the usage line", () => {
  const usage = "usage: node scripts/process-check.mjs --base <ref> [--head <ref>]\n";
  for (const args of [
    [],
    ["--bogus", "x"],
    ["--base"],
    ["--head", "x"],
    ["--head", "x", "--base"],
    ["--pr-title", "t", "--base", "x"],
    ["--override", "x"],
    ["--base", "x", "--head"],
    ["--base", "x", "--bogus", "y"],
  ]) {
    const r = cli(args, HERE);
    eq([args, r.code, r.out, r.err], [args, 2, "", usage]);
  }
});

// ── git fixtures: the rule over commits ────────────────────────────────────────────────────────

/** A repository whose base has the rule (its script) and a register. */
function started(repo) {
  return repo.commit("chore: start", {
    "scripts/process-check.mjs": STUB,
    "docs/TASKS.md": register(OLD),
    "platform/a.ts": "export const a = 1;\n",
  });
}
const ADD = (id, blocks) => register(OLD, entry(id, blocks));
/** What a Revert subject's no-task finding adds. */
const REVERT_REMEDY =
  '; a Revert "…" (or Reapply "…") needs no task only as the exact inverse of one commit on the base or earlier in the range (git revert of that commit alone, its files unchanged since)';

test("the rule over commits: tasks, entries, touches, docs-only and before the rule", () => {
  const fx = fixture("basic", (repo) => {
    const pre = repo.commit("feat: before the rule", { "lib/pre.ts": "1\n" });
    const base = started(repo);
    const noTask = repo.commit("fix: something", {
      "platform/a.ts": "export const a = 2;\n",
    });
    repo.at(base);
    const partial = repo.commit("fix: a thing (TASK-901)", {
      "platform/a.ts": "export const a = 2;\n",
      "docs/TASKS.md": ADD(
        "TASK-901",
        DESIGN.replace(/- \*\*Races:\*\*.*\n/, "").replace(
          /(- \*\*Journeys touched:\*\*).*/,
          "$1 TBD"
        )
      ),
    });
    repo.at(base);
    const unknown = repo.commit("fix: a thing (TASK-902, TASK-900)", {
      "app/api/x/route.ts": "export {};\n",
    });
    repo.at(base);
    const complete = repo.commit("feat: the thing (TASK-903)", {
      "lib/b.ts": "export const b = 1;\n",
      "docs/TASKS.md": ADD("TASK-903", COMPLETE),
    });
    const second = repo.commit("feat: more of it (TASK-903)", { "hooks/h.ts": "x\n" });
    repo.at(base);
    const docs = repo.commit("docs: wording", {
      "docs/X.md": "x\n",
      ".github/workflows/a.yml/x": "a: 1\n",
      "proxy.tsx": "x\n",
      "xlib/y.ts": "x\n",
    });
    repo.at(base);
    const proxy = repo.commit("fix: proxy", { "proxy.ts": "x\n" });
    repo.at(base);
    const comps = repo.commit("fix: comps", { "components/c.tsx": "x\n" });
    repo.at(base);
    const lastLine = repo.commit("feat: last (TASK-904)", {
      "lib/c.ts": "x\n",
      "docs/TASKS.md": `${ADD("TASK-904", COMPLETE)}`.replace(/\n## Resolved\n$/, ""),
    });
    repo.at(pre);
    const beforeRule = repo.commit("feat: still before", { "lib/pre2.ts": "2\n" });
    return {
      pre,
      base,
      noTask,
      partial,
      unknown,
      complete,
      second,
      docs,
      proxy,
      comps,
      lastLine,
      beforeRule,
    };
  });
  eq(check(fx, fx.base, fx.noTask), {
    findings: [
      `${fx.noTask.slice(0, 7)} "fix: something" changes code but names no task: end its subject with (TASK-nnn) — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${fx.noTask.slice(0, 7)}"`,
    ],
    notes: [],
    commits: 1,
    tasks: [],
  });
  eq(check(fx, fx.base, fx.partial).findings, [
    'TASK-901 "Design check": "Races" is missing',
    'TASK-901 "Design check": "Journeys touched" is not answered (4 words or more, not a placeholder)',
    'TASK-901 has no "Self-review" block',
  ]);
  eq(check(fx, fx.base, fx.unknown), {
    findings: [
      'TASK-900 has no "Design check" block',
      'TASK-900 has no "Self-review" block',
      "TASK-900: the change does not touch its entry in docs/TASKS.md (record the work there)",
      "TASK-902 is named by a commit but has no entry in docs/TASKS.md (add one, with its Design check and Self-review)",
    ],
    notes: [],
    commits: 1,
    tasks: ["TASK-900", "TASK-902"],
  });
  eq(check(fx, fx.base, fx.second), {
    findings: [],
    notes: [],
    commits: 2,
    tasks: ["TASK-903"],
  });
  eq(check(fx, fx.complete, fx.second).findings, [
    "TASK-903: the change does not touch its entry in docs/TASKS.md (record the work there)",
  ]);
  eq(check(fx, fx.base, fx.docs), { findings: [], notes: [], commits: 1, tasks: [] });
  eq(check(fx, fx.base, fx.proxy).findings.length, 1);
  eq(check(fx, fx.base, fx.comps).findings.length, 1);
  eq(check(fx, fx.base, fx.lastLine).findings, []);
  // Commits made before the rule are not judged; the rule's own first commit is.
  eq(check(fx, fx.pre, fx.beforeRule), {
    findings: [],
    notes: [],
    commits: 0,
    tasks: [],
  });
  eq(check(fx, fx.pre, fx.noTask), {
    findings: [
      `${fx.base.slice(0, 7)} "chore: start" changes code but names no task: end its subject with (TASK-nnn) — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${fx.base.slice(0, 7)}"`,
      `${fx.noTask.slice(0, 7)} "fix: something" changes code but names no task: end its subject with (TASK-nnn) — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${fx.noTask.slice(0, 7)}"`,
    ],
    notes: [],
    commits: 2,
    tasks: [],
  });
  eq(check(fx, `${fx.pre}~0`, fx.beforeRule, {}).commits, 0);
  // The CLI's report: its head line, notes and findings, its summary file, its exit code. The
  // summary is this process's own (the fixture is shared by concurrent runs: Stryker's workers).
  const own = mkdtempSync(join(tmpdir(), "process-check-mutation-summary-"));
  const summary = join(own, "summary.md");
  writeFileSync(summary, "");
  const failing = cli(["--base", fx.base, "--head", fx.noTask], fx.dir, {
    GITHUB_STEP_SUMMARY: summary,
  });
  eq(
    [failing.code, failing.out, failing.err],
    [
      1,
      `process check: 1 commit(s) judged since ${fx.base}; tasks none\n`,
      `::error::${fx.noTask.slice(0, 7)} "fix: something" changes code but names no task: end its subject with (TASK-nnn) — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${fx.noTask.slice(0, 7)}"\n`,
    ]
  );
  eq(
    readFileSync(summary, "utf8"),
    `**process check: 1 commit(s) judged since ${fx.base}; tasks none**\n\n- ${fx.noTask.slice(0, 7)} "fix: something" changes code but names no task: end its subject with (TASK-nnn) — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${fx.noTask.slice(0, 7)}"\n`
  );
  writeFileSync(summary, "");
  const passing = cli(["--base", fx.base, "--head", fx.second], fx.dir, {
    GITHUB_STEP_SUMMARY: summary,
  });
  eq(
    [passing.code, passing.out, passing.err],
    [
      0,
      `process check: 2 commit(s) judged since ${fx.base}; tasks TASK-903\n  nothing missing\n`,
      "",
    ]
  );
  eq(
    readFileSync(summary, "utf8"),
    `**process check: 2 commit(s) judged since ${fx.base}; tasks TASK-903**: nothing missing\n`
  );
  const noSummary = cli(["--base", fx.base, "--head", fx.second], fx.dir, {
    GITHUB_STEP_SUMMARY: join(own, "missing", "summary.md"),
  });
  eq(noSummary.code, 0);
  const noSummaryFail = cli(["--base", fx.base, "--head", fx.noTask], fx.dir, {
    GITHUB_STEP_SUMMARY: join(own, "missing", "summary.md"),
  });
  eq(noSummaryFail.code, 1);
  rmSync(own, { recursive: true, force: true });
  // The default head is HEAD (the fixture's checkout is the last commit it built).
  eq(cli(["--base", fx.pre], fx.dir).code, 0);
});

test("route tests: hostile cases on the files a change touches", () => {
  const routeTest = (tags) =>
    `import { GET } from "@/app/api/x/route";\n${tags.map((t) => `it("[hostile:${t}] x", () => {});`).join("\n")}\n`;
  const fx = fixture("hostile", (repo) => {
    const base = started(repo);
    const lacks = repo.commit("test: x", {
      "__tests__/x-route.test.ts": routeTest(["role", "self"]),
      "__tests__/plain.test.ts": 'it("x", () => {});\n',
      "__tests__/notes.md": 'import { GET } from "@/app/api/x/route";\n',
    });
    const fixed = repo.commit("test: tags", {
      "__tests__/x-route.test.ts": routeTest([
        "role",
        "self",
        "store-down",
        "id-spelling",
      ]),
    });
    repo.at(base);
    const deep = repo.commit("test: deep", {
      "__tests__/deep-route.test.ts": `import { GET } from "@/app/api/x/route";\nconst t = ${"`${".repeat(205)}x${"}`".repeat(205)};\n`,
    });
    repo.at(base);
    const helpers = {};
    for (const [name, ext] of [
      ["a", ""],
      ["b", ".ts"],
      ["c", ".tsx"],
      ["d", ".js"],
      ["e", "/index.ts"],
    ])
      helpers[`__tests__/helpers/${name}${ext}`] =
        'import { GET } from "@/app/api/x/route";\n';
    repo.commit("test: helpers", helpers);
    const viaHelpers = repo.commit(
      "test: via helpers",
      Object.fromEntries(
        ["a", "b", "c", "d", "e", "f"].map((n) => [
          `__tests__/${n}.test.ts`,
          `import { call } from "./helpers/${n}";\n`,
        ])
      )
    );
    const deleted = repo.commit("test: drop one", {}, ["__tests__/a.test.ts"]);
    return { base, lacks, fixed, deep, viaHelpers, deleted };
  });
  const lacking = (path, tags) =>
    `${path} drives a route and lacks ${tags.map((t) => `[hostile:${t}]`).join(", ")} (a test title tag, or a comment "hostile:<tag> n/a: <reason>")`;
  eq(check(fx, fx.base, fx.lacks).findings, [
    lacking("__tests__/x-route.test.ts", ["store-down", "id-spelling"]),
  ]);
  eq(check(fx, fx.base, fx.fixed).findings, []);
  eq(check(fx, fx.base, fx.deep).findings, [
    "__tests__/deep-route.test.ts drives a route and cannot be read for its hostile cases: templates nested deeper than 200",
  ]);
  const all = ["role", "self", "store-down", "id-spelling"];
  eq(
    check(fx, fx.base, fx.viaHelpers).findings,
    ["a", "b", "c", "d", "e"].map((n) => lacking(`__tests__/${n}.test.ts`, all))
  );
  eq(
    check(fx, fx.base, fx.deleted).findings,
    ["b", "c", "d", "e"].map((n) => lacking(`__tests__/${n}.test.ts`, all))
  );
});

test("the check's own files, CODEOWNERS and the risk tiers name their task", () => {
  const fx = fixture("gates", (repo) => {
    const base = started(repo);
    const out = { base };
    for (const [i, path] of [
      "scripts/process-check.app.json",
      "scripts/process-check-x.mjs",
      "scripts/risk-tier.mjs",
      "scripts/risk-tiers.app.json",
      ".github/CODEOWNERS",
      ".github/workflows/process-check-new.yml",
      ".github/workflows/ci.yml",
      ".github/workflows/process-check-x/y.yml",
      "scripts/process-check/inner.mjs",
      "x/scripts/process-check.mjs",
      ".github/CODEOWNERS.bak",
    ].entries()) {
      repo.at(base);
      out[`p${i}`] = repo.commit("chore: a gate file", { [path]: "x\n" });
    }
    return out;
  });
  const flagged = Array.from(
    { length: 11 },
    (_, i) => check(fx, fx.base, fx[`p${i}`]).findings.length
  );
  eq(flagged, [1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0]);
  eq(check(fx, fx.base, fx.p0).findings, [
    `${fx.p0.slice(0, 7)} "chore: a gate file" changes the process's own files but names no task: end its subject with (TASK-nnn) — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${fx.p0.slice(0, 7)}"`,
  ]);
});

test("a threat model for a change to a high-tier path, by the merge base's tiers", () => {
  const fx = fixture("threat", (repo) => {
    const base = repo.commit("chore: start", {
      "scripts/process-check.mjs": STUB,
      "docs/TASKS.md": register(OLD),
      "scripts/risk-tiers.json": JSON.stringify({
        high: [{ area: "auth", paths: ["lib/auth/**", 7] }, { area: "x" }, null],
      }),
    });
    const out = { base };
    for (const [key, files, blocks] of [
      ["tier", { "lib/auth/g.ts": "1\n" }, COMPLETE],
      ["tierOk", { "lib/auth/g.ts": "2\n" }, `${COMPLETE}\n\n${THREAT}`],
      ["plain", { "lib/plain.ts": "1\n" }, COMPLETE],
      ["github", { ".github/x.yml": "1\n", "lib/p.ts": "1\n" }, COMPLETE],
      ["review", { "REVIEW.md": "1\n", "lib/p.ts": "1\n" }, COMPLETE],
      ["claude", { "CLAUDE.md": "1\n", "lib/p.ts": "1\n" }, COMPLETE],
      ["attrs", { "x/.gitattributes": "1\n", "lib/p.ts": "1\n" }, COMPLETE],
      ["tiers", { "scripts/risk-tier-x.mjs": "1\n" }, COMPLETE],
      ["notReview", { "docs/REVIEW.md": "1\n", "lib/p.ts": "1\n" }, COMPLETE],
      ["notAttrs", { ".gitattributesx": "1\n", "lib/p.ts": "1\n" }, COMPLETE],
      [
        "lowered",
        { "scripts/risk-tiers.json": '{"high":[]}', "lib/auth/g.ts": "3\n" },
        COMPLETE,
      ],
    ]) {
      repo.at(base);
      out[key] = repo.commit("feat: guarded (TASK-905)", {
        ...files,
        "docs/TASKS.md": register(OLD, entry("TASK-905", blocks)),
      });
    }
    repo.at(base);
    const added = repo.commit("feat: guarded (TASK-905)", {
      "lib/auth/g.ts": "1\n",
      "docs/TASKS.md": register(OLD, entry("TASK-905", `${COMPLETE}\n\n${THREAT}`)),
    });
    out.added = added;
    out.revert = repo.commit(
      `Revert "feat: guarded (TASK-905)"\n\nThis reverts commit ${added}.`,
      {
        "docs/TASKS.md": register(OLD),
      },
      ["lib/auth/g.ts"]
    );
    repo.at(base);
    out.badTiers = repo.commit("chore: tiers unreadable", {
      "scripts/risk-tiers.json": "{",
    });
    out.badTiersUse = repo.commit("feat: guarded (TASK-906)", {
      "lib/auth/g.ts": "1\n",
      "docs/TASKS.md": register(OLD, entry("TASK-906", COMPLETE)),
    });
    repo.at(base);
    out.noHigh = repo.commit("chore: tiers without high", {
      "scripts/risk-tiers.json": '{"high":{}}',
    });
    out.noHighUse = repo.commit("feat: guarded (TASK-906)", {
      "lib/auth/g.ts": "1\n",
      "docs/TASKS.md": register(OLD, entry("TASK-906", COMPLETE)),
    });
    return out;
  });
  const missing = (path) => [
    `TASK-905 has no "Threat model" block (the change touches ${path}, a high-tier path)`,
  ];
  const got = (key) => check(fx, fx.base, fx[key]).findings;
  eq(
    [
      "tier",
      "tierOk",
      "plain",
      "github",
      "review",
      "claude",
      "attrs",
      "tiers",
      "notReview",
      "notAttrs",
      "lowered",
    ].map((k) => [k, got(k)]),
    [
      ["tier", missing("lib/auth/g.ts")],
      ["tierOk", []],
      ["plain", []],
      ["github", missing(".github/x.yml")],
      ["review", missing("REVIEW.md")],
      ["claude", missing("CLAUDE.md")],
      ["attrs", missing("x/.gitattributes")],
      ["tiers", missing("scripts/risk-tier-x.mjs")],
      ["notReview", []],
      ["notAttrs", []],
      ["lowered", missing("lib/auth/g.ts")],
    ]
  );
  eq(check(fx, fx.added, fx.revert).findings, []);
  eq(check(fx, fx.badTiers, fx.badTiersUse).findings, []);
  eq(check(fx, fx.noHigh, fx.noHighUse).findings, []);
});

test("an app's own task register, named in scripts/process-check.app.json", () => {
  const appTasks = (...entries) =>
    `# App tasks\n\n## Open Items\n\n${entries.join("\n")}\n## Resolved\n`;
  const fx = fixture("registers", (repo) => {
    const base = repo.commit("chore: start", {
      "scripts/process-check.mjs": STUB,
      "docs/TASKS.md": register(OLD),
      "scripts/process-check.app.json": JSON.stringify({
        taskRegisters: ["docs/APP_TASKS.md", "docs/../x.txt", 5, "docs/APP_TASKS.md"],
      }),
      "docs/APP_TASKS.md": appTasks(),
    });
    const own = repo.commit("feat: own (TASK-5001)", {
      "lib/own.ts": "1\n",
      "docs/APP_TASKS.md": appTasks(entry("TASK-5001", COMPLETE)),
    });
    const missing = repo.commit("fix: more (TASK-5002)", { "lib/own.ts": "2\n" });
    repo.at(own);
    const untouched = repo.commit("fix: again (TASK-5001)", { "lib/own.ts": "3\n" });
    repo.at(base);
    const both = repo.commit("feat: both (TASK-5003)", {
      "lib/own.ts": "1\n",
      "docs/TASKS.md": register(OLD, entry("TASK-5003", "Old.")),
      "docs/APP_TASKS.md": appTasks(entry("TASK-5003", COMPLETE)),
    });
    repo.at(base);
    const badConfig = repo.commit("chore: config", {
      "scripts/process-check.app.json": "{",
    });
    const badUse = repo.commit("feat: own (TASK-5001)", {
      "lib/own.ts": "1\n",
      "docs/APP_TASKS.md": appTasks(entry("TASK-5001", COMPLETE)),
    });
    repo.at(base);
    const notList = repo.commit("chore: config", {
      "scripts/process-check.app.json": JSON.stringify({
        taskRegisters: "docs/APP_TASKS.md",
      }),
    });
    const notListUse = repo.commit("feat: own (TASK-5001)", {
      "lib/own.ts": "1\n",
      "docs/APP_TASKS.md": appTasks(entry("TASK-5001", COMPLETE)),
    });
    return {
      base,
      own,
      missing,
      untouched,
      both,
      badConfig,
      badUse,
      notList,
      notListUse,
    };
  });
  eq(check(fx, fx.base, fx.own), {
    findings: [],
    notes: [],
    commits: 1,
    tasks: ["TASK-5001"],
  });
  eq(check(fx, fx.base, fx.missing).findings, [
    "TASK-5002 is named by a commit but has no entry in docs/TASKS.md or docs/APP_TASKS.md (add one, with its Design check and Self-review)",
  ]);
  eq(check(fx, fx.own, fx.untouched).findings, [
    "TASK-5001: the change does not touch its entry in docs/APP_TASKS.md (record the work there)",
  ]);
  // The first register to have an id wins: TASKS.md's entry (no blocks) is the one judged.
  eq(check(fx, fx.base, fx.both).findings, [
    'TASK-5003 has no "Design check" block',
    'TASK-5003 has no "Self-review" block',
  ]);
  eq(check(fx, fx.badConfig, fx.badUse).findings, [
    "TASK-5001 is named by a commit but has no entry in docs/TASKS.md (add one, with its Design check and Self-review)",
  ]);
  eq(check(fx, fx.notList, fx.notListUse).findings, [
    "TASK-5001 is named by a commit but has no entry in docs/TASKS.md (add one, with its Design check and Self-review)",
  ]);
});

test("merges: by what each changes itself", () => {
  const lines = (a, b) => `${a}\n1\n2\n3\n4\n5\n6\n7\n${b}\n`;
  const fx = fixture("merges", (repo) => {
    const base = started(repo);
    const fork = repo.commit("feat: both lines (TASK-900)", {
      "platform/m.ts": lines("a", "b"),
    });
    repo.git("checkout", "-q", "-b", "side");
    repo.commit("feat: side (TASK-900)", { "platform/m.ts": lines("a", "B") });
    repo.git("checkout", "-q", "-B", "main2", fork);
    repo.commit("feat: main (TASK-900)", { "platform/m.ts": lines("A", "b") });
    repo.git("merge", "-q", "--no-edit", "side");
    const clean = repo.git("rev-parse", "HEAD");
    repo.git("checkout", "-q", "-B", "main3", fork);
    repo.commit("docs: main side", { "docs/m.md": "m\n" });
    repo.git("merge", "-q", "--no-commit", "side");
    repo.write({ "lib/evil.ts": "x\n" });
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Merge side");
    const evil = repo.git("rev-parse", "HEAD");
    // An octopus: the result adds a path of its own; another changes nothing.
    for (const b of ["o1", "o2"]) {
      repo.git("checkout", "-q", "-B", b, base);
      repo.commit(`docs: ${b}`, { [`docs/${b}.md`]: `${b}\n` });
    }
    repo.git("checkout", "-q", "-B", "oct", base);
    repo.commit("docs: develop moves on", { "docs/dev.md": "d\n" });
    const octBase = repo.git("rev-parse", "HEAD");
    repo.git("merge", "-q", "--no-commit", "o1", "o2");
    repo.write({ "app/é v.ts": "x\n" });
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Merge o1 and o2");
    const octopus = repo.git("rev-parse", "HEAD");
    repo.git("checkout", "-q", "-B", "oct2", octBase);
    repo.git("merge", "-q", "--no-edit", "o1", "o2");
    const cleanOctopus = repo.git("rev-parse", "HEAD");
    // An unrelated history merged in.
    repo.git("checkout", "-q", "--orphan", "other");
    repo.git("rm", "-q", "-rf", ".");
    const unrelatedCommit = repo.commit("feat: unrelated", { "lib/u.ts": "u\n" });
    repo.git("checkout", "-q", "-B", "joined", base);
    repo.git("merge", "-q", "--no-edit", "--allow-unrelated-histories", "other");
    const unrelated = repo.git("rev-parse", "HEAD");
    return { base, fork, clean, evil, octopus, cleanOctopus, unrelated, unrelatedCommit };
  });
  eq(check(fx, fx.fork, fx.clean).findings, [
    'TASK-900 has no "Design check" block',
    'TASK-900 has no "Self-review" block',
    "TASK-900: the change does not touch its entry in docs/TASKS.md (record the work there)",
  ]);
  eq(check(fx, fx.fork, fx.evil).findings, [
    `${fx.evil.slice(0, 7)} "Merge side" changes code but names no task: end its subject with (TASK-nnn) — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${fx.evil.slice(0, 7)}"`,
    'TASK-900 has no "Design check" block',
    'TASK-900 has no "Self-review" block',
    "TASK-900: the change does not touch its entry in docs/TASKS.md (record the work there)",
  ]);
  eq(check(fx, fx.base, fx.octopus).findings, [
    `${fx.octopus.slice(0, 7)} "Merge o1 and o2" changes code but names no task: end its subject with (TASK-nnn) — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${fx.octopus.slice(0, 7)}"`,
  ]);
  eq(check(fx, fx.base, fx.cleanOctopus).findings, []);
  // An unrelated history merged in: its commits are judged; the merge itself (clean) is not.
  eq(check(fx, fx.base, fx.unrelated), {
    findings: [
      `${fx.unrelatedCommit.slice(0, 7)} "feat: unrelated" changes code but names no task: end its subject with (TASK-nnn) — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${fx.unrelatedCommit.slice(0, 7)}"`,
    ],
    notes: [],
    commits: 2,
    tasks: [],
  });
  // A git older than 2.36 refuses a two-parent merge, never guesses (the CLI, with a stand-in git).
  const bin = mkdtempSync(join(tmpdir(), "process-check-mutation-git-"));
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  for (const [version, refused] of [
    ["2.30.0", true],
    ["2.35.9", true],
    ["1.99.0", true],
    ["2.36.0", false],
    ["3.0.0", false],
    ["2.100.1", false],
    ["unknown", true],
  ]) {
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version ${version}"; exit 0; fi\nexec ${real} "$@"\n`,
      { mode: 0o755 }
    );
    const r = cli(["--base", fx.fork, "--head", fx.clean], fx.dir, {
      PATH: `${bin}:${process.env.PATH}`,
    });
    const want = refused
      ? `::error::${fx.clean.slice(0, 7)} "Merge branch 'side' into main2": a two-parent merge needs git 2.36 or later (--remerge-diff) to be judged; this is git version ${version} — upgrade git\n`
      : "";
    eq(
      [
        version,
        r.err
          .split("\n")
          .filter((l) => /remerge/.test(l))
          .join("\n") + (refused ? "\n" : ""),
      ],
      [version, want]
    );
  }
  rmSync(bin, { recursive: true, force: true });
});

test("modes, symlinks and submodules are changes; an octopus judges them", () => {
  const fx = fixture("modes", (repo, dir) => {
    const base = started(repo);
    repo.commit("chore: the module (TASK-900)", { "app/m.ts": "app/target\n" });
    repo.git("update-index", "--add", "--cacheinfo", `160000,${base},app/sub`);
    repo.git("commit", "-q", "-m", "chore: a submodule");
    const from = repo.git("rev-parse", "HEAD");
    const docs = (subject, path) => {
      repo.write({ [path]: `${path}\n` });
      repo.git("add", "--", path);
      repo.git("commit", "-q", "-m", subject);
    };
    for (const b of ["o1", "o2"]) {
      repo.git("checkout", "-q", "-B", b, from);
      docs(`docs: ${b}`, `docs/${b}.md`);
    }
    const out = { base, from };
    for (const [key, extra] of [
      ["none", () => {}],
      ["mode", () => repo.git("update-index", "--chmod=+x", "app/m.ts")],
      [
        "symlink",
        () => {
          rmSync(join(dir, "app/m.ts"));
          symlinkSync("app/target\n", join(dir, "app/m.ts"));
          repo.git("add", "app/m.ts");
        },
      ],
      ["sub", () => repo.git("update-index", "--cacheinfo", `160000,${from},app/sub`)],
    ]) {
      repo.git("checkout", "-q", "-f", "-B", `d-${key}`, from);
      docs("docs: develop moves on", "docs/dev.md");
      repo.git("merge", "-q", "--no-commit", "o1", "o2");
      extra();
      repo.git("commit", "-q", "-m", "Merge the branches");
      out[key] = repo.git("rev-parse", "HEAD");
    }
    return out;
  });
  const noTask = (sha) => [
    `${sha.slice(0, 7)} "Merge the branches" changes code but names no task: end its subject with (TASK-nnn) — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${sha.slice(0, 7)}"`,
  ];
  eq(check(fx, fx.from, fx.none).findings, []);
  eq(check(fx, fx.from, fx.mode).findings, noTask(fx.mode));
  eq(check(fx, fx.from, fx.symlink).findings, noTask(fx.symlink));
  eq(check(fx, fx.from, fx.sub).findings, noTask(fx.sub));
});

test("reverts: a true revert of a commit on the base passes; anything less is judged", () => {
  const fx = fixture("reverts", (repo, dir) => {
    const base = started(repo);
    const out = { base };
    // The entry restored exactly, removed, untouched, or the revert carrying more.
    out.reverted = repo.commit("fix: change (TASK-900)", {
      "platform/a.ts": "export const a = 2;\n",
      "docs/TASKS.md": ADD("TASK-950", COMPLETE).replace(
        "The work.",
        "The work, changed."
      ),
    });
    repo.git("revert", "--no-edit", out.reverted);
    out.restoring = repo.git("rev-parse", "HEAD");
    repo.at(base);
    out.adds = repo.commit("feat: new (TASK-951)", {
      "platform/a.ts": "export const a = 3;\n",
      "docs/TASKS.md": ADD("TASK-951", COMPLETE),
    });
    repo.git("revert", "--no-edit", out.adds);
    out.removing = repo.git("rev-parse", "HEAD");
    repo.at(base);
    out.other = repo.commit("fix: code only (TASK-900)", {
      "platform/a.ts": "export const a = 4;\n",
    });
    out.plain = repo.commit(
      `Revert "fix: code only (TASK-900)"\n\nThis reverts commit ${out.other}.`,
      {
        "platform/a.ts": "export const a = 1;\n",
      }
    );
    repo.at(out.other);
    out.smuggled = repo.commit(
      `Revert "fix: code only (TASK-900)"\n\nThis reverts commit ${out.other}.`,
      {
        "platform/a.ts": "export const a = 1;\n",
        "lib/smuggled.ts": "export const s = 1;\n",
      }
    );
    repo.at(out.other);
    out.partialBytes = repo.commit(
      `Revert "fix: code only (TASK-900)"\n\nThis reverts commit ${out.other}.`,
      {
        "platform/a.ts": "export const a = 5;\n",
      }
    );
    repo.at(out.other);
    repo.write({ "platform/a.ts": "export const a = 1;\n" });
    chmodSync(join(dir, "platform/a.ts"), 0o755);
    repo.git("add", "-A");
    repo.git(
      "commit",
      "-q",
      "-m",
      `Revert "fix: code only (TASK-900)"\n\nThis reverts commit ${out.other}.`
    );
    out.modeRevert = repo.git("rev-parse", "HEAD");
    repo.at(out.other);
    out.shortSha = repo.commit(
      `Revert "fix: code only (TASK-900)"\n\nThis reverts commit ${out.other.slice(0, 7)}.`,
      {
        "platform/a.ts": "export const a = 1;\n",
      }
    );
    repo.at(out.other);
    out.badSha = repo.commit(
      `Revert "fix: code only (TASK-900)"\n\nThis reverts commit ${"f".repeat(40)}.`,
      {
        "platform/a.ts": "export const a = 1;\n",
      }
    );
    repo.at(out.other);
    out.noBody = repo.commit(`Revert "fix: code only (TASK-900)"`, {
      "platform/a.ts": "export const a = 1;\n",
    });
    repo.at(out.other);
    out.notRevertSubject = repo.commit(
      `Undo "fix: code only (TASK-900)"\n\nThis reverts commit ${out.other}.`,
      {
        "platform/a.ts": "export const a = 1;\n",
      }
    );
    repo.at(out.other);
    out.indented = repo.commit(
      `Revert "fix: code only (TASK-900)"\n\n  This reverts commit ${out.other}.`,
      {
        "platform/a.ts": "export const a = 1;\n",
      }
    );
    // Edited since: the revert's parent no longer holds what the reverted commit left.
    repo.at(out.other);
    out.since = repo.commit("fix: since (TASK-900)", {
      "platform/a.ts": "export const a = 6;\n",
    });
    out.overSince = repo.commit(
      `Revert "fix: code only (TASK-900)"\n\nThis reverts commit ${out.other}.`,
      {
        "platform/a.ts": "export const a = 1;\n",
      }
    );
    // Reverting the rule itself: it deletes the script.
    repo.at(base);
    out.ruleRevert = repo.commit(
      `Revert "ci: the rule (TASK-200)"\n\nThis reverts commit ${base}.`,
      {},
      ["scripts/process-check.mjs"]
    );
    // A revert of a commit off the base (a side branch), and of the same commit once on it.
    repo.git("checkout", "-q", "-B", "side", base);
    repo.commit("feat: evil", { "app/x.ts": "export const x = 'EVIL';\n" });
    out.x = repo.commit("fix: clean", { "app/x.ts": "export const x = 'clean';\n" });
    repo.at(base);
    out.at = repo.commit("feat: x (TASK-900)", {
      "app/x.ts": "export const x = 'clean';\n",
    });
    out.offBase = repo.commit(`Revert "side X"\n\nThis reverts commit ${out.x}.`, {
      "app/x.ts": "export const x = 'EVIL';\n",
    });
    repo.at(out.x);
    repo.git("revert", "--no-edit", out.x);
    out.onBase = repo.git("rev-parse", "HEAD");
    // GitHub's Revert of a merged pull request.
    repo.git("checkout", "-q", "-B", "feature", base);
    repo.commit("feat: the feature (TASK-952)", {
      "lib/feature.ts": "export const f = 1;\n",
      "docs/TASKS.md": ADD("TASK-952", COMPLETE),
    });
    repo.git("checkout", "-q", "-B", "mainline", base);
    repo.commit("docs: meanwhile", { "docs/meanwhile.md": "m\n" });
    repo.git(
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "Merge pull request #12 from x/feature",
      "feature"
    );
    out.merged = repo.git("rev-parse", "HEAD");
    repo.git("revert", "--no-edit", "-m", "1", out.merged);
    out.mergeRevert = repo.git("rev-parse", "HEAD");
    repo.at(out.merged);
    out.mergePartial = repo.commit(
      `Revert "Merge pull request #12 from x/feature"\n\nThis reverts commit ${out.merged}, reversing\nchanges made to ${out.merged}^.`,
      { "lib/feature.ts": "export const f = 2;\n" }
    );
    // The pull request of a revert alone: its title is not judged.
    repo.at(base);
    out.feat = repo.commit("feat: x (TASK-953)", {
      "lib/x.ts": "export const x = 1;\n",
      "docs/TASKS.md": ADD("TASK-953", COMPLETE),
    });
    repo.git("revert", "--no-edit", out.feat);
    out.featReverted = repo.git("rev-parse", "HEAD");
    out.withMore = repo.commit("docs: a note", { "lib/y.ts": "export const y = 1;\n" });
    return out;
  });
  const s = (sha) => sha.slice(0, 7);
  const oldRule = [
    'TASK-900 has no "Design check" block',
    'TASK-900 has no "Self-review" block',
    "TASK-900: the change does not touch its entry in docs/TASKS.md (record the work there)",
  ];
  const only900 = (from, to) =>
    check(fx, from, to).findings.filter((f) => /TASK-900/.test(f));
  eq(only900(fx.reverted, fx.restoring), []);
  // Named by its subject (Revert "… (TASK-900)"): its entry restored exactly, it passes.
  eq(check(fx, fx.reverted, fx.restoring), {
    findings: [],
    notes: [],
    commits: 1,
    tasks: ["TASK-900"],
  });
  eq(check(fx, fx.adds, fx.removing), {
    findings: [],
    notes: [],
    commits: 1,
    tasks: ["TASK-951"],
  });
  eq(only900(fx.other, fx.plain), []);
  for (const key of [
    "smuggled",
    "partialBytes",
    "modeRevert",
    "badSha",
    "noBody",
    "indented",
  ])
    eq([key, only900(fx.other, fx[key])], [key, oldRule]);
  eq(check(fx, fx.other, fx.notRevertSubject).findings, [
    `${s(fx.notRevertSubject)} "Undo "fix: code only (TASK-900)"" changes code but names no task: end its subject with (TASK-nnn) — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${s(fx.notRevertSubject)}"`,
  ]);
  eq(only900(fx.other, fx.shortSha), []);
  eq(only900(fx.since, fx.overSince), oldRule);
  // Reverting the rule: no true revert (the rule's first commit is not the inverse of one).
  eq(check(fx, fx.base, fx.ruleRevert).findings, [
    "TASK-200 is named by a commit but has no entry in docs/TASKS.md (add one, with its Design check and Self-review)",
  ]);
  eq(check(fx, fx.at, fx.offBase).findings, [
    `${s(fx.offBase)} "Revert "side X"" changes code but names no task: end its subject with (TASK-nnn) — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${s(fx.offBase)}"${REVERT_REMEDY}`,
  ]);
  eq(check(fx, fx.x, fx.onBase), {
    findings: [],
    notes: [`${s(fx.onBase)} is a true revert of ${s(fx.x)}, on the base: judged there`],
    commits: 1,
    tasks: [],
  });
  eq(check(fx, fx.merged, fx.mergeRevert), {
    findings: [],
    notes: [
      `${s(fx.mergeRevert)} is a true revert of ${s(fx.merged)}, on the base: judged there`,
    ],
    commits: 1,
    tasks: [],
  });
  eq(check(fx, fx.merged, fx.mergePartial).findings, [
    `${s(fx.mergePartial)} "Revert "Merge pull request #12 from x/feature"" changes code but names no task: end its subject with (TASK-nnn) — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${s(fx.mergePartial)}"${REVERT_REMEDY}`,
  ]);
  eq(check(fx, fx.feat, fx.featReverted).notes, []);
  eq(check(fx, fx.feat, fx.withMore).findings, [
    `${s(fx.withMore)} "docs: a note" changes code but names no task: end its subject with (TASK-nnn) — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${s(fx.withMore)}"`,
  ]);
});

test("baselines against the merge base, renames followed", () => {
  const body = "export const long = 1;\n".repeat(20);
  const fx = fixture("baselines", (repo) => {
    const base = repo.commit("chore: start", {
      "scripts/process-check.mjs": STUB,
      "docs/TASKS.md": register(OLD),
      "lib/old.ts": body,
      "body-schema-baseline.json": JSON.stringify({
        count: 2,
        files: { "lib/old.ts": 2 },
      }),
      "screen-literal-baseline.json": JSON.stringify({ count: 3 }),
      "coverage-baseline.json": JSON.stringify({
        margin: 1,
        baseline: { statements: 90, lines: 90, functions: 90, branches: 80 },
      }),
      "fake-fetch-baseline.json": JSON.stringify({ count: 1, files: { "x.test.ts": 1 } }),
      "open-input-register.json": JSON.stringify({ count: 1, entries: { "a#b": "r" } }),
      "refusal-coverage-baseline.json": JSON.stringify({
        count: 1,
        gaps: ["a -> /b : c"],
      }),
    });
    repo.git("mv", "lib/old.ts", "lib/new.ts");
    const renamed = repo.commit("refactor: rename (TASK-900)", {
      "body-schema-baseline.json": JSON.stringify({
        count: 2,
        files: { "lib/new.ts": 3 },
      }),
    });
    repo.at(base);
    const raised = repo.commit("chore: raise", {
      "screen-literal-baseline.json": JSON.stringify({ count: 4 }),
      "fake-fetch-baseline.json": JSON.stringify({ count: 2, files: { "x.test.ts": 2 } }),
      "open-input-register.json": JSON.stringify({
        count: 1,
        entries: { "a#b": "r", "a#c": "r" },
      }),
      "refusal-coverage-baseline.json": JSON.stringify({
        count: 1,
        gaps: ["a -> /b : d"],
      }),
      "coverage-baseline.json": JSON.stringify({
        margin: 1,
        baseline: { statements: 90, lines: 89, functions: 90, branches: 80 },
      }),
    });
    const dropped = repo.commit("chore: drop", {}, ["screen-literal-baseline.json"]);
    repo.at(base);
    const noRule = repo.commit("chore: drop the rule", {}, ["scripts/process-check.mjs"]);
    const afterNoRule = repo.commit("chore: raise", {
      "screen-literal-baseline.json": JSON.stringify({ count: 9 }),
    });
    return { base, renamed, raised, dropped, noRule, afterNoRule };
  });
  eq(
    check(fx, fx.base, fx.renamed).findings.filter((f) => /baseline/.test(f)),
    ["body-schema-baseline.json: lib/new.ts 3, the base has 2 (as lib/old.ts)"]
  );
  eq(check(fx, fx.base, fx.raised).findings, [
    "fake-fetch-baseline.json: count 2, the base has 1 — it only shrinks",
    "fake-fetch-baseline.json: x.test.ts 2, the base has 1",
    "open-input-register.json: a#c added — the base does not list it, and the total rises (2 > 1); fix the new findings instead, or remove the key",
    "refusal-coverage-baseline.json: gap added — a -> /b : d",
    "screen-literal-baseline.json: count 4, the base has 3 — it only shrinks",
    "coverage-baseline.json: the lines floor 89, the base has 90 — floors only rise",
  ]);
  eq(
    check(fx, fx.base, fx.dropped).findings.includes(
      "screen-literal-baseline.json: removed — a ratchet baseline stays (lower it to zero instead)"
    ),
    true
  );
  // A head that dropped the script is still judged (the rule began in its history).
  eq(
    check(fx, fx.base, fx.afterNoRule).findings.filter((f) => /baseline\.json/.test(f)),
    ["screen-literal-baseline.json: count 9, the base has 3 — it only shrinks"]
  );
});

/** The sync fixtures: platform-foundation, and an app syncing from it (built once). */
// ── round 6: flows that must have a way out ────────────────────────────────────────────────

test("subjectRefs: platform-foundation's tasks named by an app", () => {
  eq(m.subjectRefs("fix: x (platform TASK-1, TASK-2)"), [
    { id: "TASK-1", platform: true },
    { id: "TASK-2", platform: false },
  ]);
  eq(m.subjectRefs('Revert "fix: x (platform TASK-3)"'), [
    { id: "TASK-3", platform: true },
  ]);
  eq(m.subjectRefs("fix: x"), []);
  eq(m.subjectTasks("fix: x (platform TASK-1, TASK-1)"), ["TASK-1"]);
});

test("TASK-200's own entry passes its own check", () => {
  const text = readFileSync(join(HERE, "..", "docs", "TASKS.md"), "utf8");
  const own = m.taskEntries(text).find((e) => e.id === "TASK-200");
  eq(m.entryFindings(own, [m.THREAT_MODEL]), []);
});

test("adoption, an app's platform task, Dependabot's and sync commits, a revert after the register moved", () => {
  const ciText = `name: CI\njobs:\n  ci:\n    steps:\n      - uses: actions/checkout@${"a".repeat(40)} # v7\n`;
  const bumped = ciText.replace("a".repeat(40), "f".repeat(40)).replace("# v7", "# v8");
  const appTasks = (body) => `# App tasks\n\n## Open Items\n\n${body}\n## Resolved\n`;
  const fx = fixture("round6", (repo) => {
    const base = started(repo);
    const out = { base };
    out.lost = repo.commit("feat: y", { "lib/y.ts": "y\n" });
    const adopt = (line) => register(OLD, entry("TASK-910", `${line}\n\n${COMPLETE}`));
    out.adopted = repo.commit("docs: adopt (TASK-910)", {
      "docs/TASKS.md": adopt(`**Commits:** ${out.lost.slice(0, 7)}, deadbee`),
    });
    repo.at(out.lost);
    out.full = repo.commit("docs: adopt (TASK-910)", {
      "docs/TASKS.md": adopt(`- **Commits:** ${out.lost}`),
    });
    repo.at(out.lost);
    out.mention = repo.commit("docs: mention (TASK-910)", {
      "docs/TASKS.md": adopt(`Commits ${out.lost.slice(0, 7)} were pushed.`),
    });
    repo.at(out.lost);
    out.quoted = repo.commit("docs: quote (TASK-910)", {
      "docs/TASKS.md": adopt(`Adopt it with \`**Commits:** ${out.lost.slice(0, 7)}\`.`),
    });
    repo.at(out.lost);
    out.short6 = repo.commit("docs: adopt (TASK-910)", {
      "docs/TASKS.md": adopt(`**Commits:** ${out.lost.slice(0, 6)}`),
    });
    // An app naming platform-foundation's task.
    repo.at(base);
    out.appBase = repo.commit("chore: the app", {
      "scripts/process-check.app.json": JSON.stringify({
        taskRegisters: ["docs/APP_TASKS.md"],
      }),
      "docs/APP_TASKS.md": appTasks(entry("TASK-5000", "Old.")),
      "docs/TASKS.md": register(OLD, entry("TASK-200", COMPLETE)),
    });
    out.appOk = repo.commit("ci(app): x (platform TASK-200)", {
      "lib/own.ts": "1\n",
      "docs/APP_TASKS.md": appTasks(
        entry("TASK-5000", "The app's part of platform TASK-200.")
      ),
    });
    repo.at(out.appBase);
    out.appNoRef = repo.commit("ci(app): x (platform TASK-200)", {
      "lib/own.ts": "1\n",
      "docs/APP_TASKS.md": appTasks(entry("TASK-5000", "Something else entirely.")),
    });
    repo.at(out.appBase);
    out.appUntouched = repo.commit("ci(app): x (platform TASK-200)", {
      "lib/own.ts": "1\n",
    });
    repo.at(out.appBase);
    out.appBoth = repo.commit("ci(app): x (platform TASK-200, TASK-200)", {
      "lib/own.ts": "1\n",
    });
    repo.at(out.appBase);
    out.appMissing = repo.commit("ci(app): x (platform TASK-201)", {
      "lib/own.ts": "1\n",
      "docs/APP_TASKS.md": appTasks(
        entry("TASK-5000", "The app's part of platform TASK-201.")
      ),
    });
    // platform-foundation itself (no app register): `platform TASK-nnn` is its own task.
    repo.at(base);
    out.pfPlatform = repo.commit("fix: x (platform TASK-900)", { "lib/z.ts": "1\n" });
    // Dependabot's commits (by their author) and sync commits (by their subject) are not judged.
    repo.at(base);
    out.wfBase = repo.commit("ci: the workflow (TASK-900)", {
      ".github/workflows/ci.yml": ciText,
    });
    const byDependabot = (
      subject,
      files,
      committer = "GitHub",
      author = "dependabot[bot]"
    ) => {
      repo.write(files);
      repo.git("add", "-A");
      execFileSync(
        "git",
        [
          "commit",
          "-q",
          `--author=${author} <49699333+dependabot[bot]@users.noreply.github.com>`,
          "-m",
          subject,
        ],
        { cwd: repo.dir, env: { ...GIT_ENV, GIT_COMMITTER_NAME: committer } }
      );
      return repo.git("rev-parse", "HEAD");
    };
    out.bump = byDependabot("ci: bump actions/checkout from 7 to 8", {
      ".github/workflows/ci.yml": bumped,
      "lib/z.ts": "2\n",
    });
    repo.at(out.wfBase);
    out.bumpBot = byDependabot(
      "ci: bump actions/checkout from 7 to 8",
      { ".github/workflows/ci.yml": bumped },
      "dependabot[bot]"
    );
    // Amended (or rebased) by hand: Dependabot stays the author, a person commits it — judged.
    repo.at(out.wfBase);
    out.bumpAmended = byDependabot(
      "ci: bump actions/checkout from 7 to 8",
      { ".github/workflows/ci.yml": bumped, "platform/fix.ts": "1\n" },
      "T"
    );
    // Not Dependabot's exact name.
    repo.at(out.wfBase);
    out.bumpLookalike = byDependabot(
      "ci: bump actions/checkout from 7 to 8",
      { ".github/workflows/ci.yml": bumped },
      "GitHub",
      "dependabot"
    );
    repo.at(out.wfBase);
    out.bumpByHand = repo.commit("ci: bump actions/checkout from 7 to 8", {
      ".github/workflows/ci.yml": bumped,
    });
    repo.at(out.wfBase);
    out.notDependabot = repo.commit("ci: bump (dependabot[bot])", {
      ".github/workflows/ci.yml": bumped,
    });
    repo.at(base);
    out.sync = repo.commit(
      `chore(sync): inherit platform-foundation main @ ${"b".repeat(40)}`,
      {
        "lib/synced.ts": "s\n",
      }
    );
    repo.at(base);
    out.syncShort = repo.commit(
      `chore(sync): inherit platform-foundation main @ ${"b".repeat(39)}`,
      {
        "lib/synced.ts": "s\n",
      }
    );
    // GitHub's Revert of a merged pull request after another commit moved the register.
    repo.git("checkout", "-q", "-B", "feature", base);
    repo.commit("feat: the feature (TASK-952)", {
      "lib/feature.ts": "f\n",
      "docs/TASKS.md": register(OLD, entry("TASK-952", COMPLETE)),
    });
    repo.git("checkout", "-q", "-B", "mainline", base);
    repo.git(
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "Merge pull request #12 from x/feature",
      "feature"
    );
    out.merged = repo.git("rev-parse", "HEAD");
    out.moved = repo.commit("feat: next (TASK-953)", {
      "lib/next.ts": "n\n",
      "docs/TASKS.md": register(
        entry("TASK-953", COMPLETE),
        OLD,
        entry("TASK-952", COMPLETE)
      ),
    });
    repo.git("revert", "--no-edit", "-m", "1", out.merged);
    out.reverted = repo.git("rev-parse", "HEAD");
    return out;
  });
  const s = (sha) => sha.slice(0, 7);
  const adopt = (sha) =>
    ` — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${s(sha)}"`;
  const lostTask = `${s(fx.lost)} "feat: y" changes code but names no task: end its subject with (TASK-nnn)${adopt(fx.lost)}`;
  eq(check(fx, fx.base, fx.lost).findings, [lostTask]);
  for (const key of ["adopted", "full"])
    eq(
      [key, check(fx, fx.base, fx[key])],
      [
        key,
        {
          findings: [],
          notes: [`${s(fx.lost)} names no task in its subject; adopted by TASK-910`],
          commits: 2,
          tasks: ["TASK-910"],
        },
      ]
    );
  for (const key of ["mention", "quoted", "short6"])
    eq([key, check(fx, fx.base, fx[key]).findings], [key, [lostTask]]);
  eq(check(fx, fx.appBase, fx.appOk), {
    findings: [],
    notes: [],
    commits: 1,
    tasks: ["TASK-200"],
  });
  const noRef = `platform TASK-200: the change touches no entry in docs/APP_TASKS.md that references "platform TASK-200" (record the app's work there; sync platform-foundation's entry first)`;
  eq(check(fx, fx.appBase, fx.appNoRef).findings, [noRef]);
  eq(check(fx, fx.appBase, fx.appUntouched).findings, [noRef]);
  // Named plainly too (`TASK-200`): its entry itself must be touched.
  eq(check(fx, fx.appBase, fx.appBoth).findings, [
    // L-1: an app's message points to its own register and `(platform TASK-nnn)`.
    `TASK-200: the change does not touch its entry in docs/TASKS.md, platform-foundation's synced register (for platform-foundation's task, end the subject with (platform TASK-200) and record the app's work in an entry of docs/APP_TASKS.md that references "platform TASK-200")`,
  ]);
  eq(check(fx, fx.appBase, fx.appMissing).findings, [
    "TASK-201 is named by a commit but has no entry in docs/TASKS.md or docs/APP_TASKS.md (a platform task: sync platform-foundation's entry first)",
  ]);
  eq(check(fx, fx.base, fx.pfPlatform).findings, [
    'TASK-900 has no "Design check" block',
    'TASK-900 has no "Self-review" block',
    "TASK-900: the change does not touch its entry in docs/TASKS.md (record the work there)",
  ]);
  eq(check(fx, fx.wfBase, fx.bump), {
    findings: [],
    notes: [`${s(fx.bump)} is Dependabot's: not judged`],
    commits: 1,
    tasks: [],
  });
  eq(check(fx, fx.wfBase, fx.bumpBot).notes, [
    `${s(fx.bumpBot)} is Dependabot's: not judged`,
  ]);
  eq(check(fx, fx.wfBase, fx.bumpAmended).findings, [
    `${s(fx.bumpAmended)} "ci: bump actions/checkout from 7 to 8" changes code but names no task: end its subject with (TASK-nnn)${adopt(fx.bumpAmended)}`,
  ]);
  for (const [key, subject] of [
    ["bumpLookalike", "ci: bump actions/checkout from 7 to 8"],
    ["bumpByHand", "ci: bump actions/checkout from 7 to 8"],
    ["notDependabot", "ci: bump (dependabot[bot])"],
  ])
    eq(check(fx, fx.wfBase, fx[key]).findings, [
      `${s(fx[key])} "${subject}" changes the process's own files but names no task: end its subject with (TASK-nnn)${adopt(fx[key])}`,
    ]);
  eq(check(fx, fx.base, fx.sync), {
    findings: [],
    notes: [
      `${s(fx.sync)} is a sync from platform-foundation (by its subject): not judged here`,
    ],
    commits: 1,
    tasks: [],
  });
  eq(check(fx, fx.base, fx.syncShort).findings.length, 1);
  eq(check(fx, fx.moved, fx.reverted), {
    findings: [],
    notes: [
      `${s(fx.reverted)} is a true revert of ${s(fx.merged)}, on the base: judged there`,
    ],
    commits: 1,
    tasks: [],
  });
});

test("a base with no history in common: the range is judged from the base itself", () => {
  const fx = fixture("unrelated-base", (repo) => {
    const head = started(repo);
    const code = repo.commit("feat: code (TASK-901)", {
      "platform/a.ts": "export const a = 2;\n",
    });
    repo.git("checkout", "-q", "--orphan", "other");
    repo.git("rm", "-q", "-rf", ".");
    const other = repo.commit("chore: elsewhere", { "x.txt": "x\n" });
    // A history the rule never reached: its head's own files are not judged either.
    repo.git("checkout", "-q", "--orphan", "pre");
    repo.git("rm", "-q", "-rf", ".");
    const pre = repo.commit("feat: before any rule", {
      "lib/a.ts": "a\n",
    });
    return { head, code, other, pre };
  });
  // No merge base: every commit of the head's history is the range's (both), as for a first push.
  const r = check(fx, fx.other, fx.code);
  eq([r.commits, r.findings.length], [2, 2]);
  eq(
    r.findings[1],
    "TASK-901 is named by a commit but has no entry in docs/TASKS.md (add one, with its Design check and Self-review)"
  );
  eq(check(fx, fx.other, fx.pre), { findings: [], notes: [], commits: 0, tasks: [] });
});

test("survivors: reverts, entries, route tests and the range's own history", () => {
  // TASK-910's entry is incomplete on purpose: an entry judged shows its findings, one passed by a
  // true revert shows none.
  const E910 = entry("TASK-910", "Old.");
  const E910b = entry("TASK-910", "Old.\n\nMore.");
  const reverts = (sha) => `This reverts commit ${sha}.`;
  const fx = fixture("survivors-history", (repo) => {
    const out = {};
    // Before the rule: a code commit without a task, then the script arrives.
    out.c0 = repo.commit("feat: before", { "platform/a.ts": "export const a = 0;\n" });
    out.root = started(repo);
    out.c1 = repo.commit("feat: a (TASK-910)", {
      "platform/a.ts": "export const a = 2;\n",
      "platform/b.ts": "b1\n",
      "docs/TASKS.md": register(OLD, E910),
    });
    const revert = (target, files, remove = []) => {
      repo.write(files);
      for (const p of remove) rmSync(join(repo.dir, p), { force: true });
      repo.git("add", "-A");
      const subject = repo.git("log", "-1", "--format=%s", target);
      repo.git("commit", "-q", "-m", `Revert "${subject}"`, "-m", reverts(target));
      return repo.git("rev-parse", "HEAD");
    };
    // A true revert of c1, its entry kept: no entry before c1 to be as.
    out.rC1 = revert(out.c1, { "platform/a.ts": "export const a = 1;\n" }, [
      "platform/b.ts",
    ]);
    repo.at(out.c1);
    out.c2 = repo.commit("fix: a again (TASK-910)", {
      "platform/a.ts": "export const a = 3;\n",
      "docs/TASKS.md": register(OLD, E910b),
    });
    // Reverts of c2 (on the base), each with the entry left differently.
    out.rBack = revert(out.c2, {
      "platform/a.ts": "export const a = 2;\n",
      "docs/TASKS.md": register(OLD, E910),
    });
    out.rBoth = revert(out.c1, { "platform/a.ts": "export const a = 1;\n" }, [
      "platform/b.ts",
    ]);
    repo.at(out.c2);
    out.rKept = revert(out.c2, { "platform/a.ts": "export const a = 2;\n" });
    // A revert naming a commit this repository does not have: no reverted commit.
    repo.at(out.c2);
    repo.write({ "platform/a.ts": "export const a = 2;\n" });
    repo.git("add", "-A");
    repo.git(
      "commit",
      "-q",
      "-m",
      'Revert "fix: a again (TASK-910)"',
      "-m",
      reverts("deadbeefdeadbeef")
    );
    out.rUnknown = repo.git("rev-parse", "HEAD");
    // A partial revert of c1: as many files, one not back; its entry removed.
    repo.at(out.c1);
    out.rPartial = revert(out.c1, {
      "platform/a.ts": "export const a = 1;\n",
      "platform/b.ts": "b2\n",
      "docs/TASKS.md": register(OLD),
    });
    // A revert subject with no "This reverts commit" line, and a revert of the root.
    repo.at(out.c2);
    out.rNoBody = repo.commit('Revert "fix: a again (TASK-910)"', {
      "platform/a.ts": "export const a = 2;\n",
    });
    repo.at(out.c2);
    out.rRoot = revert(out.c0, {}, ["platform/a.ts"]);
    // A task whose entry its own commit removed, reverted (the entry not restored).
    repo.at(out.c2);
    repo.commit("docs: TASK-920", {
      "docs/TASKS.md": register(OLD, E910b, entry("TASK-920", "Old.")),
    });
    out.c3 = repo.commit("feat: c (TASK-920)", {
      "platform/c.ts": "c\n",
      "docs/TASKS.md": register(OLD, E910b),
    });
    out.rC3 = revert(out.c3, {}, ["platform/c.ts"]);
    // The entry touched on its last line only (the blank line before the next heading).
    repo.at(out.c2);
    out.lastLine = repo.commit("fix: a (TASK-910)", {
      "platform/a.ts": "export const a = 4;\n",
      "docs/TASKS.md": register(OLD, E910b).replace(
        "More.\n\n## Resolved",
        "More.\nDone.\n## Resolved"
      ),
    });
    // Two route tests, the later-sorted one first.
    repo.at(out.c2);
    const RT = 'import { GET } from "@/app/api/x/route";\nit("x", () => {});\n';
    repo.commit("test: z (TASK-910)", {
      "__tests__/z.test.ts": RT,
      "docs/TASKS.md": register(OLD, E910),
    });
    out.routes = repo.commit("test: a (TASK-910)", { "__tests__/a.test.ts": RT });
    // A side branch whose register already holds the entry the head adds.
    repo.at(out.root);
    out.side = repo.commit("docs: side", { "docs/TASKS.md": register(OLD, E910) });
    // Baselines: a key re-keyed from a deleted file; a key of a renamed file.
    repo.at(out.c2);
    const long = (x) =>
      `export const ${x} = 'a line long enough for git to see the file renamed';\n`;
    out.bBase = repo.commit("chore: baseline (TASK-910)", {
      "body-schema-baseline.json": JSON.stringify({
        count: 2,
        files: { "lib/a.ts": 1, "lib/c.ts": 1 },
      }),
      "lib/a.ts": long("a"),
      "lib/c.ts": long("c"),
    });
    out.bDelete = repo.commit(
      "refactor: a to b (TASK-910)",
      {
        "body-schema-baseline.json": JSON.stringify({
          count: 2,
          files: { "lib/b.ts": 1, "lib/c.ts": 1 },
        }),
        "lib/b.ts": "export const y = 1;\n",
      },
      ["lib/a.ts"]
    );
    repo.at(out.bBase);
    repo.git("mv", "lib/c.ts", "lib/d.ts");
    out.bRename = repo.commit("refactor: c to d (TASK-910)", {
      "body-schema-baseline.json": JSON.stringify({
        count: 2,
        files: { "lib/a.ts": 1, "lib/d.ts": 1 },
      }),
    });
    // An app with two registers: platform TASK-200's work recorded in the first.
    repo.git("checkout", "-q", "--orphan", "app");
    repo.git("rm", "-q", "-rf", ".");
    const appTasks = (...e) =>
      `# App tasks\n\n## Open Items\n\n${e.join("\n")}\n## Resolved\n`;
    out.appBase = repo.commit("chore: start", {
      "scripts/process-check.mjs": STUB,
      "docs/TASKS.md": register(OLD, entry("TASK-200", COMPLETE)),
      "scripts/process-check.app.json": JSON.stringify({
        taskRegisters: ["docs/A.md", "docs/B.md"],
      }),
      "docs/A.md": appTasks(
        entry("TASK-5000", "Other."),
        entry("TASK-5001", `${COMPLETE}\n\nFor platform TASK-200.`)
      ),
      "docs/B.md": appTasks(entry("TASK-5002", "Unrelated.")),
    });
    out.appRecorded = repo.commit("feat: the app's part (platform TASK-200)", {
      "lib/x.ts": "1\n",
      "docs/A.md": appTasks(
        entry("TASK-5000", "Other."),
        entry("TASK-5001", `${COMPLETE}\n\nFor platform TASK-200. Done.`)
      ),
    });
    repo.at(out.appBase);
    out.appNot = repo.commit("feat: the app's part (platform TASK-200)", {
      "lib/x.ts": "2\n",
    });
    repo.git("checkout", "-q", "--orphan", "other");
    repo.git("rm", "-q", "-rf", ".");
    out.other = repo.commit("chore: elsewhere", { "x.txt": "x\n" });
    repo.git("checkout", "-q", "-f", "develop");
    return out;
  });
  const run = (base, head) => check(fx, base, head);
  const blocks = [
    'TASK-910 has no "Design check" block',
    'TASK-910 has no "Self-review" block',
  ];
  const judged = [
    ...blocks,
    "TASK-910: the change does not touch its entry in docs/TASKS.md (record the work there)",
  ];
  const noTask = (sha, subject) =>
    `${sha.slice(0, 7)} "${subject}" changes code but names no task: end its subject with (TASK-nnn) — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${sha.slice(0, 7)}"`;
  const lacks = (p) =>
    `${p} drives a route and lacks [hostile:role], [hostile:self], [hostile:store-down], [hostile:id-spelling] (a test title tag, or a comment "hostile:<tag> n/a: <reason>")`;
  // A true revert's entry, as before the reverted commit (of either of two reverts), passes.
  eq(run(fx.c2, fx.rBack).findings, []);
  eq(run(fx.c2, fx.rBoth).findings, []);
  // Left as the reverted commit made it, or with no entry before it to be as: judged.
  eq(run(fx.c2, fx.rKept).findings, judged);
  eq(run(fx.c1, fx.rC1).findings, judged);
  // A partial revert is no true revert: its task named plainly, the entry removed is missing.
  eq(run(fx.c1, fx.rPartial).findings, [
    "TASK-910 is named by a commit but has no entry in docs/TASKS.md (add one, with its Design check and Self-review)",
  ]);
  // No reverted commit named, or one not here: an ordinary commit of its task.
  eq(run(fx.c2, fx.rNoBody).findings, judged);
  eq(run(fx.c2, fx.rUnknown).findings, judged);
  // A root commit has no parent to revert to: no true revert.
  eq(run(fx.c2, fx.rRoot).findings, [
    noTask(fx.rRoot, 'Revert "feat: before"') + REVERT_REMEDY,
  ]);
  // A true revert of a task with no entry, at the base or now.
  eq(run(fx.c3, fx.rC3).findings, [
    "TASK-920 is named by a commit but has no entry in docs/TASKS.md (add one, with its Design check and Self-review)",
  ]);
  // The entry's last line is the entry's.
  eq(run(fx.c2, fx.lastLine).findings, blocks);
  // Route tests in path order, whatever order their commits came in.
  eq(run(fx.c2, fx.routes).findings, [
    lacks("__tests__/a.test.ts"),
    lacks("__tests__/z.test.ts"),
  ]);
  // A key re-keyed from a deleted file; one of a renamed file: no baseline finding.
  eq(run(fx.bBase, fx.bDelete).findings, judged);
  eq(run(fx.bBase, fx.bRename).findings, judged);
  // A diverged base is judged from the merge base, not from itself.
  eq(run(fx.side, fx.c1).findings, blocks);
  // No common history: from the base itself; commits before the rule are not judged, even when
  // the checkout's own index holds the script.
  eq(run(fx.other, fx.c1), {
    findings: [noTask(fx.root, "chore: start"), ...blocks],
    notes: [],
    commits: 2,
    tasks: ["TASK-910"],
  });
  eq(run(fx.other, fx.c0), { findings: [], notes: [], commits: 0, tasks: [] });
  // An app's platform task: an entry of any one of its registers, any one entry, referencing it.
  eq(run(fx.appBase, fx.appRecorded).findings, []);
  eq(run(fx.appBase, fx.appNot).findings, [
    "platform TASK-200: the change touches no entry in docs/A.md or docs/B.md that references \"platform TASK-200\" (record the app's work there; sync platform-foundation's entry first)",
  ]);
});

test("survivors: adoption, high-tier paths, merges and the CLI", () => {
  const E = (id, extra = "") => entry(id, `${extra}${COMPLETE}`);
  const fx = fixture("survivors-more", (repo) => {
    const out = {};
    out.base = started(repo);
    out.lost = repo.commit("feat: y", { "lib/y.ts": "y\n" });
    out.lost2 = repo.commit("feat: w", { "lib/w.ts": "w\n" });
    out.adopted = repo.commit("docs: adopt (TASK-901, TASK-902, TASK-903)", {
      "docs/TASKS.md": register(
        OLD,
        E("TASK-902", `**Commits:** ${out.lost}\n\n`),
        E("TASK-901", `**Commits:** ${out.lost}\n\n`),
        E("TASK-903", `**Commits:** ${out.lost2}\n\n`)
      ),
    });
    repo.at(out.lost);
    out.prose = repo.commit("docs: mention (TASK-904)", {
      "docs/TASKS.md": register(OLD, E("TASK-904", `Note**Commits:** ${out.lost}\n\n`)),
    });
    // A true revert of a high-tier change, its entry kept; a task's two high-tier paths.
    repo.at(out.base);
    out.g = repo.commit("feat: g (TASK-940)", {
      "scripts/risk-tier-g.mjs": "g\n",
      "docs/TASKS.md": register(OLD, E("TASK-940")),
    });
    repo.git("rm", "-q", "scripts/risk-tier-g.mjs");
    repo.git(
      "commit",
      "-q",
      "-m",
      'Revert "feat: g (TASK-940)"',
      "-m",
      `This reverts commit ${out.g}.`
    );
    out.gRevert = repo.git("rev-parse", "HEAD");
    repo.at(out.base);
    repo.commit("feat: h (TASK-950)", {
      "scripts/risk-tier-a.mjs": "a\n",
      "docs/TASKS.md": register(OLD, E("TASK-950")),
    });
    out.h2 = repo.commit("feat: h2 (TASK-950)", { "scripts/risk-tier-b.mjs": "b\n" });
    // A merge titled as a revert, whose own change undoes a commit: judged as a merge.
    repo.at(out.base);
    out.m1 = repo.commit("feat: m (TASK-960)", {
      "platform/m.ts": "m\n",
      "docs/TASKS.md": register(OLD, entry("TASK-960", "Old.")),
    });
    repo.git("checkout", "-q", "-B", "side", out.m1);
    repo.commit("docs: side", { "x.txt": "x\n" });
    repo.git("checkout", "-q", "-B", "trunk", out.m1);
    repo.git("merge", "-q", "--no-ff", "--no-commit", "side");
    repo.git("rm", "-q", "platform/m.ts");
    repo.write({ "docs/TASKS.md": register(OLD) });
    repo.git("add", "-A");
    repo.git(
      "commit",
      "-q",
      "-m",
      'Revert "feat: m (TASK-960)"',
      "-m",
      `This reverts commit ${out.m1}.`
    );
    out.mRevert = repo.git("rev-parse", "HEAD");
    // An evil merge whose own change re-pins an action of ci.yml.
    const ciText = `name: CI\njobs:\n  ci:\n    steps:\n      - uses: actions/checkout@${"a".repeat(40)} # v7\n`;
    repo.git("checkout", "-q", "-f", "--detach", out.base);
    out.wf = repo.commit("ci: the workflow (TASK-900)", {
      ".github/workflows/ci.yml": ciText,
    });
    repo.git("checkout", "-q", "-B", "side2", out.wf);
    repo.commit("docs: side", { "y.txt": "y\n" });
    repo.git("checkout", "-q", "-B", "trunk2", out.wf);
    repo.git("merge", "-q", "--no-ff", "--no-commit", "side2");
    repo.write({
      ".github/workflows/ci.yml": ciText.replace(
        /uses: actions\/checkout@[0-9a-f]{40} # v\d+/g,
        `uses: actions/checkout@${"f".repeat(40)} # v8`
      ),
    });
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "Merge branch 'side2'");
    out.pinMerge = repo.git("rev-parse", "HEAD");
    // Titles: TASK-910 and TASK-911 complete; a change touching TASK-910's entry only.
    repo.git("checkout", "-q", "-f", "--detach", out.base);
    out.t1 = repo.commit("docs: entries (TASK-900)", {
      "docs/TASKS.md": register(OLD, E("TASK-910"), E("TASK-911")),
    });
    out.t2 = repo.commit("fix: a (TASK-910)", {
      "platform/a.ts": "export const a = 5;\n",
      "docs/TASKS.md": register(OLD, E("TASK-910", "Done.\n\n"), E("TASK-911")),
    });
    // An app: its register's TASK-5001 references platform TASK-200.
    repo.git("checkout", "-q", "--orphan", "app");
    repo.git("rm", "-q", "-rf", ".");
    const appTasks = (...e) =>
      `# App tasks\n\n## Open Items\n\n${e.join("\n")}\n## Resolved\n`;
    out.appBase = repo.commit("chore: start", {
      "scripts/process-check.mjs": STUB,
      "docs/TASKS.md": register(OLD, E("TASK-200")),
      "scripts/process-check.app.json": JSON.stringify({ taskRegisters: ["docs/A.md"] }),
      "docs/A.md": appTasks(E("TASK-5001", "For platform TASK-200.\n\n")),
    });
    out.appOwn = repo.commit("feat: the app's part (TASK-5001)", {
      "lib/x.ts": "1\n",
      "docs/A.md": appTasks(E("TASK-5001", "For platform TASK-200. Done.\n\n")),
    });
    repo.at(out.appBase);
    out.a1 = repo.commit("fix: y", { "lib/y.ts": "y\n" });
    repo.commit("feat: x (platform TASK-200)", { "lib/x.ts": "3\n" });
    out.a3 = repo.commit("docs: adopt (TASK-200)", {
      "docs/TASKS.md": register(OLD, E("TASK-200", `**Commits:** ${out.a1}\n\n`)),
    });
    repo.git("checkout", "-q", "-f", "develop");
    return out;
  });
  const run = (base, head, extra) => check(fx, base, head, extra);
  const noTask = (sha, subject, what = "code") =>
    `${sha.slice(0, 7)} "${subject}" changes ${what} but names no task: end its subject with (TASK-nnn) — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${sha.slice(0, 7)}"`;
  // Adoption: each commit by the entries naming it, in id order.
  eq(run(fx.base, fx.adopted), {
    findings: [],
    notes: [
      `${fx.lost.slice(0, 7)} names no task in its subject; adopted by TASK-901, TASK-902`,
      `${fx.lost2.slice(0, 7)} names no task in its subject; adopted by TASK-903`,
    ],
    commits: 3,
    tasks: ["TASK-901", "TASK-902", "TASK-903"],
  });
  // A `**Commits:**` after other text on its line adopts nothing.
  eq(run(fx.base, fx.prose).findings, [noTask(fx.lost, "feat: y")]);
  // A true revert of a high-tier change needs no threat model; its entry, kept, is judged.
  eq(run(fx.g, fx.gRevert).findings, [
    "TASK-940: the change does not touch its entry in docs/TASKS.md (record the work there)",
  ]);
  // A task's threat model is asked for by the first high-tier path its change touched.
  eq(run(fx.base, fx.h2).findings, [
    'TASK-950 has no "Threat model" block (the change touches scripts/risk-tier-a.mjs, a high-tier path)',
  ]);
  // A merge is never a revert, nor a pinned-action bump: its own change is judged.
  eq(run(fx.m1, fx.mRevert).findings, [
    "TASK-960 is named by a commit but has no entry in docs/TASKS.md (add one, with its Design check and Self-review)",
  ]);
  eq(run(fx.wf, fx.pinMerge).findings, [
    noTask(fx.pinMerge, "Merge branch 'side2'", "the process's own files"),
  ]);
  // A commit adopted by platform TASK-200's entry names it plainly: that entry, touched, passes.
  eq(run(fx.appBase, fx.a3), {
    findings: [],
    notes: [`${fx.a1.slice(0, 7)} names no task in its subject; adopted by TASK-200`],
    commits: 3,
    tasks: ["TASK-200"],
  });
  // The CLI: notes printed, "tasks none", the summary appended only to a file that exists.
  const dir = mkdtempSync(join(tmpdir(), "process-check-mutation-cli2-"));
  const summary = join(dir, "summary.md");
  const absent = join(dir, "absent.md");
  writeFileSync(summary, "");
  const one = cli(["--base", fx.base, "--head", fx.lost2], fx.dir, {
    GITHUB_STEP_SUMMARY: summary,
  });
  const lines = [noTask(fx.lost, "feat: y"), noTask(fx.lost2, "feat: w")];
  eq(
    [one.code, one.out, one.err],
    [
      1,
      `process check: 2 commit(s) judged since ${fx.base}; tasks none\n`,
      lines.map((l) => `::error::${l}\n`).join(""),
    ]
  );
  eq(
    readFileSync(summary, "utf8"),
    `**process check: 2 commit(s) judged since ${fx.base}; tasks none**\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`
  );
  const two = cli(["--base", fx.base, "--head", fx.adopted], fx.dir, {
    GITHUB_STEP_SUMMARY: absent,
  });
  eq(
    [two.code, two.out],
    [
      0,
      `process check: 3 commit(s) judged since ${fx.base}; tasks TASK-901, TASK-902, TASK-903\n` +
        `  ${fx.lost.slice(0, 7)} names no task in its subject; adopted by TASK-901, TASK-902\n` +
        `  ${fx.lost2.slice(0, 7)} names no task in its subject; adopted by TASK-903\n` +
        "  nothing missing\n",
    ]
  );
  eq(existsSync(absent), false);
  const three = cli(["--base", fx.base, "--head", fx.lost2], fx.dir, {
    GITHUB_STEP_SUMMARY: absent,
  });
  eq([three.code, existsSync(absent)], [1, false]);
  rmSync(dir, { recursive: true, force: true });
});

test("round 7: adoption by the sha's start, in-range reverts, an app's threat model, the first promotion", () => {
  // A register is never code nor one of the process's own files.
  eq(
    m.registersIn(
      JSON.stringify({
        taskRegisters: ["docs/A.md", "scripts/process-check-notes.md", "lib/x.md"],
      })
    ),
    ["docs/TASKS.md", "docs/A.md"]
  );
  const appTasks = (...e) =>
    `# App tasks\n\n## Open Items\n\n${e.join("\n")}\n## Resolved\n`;
  const fx = fixture("round7", (repo) => {
    const out = {};
    // Before the rule: a baseline raised (a first promotion carries such commits).
    out.root = repo.commit("chore: before", {
      "screen-literal-baseline.json": JSON.stringify({ count: 3 }),
      "docs/TASKS.md": register(OLD),
    });
    repo.commit("chore: more literals", {
      "screen-literal-baseline.json": JSON.stringify({ count: 5 }),
    });
    out.base = repo.commit("ci: the rule (TASK-900)", {
      "scripts/process-check.mjs": STUB,
      "docs/TASKS.md": register(entry("TASK-900", `${COMPLETE}\n\n${THREAT}`)),
    });
    out.raised = repo.commit("chore: more again (TASK-900)", {
      "screen-literal-baseline.json": JSON.stringify({ count: 6 }),
      "lib/r.ts": "r\n",
      "docs/TASKS.md": register(entry("TASK-900", `Raised.\n\n${COMPLETE}\n\n${THREAT}`)),
    });
    // Adoption: only a whole hex word, at the start of the commit's sha.
    repo.at(out.base);
    out.lost = repo.commit("feat: y", { "lib/y.ts": "y\n" });
    const adoptWith = (line) =>
      repo.commit("docs: adopt (TASK-910)", {
        "docs/TASKS.md": register(
          OLD,
          entry("TASK-910", `**Commits:** ${line}\n\n${COMPLETE}`)
        ),
      });
    out.inside = adoptWith(out.lost.slice(3, 11));
    repo.at(out.lost);
    out.glued = adoptWith(`z${out.lost.slice(0, 7)}`);
    repo.at(out.lost);
    out.whole = adoptWith(out.lost.slice(0, 7));
    // A commit and its revert, both in the range: a net no-op.
    repo.at(out.base);
    out.feat = repo.commit("feat: f (TASK-970)", {
      "lib/f.ts": "f\n",
      "docs/TASKS.md": register(OLD, entry("TASK-970", COMPLETE)),
    });
    repo.git("rm", "-q", "lib/f.ts");
    repo.write({ "docs/TASKS.md": register(OLD) });
    repo.git("add", "-A");
    repo.git(
      "commit",
      "-q",
      "-m",
      'Revert "feat: f (TASK-970)"',
      "-m",
      `This reverts commit ${out.feat}.`
    );
    out.unfeat = repo.git("rev-parse", "HEAD");
    // The same revert, the entry kept as the commit made it: judged as the task's own.
    repo.at(out.feat);
    repo.git("rm", "-q", "lib/f.ts");
    repo.git(
      "commit",
      "-q",
      "-m",
      'Revert "feat: f (TASK-970)"',
      "-m",
      `This reverts commit ${out.feat}.`
    );
    out.unfeatKept = repo.git("rev-parse", "HEAD");
    // A partial revert in the range: no true revert.
    repo.at(out.feat);
    repo.write({ "lib/f.ts": "g\n" });
    repo.git("add", "-A");
    repo.git(
      "commit",
      "-q",
      "-m",
      'Revert "feat: f"',
      "-m",
      `This reverts commit ${out.feat}.`
    );
    out.unfeatPartial = repo.git("rev-parse", "HEAD");
    // An app's (platform TASK-200) touching a high-tier path: the app's entry carries the threat model.
    repo.git("checkout", "-q", "--orphan", "app");
    repo.git("rm", "-q", "-rf", ".");
    out.appBase = repo.commit("chore: start", {
      "scripts/process-check.mjs": STUB,
      "docs/TASKS.md": register(OLD, entry("TASK-200", COMPLETE)),
      "scripts/process-check.app.json": JSON.stringify({ taskRegisters: ["docs/A.md"] }),
      "docs/A.md": appTasks(entry("TASK-5001", "Old.")),
    });
    const appWork = (blocks) =>
      repo.commit("ci(app): deploy (platform TASK-200)", {
        "lib/x.ts": "1\n",
        ".github/workflows/deploy.yml": "name: deploy\n",
        "docs/A.md": appTasks(entry("TASK-5001", `For platform TASK-200.\n\n${blocks}`)),
      });
    out.appNoThreat = appWork(COMPLETE);
    repo.at(out.appBase);
    out.appThreat = appWork(`${COMPLETE}\n\n${THREAT}`);
    repo.git("checkout", "-q", "-f", "develop");
    return out;
  });
  const s7 = (sha) => sha.slice(0, 7);
  const noTask = (sha, subject) =>
    `${s7(sha)} "${subject}" changes code but names no task: end its subject with (TASK-nnn) — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${s7(sha)}"`;
  // The first promotion: a baseline raised before the rule is the starting point; one raised after it is not.
  eq(check(fx, fx.root, fx.base).findings, []);
  eq(check(fx, fx.root, fx.raised).findings, [
    "screen-literal-baseline.json: count 6, the base has 5 — it only shrinks",
  ]);
  // Adoption: a hex word inside the sha, or glued to other characters, adopts nothing.
  for (const key of ["inside", "glued"])
    eq([key, check(fx, fx.base, fx[key]).findings], [key, [noTask(fx.lost, "feat: y")]]);
  eq(check(fx, fx.base, fx.whole), {
    findings: [],
    notes: [`${s7(fx.lost)} names no task in its subject; adopted by TASK-910`],
    commits: 2,
    tasks: ["TASK-910"],
  });
  // A commit and its true revert, both in the range: nothing to record, the entry removed.
  // (Not adopted, not named plainly: the entry's absence is as it was before the reverted commit.)
  eq(check(fx, fx.base, fx.unfeat), {
    findings: [],
    notes: [],
    commits: 2,
    tasks: ["TASK-970"],
  });

  // The entry kept: it was not there before the reverted commit, so it is the task's own work.
  eq(check(fx, fx.base, fx.unfeatKept).findings, []);
  eq(check(fx, fx.base, fx.unfeatPartial).findings, [
    noTask(fx.unfeatPartial, 'Revert "feat: f"') + REVERT_REMEDY,
  ]);
  // The app's entry referencing platform TASK-200 carries the Threat model, not platform-foundation's.
  eq(check(fx, fx.appBase, fx.appNoThreat).findings, [
    'TASK-5001 has no "Threat model" block (the change touches .github/workflows/deploy.yml, a high-tier path)',
  ]);
  eq(check(fx, fx.appBase, fx.appThreat).findings, []);
});

test("round 8: promotions after their merges, Reapply, one tag missing, entries and exemptions", () => {
  const routeTest = (tags) =>
    `import { GET } from "@/app/api/x/route";\n${tags.map((t) => `it("[hostile:${t}] x", () => {});`).join("\n")}\n`;
  const appTasks = (...e) =>
    `# App tasks\n\n## Open Items\n\n${e.join("\n")}\n## Resolved\n`;
  const ENTRY = (note) =>
    register(entry("TASK-900", `${note}\n\n${COMPLETE}\n\n${THREAT}`));
  const revertOf = (sha, subject, files, remove = []) => {
    repo8.write(files);
    for (const p of remove) repo8.git("rm", "-q", p);
    repo8.git("add", "-A");
    repo8.git("commit", "-q", "-m", subject, "-m", `This reverts commit ${sha}.`);
    return repo8.git("rev-parse", "HEAD");
  };
  let repo8;
  const fx = fixture("round8", (repo) => {
    repo8 = repo;
    const out = {};
    const merge = (branch, into) => {
      repo.git("checkout", "-q", "-f", into);
      repo.git("merge", "-q", "--no-ff", "-m", `Merge ${branch} into ${into}`, branch);
      return repo.git("rev-parse", "HEAD");
    };
    // Before the rule: develop, staging and main, each promotion a merge commit develop lacks.
    out.root = repo.commit("chore: root", {
      "screen-literal-baseline.json": JSON.stringify({ count: 3 }),
      "docs/TASKS.md": register(OLD),
    });
    repo.git("branch", "staging");
    repo.git("branch", "main");
    repo.commit("feat: before the rule", { "lib/d.ts": "d\n" });
    out.staging0 = merge("develop", "staging");
    out.main0 = merge("staging", "main");
    repo.git("checkout", "-q", "-f", "develop");
    out.preRaise = repo.commit("chore: more literals", {
      "screen-literal-baseline.json": JSON.stringify({ count: 5 }),
    });
    out.intro = repo.commit("ci: the rule (TASK-900)", {
      "scripts/process-check.mjs": STUB,
      "docs/TASKS.md": ENTRY("The rule."),
    });
    out.feature = repo.commit("feat: f (TASK-900)", {
      "lib/f.ts": "f\n",
      "docs/TASKS.md": ENTRY("The feature."),
    });
    // The first promotion after the rule: the merges into staging and main.
    out.staging1 = merge("develop", "staging");
    out.main1 = merge("staging", "main");
    repo.git("checkout", "-q", "-f", "develop");
    // After the rule: lowered, then raised again — still below the rule's starting value.
    out.lowered = repo.commit("chore: fewer literals", {
      "screen-literal-baseline.json": JSON.stringify({ count: 2 }),
    });
    out.reraised = repo.commit("chore: more literals again", {
      "screen-literal-baseline.json": JSON.stringify({ count: 4 }),
    });
    // A revert of a revert: git 2.43+ titles it `Reapply "…"`.
    repo.at(out.feature);
    out.g = repo.commit("feat: g (TASK-900)", {
      "lib/g.ts": "g\n",
      "docs/TASKS.md": ENTRY("The g."),
    });
    out.ungone = revertOf(out.g, 'Revert "feat: g (TASK-900)"', {}, ["lib/g.ts"]);
    out.reapply = revertOf(out.ungone, 'Reapply "feat: g (TASK-900)"', {
      "lib/g.ts": "g\n",
    });
    repo.at(out.ungone);
    out.reapplyPartial = revertOf(out.ungone, 'Reapply "feat: g (TASK-900)"', {
      "lib/g.ts": "h\n",
    });
    // A route test lacking exactly one tag; one in a sync commit, lacking all four.
    repo.at(out.feature);
    out.oneTag = repo.commit("test: route (TASK-900)", {
      "__tests__/x-route.test.ts": routeTest(["role", "self", "store-down"]),
      "lib/t.ts": "t\n",
      "docs/TASKS.md": ENTRY("The route test."),
    });
    repo.at(out.feature);
    out.syncRoute = repo.commit(
      `chore(sync): inherit platform-foundation main @ ${"d".repeat(40)}`,
      {
        "__tests__/y-route.test.ts": routeTest([]),
      }
    );
    // A sync subject whose ref holds a space is no sync's.
    repo.at(out.feature);
    out.syncSpace = repo.commit(
      `chore(sync): inherit platform-foundation main x @ ${"d".repeat(40)}`,
      { "lib/s.ts": "s\n" }
    );
    // A true revert restoring a task's code but not its entry: the entry is still needed.
    repo.at(out.feature);
    out.dropBase = repo.commit("chore: keep 5", {
      "docs/TASKS.md": register(OLD, entry("TASK-905", COMPLETE)),
      "platform/five.ts": "5\n",
    });
    out.drop = repo.commit(
      "chore: drop five (TASK-905)",
      {
        "docs/TASKS.md": register(OLD),
      },
      ["platform/five.ts"]
    );
    out.undrop = revertOf(out.drop, 'Revert "chore: drop five (TASK-905)"', {
      "platform/five.ts": "5\n",
    });
    // An app: platform-foundation's entry incomplete; an app entry naming another platform task.
    repo.git("checkout", "-q", "--orphan", "app");
    repo.git("rm", "-q", "-rf", ".");
    const appStart = (pfEntry, appEntry) =>
      repo.commit("chore: start", {
        "scripts/process-check.mjs": STUB,
        "docs/TASKS.md": register(OLD, pfEntry),
        "scripts/process-check.app.json": JSON.stringify({
          taskRegisters: ["docs/A.md"],
        }),
        "docs/A.md": appTasks(appEntry),
      });
    const appWork = (note) =>
      repo.commit("fix(app): x (platform TASK-200)", {
        "lib/x.ts": "1\n",
        "docs/A.md": appTasks(entry("TASK-5001", `${note}\n\n${COMPLETE}`)),
      });
    out.appBase = appStart(entry("TASK-200", "Old."), entry("TASK-5001", "Old."));
    out.appIncomplete = appWork("For platform TASK-200.");
    repo.at(out.appBase);
    out.appOther = appWork("For platform TASK-2001.");
    repo.git("checkout", "-q", "-f", "develop");
    return out;
  });
  const s8 = (sha) => sha.slice(0, 7);
  // I-1: the pushes after the promotion's merges, and the pull request staging → main.
  for (const [base, head] of [
    ["staging0", "staging1"],
    ["main0", "staging1"],
    ["main0", "main1"],
    ["staging0", "feature"],
  ])
    eq([base, head, check(fx, fx[base], fx[head]).findings], [base, head, []]);
  // B2: the later of the merge base and the rule's first commit — here the merge base.
  eq(check(fx, fx.lowered, fx.reraised).findings, [
    "screen-literal-baseline.json: count 4, the base has 2 — it only shrinks",
  ]);
  // B3: a head before the rule is not judged at all, its baselines included.
  eq(check(fx, fx.root, fx.preRaise), { findings: [], notes: [], commits: 0, tasks: [] });
  // I-3: Reapply "…", a true revert of a revert on the base, needs nothing more.
  eq(check(fx, fx.ungone, fx.reapply), {
    findings: [],
    notes: [],
    commits: 1,
    tasks: ["TASK-900"],
  });
  // …and one that is not names the task its quoted subject ends with.
  eq(check(fx, fx.ungone, fx.reapplyPartial).findings, [
    "TASK-900: the change does not touch its entry in docs/TASKS.md (record the work there)",
  ]);
  // X15: exactly one tag missing.
  eq(check(fx, fx.feature, fx.oneTag).findings, [
    '__tests__/x-route.test.ts drives a route and lacks [hostile:id-spelling] (a test title tag, or a comment "hostile:<tag> n/a: <reason>")',
  ]);
  // E5: a route test in an exempt (sync) commit is still held to its hostile cases.
  eq(check(fx, fx.feature, fx.syncRoute).findings, [
    '__tests__/y-route.test.ts drives a route and lacks [hostile:role], [hostile:self], [hostile:store-down], [hostile:id-spelling] (a test title tag, or a comment "hostile:<tag> n/a: <reason>")',
  ]);
  // E6: a sync subject's ref has no space.
  eq(check(fx, fx.feature, fx.syncSpace).findings, [
    `${s8(fx.syncSpace)} "chore(sync): inherit platform-foundation main x @ ${"d".repeat(40)}" changes code but names no task: end its subject with (TASK-nnn) — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${s8(fx.syncSpace)}"`,
  ]);
  // A true revert restores the code; the task's entry, gone with it, is still required.
  eq(check(fx, fx.drop, fx.undrop).findings, [
    "TASK-905 is named by a commit but has no entry in docs/TASKS.md (add one, with its Design check and Self-review)",
  ]);
  // P7: platform-foundation's entry must be complete, even though the app's carries the work.
  eq(check(fx, fx.appBase, fx.appIncomplete).findings, [
    'TASK-200 has no "Design check" block',
    'TASK-200 has no "Self-review" block',
  ]);
  // P11: "platform TASK-2001" does not reference platform TASK-200.
  eq(check(fx, fx.appBase, fx.appOther).findings, [
    'TASK-200 has no "Design check" block',
    'TASK-200 has no "Self-review" block',
    `platform TASK-200: the change touches no entry in docs/A.md that references "platform TASK-200" (record the app's work there; sync platform-foundation's entry first)`,
  ]);
});

test("round 9 (TASK-204 N-18): the last survivors", () => {
  const appTasks = (...e) =>
    `# App tasks\n\n## Open Items\n\n${e.join("\n")}\n## Resolved\n`;
  const fx = fixture("round9", (repo, dir) => {
    const out = {};
    /** Start a line of history of its own. */
    const line = (name, files) => {
      repo.git("checkout", "-q", "-f", "--orphan", name);
      repo.git("rm", "-q", "-rf", "--ignore-unmatch", ".");
      repo.git("clean", "-q", "-fdx", "-e", ".fixture.json");
      return repo.commit("chore: start", { "scripts/process-check.mjs": STUB, ...files });
    };
    const revertOf = (sha, subject, files, remove = []) => {
      repo.write(files);
      for (const p of remove) repo.git("rm", "-q", p);
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", subject, "-m", `This reverts commit ${sha}.`);
      return repo.git("rev-parse", "HEAD");
    };
    // nameStatus: a two-parent merge's own path, under a tier ("*": top-level files) it misses.
    out.kBase = line("k", {
      "scripts/risk-tiers.json": JSON.stringify({ high: [{ paths: ["*"] }] }),
      "docs/TASKS.md": ADD("TASK-980", COMPLETE),
      "platform/a.ts": "a\n",
    });
    repo.git("checkout", "-q", "-b", "k-side");
    repo.commit("fix: side (TASK-980)", { "platform/a.ts": "c\n" });
    repo.git("checkout", "-q", "k");
    repo.commit("fix: main (TASK-980)", {
      "platform/a.ts": "b\n",
      "docs/TASKS.md": ADD("TASK-980", `${COMPLETE}\n\nMerged.`),
    });
    try {
      repo.git("merge", "-q", "--no-ff", "-m", "Merge k-side (TASK-980)", "k-side");
    } catch {
      // The conflict, resolved below.
    }
    out.kMerge = repo.commit("Merge k-side (TASK-980)", { "platform/a.ts": "d\n" });
    // A non-test file importing a route is no route test.
    repo.at(out.kBase);
    out.usesRoute = repo.commit("feat: u (TASK-980)", {
      "lib/uses-route.ts": 'import { GET } from "@/app/api/x/route";\n',
      "docs/TASKS.md": ADD("TASK-980", `${COMPLETE}\n\nUses.`),
    });
    // A true revert of a commit on the base that removes the entry the commit had changed.
    line("a", { "docs/TASKS.md": ADD("TASK-981", COMPLETE), "platform/a.ts": "1\n" });
    out.aX = repo.commit("fix: p (TASK-981)", {
      "platform/a.ts": "2\n",
      "docs/TASKS.md": ADD("TASK-981", `${COMPLETE}\n\nChanged.`),
    });
    out.aR = revertOf(out.aX, 'Revert "fix: p (TASK-981)"', {
      "platform/a.ts": "1\n",
      "docs/TASKS.md": register(OLD),
    });
    // An app: two registers; platform TASK-200 on a high-tier path; a plain TASK-200 untouched.
    const appEntry = (id, note, threat) =>
      entry(
        id,
        `For platform TASK-200: ${note}.\n\n${COMPLETE}${threat ? `\n\n${THREAT}` : ""}`
      );
    out.dBase = line("d", {
      "docs/TASKS.md": register(OLD, entry("TASK-200", COMPLETE)),
      "scripts/process-check.app.json": JSON.stringify({
        taskRegisters: ["docs/A.md", "docs/B.md"],
      }),
      "docs/A.md": appTasks(entry("TASK-5001", "Old.")),
      "docs/B.md": appTasks(entry("TASK-5002", "Old.")),
      "platform/a.ts": "1\n",
    });
    out.dOne = repo.commit("ci: x (platform TASK-200)", {
      ".github/workflows/x.yml": "on: push\n",
      "docs/A.md": appTasks(appEntry("TASK-5001", "one", false)),
    });
    repo.at(out.dBase);
    out.dTwo = repo.commit("ci: x (platform TASK-200)", {
      ".github/workflows/x.yml": "on: push\n",
      "docs/A.md": appTasks(
        appEntry("TASK-5001", "one", false),
        appEntry("TASK-5003", "two", true)
      ),
    });
    repo.at(out.dBase);
    out.eOwn = repo.commit("fix: y (TASK-200)", { "lib/y.ts": "y\n" });
    // A baseline key that names no file ("#odd") is no key a deletion vacated.
    out.fBase = line("f", {
      "docs/TASKS.md": register(OLD),
      "fake-fetch-baseline.json": JSON.stringify({ count: 1, files: { "#odd": 1 } }),
    });
    out.fHead = repo.commit("chore: re-key", {
      "fake-fetch-baseline.json": JSON.stringify({
        count: 1,
        files: { "lib/n.test.ts": 1 },
      }),
    });
    // A commit and its true revert in the range, the revert's subject naming no task.
    out.hBase = line("h", {
      "docs/TASKS.md": ADD("TASK-984", COMPLETE),
      "platform/a.ts": "1\n",
    });
    out.hX = repo.commit("fix: x (TASK-984)", {
      "platform/a.ts": "2\n",
      "docs/TASKS.md": ADD("TASK-984", `${COMPLETE}\n\nChanged.`),
    });
    out.hR = revertOf(out.hX, 'Revert "fix: x"', {
      "platform/a.ts": "1\n",
      "docs/TASKS.md": ADD("TASK-984", COMPLETE),
    });
    // A revert of a commit on the base, then its reapply: a net no-op.
    line("j", { "docs/TASKS.md": ADD("TASK-985", COMPLETE), "platform/a.ts": "1\n" });
    out.jX = repo.commit("fix: x (TASK-985)", {
      "platform/a.ts": "2\n",
      "docs/TASKS.md": ADD("TASK-985", `${COMPLETE}\n\nChanged.`),
    });
    out.jR = revertOf(out.jX, 'Revert "fix: x (TASK-985)"', { "platform/a.ts": "1\n" });
    out.jRR = revertOf(out.jR, 'Reapply "fix: x"', { "platform/a.ts": "2\n" });
    // Last: a commit whose tree cannot be read (an object lost) — git's failure is not a finding.
    out.lBase = line("l", {
      "docs/TASKS.md": ADD("TASK-986", COMPLETE),
      "lib/l-a.ts": "l\n",
    });
    out.lC = repo.commit("fix: l (TASK-986)", {
      "lib/l-b.ts": "l\n",
      "docs/TASKS.md": ADD("TASK-986", `${COMPLETE}\n\nMore.`),
    });
    const lost = repo.git("rev-parse", `${out.lC}:lib`);
    rmSync(join(dir, ".git", "objects", lost.slice(0, 2), lost.slice(2)));
    return out;
  });
  const s9 = (sha) => sha.slice(0, 7);
  // nameStatus reads pairs only: no path-less entry a "*" tier could match.
  eq(check(fx, fx.kBase, fx.kMerge).findings, []);
  eq(check(fx, fx.kBase, fx.usesRoute).findings, []);
  // The entry gone with a true revert of a commit on the base that had it: passes.
  eq(check(fx, fx.aX, fx.aR).findings, []);
  // The app's entries: the first lacking its Threat model fails alone; a later complete one passes.
  eq(check(fx, fx.dBase, fx.dOne).findings, [
    'TASK-5001 has no "Threat model" block (the change touches .github/workflows/x.yml, a high-tier path)',
  ]);
  eq(check(fx, fx.dBase, fx.dTwo).findings, []);
  eq(check(fx, fx.dBase, fx.eOwn).findings, [
    "TASK-200: the change does not touch its entry in docs/TASKS.md, platform-foundation's synced register (for platform-foundation's task, end the subject with (platform TASK-200) and record the app's work in an entry of docs/A.md or docs/B.md that references \"platform TASK-200\")",
  ]);
  eq(check(fx, fx.fBase, fx.fHead).findings, [
    "fake-fetch-baseline.json: lib/n.test.ts added — the base does not list it, and no key it could replace went with its file (deleted or renamed in this change); fix the new findings instead, or remove the key",
  ]);
  eq(check(fx, fx.hBase, fx.hR), {
    findings: [],
    notes: [
      `${s9(fx.hR)} is a true revert of ${s9(fx.hX)}, earlier in this range: the pair is a net no-op`,
    ],
    commits: 2,
    tasks: ["TASK-984"],
  });
  eq(check(fx, fx.jX, fx.jRR), {
    findings: [],
    notes: [
      `${s9(fx.jRR)} is a true revert of ${s9(fx.jR)}, earlier in this range: the pair is a net no-op`,
    ],
    commits: 2,
    tasks: ["TASK-985"],
  });
  // The commit's own reading fails, and the check with it — not a finding, not a later read.
  assert.throws(() => check(fx, fx.lBase, fx.lC), /Command failed: git ls-tree/);
});

// ── run ────────────────────────────────────────────────────────────────────────────────────────

let failed = false;
// PROCESS_CHECK_ONLY=<text>[|<text>…]: only the cases whose name holds one (a local aid; Stryker
// runs all).
const only = process.env.PROCESS_CHECK_ONLY?.split("|");
const chosen = ([n]) => !only || only.some((o) => n.includes(o));
for (const [name, fn] of cases.filter(chosen)) {
  const t0 = Date.now();
  try {
    await fn();
    if (process.env.PROCESS_CHECK_TIMES) console.log(`${Date.now() - t0} ms  ${name}`);
  } catch (err) {
    console.error(`✗ ${name}\n${err?.stack ?? err}`);
    failed = true;
    break;
  }
}
if (failed) process.exit(1);
const ran = cases.filter(chosen).length;
console.log(`process-check mutation suite: ${ran} of ${cases.length} cases passed`);
