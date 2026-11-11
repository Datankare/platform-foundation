#!/usr/bin/env node
/**
 * TASK-200 — the engineering-process check: what a change must carry before it is reviewed
 * (docs/AI_ENGINEERING.md §3a). CI's Layer 0f runs it on every push and pull request; it fails the
 * build. It catches our own mistakes — a commit without its task, an entry without its blocks, a
 * baseline raised — not an attacker: these repositories have one person who can push, and GitHub
 * (2FA, branch rulesets, the owner merging every pull request) keeps outsiders out. TASK-200's
 * entry lists what is deliberately not built and when to build it.
 *
 *   node scripts/process-check.mjs --base <ref> [--head HEAD]
 *
 * Node's built-ins only (no install needed). Every git call separates its revisions
 * (`--end-of-options`) and paths (`--`), and reads paths NUL-separated.
 *
 * The range is the change: from the merge base of <base> and <head> to <head>. A commit in it is
 * judged unless it was made before the rule — an ancestor of the first commit that brought this
 * script into <head>'s history. A merge is judged by what it changes itself: a two-parent merge by
 * what differs from git's own re-merge of its parents (`git show --remerge-diff`, git 2.36 or
 * later, or the merge is refused) — a clean merge changes nothing; an evil merge or a conflict's
 * resolution does. An octopus merge by the paths whose result differs from every parent's (mode
 * and object).
 *
 *   1. A commit that changes code (platform/, app/, lib/, components/, hooks/, proxy.ts) or the
 *      process's own files (GATE_PATH: this script and its settings, the risk tiers, CODEOWNERS,
 *      the workflows) names its task: the task group its subject ends with — `(TASK-901)`,
 *      `(TASK-901, TASK-902)`, `(platform TASK-197)`, a squash's ` (#12)` after it. A TASK-nnn
 *      elsewhere in the subject is a mention, not a naming. A pushed commit that named none is
 *      adopted by a line `**Commits:** <sha>` in its task's entry.
 *   2. Each task named that way has an entry in a task register — docs/TASKS.md, or an app's own
 *      (scripts/process-check.app.json `taskRegisters`; Playform's docs/PLAYFORM_TASKS.md, which a
 *      sync never overwrites) — with a complete "Design check" and "Self-review" (fields below),
 *      and the range's change touches that entry. When the task's change touches a high-tier path
 *      (scripts/risk-tiers.json's high areas at the merge base, and the hard rule: .github/**,
 *      scripts/risk-tier*, this script, REVIEW.md, CLAUDE.md), the entry also carries a complete
 *      "Threat model". An app's `(platform TASK-nnn)` names platform-foundation's task: its entry
 *      (synced) is complete, and the app's work is recorded in an entry of the app's own register
 *      that references `platform TASK-nnn` and is touched — that entry carries the Threat model.
 *      A true revert — the exact inverse of one commit on the base, or of one earlier in the range
 *      (judged there: the pair is a net no-op) — needs no task, and passes when its entry is
 *      removed, touched, or left exactly as before the reverted commit.
 *   3. A route test file it adds or changes (a test that imports an app/api route module, or a
 *      test helper that does — one level) has the hostile cases, recognised by the tags in the
 *      titles of its running it(…) / test(…) / describe(…) calls: [hostile:role], [hostile:self],
 *      [hostile:store-down] and [hostile:id-spelling] — or, for one that cannot apply, a comment
 *      line `hostile:<tag> n/a: <reason>` whose reason is four words or more.
 *   4. The ratchet baselines (BASELINES below) never loosen against the later of the merge base
 *      and the rule's first commit (baselines raised before the rule are its starting point): no
 *      key's count rises, the total never rises, no gap is added, a coverage floor never falls and
 *      its margin never rises. A new key is a re-key only when a key it replaces went with its file
 *      (deleted or renamed in the change) and the total does not rise.
 *
 * Not judged: an app's sync commit, by its subject alone ("chore(sync): inherit platform-foundation
 * <ref> @ <40-hex sha>", a squash's ` (#n)` allowed) — the platform's commits were judged where
 * they were made; and a commit authored by dependabot[bot] and committed by it or GitHub (one
 * amended or rebased by hand is judged). A route test file in either is still held to rule 3.
 * Never amend Playform's own change into a sync commit: the subject alone exempts it.
 *
 * Exit codes: 0 when nothing is missing; 1 with each finding on stderr (as a GitHub error
 * annotation) and in $GITHUB_STEP_SUMMARY when set; 2 for a usage error.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SCRIPT_PATH = "scripts/process-check.mjs";
export const TASKS_PATH = "docs/TASKS.md";
/**
 * An app's own settings for this check (scripts/process-check.app.json, the app's file, as
 * scripts/risk-tiers.app.json): `taskRegisters`, more registers whose entries count as TASKS.md's
 * do — Playform's docs/PLAYFORM_TASKS.md, which a sync never overwrites.
 */
export const APP_CONFIG_PATH = "scripts/process-check.app.json";
/** Where the high-tier paths are (scripts/risk-tiers.json, read at the merge base). */
export const RISK_TIERS_PATH = "scripts/risk-tiers.json";

/** The paths a code change touches; a change to any of them needs a task entry. */
export const CODE_PATH = /^(?:platform|app|lib|components|hooks)\/|^proxy\.ts$/;
/**
 * The process's own files: a change to any of them needs a task entry as code does (and, being
 * high-tier, a threat model) — this script and its app settings, the risk tiers, CODEOWNERS, and
 * the workflows (ordinary changes that name their task, none special).
 */
export const GATE_PATH =
  /^scripts\/process-check[^/]*$|^scripts\/risk-tier[^/]*$|^\.github\/CODEOWNERS$|^\.github\/workflows\/[^/]+\.ya?ml$/;

/** The fields of each block, in order. An answer is four words or more, not a placeholder. */
export const DESIGN_CHECK_FIELDS = [
  "Reach",
  "Races",
  "Dependencies down",
  "Erasure leftovers",
  "Screens × responses",
  "Journeys touched",
  "Weakens a tenant's protection?",
];
export const SELF_REVIEW_FIELDS = ["Consumers checked", "Hostile re-read"];
export const BLOCKS = [
  { name: "Design check", fields: DESIGN_CHECK_FIELDS },
  { name: "Self-review", fields: SELF_REVIEW_FIELDS },
];
/**
 * The threat model a change to a high-tier path carries (REVIEW.md rule 18): written before the
 * code, every bypass, forgery and legitimate flow named.
 */
export const THREAT_MODEL_FIELDS = [
  "Boundary",
  "Bypasses",
  "Forgeries",
  "Legitimate flows",
  "Agreed before code",
];
export const THREAT_MODEL = { name: "Threat model", fields: THREAT_MODEL_FIELDS };
/**
 * Paths always high-tier, whatever scripts/risk-tiers.json says (scripts/risk-tier.mjs's hard rule
 * and this check's own files).
 */
export const HARD_HIGH = [
  /^\.github\//,
  /^scripts\/risk-tier/,
  /^scripts\/process-check/,
  /^REVIEW\.md$/,
  /^CLAUDE\.md$/,
  /(?:^|\/)\.gitattributes$/,
];

/** The hostile cases a route test file names (docs/AI_ENGINEERING.md §3a, rule 6). */
export const HOSTILE_TAGS = ["role", "self", "store-down", "id-spelling"];

