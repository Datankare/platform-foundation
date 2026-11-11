#!/usr/bin/env node
// scripts/review-eval.mjs — score the reviewer over its eval set (TASK-183 §6, TASK-204 N-44)
//
//   node scripts/review-eval.mjs [--cases 01,13] [--out results.json]
//
// docs/review-evals/README.md is the rubric; this runs it. For each case (docs/review-evals/NN-*.md)
// it builds the case's review input — a patch in inputs/, `git show <sha> -- <path>`, files "as of
// `<sha>`", or a PR's diff with files as of a commit — and never the case file itself; gives the
// reviewer under test this repository's CLAUDE.md and REVIEW.md as its instructions; and collects
// its findings as JSON. Each case is then scored by a second, separate call (the verifier), which
// sees the case's defect, its "Where" and its Scoring lines and the reviewer's findings:
//   2 caught — a finding names the case's file and a line within its location, describes the
//              defect's mechanism, and is tagged Important (a 2 without the Important tag is
//              capped at 1 here, in code, whatever the verifier says);
//   1 partial, 0 missed. Noise: the reviewer's other findings that the verifier judges not real.
//
// The reviewer is MODEL_REGISTRY's standard tier (read from platform/ai/types.ts, so the model check
// covers it) with the protocol as written at HEAD; the run records both, and CLAUDE.md's and
// REVIEW.md's commit, for the README's Runs table. Needs the repository's history (the cases name
// public develop commits): the workflow checks out with fetch-depth 0.
//
// Without ANTHROPIC_API_KEY nothing is scored, and the run says so (a notice and a summary line),
// never silently; with REQUIRE_REVIEW_EVAL=true that is a failure (the workflow sets it). The key
// is only ever sent as a header.
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { askModel, jsonOf, registryTier } from "./anthropic-messages.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CASES_DIR = join(ROOT, "docs/review-evals");
export const MAX_INPUT_CHARS = 150_000;

/** Every `…` token of a text without spaces, in order. */
function backticked(text) {
  return [...text.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]);
}

/** Whether a token is a file path: one with a directory, or a known file type at the root. */
function isPath(token) {
  return (
    !/^[0-9a-f]{7,40}$/.test(token) &&
    !token.includes(":") &&
    (/\/.+\.[a-z]+$/.test(token) || /^[\w.-]+\.(?:md|yml|ts|tsx|sql)$/.test(token))
  );
}

