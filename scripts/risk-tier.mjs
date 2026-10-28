#!/usr/bin/env node
/**
 * TASK-183 — the review risk tier of a change, set from what it changes, not who wrote it
 * (docs/AI_ENGINEERING.md §4).
 *
 *   node scripts/risk-tier.mjs --base origin/develop [--head HEAD] [--patterns <dir>] [--format text|json|markdown]
 *   git diff --name-only --no-renames origin/develop...HEAD | node scripts/risk-tier.mjs
 *
 * With --base, the changed files are `git diff --name-only -z <base>...<head>` (NUL-separated, so
 * a name with spaces or one git would quote is read as it is) and each file's changed lines
 * (`git diff -U0 <range> -- <file>`, one call per file, no shell) are read too, for the content
 * patterns. From stdin, one path per line, only the path patterns apply (the output says so). A
 * path starting with `"` is git's quoted form, not a name: it is refused (exit 2).
 *
 * --patterns <dir> reads the pattern files from <dir> instead of the current directory; CI's
 * review-tier job runs the base branch's copy of this script with the base's patterns, so a PR
 * that edits either cannot lower its tier through them. A PR that edits the workflow itself runs
 * its own copy of the workflow (pull_request), so its tier is not trustworthy: the hard rule makes
 * it High, and the owner runs the base's classifier locally (docs/AI_ENGINEERING.md §4.2).
 *
 * Hard rule, in this script and not in the pattern files: any changed path under `.github/`,
 * `scripts/risk-tier*`, `REVIEW.md`, `CLAUDE.md`, or any `.gitattributes` (which can hide a
 * file's diff) is High (area workflows), whatever the patterns say. Each file's diff is read with
 * --text, --no-ext-diff and --no-textconv, so an attribute cannot hide its content either.
 *
 * Tiers: High when any file or changed line matches a high area; Low when every file is docs,
 * copy or a generated file; Medium otherwise ("ordinary product code"). The patterns live in
 * scripts/risk-tiers.json (the platform's) and scripts/risk-tiers.app.json (a consuming app's,
 * optional, merged by area name), read from the current directory — REVIEW.md points to them, so
 * the patterns have one source.
 *
 * Exit codes: 0 with a tier (any tier — this classifies, it does not gate); 2 for a usage or
 * configuration error, with nothing on stdout.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The pattern files, platform first; the app's is optional. */
export const TIER_FILES = ["scripts/risk-tiers.json", "scripts/risk-tiers.app.json"];

export const TIERS = ["Low", "Medium", "High"];

/**
 * The hard rule: the review process's own files. A change to any of these is High even when the
 * pattern files (which such a change could edit) say otherwise.
 */