/**
 * The ratchet baselines, each per repository: what "never loosens" means for each.
 *   counts  `files` maps a file to its count (a number, or `{ count }`): no file added, none
 *           above the base's, and `count` (their total) not above the base's.
 *   keys    `entries` maps a key (`<file>#<path>`) to its reason: no key added, `count` not above.
 *   gaps    `gaps` lists strings: none added, and `count` not above the base's.
 *   count   `count` not above the base's.
 *   floors  `baseline` holds the coverage floors: each axis there, a number, none below the base's;
 *           `margin` (how far coverage must pass a floor before it is raised) not above the base's.
 * A key or gap naming a file git sees renamed (from the merge base to the head) is the old one's.
 */
export const BASELINES = {
  "body-schema-baseline.json": "counts",
  "fake-fetch-baseline.json": "counts",
  "open-input-register.json": "keys",
  "refusal-coverage-baseline.json": "gaps",
  "screen-literal-baseline.json": "count",
  "coverage-baseline.json": "floors",
};
const COVERAGE_AXES = ["statements", "lines", "functions", "branches"];

/**
 * An answer that is a placeholder (a shorter one than four words already fails), read with its code
 * spans (`` `…` ``) taken out, so prose may name a marker: it starts with a marker (`TBD`, `TODO`,
 * `FIXME`, `XXX`, `n/a`, an ellipsis, "to be decided / determined / confirmed / done / written /
 * filled") — and so is one when it is nothing else — or it holds an unfilled template slot
 * (`<describe …>`, `<reason>`).
 */
const PLACEHOLDER_START =
  /^(?:(?:tbd|todo|fixme|xxx|n\/a)(?![\w/])|…|\.{3}|to be (?:decided|determined|confirmed|done|written|filled)\b)/i;
const PLACEHOLDER_SLOT =
  /<(?:describe|explain|list|name|fill|answer|reason|why|what|who|how|todo)\b[^<>\n]*>/i;
const MIN_WORDS = 4;
/**
 * A sync commit's subject: platform-foundation's commit `… @ <40 hex>` at its end, a squash merge's
 * ` (#n)` after it allowed. Such a commit is not judged (by its subject alone).
 */