/** The text of a markdown section `## title` (up to the next `## `), trimmed. */
export function section(text, title) {
  const at = text.indexOf(`\n## ${title}\n`);
  if (at < 0) return "";
  const rest = text.slice(at + title.length + 5);
  const end = rest.indexOf("\n## ");
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

/** The table field `| Field | value |` of a case. */
export function field(text, name) {
  const m = text.match(new RegExp(`^\\|\\s*${name}\\s*\\|\\s*(.+?)\\s*\\|\\s*$`, "m"));
  return m ? m[1] : "";
}

/**
 * How a case's review input is built: { kind: "patch", file } | { kind: "show", sha, path } |
 * { kind: "files", sha, paths } | { kind: "pr", sha, at, paths }, or null when it is not one of
 * the forms the README uses.
 */
export function inputSpec(reviewInput) {
  const patch = reviewInput.match(/\(inputs\/([\w.-]+\.patch)\)/);
  if (patch) return { kind: "patch", file: `inputs/${patch[1]}` };
  const show = reviewInput.match(/`git show ([0-9a-f]{7,40}) -- ([^`\s]+)`/);
  if (show) return { kind: "show", sha: show[1], path: show[2] };
  const paths = backticked(reviewInput).filter(isPath);
  const pr = reviewInput.match(/diff of PR #\d+ \(`([0-9a-f]{7,40})`\)/);
  const asOf = reviewInput.match(/as of `([0-9a-f]{7,40})`/);
  if (pr && asOf) return { kind: "pr", sha: pr[1], at: asOf[1], paths };
  if (asOf && paths.length > 0) return { kind: "files", sha: asOf[1], paths };
  return null;
}

/**
 * The case's expected location: { file, lines: [from, to][] } from its "Where" section; `lines` is
 * empty for a whole-file location.
 */
export function expectedWhere(whereText) {
  const m = whereText.match(/`([^`\s:]+\.[a-z]+):(\d+)(?:[–-](\d+))?`/);
  if (!m) {
    // A whole-file location (a missing setting, a document): any line of it.
    const file = backticked(whereText).find(isPath);
    return file ? { file, lines: [] } : null;
  }
  const lines = [[Number(m[2]), Number(m[3] ?? m[2])]];
  for (const x of whereText.matchAll(/`:(\d+)(?:[–-](\d+))?`/g)) {
    lines.push([Number(x[1]), Number(x[2] ?? x[1])]);
  }
  return { file: m[1], lines };
}

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** The review input's text for a spec (git for commits; the inputs/ folder for patches). */
export function buildInput(
  spec,
  read = git,
  readPatch = (f) => readFileSync(join(CASES_DIR, f), "utf8")
) {
  let text;
  if (spec.kind === "patch") text = readPatch(spec.file);
  else if (spec.kind === "show")
    text = read(["show", "--no-color", spec.sha, "--", spec.path]);
  else {
    const files = spec.paths
      .map(
        (p) =>
          `=== ${p} as of ${spec.at ?? spec.sha} ===\n${read(["show", `${spec.at ?? spec.sha}:${p}`])}`
      )
      .join("\n\n");
    text =
      spec.kind === "pr"
        ? `${read(["show", "--no-color", spec.sha])}\n\n${files}`
        : files;
  }
  return text.length > MAX_INPUT_CHARS
    ? `${text.slice(0, MAX_INPUT_CHARS)}\n[… the input was cut at ${MAX_INPUT_CHARS} characters]`
    : text;
}

export function reviewerSystem(claudeMd, reviewMd) {
  return `You are the code reviewer described by this repository's CLAUDE.md and REVIEW.md, reviewing one change. Follow REVIEW.md: its tags (Important, Low, Nit, Pre-existing), its lenses, and its verifier step before you report.

<CLAUDE.md>
${claudeMd}
</CLAUDE.md>

<REVIEW.md>
${reviewMd}
</REVIEW.md>

Answer with ONLY one JSON object: {"findings": [{"tag": "Important" | "Low" | "Nit" | "Pre-existing", "file": "path", "line": 1, "finding": "what is wrong and why"}]}. An empty list is a valid answer.`;
}

export const VERIFIER_SYSTEM = `You score a code reviewer's findings against one known defect, by the rubric you are given. You are sceptical and literal. Answer with ONLY one JSON object: {"score": 0 | 1 | 2, "matched": <index of the finding that earns it, or null>, "noise": [<indexes of the other findings that are not real defects in the input>], "why": "one sentence"}`;

/** A reviewer's findings, well formed only. */
export function readReviewerFindings(reply) {
  const json = jsonOf(reply);
  if (!json || !Array.isArray(json.findings)) return null;
  return json.findings
    .filter(
      (f) =>
        f &&
        typeof f.file === "string" &&
        typeof f.finding === "string" &&
        ["Important", "Low", "Nit", "Pre-existing"].includes(f.tag)
    )
    .slice(0, 30)
    .map((f) => ({
      tag: f.tag,
      file: f.file,
      line: Number.isInteger(f.line) ? f.line : null,
      finding: f.finding.slice(0, 2000),
    }));
}

/** The verifier's score, with the rubric's hard rule in code: a 2 needs the Important tag. */
export function finalScore(verdict, findings) {
  if (!verdict || ![0, 1, 2].includes(verdict.score)) return null;
  const m = Number.isInteger(verdict.matched) ? findings[verdict.matched] : null;
  let score = verdict.score;
  if (score > 0 && !m) score = 0;
  if (score === 2 && m.tag !== "Important") score = 1;
  const noise = Array.isArray(verdict.noise)
    ? new Set(
        verdict.noise.filter(
          (i) => Number.isInteger(i) && i !== verdict.matched && findings[i]
        )
      ).size
    : 0;
  return { score, noise };
}

/** The cases on disk, in order: { id, text }. */
export function listCases(dir = CASES_DIR) {
  return readdirSync(dir)
    .filter((f) => /^\d{2}-.+\.md$/.test(f))
    .sort()
    .map((f) => ({
      id: f.slice(0, 2),
      file: f,
      text: readFileSync(join(dir, f), "utf8"),
    }));
}

function say(line, summaryLine = line) {
  console.log(line);
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) {
    try {
      appendFileSync(file, `${summaryLine}\n`);
    } catch {
      // A summary that cannot be written is not a failure of the run.
    }
  }
}