export const HARD_HIGH = [
  { pattern: ".github/**", re: /^\.github\// },
  { pattern: "scripts/risk-tier*", re: /^scripts\/risk-tier[^/]*$/ },
  { pattern: "REVIEW.md", re: /^REVIEW\.md$/ },
  { pattern: "CLAUDE.md", re: /^CLAUDE\.md$/ },
  { pattern: ".gitattributes", re: /^\.gitattributes$/ },
  { pattern: "**/.gitattributes", re: /\/\.gitattributes$/ },
];

/** Content-pattern flags an area may set: case-insensitive only. */
const FLAGS = /^i?$/;

/** A glob (`**` any depth, `*` and `?` within one segment) as an anchored regular expression. */
export function globToRegExp(glob) {
  if (typeof glob !== "string" || glob === "" || glob.startsWith("/"))
    throw new Error(`invalid path pattern ${JSON.stringify(glob)}`);
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // "**/" matches zero or more whole segments; a trailing "**" matches the rest.
      if (glob[i + 2] === "/") {
        out += "(?:[^/]+/)*";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function compileList(list, where) {
  if (!Array.isArray(list) || !list.every((p) => typeof p === "string"))
    throw new Error(`${where}: expected a list of path patterns`);
  return list.map((p) => ({ pattern: p, re: globToRegExp(p) }));
}

function compileContent(list, where, flags = "") {
  if (list === undefined) return [];
  if (!Array.isArray(list) || !list.every((p) => typeof p === "string"))
    throw new Error(`${where}: expected a list of regular expressions`);
  if (typeof flags !== "string" || !FLAGS.test(flags))
    throw new Error(`${where}: "flags" may only be "i"`);
  return list.map((p) => {
    try {
      return { pattern: p, re: new RegExp(p, flags) };
    } catch {
      throw new Error(`${where}: invalid regular expression ${JSON.stringify(p)}`);
    }
  });
}

/**
 * The merged configuration: the platform's file and the app's, if present. An app's area of an
 * existing name adds its paths and content patterns to that area (its failure text is kept from
 * the first file that states one); a new name is a new area.
 */
export function loadConfig(root = process.cwd()) {
  const merged = { generated: [], low: [], contentSkip: [], high: new Map() };
  let found = 0;
  for (const rel of TIER_FILES) {
    const file = `${root}/${rel}`;
    if (!existsSync(file)) continue;
    found++;
    let raw;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`${rel}: not valid JSON (${err.message})`);
    }
    merged.generated.push(...compileList(raw.generated ?? [], `${rel} generated`));
    merged.low.push(...compileList(raw.low ?? [], `${rel} low`));
    merged.contentSkip.push(...compileList(raw.contentSkip ?? [], `${rel} contentSkip`));
    if (!Array.isArray(raw.high))
      throw new Error(`${rel}: "high" must be a list of areas`);
    for (const area of raw.high) {
      if (!area || typeof area.area !== "string" || !/^[a-z][a-z0-9-]*$/.test(area.area))
        throw new Error(`${rel}: every high area needs a lower-case "area" name`);
      const at = `${rel} ${area.area}`;
      const entry = merged.high.get(area.area) ?? {
        area: area.area,
        failure: "",
        paths: [],
        content: [],
      };
      if (!entry.failure && typeof area.failure === "string")
        entry.failure = area.failure;
      entry.paths.push(...compileList(area.paths ?? [], `${at} paths`));
      entry.content.push(
        ...compileContent(area.content, `${at} content`, area.flags ?? "")
      );
      merged.high.set(area.area, entry);
    }
  }
  if (found === 0)
    throw new Error(`${TIER_FILES[0]} not found (run from the repository root)`);
  for (const entry of merged.high.values())
    if (!entry.failure) throw new Error(`area ${entry.area} states no failure`);
  return { ...merged, high: [...merged.high.values()] };
}

const matches = (list, path) => list.find((p) => p.re.test(path));

/**
 * The tier of a change: `paths` the changed files, `lines` (optional) each file's changed lines
 * (added and removed, without the +/- marker). Returns the tier and every reason for it.
 */
export function classify(config, paths, lines = null) {
  const files = [...new Set(paths.filter(Boolean))].sort();
  const reasons = [];
  for (const file of files) {
    const hard = matches(HARD_HIGH, file);
    if (hard)
      reasons.push({
        tier: "High",
        area: "workflows",
        file,
        why: `hard rule ${hard.pattern}`,
      });
    for (const area of config.high) {
      const hit = matches(area.paths, file);
      if (hit)
        reasons.push({ tier: "High", area: area.area, file, why: `path ${hit.pattern}` });
    }
    if (lines && !matches(config.contentSkip, file)) {
      for (const line of lines.get(file) ?? []) {
        for (const area of config.high) {
          const hit = area.content.find((c) => c.re.test(line));
          if (
            hit &&
            !reasons.some(
              (r) =>
                r.area === area.area && r.file === file && r.why.startsWith("content")
            )
          )
            reasons.push({
              tier: "High",
              area: area.area,
              file,
              why: `content /${hit.pattern}/`,
            });
        }
      }
    }
  }
  if (reasons.length > 0)
    return { tier: "High", files, reasons, contentChecked: !!lines };
  const notLow = files.filter(
    (f) => !matches(config.generated, f) && !matches(config.low, f)
  );
  if (files.length === 0)
    return {
      tier: "Low",
      files,
      reasons: [{ tier: "Low", area: "none", file: "", why: "no changed files" }],
      contentChecked: !!lines,
    };
  if (notLow.length === 0)
    return {
      tier: "Low",
      files,
      reasons: files.map((file) => ({
        tier: "Low",
        area: matches(config.generated, file) ? "generated" : "docs-copy",
        file,
        why: `path ${(matches(config.generated, file) ?? matches(config.low, file)).pattern}`,
      })),
      contentChecked: !!lines,
    };
  return {
    tier: "Medium",
    files,
    reasons: notLow.map((file) => ({
      tier: "Medium",
      area: "product",
      file,
      why: "ordinary product code (no high area, not docs or copy)",
    })),
    contentChecked: !!lines,
  };
}

/**
 * One file's changed lines, from `git diff -U0 <range> -- <file>` output. Everything before the
 * first hunk is the header and is skipped; inside a hunk, a removed SQL comment (`-- note`) is
 * the line `--- note`, a change, not a header.
 */
export function hunkLines(diff) {
  const out = [];
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && (line.startsWith("+") || line.startsWith("-")))
      out.push(line.slice(1));
  }
  return out;
}

const REF = /^[\w./@^~-]+$/;