export const SYNC_SHA =
  /^chore\(sync\): inherit platform-foundation \S+ @ ([0-9a-f]{40})(?: \(#\d+\))?$/;
/**
 * The task group a subject ends with: `(TASK-901)`, `(TASK-901, TASK-902)`, `(platform TASK-197)`,
 * a squash merge's ` (#n)` after it allowed. A TASK-nnn elsewhere in the subject is a mention.
 */
const TASK_GROUP =
  /\(((?:platform\s+)?TASK-\d+(?:\s*,\s*(?:platform\s+)?TASK-\d+)*)\)(?:\s+\(#\d+\))?\s*$/;
/** Dependabot's author name, and who commits its commits: itself, or GitHub (web-flow). */
const DEPENDABOT = "dependabot[bot]";
const BOT_COMMITTERS = [DEPENDABOT, "GitHub"];
/** A revert's subject: git's `Revert "…"`, and `Reapply "…"` for a revert of a revert (git 2.43+). */
export const REVERT_SUBJECT = /^(?:Revert|Reapply) "/;
const REVERTS = /^This reverts commit ([0-9a-f]{7,40})\b/m;
/**
 * A route module specifier: quoted, or a template literal (`@/app/api/${name}/route`), from
 * `@/app/api/…/route` or a relative `../app/api/…/route`.
 */
const ROUTE_MODULE = String.raw`["'\x60](?:@\/|(?:\.\.\/)+)app\/api\/[^"'\x60\n]*\/route["'\x60]`;
/**
 * A statement importing a module: `import … from` / `export … from` (its last line), a bare
 * `import "…"`, `require(…)`, `import(…)`.
 */
const importOf = (specifier) => [
  new RegExp(String.raw`^(?:(?:import|export)\s[^\n]*|\}\s*)from\s+` + specifier, "m"),
  new RegExp(String.raw`^import\s+` + specifier, "m"),
  new RegExp(
    String.raw`^(?:[^"'\x60\n]*[^\w"'\x60\n])?(?:require|requireActual|import)(?:<[^>\n]*>)?\(\s*` +
      specifier,
    "m"
  ),
];
const ROUTE_IMPORTS = importOf(ROUTE_MODULE);
/** A test helper module: `./helpers/x`, `../helpers/x`, `@/__tests__/helpers/x`. */
const HELPER_SPECIFIER = String.raw`["'](?:\.{1,2}\/(?:\.\.\/)*|@\/__tests__\/)helpers\/([\w./-]+)["']`;
const HELPER_IMPORTS = importOf(HELPER_SPECIFIER).map(
  (re) => new RegExp(re.source, "gm")
);
/** A test file: the only files rule 3 judges (checkRange collects them; drivesRoute reads them). */
export const TEST_FILE = /\.test\.tsx?$/;

/** Whether an answer is one: four words or more, not a placeholder (PLACEHOLDER_START, _SLOT). */
export const answered = (text) => {
  const prose = text.replace(/`[^`\n]*`/g, " ").trim();
  return (
    !PLACEHOLDER_START.test(prose) &&
    !PLACEHOLDER_SLOT.test(prose) &&
    text.split(/\s/).filter(Boolean).length >= MIN_WORDS
  );
};

// ── TASKS.md ────────────────────────────────────────────────────────────────────────────────

/** Each `### TASK-nnn — title` entry, with its line span (1-based, inclusive) and text. */
export function taskEntries(text) {
  const lines = text.split("\n");
  const out = [];
  let current = null;
  lines.forEach((line, i) => {
    const heading = /^### (TASK-\d+) — /.exec(line);
    // An entry ends at the next heading, or at the register's "_Last updated_" stamps.
    if (heading || /^#{2,3} /.test(line) || /^_(?:Last|Previously) updated/.test(line)) {
      if (current) out.push(current);
      current = heading
        ? { id: heading[1], start: i + 1, end: i + 1, lines: [line] }
        : null;
      return;
    }
    if (current) {
      current.end = i + 1;
      current.lines.push(line);
    }
  });
  if (current) out.push(current);
  return out.map((e) => ({
    id: e.id,
    start: e.start,
    end: e.end,
    body: e.lines.join("\n"),
  }));
}

/**
 * The answers of a block: the list after a line `**<name>**`, one `- **Field:** answer` item per
 * field (an answer may wrap onto indented lines). Null when the block is absent.
 */
export function blockAnswers(body, name) {
  const lines = body.split("\n");
  const at = lines.findIndex((l) => l.trim() === `**${name}**`);
  if (at < 0) return null;
  const answers = new Map();
  let key = null;
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") {
      // Stryker disable next-line StringLiteral: past the last line, any text but an item ends it
      if (answers.size > 0 && !/^\s*- /.test(lines[i + 1] ?? "")) break;
      continue;
    }
    // `- **Field:** answer`; a question keeps its mark and needs no colon: `- **Weakens …?** No: …`.
    const item = /^- \*\*([^*:]+):?\*\*(.*)/.exec(line);
    if (item) {
      key = item[1];
      answers.set(key, item[2].trim());
    } else if (key && /^\s+\S/.test(line)) {
      answers.set(key, `${answers.get(key)} ${line.trim()}`.trim());
    } else {
      break;
    }
  }
  return answers;
}

/**
 * What an entry's blocks lack: one line per missing block or field. `extra`: more blocks it must
 * carry, each with the reason it must (`why`, appended to its findings); `base`: the blocks every
 * entry carries (none, when only `extra` is asked for).
 */
export function entryFindings(entry, extra = [], base = BLOCKS) {
  const out = [];
  for (const block of [...base, ...extra]) {
    const answers = blockAnswers(entry.body, block.name);
    const why = block.why ? ` (${block.why})` : "";
    if (!answers) {
      out.push(`${entry.id} has no "${block.name}" block${why}`);
      continue;
    }
    for (const field of block.fields) {
      const answer = answers.get(field);
      if (answer === undefined) {
        out.push(`${entry.id} "${block.name}": "${field}" is missing${why}`);
      } else if (!answered(answer)) {
        out.push(
          `${entry.id} "${block.name}": "${field}" is not answered (${MIN_WORDS} words or more, not a placeholder)${why}`
        );
      }
    }
  }
  return out;
}

/**
 * Task ids a subject line names: those of the task group it ends with, `(TASK-nnn, …)`. A revert
 * (`Revert "<subject>"`) names its reverted subject's.
 */
export function subjectTasks(subject) {
  return [...new Set(subjectRefs(subject).map((r) => r.id))];
}

/**
 * The task references of a subject's task group, each `{ id, platform }`: `platform` when written
 * `platform TASK-nnn` (an app naming platform-foundation's task).
 */
export function subjectRefs(subject) {
  const reverted = /^(?:Revert|Reapply) "(.*)"(?:\s+\(#\d+\))?$/.exec(subject);
  if (reverted) return subjectRefs(reverted[1]);
  const group = TASK_GROUP.exec(subject);
  if (!group) return [];
  return [...group[1].matchAll(/(platform\s+)?TASK-(\d+)/g)].map((m) => ({
    id: `TASK-${m[2]}`,
    platform: m[1] !== undefined,
  }));
}

/** The new-side line numbers a unified diff (-U0) adds, changes or deletes next to. */
export function touchedLines(diff) {
  const out = new Set();
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    // A pure deletion (count 0) touches the line after it (the line before, at the file's end).
    const lines =
      count === 0 ? [Math.max(start, 1)] : [...Array(count).keys()].map((i) => start + i);
    for (const line of lines) out.add(line);
  }
  return out;
}

// ── A small JavaScript / TypeScript lexer ───────────────────────────────────────────────────

const REGEX_AFTER_WORD = new Set([
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
]);

/** Templates nested deeper than this (`${`…` ${…}`…`}`) are refused, not recursed into. */
const MAX_TEMPLATE_DEPTH = 200;

/** A source the lexer refuses: templates nested deeper than MAX_TEMPLATE_DEPTH. */
export class LexError extends Error {
  constructor() {
    super(`templates nested deeper than ${MAX_TEMPLATE_DEPTH}`);
  }
}

/**
 * The tokens of a source text, enough to tell code from comments, strings and templates:
 * `comment` (its text), `string` (its value), `template` (its static parts, `parts`; the code in a
 * `${…}` is skipped), `regex`, `ident`, `number`, `punct` (one character). Not a parser: a
 * division and a regular expression are told apart by the token before the `/`.
 */
export function lex(text) {
  const tokens = [];
  const n = text.length;
  let i = 0;
  /** Where `s` next occurs from `from`, or the text's end. */
  const indexOr = (s, from) => {
    const at = text.indexOf(s, from);
    return at === -1 ? n : at;
  };
  const lastSignificant = () => {
    for (let k = tokens.length - 1; k >= 0; k -= 1)
      if (tokens[k].type !== "comment") return tokens[k];
    return null;
  };
  /** Read a quoted string starting at `at` (its quote); returns [value, end]. */
  const readString = (at) => {
    const q = text[at];
    let j = at + 1;
    let value = "";
    while (j < n && text[j] !== q && text[j] !== "\n") {
      if (text[j] === "\\") {
        value += text[j + 1] ?? "";
        j += 2;
      } else {
        value += text[j];
        j += 1;
      }
    }
    return [value, Math.min(j + 1, n)];
  };
  /** Read a template starting at `at` (its backtick); returns [static parts, end]. */
  const readTemplate = (at, depth = 0) => {
    if (depth > MAX_TEMPLATE_DEPTH) throw new LexError();
    const parts = [];
    let part = "";
    let j = at + 1;
    while (j < n && text[j] !== "`") {
      if (text[j] === "\\") {
        part += text[j + 1] ?? "";
        j += 2;
      } else if (text[j] === "$" && text[j + 1] === "{") {
        parts.push(part);
        part = "";
        j = skipCode(j + 2, depth);
      } else {
        part += text[j];
        j += 1;
      }
    }
    parts.push(part);
    return [parts, Math.min(j + 1, n)];
  };
  /** Skip the code of a `${…}` from `at` (after `${`) to past its `}`; returns the end. */
  const skipCode = (at, nesting) => {
    let depth = 0;
    let j = at;
    while (j < n) {
      const c = text[j];
      if (c === "}" && depth === 0) return j + 1;
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      if (c === '"' || c === "'") j = readString(j)[1];
      else if (c === "`") j = readTemplate(j, nesting + 1)[1];
      else if (c === "/" && text[j + 1] === "/") j = indexOr("\n", j);
      else if (c === "/" && text[j + 1] === "*")
        j = Math.min(indexOr("*/", j + 2) + 2, n);
      else j += 1;
    }
    return n;
  };
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === "/" && text[i + 1] === "/") {
      const end = indexOr("\n", i);
      tokens.push({ type: "comment", value: text.slice(i, end), start: i });
      i = end;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = Math.min(indexOr("*/", i + 2) + 2, n);
      tokens.push({ type: "comment", value: text.slice(i, end), start: i });
      i = end;
    } else if (c === '"' || c === "'") {
      const [value, end] = readString(i);
      tokens.push({ type: "string", value, start: i });
      i = end;
    } else if (c === "`") {
      const [parts, end] = readTemplate(i);
      tokens.push({ type: "template", parts, value: parts.join(""), start: i });
      i = end;
    } else if (/[a-z_$]/i.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(text[j])) j += 1;
      tokens.push({ type: "ident", value: text.slice(i, j), start: i });
      i = j;
    } else if (/\d/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(text[j])) j += 1;
      tokens.push({ type: "number", value: text.slice(i, j), start: i });
      i = j;
    } else if (c === "/") {
      const prev = lastSignificant();
      const regex =
        prev === null ||
        (prev.type === "punct" && !/[)\]]/.test(prev.value)) ||
        (prev.type === "ident" && REGEX_AFTER_WORD.has(prev.value));
      if (regex) {
        let j = i + 1;
        let inClass = false;
        while (j < n && text[j] !== "\n") {
          if (text[j] === "\\") j += 2;
          else if (text[j] === "[" || text[j] === "]") {
            inClass = text[j] === "[";
            j += 1;
          } else if (text[j] === "/" && !inClass) break;
          else j += 1;
        }
        j += 1;
        while (j < n && /[a-z]/i.test(text[j])) j += 1;
        tokens.push({ type: "regex", value: text.slice(i, j), start: i });
        i = j;
      } else {
        tokens.push({ type: "punct", value: c, start: i });
        i += 1;
      }
    } else {
      tokens.push({ type: "punct", value: c, start: i });
      i += 1;
    }
  }
  return tokens;
}

// ── Hostile tags ────────────────────────────────────────────────────────────────────────────

const TEST_ROOTS = new Set(["it", "test", "describe"]);
const NOT_RUN_ROOTS = new Set(["xit", "xtest", "xdescribe"]);
/** Members that keep a test from running, or make its failure a pass. */
const NOT_RUN_MEMBERS = new Set(["skip", "todo", "failing"]);

/**
 * The titles of the it(…) / test(…) / describe(…) calls in a test file that run: not skipped
 * (`.skip`, `xit`, `xtest`, `xdescribe`, inside a skipped describe), not `.todo`, not `.failing`.
 * A template title counts by its static parts; a comment or a string elsewhere is no title.
 */