async function scoreCase(c, ask, system) {
  const spec = inputSpec(field(c.text, "Review input"));
  const where = expectedWhere(section(c.text, "Where"));
  if (!spec || !where)
    return { id: c.id, error: "the case's review input or Where could not be read" };
  const input = buildInput(spec);
  const r = await ask(system, `Review this change.\n\n<change>\n${input}\n</change>`);
  if (r.status !== 200 || r.stopReason === "max_tokens") {
    return {
      id: c.id,
      error:
        r.status !== 200 ? `reviewer call: HTTP ${r.status}` : "reviewer answer cut off",
    };
  }
  const findings = readReviewerFindings(r.text);
  if (!findings) return { id: c.id, error: "the reviewer's answer could not be read" };
  const rubric = [
    `The defect:\n${section(c.text, "The defect")}`,
    `Where: ${section(c.text, "Where")}`,
    `The finding a reviewer should have produced:\n${section(c.text, "The finding a reviewer should have produced")}`,
    `Scoring:\n${section(c.text, "Scoring")}`,
    "Score 2 only when a finding names this file and a line within the location, describes the mechanism, and is tagged Important; 1 when the Partial line holds or the right defect is tagged Nit or Pre-existing; else 0.",
  ].join("\n\n");
  const v = await ask(
    VERIFIER_SYSTEM,
    `${rubric}\n\nThe reviewer's findings (indexed from 0):\n${JSON.stringify(findings, null, 1)}\n\nThe review input:\n<change>\n${input}\n</change>`
  );
  const score = v.status === 200 ? finalScore(jsonOf(v.text), findings) : null;
  if (!score) return { id: c.id, error: "the verifier's answer could not be read" };
  return { id: c.id, ...score, findings: findings.length };
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes("--cases")
    ? args[args.indexOf("--cases") + 1].split(",")
    : null;
  const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
  const key = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!key) {
    say(
      "::notice::review-eval skipped: ANTHROPIC_API_KEY is not set, so the reviewer was not scored (docs/review-evals/README.md).",
      "## Reviewer eval: skipped\n\nANTHROPIC_API_KEY is not set: the reviewer was not scored."
    );
    return process.env.REQUIRE_REVIEW_EVAL === "true" ? 1 : 0;
  }
  const entry = registryTier("standard");
  const system = reviewerSystem(
    readFileSync(join(ROOT, "CLAUDE.md"), "utf8"),
    readFileSync(join(ROOT, "REVIEW.md"), "utf8")
  );
  const protocolCommit = git([
    "log",
    "-1",
    "--format=%h",
    "--",
    "CLAUDE.md",
    "REVIEW.md",
  ]).trim();
  const ask = (sys, user) => askModel({ key, entry, system: sys, user, maxTokens: 8192 });
  const cases = listCases().filter((c) => !only || only.includes(c.id));
  const results = [];
  for (const c of cases) {
    const r = await scoreCase(c, ask, system);
    results.push(r);
    say(
      r.error
        ? `case ${c.id}: not scored — ${r.error}`
        : `case ${c.id}: ${r.score} (noise ${r.noise})`
    );
  }
  const scored = results.filter((r) => !r.error);
  const total = scored.reduce((n, r) => n + r.score, 0);
  const noise = scored.reduce((n, r) => n + r.noise, 0);
  const row = `| ${new Date().toISOString().slice(0, 10)} | ${entry.modelId}, AI_ENGINEERING §3, CLAUDE.md/REVIEW.md \`${protocolCommit}\` | ${total} / ${2 * cases.length} | ${noise} | — |`;
  say(
    `Score ${total} of ${2 * cases.length}, noise ${noise}; ${results.length - scored.length} case(s) not scored.`,
    `## Reviewer eval\n\n${row}`
  );
  if (out)
    writeFileSync(
      out,
      `${JSON.stringify({ model: entry.modelId, protocolCommit, total, max: 2 * cases.length, noise, results, row }, null, 2)}\n`
    );
  return scored.length === results.length ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.log(
        `::error::review-eval failed: ${err instanceof Error ? err.message : err}`
      );
      process.exit(1);
    }
  );
}