/**
 * A path git would never print as a plain name: absolute, a `.`/`..`/empty segment, a control
 * character, or git's quoted form (`"…"`, printed when core.quotepath or a special character
 * applies). "docs/../platform/auth/x.ts" would otherwise match docs/** and read as Low.
 */
function refused(p) {
  return (
    p.startsWith("/") ||
    p.startsWith('"') ||
    p.split("/").some((s) => s === ".." || s === "." || s === "") ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(p)
  );
}

function git(args) {
  return execFileSync("git", ["-c", "core.quotepath=off", ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function render(result, format, source) {
  if (format === "json") return `${JSON.stringify({ ...result, source })}\n`;
  const areas = [...new Set(result.reasons.map((r) => r.area))];
  if (format === "markdown") {
    const rows = result.reasons
      .map((r) => `| ${r.area} | \`${r.file || "—"}\` | ${r.why.replace(/\|/g, "\\|")} |`)
      .join("\n");
    return (
      `## Review risk tier: ${result.tier}\n\n` +
      `${result.files.length} changed file(s); ${source}.` +
      `${result.contentChecked ? "" : " Content patterns were not applied (paths only)."}\n\n` +
      `| Area | File | Why |\n| ---- | ---- | --- |\n${rows}\n\n` +
      `What ${result.tier} requires: docs/AI_ENGINEERING.md §4.\n`
    );
  }
  return (
    `tier: ${result.tier}\n` +
    `areas: ${areas.join(", ")}\n` +
    `files: ${result.files.length} (${source}${result.contentChecked ? "" : "; paths only, content not checked"})\n` +
    result.reasons
      .map((r) => `- ${r.tier} ${r.area}: ${r.file || "—"} (${r.why})`)
      .join("\n") +
    "\n"
  );
}

function parseArgs(argv) {
  const opts = { base: null, head: "HEAD", format: "text", patterns: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--base") opts.base = value();
    else if (a === "--head") opts.head = value();
    else if (a === "--format") opts.format = value();
    else if (a === "--patterns") opts.patterns = value();
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!["text", "json", "markdown"].includes(opts.format))
    throw new Error(`--format is text, json or markdown, not ${opts.format}`);
  for (const ref of [opts.base, opts.head])
    if (ref !== null && !REF.test(ref)) throw new Error(`not a git ref: ${ref}`);
  return opts;
}

const USAGE =
  "usage: node scripts/risk-tier.mjs --base <ref> [--head <ref>] [--patterns <dir>] [--format text|json|markdown]\n" +
  "       git diff --name-only --no-renames <base>...<head> | node scripts/risk-tier.mjs [--format …]\n";

export async function main(argv = process.argv.slice(2), stdin = process.stdin) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  let config;
  try {
    config = loadConfig(opts.patterns ?? process.cwd());
  } catch (err) {
    process.stderr.write(`risk-tier: ${err.message}\n`);
    return 2;
  }
  let paths;
  let lines = null;
  let source;
  if (opts.base) {
    const range = `${opts.base}...${opts.head}`;
    try {
      paths = git(["diff", "--name-only", "-z", "--no-renames", range])
        .split("\0")
        .filter(Boolean);
      lines = new Map();
      for (const file of paths)
        if (!refused(file))
          lines.set(
            file,
            hunkLines(
              git([
                "diff",
                "-U0",
                "--no-renames",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--text",
                range,
                "--",
                `:(literal)${file}`,
              ])
            )
          );
    } catch (err) {
      process.stderr.write(
        `risk-tier: git diff ${range} failed: ${err.stderr || err.message}\n`
      );
      return 2;
    }
    source = `git diff ${range}`;
  } else {
    if (stdin.isTTY) {
      process.stderr.write(`risk-tier: no --base and nothing on stdin\n${USAGE}`);
      return 2;
    }
    let text = "";
    for await (const chunk of stdin) text += chunk;
    paths = text
      .split("\n")
      .map((p) => p.replace(/\r$/, ""))
      .filter((p) => p.trim() !== "");
    source = "paths from stdin";
  }
  // A path git would never print is refused, not classified: "docs/../platform/auth/x.ts" would
  // otherwise match docs/** and read as Low.
  const unsafe = paths.filter(refused);
  if (unsafe.length > 0) {
    process.stderr.write(
      `risk-tier: not a repository path: ${JSON.stringify(unsafe[0])}\n`
    );
    return 2;
  }
  process.stdout.write(render(classify(config, paths, lines), opts.format, source));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // exitCode, not exit(): exit() can cut off stdout still being written to a pipe.
  main().then((code) => {
    process.exitCode = code;
  });
}