export function runningTestTitles(text) {
  const tokens = lex(text).filter((t) => t.type !== "comment");
  // The closing token of each opening one: ( [ {.
  const close = new Map();
  // Stryker disable next-line ArrayDeclaration: an extra bottom entry is never a token's index
  const stack = [];
  tokens.forEach((t, k) => {
    if (t.type !== "punct") return;
    if ("([{".includes(t.value)) stack.push(k);
    else if (")]}".includes(t.value) && stack.length) close.set(stack.pop(), k);
  });
  const out = [];
  // Stryker disable next-line ArrayDeclaration: a number is never below a string's NaN
  const skippedUntil = [];
  for (let k = 0; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t.type !== "ident" || !(TEST_ROOTS.has(t.value) || NOT_RUN_ROOTS.has(t.value)))
      continue;
    const prev = tokens[k - 1];
    if (prev && ((prev.type === "punct" && prev.value === ".") || prev.type === "ident"))
      continue;
    const chain = [t.value];
    let j = k + 1;
    for (;;) {
      const a = tokens[j];
      const b = tokens[j + 1];
      if (a?.type === "punct" && a.value === "." && b?.type === "ident") {
        chain.push(b.value);
        j += 2;
        if (b.value === "each") {
          const c = tokens[j];
          if (c?.value === "(" && close.has(j)) j = close.get(j) + 1;
          else if (c?.type === "template") j += 1;
        }
      } else break;
    }
    const open = tokens[j];
    const title = tokens[j + 1];
    if (!(open?.type === "punct" && open.value === "(")) continue;
    const at = tokens[k].start;
    const inSkipped = skippedUntil.some((end) => at < end);
    const notRun =
      inSkipped ||
      NOT_RUN_ROOTS.has(chain[0]) ||
      chain.some((m) => NOT_RUN_MEMBERS.has(m));
    if (notRun && close.has(j)) skippedUntil.push(tokens[close.get(j)].start);
    if (!notRun && (title?.type === "string" || title?.type === "template"))
      out.push(title.type === "template" ? title.parts.join(" ") : title.value);
  }
  return out;
}

/** Each comment line of a file, its comment marks taken off (`//`, `/*`, `*`, `*\/`). */
export function commentLines(text) {
  return lex(text)
    .filter((t) => t.type === "comment")
    .flatMap((t) => t.value.split("\n"))
    .map((l) =>
      l
        .replace(/\*+\/$/, "")
        .replace(/^\s*(?:\/{2,}|\/\*+|\*+)\s?/, "")
        .trim()
    );
}

/** A waiver of a tag: a comment line `hostile:<tag> n/a: <reason>`, its reason on the line. */
function waiverReason(text, tag) {
  for (const line of commentLines(text)) {
    const m = new RegExp(String.raw`^hostile:${tag} n\/a:[ \t]*(.*)$`).exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * The hostile tags a route test file lacks: neither in a running test's title nor waived on a
 * comment line with a reason of four words or more on that line.
 */
export function missingHostileTags(text) {
  const titles = runningTestTitles(text);
  return HOSTILE_TAGS.filter((tag) => {
    if (titles.some((t) => t.includes(`[hostile:${tag}]`))) return false;
    const reason = waiverReason(text, tag);
    return !(reason !== null && answered(reason));
  });
}

/** The helper modules a test imports (`./helpers/x`, `@/__tests__/helpers/x`), by their name. */
export function importedHelpers(text) {
  const out = new Set();
  for (const re of HELPER_IMPORTS) for (const m of text.matchAll(re)) out.add(m[1]);
  return [...out];
}

/**
 * Whether a test file's text drives a route handler: it imports an app/api route module, or a
 * test helper (`__tests__/helpers/…`, one level) that does. `helperText(name)` gives a helper's
 * text (null when it cannot be read). Only test files are read (TEST_FILE, at checkRange's
 * collection: TASK-204 N-18 — a second check here could not be told apart from the first).
 */
export function drivesRoute(text, helperText) {
  if (ROUTE_IMPORTS.some((re) => re.test(text))) return true;
  // An unreadable helper (null) imports nothing: RegExp#test reads it as "null".
  return importedHelpers(text).some((name) =>
    ROUTE_IMPORTS.some((re) => re.test(helperText(name)))
  );
}

// ── Baselines ───────────────────────────────────────────────────────────────────────────────

export const countOf = (v) => (typeof v === "number" ? v : v?.count);
export const isCount = (n) => Number.isInteger(n) && n >= 0;

/** A route file's URL: app/api/a/[id]/route.ts → /api/a/[id]. */
export const routeUrl = (file) => {
  const m = /^app(\/api\/.*)\/route\.tsx?$/.exec(file);
  return m ? m[1] : null;
};

/** A key (`<file>` or `<file>#<path>`) under the names git sees renamed: the old key, or itself. */
export function renamedFrom(key, renames) {
  for (const [from, to] of renames) {
    if (key === to) return from;
    if (key.startsWith(`${to}#`)) return `${from}${key.slice(to.length)}`;
  }
  return key;
}

/** A gap (`<caller> -> <route url> : <code>`) with its caller and route under their old names. */
export function gapFrom(gap, renames) {
  const m = /(.*) -> (\S+) : (.*)/.exec(gap);
  if (!m) return gap;
  let [, caller, url, code] = m;
  for (const [from, to] of renames) {
    if (caller === to) caller = from;
    const [a, b] = [routeUrl(from), routeUrl(to)];
    if (a && url === b) url = a;
  }
  return `${caller} -> ${url} : ${code}`;
}

/**
 * How a baseline file loosened from the base to the head, one line each (empty: it did not).
 * `baseText` null: the base has no such file — the change introduces it, nothing to compare.
 * `renames`: old path → new path, as git sees them between the base and the head.
 */
export function baselineFindings(
  name,
  kind,
  baseText,
  headText,
  renames = new Map(),
  deleted = new Set()
) {
  // A file the change deleted or renamed away: only its keys may be re-keyed (a split, a move).
  const gone = (file) => deleted.has(file) || renames.has(file);
  if (baseText === null) return [];
  if (headText === null)
    return [`${name}: removed — a ratchet baseline stays (lower it to zero instead)`];
  let base;
  let head;
  try {
    base = JSON.parse(baseText);
  } catch {
    return []; // the base's own file unreadable: nothing to hold the head to
  }
  try {
    head = JSON.parse(headText);
  } catch {
    return [`${name}: not valid JSON`];
  }
  const out = [];
  const total = (label = "count") => {
    if (!isCount(head.count)) out.push(`${name}: "${label}" is not a count`);
    else if (isCount(base.count) && head.count > base.count)
      out.push(
        `${name}: ${label} ${head.count}, the base has ${base.count} — it only shrinks`
      );
  };
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  if (kind === "counts" || kind === "keys") {
    total();
    const field = kind === "counts" ? "files" : "entries";
    const was = base[field] && typeof base[field] === "object" ? base[field] : {};
    const now = head[field] && typeof head[field] === "object" ? head[field] : {};
    // A key's weight: its count (counts), or one entry (keys).
    const weight = (v) => (kind === "counts" ? countOf(v) : 1);
    const sum = (o) =>
      Object.values(o).reduce((n, v) => n + (isCount(weight(v)) ? weight(v) : 0), 0);
    const added = [];
    for (const [key, v] of Object.entries(now)) {
      if (kind === "counts" && !isCount(countOf(v))) {
        out.push(`${name}: ${key}'s count is not a count`);
        continue;
      }
      const old = has(was, key) ? key : renamedFrom(key, renames);
      if (!has(was, old) || (old !== key && has(now, old))) added.push(key);
      else if (
        kind === "counts" &&
        isCount(countOf(was[old])) &&
        countOf(v) > countOf(was[old])
      )
        out.push(
          `${name}: ${key} ${countOf(v)}, the base has ${countOf(was[old])}${old === key ? "" : ` (as ${old})`}`
        );
    }
    // A new key is a re-key (a file split, or renamed below git's similarity threshold) only when
    // the total does not rise (the existing keys' never may, checked above) and a key it replaces
    // went with its file: a key of the base, no longer listed, whose file the change deleted or
    // renamed away. Anything else is new debt.
    const vacated = Object.keys(was).some((k) => !has(now, k) && gone(k.split("#")[0]));
    if (sum(now) > sum(was) || !vacated)
      for (const key of added)
        out.push(
          sum(now) > sum(was)
            ? `${name}: ${key} added — the base does not list it, and the total rises (${sum(now)} > ${sum(was)}); fix the new findings instead, or remove the key`
            : `${name}: ${key} added — the base does not list it, and no key it could replace went with its file (deleted or renamed in this change); fix the new findings instead, or remove the key`
        );
  } else if (kind === "gaps") {
    total();
    // Stryker disable next-line ArrayDeclaration: no head gap is the mutant's text, none re-keys it
    const was = Array.isArray(base.gaps) ? base.gaps : [];
    const now = Array.isArray(head.gaps) ? head.gaps : [];
    if (!Array.isArray(head.gaps)) out.push(`${name}: "gaps" is not a list`);
    // A gap's route and code (` -> <route> : <code>`): a gap whose caller moved keeps them.
    const tail = (g) => / -> \S+ : .*/.exec(g)?.[0] ?? g;
    // Stryker disable next-line StringLiteral: a gap without a caller has none the change removed
    const caller = (g) => /(.+) -> \S+ : /.exec(g)?.[1] ?? "";
    // Only a gap whose caller the change deleted or renamed away may be re-keyed.
    const removed = was.filter((g) => !now.includes(g) && gone(caller(g))).map(tail);
    for (const g of now) {
      if (was.includes(g) || was.includes(gapFrom(g, renames))) continue;
      // Re-keyed: its caller split or moved, the same route and code no longer listed under the
      // old caller, and the gaps no more than before.
      const at = removed.indexOf(tail(g));
      if (at >= 0 && now.length <= was.length) removed.splice(at, 1);
      else out.push(`${name}: gap added — ${g}`);
    }
  } else if (kind === "count") {
    total();
  } else if (kind === "floors") {
    const was = base.baseline ?? {};
    const now = head.baseline ?? {};
    for (const axis of COVERAGE_AXES) {
      if (!Number.isFinite(now[axis])) out.push(`${name}: the ${axis} floor is missing`);
      else if (typeof was[axis] === "number" && now[axis] < was[axis])
        out.push(
          `${name}: the ${axis} floor ${now[axis]}, the base has ${was[axis]} — floors only rise`
        );
    }
    if (typeof base.margin === "number") {
      if (!Number.isFinite(head.margin)) out.push(`${name}: the margin is missing`);
      else if (head.margin > base.margin)
        out.push(
          `${name}: the margin ${head.margin}, the base has ${base.margin} — it never rises`
        );
    }
  }
  return out;
}

// ── git ─────────────────────────────────────────────────────────────────────────────────────

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Whether a revision has a file (a blob: a directory or a submodule there is no file). */
function hasPath(rev, path, cwd) {
  return (
    spawnSync("git", ["cat-file", "-t", "--end-of-options", `${rev}:${path}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).stdout.trim() === "blob"
  );
}

/**
 * What a read of a commit (named by its full sha) gave: a commit never changes, so neither does a
 * file's text at it or its tree. Speed only — every rule reads the same answer either way.
 */
const readCache = new Map();
function cached(kind, rev, key, cwd, read) {
  if (!/^[0-9a-f]{40}$/.test(rev)) return read();
  const id = `${kind}\0${cwd}\0${rev}\0${key}`;
  if (!readCache.has(id)) readCache.set(id, read());
  return readCache.get(id);
}

/** A file's text at a revision, or null when it has none. */
function textAt(rev, path, cwd) {
  // Stryker disable next-line StringLiteral: a cache's kind — "" collides with no other read's key
  return cached("text", rev, path, cwd, () =>
    hasPath(rev, path, cwd)
      ? git(["show", "--end-of-options", `${rev}:${path}`], cwd)
      : null
  );
}

function nameStatus(out) {
  // Stryker disable next-line MethodExpression: the one empty part is the last, an odd one out
  const parts = out.split("\0").filter(Boolean);
  const list = [];
  for (let i = 0; i < parts.length; i += 2)
    list.push({ status: parts[i], path: parts[i + 1] });
  return list;
}

/** Whether a `git --version` text names 2.36 or later (with `--remerge-diff`). */
export function remergeDiffIn(version) {
  const v = /(\d+)\.(\d+)/.exec(version);
  return !!v && (Number(v[1]) > 2 || (Number(v[1]) === 2 && Number(v[2]) >= 36));
}
let remergeDiff;
/** Whether this git has `--remerge-diff`. */
function hasRemergeDiff(cwd) {
  if (remergeDiff === undefined) remergeDiff = remergeDiffIn(git(["--version"], cwd));
  return remergeDiff;
}

/** A merge this git cannot judge (older than 2.36, without --remerge-diff): refused, never guessed. */
export class MergeUnjudgeable extends Error {
  constructor(version) {
    super(
      `a two-parent merge needs git 2.36 or later (--remerge-diff) to be judged; this is ${version.trim()} — upgrade git`
    );
  }
}

/**
 * The paths a merge's result changes against every parent: its blob (or its absence) differs from
 * each parent's. Read from `ls-tree -r -z`, so a path with spaces or non-ASCII characters is
 * read as it is, never quoted.
 */
export function ownPaths(result, parents) {
  const paths = new Set([...result.keys(), ...parents.flatMap((p) => [...p.keys()])]);
  return [...paths]
    .filter((path) =>
      parents.every((p) => (p.get(path) ?? null) !== (result.get(path) ?? null))
    )
    .sort();
}

/**
 * What a commit itself changes. A two-parent merge: what differs from git's own re-merge of its
 * parents (`git show --remerge-diff`) — a clean merge changes nothing, a file both parents edited
 * cleanly included; a conflict's resolution or anything added in the merge does. Any other commit
 * (one parent, a root, an octopus merge, which --remerge-diff skips): ownPaths — for one parent the
 * paths `git diff-tree` names, for a root every path (TASK-204 N-18: one reading, not two that
 * could not be told apart). A git older than 2.36 cannot judge a two-parent merge:
 * MergeUnjudgeable. Every path is read NUL-separated.
 */
function changes(sha, parents, cwd) {
  if (parents.length === 2) {
    if (!hasRemergeDiff(cwd)) throw new MergeUnjudgeable(git(["--version"], cwd));
    return nameStatus(
      git(
        [
          "show",
          "--remerge-diff",
          "--no-renames",
          "--format=",
          "--name-status",
          "-z",
          "--end-of-options",
          sha,
          "--",
        ],
        cwd
      )
    );
  }
  const own = ownPaths(
    treeBlobs(sha, cwd),
    parents.map((p) => treeBlobs(p, cwd))
  );
  // Stryker disable next-line StringLiteral: no rule reads a file's status
  return own.map((path) => ({ status: "MM", path }));
}

/**
 * The task registers at a revision: docs/TASKS.md, then each of the app's own
 * (scripts/process-check.app.json `taskRegisters`: repository paths of markdown files).
 */
function taskRegisters(rev, cwd) {
  return registersIn(textAt(rev, APP_CONFIG_PATH, cwd));
}

/**
 * A JSON text read: its value, or null when it is no JSON (null in: null out). Callers test for
 * null before reading a key, so an undefined here would throw.
 */
function jsonOf(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The task registers an app config's text names, docs/TASKS.md first (taskRegisters). */
export function registersIn(text) {
  const config = jsonOf(text);
  const list = config === null ? undefined : config.taskRegisters;
  // A register is a markdown file that is neither code nor one of the process's own files.
  const extra = Array.isArray(list)
    ? list.filter(
        (f) =>
          typeof f === "string" &&
          /^[\w./-]+\.md$/.test(f) &&
          !CODE_PATH.test(f) &&
          !GATE_PATH.test(f)
      )
    : [];
  return [...new Set([TASKS_PATH, ...extra])];
}

/** A risk-tiers path pattern as a test: `**` any depth, `*` within one segment, the whole path. */
export function tierPattern(pattern) {
  const body = pattern
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*")
    )
    .join(".*");
  return new RegExp(`^${body}$`);
}

/**
 * Whether a path is high-tier: the hard rule (HARD_HIGH), or a high area's path in
 * scripts/risk-tiers.json at `rev` (the merge base: a change cannot lower its own tier). An
 * unreadable risk-tiers file leaves only the hard rule.
 */
function highTierPaths(rev, cwd) {
  return highTierIn(textAt(rev, RISK_TIERS_PATH, cwd));
}

/** Whether a path is high-tier, by a risk-tiers text (null: none) and the hard rule. */
export function highTierIn(text) {
  const tiers = jsonOf(text);
  const high = tiers === null ? undefined : tiers.high;
  const patterns = Array.isArray(high)
    ? high
        .flatMap((area) => (Array.isArray(area?.paths) ? area.paths : []))
        .filter((p) => typeof p === "string")
        .map(tierPattern)
    : [];
  return (path) =>
    HARD_HIGH.some((re) => re.test(path)) || patterns.some((re) => re.test(path));
}

/**
 * Each path of a tree and what it is there: `<mode> <object>` — a file's mode (100644, 100755), a
 * symlink (120000) or a submodule's commit (160000) with its object, so a mode change, a file
 * turned symlink or a submodule moved is a change (`git ls-tree -r -z`, read NUL-separated).
 */
function treeBlobs(rev, cwd) {
  // Stryker disable next-line StringLiteral: a cache's key — no text read has an empty path
  return cached("tree", rev, "", cwd, () => readTree(rev, cwd));
}
function readTree(rev, cwd) {
  const out = new Map();
  for (const entry of git(
    // No `--` here: ls-tree reads what follows the tree as path patterns, `--` among them.
    ["ls-tree", "-r", "-z", "--end-of-options", rev],
    cwd
  ).split("\0")) {
    // Sticky (`y`): the entry from its start, where every ls-tree entry has its mode.
    const m = /(\d{6}) (?:blob|commit) ([0-9a-f]+)\t(.*)/sy.exec(entry);
    if (m) out.set(m[3], `${m[1]} ${m[2]}`);
  }
  return out;
}

/** The commit a revert names ("This reverts commit <sha>."), resolved; null when none. */
function revertedCommit(sha, cwd) {
  const m = REVERTS.exec(
    git(["log", "-1", "--format=%B", "--end-of-options", sha, "--"], cwd)
  );
  if (!m) return null;
  const r = spawnSync(
    "git",
    ["rev-parse", "--verify", "-q", "--end-of-options", `${m[1]}^{commit}`],
    { cwd, encoding: "utf8" }
  );
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Whether a commit is on the base: an ancestor of (or) the range's merge base. */
function onBase(sha, from, cwd) {
  return (
    spawnSync("git", ["merge-base", "--is-ancestor", "--end-of-options", sha, from], {
      cwd,
      // Stryker disable next-line StringLiteral: where git's output goes, only
      stdio: "ignore",
    }).status === 0
  );
}

/**
 * Whether a commit is the exact inverse of `reverted` (against its first parent — for a merge, what
 * it brought into its mainline, as `git revert -m 1` and GitHub's Revert button undo it): it changes
 * exactly the files `reverted` changed; each was, in the revert's parent, still as `reverted` left
 * it (nothing changed it since); and each is now as it was before `reverted` — the task registers
 * aside (`registers`). A partial revert, or one over a file edited since, is no true revert.
 */
function trueRevert(files, sha, parent, reverted, cwd, registers) {
  // The task registers are left out: nearly every commit edits one, and a revert's entry is
  // judged on its own (removed, or as it was before the reverted commit).
  const own = (path) => !registers.includes(path);
  const parents = git(
    ["rev-list", "--parents", "-n", "1", "--end-of-options", reverted, "--"],
    cwd
  )
    .trim()
    .split(" ");
  if (parents.length < 2) return false;
  const mainline = parents[1];
  const undone = new Set(
    nameStatus(
      git(
        [
          "diff",
          "--no-renames",
          "--name-status",
          "-z",
          "--end-of-options",
          mainline,
          reverted,
          "--",
        ],
        cwd
      )
    )
      .map((f) => f.path)
      .filter(own)
  );
  const touched = new Set(files.map((f) => f.path).filter(own));
  // Equal sizes and every undone path touched: the same files. (Neither is ever empty here: a
  // commit judged changes code or the process's files, and a register is neither.)
  if (touched.size !== undone.size) return false;
  const now = treeBlobs(sha, cwd);
  const was = treeBlobs(parent, cwd);
  const after = treeBlobs(reverted, cwd);
  const before = treeBlobs(mainline, cwd);
  return [...undone].every(
    (path) =>
      touched.has(path) &&
      was.get(path) === after.get(path) &&
      now.get(path) === before.get(path)
  );
}

/** Rule 3 over the test files a range changed: each route test's missing hostile cases. */
function hostileFindings(testFiles, head, cwd) {
  const findings = [];
  const helperText = (name) => {
    for (const ext of ["", ".ts", ".tsx", ".js", "/index.ts"]) {
      const text = textAt(head, `__tests__/helpers/${name}${ext}`, cwd);
      if (text !== null) return text;
    }
    return null;
  };
  for (const path of [...testFiles].sort()) {
    const text = textAt(head, path, cwd);
    if (text === null || !drivesRoute(text, helperText)) continue;
    let missing;
    try {
      missing = missingHostileTags(text);
    } catch (err) {
      // A LexError, the only error the reading throws (TASK-204 N-18): whatever it is, the file
      // is not passed over — the check fails, naming it.
      findings.push(
        `${path} drives a route and cannot be read for its hostile cases: ${err.message}`
      );
      continue;
    }
    if (missing.length > 0) {
      findings.push(
        `${path} drives a route and lacks ${missing.map((t) => `[hostile:${t}]`).join(", ")} (a test title tag, or a comment "hostile:<tag> n/a: <reason>")`
      );
    }
  }

  return findings;
}

/**
 * What the named tasks' entries lack (rule 2): each named task has an entry, complete (with a
 * Threat model when its change touched a high-tier path), and touched by the change — or, for an
 * app's `(platform TASK-nnn)`, platform-foundation's entry complete and an app-register entry
 * referencing it touched, that entry carrying the Threat model. A task named only by true reverts
 * passes when its entry was removed, or is as it was before a reverted commit (absent included).
 */
function namedFindings({
  named,
  entries,
  fromEntries,
  registers,
  appRegisters,
  platformRefs,
  plainRefs,
  threatened,
  touched,
  head,
  cwd,
}) {
  const findings = [];
  const threat = (id) =>
    threatened.has(id)
      ? [
          {
            ...THREAT_MODEL,
            why: `the change touches ${threatened.get(id)}, a high-tier path`,
          },
        ]
      : [];
  const hits = (e) => {
    const lines = touched.get(e.file);
    for (let l = e.start; l <= e.end; l += 1) if (lines.has(l)) return true;
    return false;
  };
  for (const id of [...named.keys()].sort()) {
    const how = named.get(id);
    const entry = entries.get(id);
    if (how.plainBy.size === 0) {
      // Only reverts name it: the entry removed, or exactly as before a reverted commit, passes.
      if (!entry && fromEntries.has(id)) continue;
      if (
        how.reverts.some((sha) => {
          const parent = `${sha}^`;
          // Stryker disable next-line StringLiteral: the mutant's text holds no entry
          const read = (file) => taskEntries(textAt(parent, file, cwd) ?? "");
          const before = registers.flatMap(read).find((e) => e.id === id);
          return before?.body === entry?.body;
        })
      )
        continue;
    }
    if (!entry) {
      findings.push(
        `${id} is named by a commit but has no entry in ${registers.join(" or ")}${
          platformRefs.has(id)
            ? ` (a platform task: sync platform-foundation's entry first)`
            : " (add one, with its Design check and Self-review)"
        }`
      );
      continue;
    }
    if (platformRefs.has(id) && !plainRefs.has(id)) {
      // platform-foundation's task, named by an app: its entry (synced) is complete; the app's work
      // is recorded in an entry of the app's own register that references it, and that entry —
      // the app's, which the app can edit — carries the Threat model.
      findings.push(...entryFindings(entry));
      const ref = new RegExp(`\\bplatform ${id}\\b`);
      const recorded = appRegisters.flatMap((file) =>
        // Stryker disable next-line StringLiteral: a missing register's text, any, holds no entry
        taskEntries(textAt(head, file, cwd) ?? "")
          .map((e) => ({ ...e, file }))
          .filter((e) => ref.test(e.body) && hits(e))
      );
      if (recorded.length === 0)
        findings.push(
          `platform ${id}: the change touches no entry in ${appRegisters.join(" or ")} that references "platform ${id}" (record the app's work there; sync platform-foundation's entry first)`
        );
      else {
        const gaps = recorded.map((e) => entryFindings(e, threat(id), []));
        if (gaps.every((g) => g.length > 0)) findings.push(...gaps[0]);
      }
      continue;
    }
    findings.push(...entryFindings(entry, threat(id)));
    if (!hits(entry))
      findings.push(
        entry.file === TASKS_PATH && appRegisters.length > 0
          ? `${id}: the change does not touch its entry in ${entry.file}, platform-foundation's synced register (for platform-foundation's task, end the subject with (platform ${id}) and record the app's work in an entry of ${appRegisters.join(" or ")} that references "platform ${id}")`
          : `${id}: the change does not touch its entry in ${entry.file} (record the work there)`
      );
  }

  return findings;
}

/** Each ratchet baseline at the head against the merge base, renames and deletions followed. */
function rangeBaselineFindings(from, head, cwd) {
  const findings = [];
  // Each rename: `R<score>\0<old>\0<new>\0`.
  const renames = new Map(
    [
      ...git(
        [
          "diff",
          "-M",
          "--diff-filter=R",
          "--name-status",
          "-z",
          "--end-of-options",
          from,
          head,
          "--",
        ],
        cwd
      ).matchAll(/R\d*\0([^\0]+)\0([^\0]+)\0/g),
    ].map((m) => [m[1], m[2]])
  );
  const gone = git(
    [
      "diff",
      "-M",
      "--diff-filter=D",
      "--name-only",
      "-z",
      "--end-of-options",
      from,
      head,
      "--",
    ],
    cwd
  );
  const deleted = new Set(gone.split("\0").filter(Boolean));
  for (const [file, kind] of Object.entries(BASELINES)) {
    findings.push(
      ...baselineFindings(
        file,
        kind,
        textAt(from, file, cwd),
        textAt(head, file, cwd),
        renames,
        deleted
      )
    );
  }
  return findings;
}

/** Every finding for the range, and what was checked (for the summary). */
export function checkRange({ base, head = "HEAD", cwd = process.cwd() }) {
  const findings = [];
  const notes = [];
  let from;
  try {
    from = git(["merge-base", "--end-of-options", base, head], cwd).trim();
  } catch {
    from = git(
      ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`],
      cwd
    ).trim();
  }
  // The rule's start in head's history: the first commit that brought the script. A commit is
  // judged unless it is an ancestor of that one (made before the rule existed).
  const intro = git(
    [
      "rev-list",
      "--reverse",
      "--topo-order",
      "--full-history",
      "--end-of-options",
      head,
      "--",
      SCRIPT_PATH,
    ],
    cwd
  )
    .split("\n")
    .filter(Boolean)
    .find((sha) => hasPath(sha, SCRIPT_PATH, cwd));
  const introParents = intro
    ? git(["rev-list", "--parents", "-n", "1", "--end-of-options", intro, "--"], cwd)
        .trim()
        .split(" ")
        .slice(1)
    : [];
  const beforeRule = new Set(
    // Stryker disable next-line ArrayDeclaration: no commit's sha is the mutant's text
    introParents.length > 0
      ? // Stryker disable next-line MethodExpression: "" is no commit's sha
        git(["rev-list", "--end-of-options", ...introParents, "--"], cwd)
          .split("\n")
          .filter(Boolean)
      : // Stryker disable next-line ArrayDeclaration: no commit's sha is the mutant's text
        []
  );
  const ruled = (sha) => intro !== undefined && !beforeRule.has(sha);

  const commits = git(
    [
      "rev-list",
      "--reverse",
      "--topo-order",
      "--parents",
      "--end-of-options",
      `${from}..${head}`,
      "--",
    ],
    cwd
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, ...parents] = line.split(" ");
      return { sha, parents };
    });
  // The task registers: docs/TASKS.md, and an app's own (scripts/process-check.app.json).
  const registers = taskRegisters(head, cwd);
  /** Each entry by id, with the register it is in; the first register to have an id wins. */
  const entriesAt = (rev) => {
    const out = new Map();
    for (const file of registers)
      // Stryker disable next-line StringLiteral: a missing register's text, any, holds no entry
      for (const e of taskEntries(textAt(rev, file, cwd) ?? ""))
        if (!out.has(e.id)) out.set(e.id, { ...e, file });
    return out;
  };
  const entries = entriesAt(head);
  const fromEntries = entriesAt(from);
  // A pushed commit that named no task is adopted by its entry's `**Commits:** <sha>` line: a
  // subject cannot be changed once pushed (develop takes no force-push), an entry can.
  const adoptions = [...entries.values()].flatMap((e) =>
    // The line itself, not a mention of one (in prose or a code span): `**Commits:** …` or
    // `- **Commits:** …` at its start.
    [...e.body.matchAll(/^[ \t]*(?:- )?\*\*Commits:\*\*([^\n]*)/gm)].flatMap((m) =>
      [...m[1].matchAll(/\b[0-9a-f]{7,40}\b/g)].map((h) => ({ id: e.id, sha: h[0] }))
    )
  );
  const adoptedBy = (sha) =>
    [...new Set(adoptions.filter((a) => sha.startsWith(a.sha)).map((a) => a.id))].sort();
  // An app (its own register beside TASKS.md): `(platform TASK-nnn)` names platform-foundation's
  // task, whose entry is in the synced docs/TASKS.md; the app's work is recorded in its own
  // register, in an entry that references it.
  const appRegisters = registers.filter((f) => f !== TASKS_PATH);
  const touched = new Map(
    registers.map((file) => [
      file,
      touchedLines(
        git(
          [
            "diff",
            "-U0",
            "--no-ext-diff",
            "--no-textconv",
            "--end-of-options",
            from,
            head,
            "--",
            file,
          ],
          cwd
        )
      ),
    ])
  );
  // The high-tier paths, as the merge base has them (the change cannot loosen its own tier).
  const high = highTierPaths(from, cwd);

  /** task → the commits that named it plainly, and the commits only reverts of which named it. */
  const named = new Map();
  const name = (task, sha, revertOf) => {
    const was = named.get(task) ?? { plainBy: new Set(), reverts: [] };
    if (revertOf) was.reverts.push(revertOf);
    else was.plainBy.add(sha);
    named.set(task, was);
  };
  /** The commits judged so far in this range, each with the tasks it named plainly. */
  const judged = new Map();
  const testFiles = new Set();
  /** Tasks whose change touched a high-tier path (the first such path): they carry a Threat model. */
  const threatened = new Map();
  /** Tasks an app named only as platform-foundation's (`platform TASK-nnn`). */
  const platformRefs = new Set();
  const plainRefs = new Set();
  let count = 0;
  for (const { sha, parents } of commits) {
    if (!ruled(sha)) continue; // made before the rule
    count += 1;
    const [author, committer, subject] = git(
      ["log", "-1", "--format=%an%x00%cn%x00%s", "--end-of-options", sha, "--"],
      cwd
    )
      .trim()
      .split("\0");
    const short = sha.slice(0, 7);
    let files;
    try {
      files = changes(sha, parents, cwd);
    } catch (err) {
      if (!(err instanceof MergeUnjudgeable)) throw err;
      findings.push(`${short} "${subject}": ${err.message}`);
      continue;
    }

    // A test file it changes is judged for its hostile cases, whoever made it (rule 3).
    for (const f of files)
      // A deleted test file has no text at the head: hostileFindings passes over it.
      if (TEST_FILE.test(f.path)) testFiles.add(f.path);

    // Not judged: a sync (by its subject: the platform's commits were judged where they were
    // made) and Dependabot's commits (it cannot name a task) — as Dependabot or GitHub committed
    // them: one amended or rebased by hand keeps Dependabot as its author and is judged.
    if (SYNC_SHA.test(subject)) {
      notes.push(
        `${short} is a sync from platform-foundation (by its subject): not judged here`
      );
      continue;
    }
    if (author === DEPENDABOT && BOT_COMMITTERS.includes(committer)) {
      notes.push(`${short} is Dependabot's: not judged`);
      continue;
    }
    const code = files.some((f) => CODE_PATH.test(f.path));
    const gate = files.some((f) => GATE_PATH.test(f.path));
    if (!code && !gate) continue;
    // A true revert: the exact inverse of one commit already on the base (judged there), or of one
    // earlier in this range (judged here: the pair is a net no-op) — changing only the files that
    // commit changed, each back to what it was before it (a merge: its first parent, as GitHub's
    // Revert button does).
    const target = REVERT_SUBJECT.test(subject) ? revertedCommit(sha, cwd) : null;
    // (judged holds no null.) The exact inverse first: it reads the target, so a null one fails.
    const earlier = judged.has(target);
    const revertOf =
      target !== null &&
      parents.length === 1 &&
      trueRevert(files, sha, parents[0], target, cwd, registers) &&
      (earlier || onBase(target, from, cwd))
        ? target
        : null;
    if (revertOf !== null && earlier)
      // The pair is a net no-op: the reverted commit's tasks are named by a revert only.
      for (const t of judged.get(revertOf)) {
        const was = named.get(t);
        was.plainBy.delete(revertOf);
        was.reverts.push(revertOf);
      }
    const refs = subjectRefs(subject);
    for (const r of refs)
      (r.platform && appRegisters.length > 0 ? platformRefs : plainRefs).add(r.id);
    let tasks = subjectTasks(subject);
    if (tasks.length === 0 && revertOf === null) {
      tasks = adoptedBy(sha);
      tasks.forEach((t) => plainRefs.add(t));
      if (tasks.length > 0)
        notes.push(
          `${short} names no task in its subject; adopted by ${tasks.join(", ")}`
        );
      else
        findings.push(
          `${short} "${subject}" changes ${code ? "code" : "the process's own files"} but names no task: end its subject with (TASK-nnn) — or, once pushed, adopt it in its task's entry with a line "**Commits:** ${short}"${
            REVERT_SUBJECT.test(subject)
              ? `; a Revert "…" (or Reapply "…") needs no task only as the exact inverse of one commit on the base or earlier in the range (git revert of that commit alone, its files unchanged since)`
              : ""
          }`
        );
    }
    if (tasks.length === 0 && revertOf !== null)
      notes.push(
        earlier
          ? `${short} is a true revert of ${revertOf.slice(0, 7)}, earlier in this range: the pair is a net no-op`
          : `${short} is a true revert of ${revertOf.slice(0, 7)}, on the base: judged there`
      );
    tasks.forEach((t) => name(t, sha, revertOf));
    // A revert's own tasks too: reverted in turn in this range (a Reapply), the pair is a net
    // no-op for them as well (TASK-204 N-18).
    judged.set(sha, tasks);
    // A change to a high-tier path (a gate or a security boundary) carries a threat model.
    const highPath = revertOf === null ? files.find((f) => high(f.path)) : undefined;
    if (highPath)
      tasks.forEach((t) => {
        if (!threatened.has(t)) threatened.set(t, highPath.path);
      });
  }

  findings.push(
    ...namedFindings({
      named,
      entries,
      fromEntries,
      registers,
      appRegisters,
      platformRefs,
      plainRefs,
      threatened,
      touched,
      head,
      cwd,
    })
  );
  findings.push(...hostileFindings(testFiles, head, cwd));

  // Rule 4, against the later of the merge base and the rule's first commit: a baseline raised
  // before the rule existed is the rule's starting point (a first promotion carries such commits).
  if (ruled(head)) {
    const since = onBase(intro, from, cwd) ? from : intro;
    findings.push(...rangeBaselineFindings(since, head, cwd));
  }
  return { findings, notes, commits: count, tasks: [...named.keys()].sort() };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────

const USAGE = `usage: node ${SCRIPT_PATH} --base <ref> [--head <ref>]`;
const FLAGS = ["--base", "--head"];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!FLAGS.includes(flag) || value === undefined) throw new Error(USAGE);
    args[flag.slice(2)] = value;
  }
  if (!args.base) throw new Error(USAGE);
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const result = checkRange(args);
  const head = `process check: ${result.commits} commit(s) judged since ${args.base}; tasks ${result.tasks.join(", ") || "none"}`;
  console.log(head);
  result.notes.forEach((n) => console.log(`  ${n}`));
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (result.findings.length === 0) {
    console.log("  nothing missing");
    if (summary && existsSync(summary))
      appendFileSync(summary, `**${head}**: nothing missing\n`);
    return;
  }
  for (const f of result.findings) console.error(`::error::${f}`);
  if (summary && existsSync(summary)) {
    appendFileSync(
      summary,
      `**${head}**\n\n${result.findings.map((f) => `- ${f}`).join("\n")}\n`
    );
  }
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
