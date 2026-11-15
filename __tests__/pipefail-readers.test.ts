/**
 * __tests__/pipefail-readers.test.ts — no pipeline under pipefail reads with a reader that stops early (TASK-218)
 *
 * @guard a pipeline, where pipefail is in force, whose reader can exit before its writer is done (grep -q, head, read, …)
 *
 * Under `set -o pipefail` a pipeline fails when any of its commands does. A reader that stops at
 * its first match or line (`grep -q`, `grep -m`, `grep -l`, a grep whose output is /dev/null —
 * GNU grep then stops at the first match as -q does —, `head`, `sed …q`, `awk` with `exit`
 * outside END, `read`, `true`, `cmp`) closes the pipe while its writer may still be writing; the
 * writer's next write gets SIGPIPE and it exits 141, so the pipeline fails although the reader
 * found what it looked for. Whether it happens depends on how much is still unwritten when the
 * reader exits: a race, not a bug that shows every time. Playform run 43533561700 ("Container
 * image") failed exactly so at `docker logs app 2>&1 | grep -q '^\[shutdown\] database pools:
 * done' || exit 1` with the line in the log; the rerun passed.
 *
 * This scan reads every shell script of the repository and every `run:` step of every workflow
 * (and of every template or composite action: any YAML file with steps), works out where
 * pipefail is in force — `set -o pipefail` / `set -euo pipefail` in the text (until a
 * `set +o pipefail`), or a step whose shell is `bash` (GitHub runs it as
 * `bash --noprofile --norc -eo pipefail {0}`) or names pipefail — and refuses, there, every
 * command in a pipeline's reading position (after a `|`, the last or a middle one) that can exit
 * before reading to the end. It also reads every string literal of the repository's own
 * TypeScript and JavaScript that sets pipefail (a shell string a script or test runs). The fix is
 * one of two: capture the writer's output first and test that (`out=$(…)`, then
 * `grep -q … <<<"$out"` — a here-string is no pipe), or let the reader read to the end
 * (`grep -c`, `sed -n 1p`, `awk 'NR==1'`). Each failure names the file, the line and the reader.
 *
 * Every writer is refused, however little it writes: a shell builtin's one small write lands
 * before the reader can match, but whether a variable stays small is not something a scan can
 * know, and the fixed form costs nothing.
 *
 * Sources: GNU bash manual, "Pipelines" (pipefail: "the return status of a pipeline is the value
 * of the last (rightmost) command to exit with a non-zero status"); POSIX write(2) (EPIPE and
 * SIGPIPE on a pipe with no reader); GNU grep manual, "Usage" (with output to /dev/null grep
 * "can stop after the first match", as with -q); GitHub Docs, "Workflow syntax for GitHub
 * Actions", `jobs.<job_id>.steps[*].shell` (bash: `bash --noprofile --norc -eo pipefail {0}`;
 * unspecified: `bash -e {0}`).
 */
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative, sep } from "path";
import * as ts from "typescript";
import { isMap, isScalar, isSeq, parseDocument, type Node as YamlNode } from "yaml";
import { walkFiles } from "./helpers/repo-files";
import { lexShell, shellScripts } from "./helpers/shell-lex";

const ROOT = join(__dirname, "..");

// ---------------------------------------------------------------------------------------------
// Commands and their place in a pipeline.
// ---------------------------------------------------------------------------------------------

type Tok = { op: string; at: number } | { word: string; at: number; end: number };

/** The lexed code as operators and words (a word keeps its quoted text, via `data`). */
function tokens(code: string, data: Uint8Array): Tok[] {
  const out: Tok[] = [];
  const n = code.length;
  const isData = (k: number) => data[k] === 1;
  const closeAt = (from: number, open: string, close: string) => {
    let depth = 0;
    let k = from;
    for (; k < n; k++) {
      if (isData(k)) continue;
      if (code[k] === open) depth++;
      else if (code[k] === close && --depth === 0) break;
    }
    return k + 1;
  };
  let i = 0;
  while (i < n) {
    const c = code[i];
    if (!isData(i)) {
      if (c === "\\" && code[i + 1] === "\n") {
        i += 2;
        continue;
      }
      if (c === " " || c === "\t" || c === "\r") {
        i += 1;
        continue;
      }
      if (c === "\n") {
        out.push({ op: "\n", at: i });
        i += 1;
        continue;
      }
      const two = code.slice(i, i + 2);
      if (two === "||" || two === "&&" || two === ";;" || two === "|&") {
        out.push({ op: two === "|&" ? "|" : two, at: i });
        i += 2;
        continue;
      }
      if ((two === "$(" || two === "<(" || two === ">(") && code[i + 2] !== "(") {
        out.push({ op: "$(", at: i });
        i += 2;
        continue;
      }
      if (c === "|" || c === ";" || c === "(" || c === ")") {
        out.push({ op: c, at: i });
        i += 1;
        continue;
      }
      if (c === "&" && code[i + 1] !== ">") {
        out.push({ op: ";", at: i });
        i += 1;
        continue;
      }
    }
    // A word: up to a space or an operator that is not quoted.
    const start = i;
    while (i < n) {
      if (isData(i)) {
        i += 1;
        continue;
      }
      const d = code[i];
      if (d === "\\" && code[i + 1] !== "\n") {
        i += 2;
        continue;
      }
      if (d === " " || d === "\t" || d === "\r" || d === "\n") break;
      if (d === "|" || d === ";" || d === "(" || d === ")") break;
      if (d === "&") {
        if (code[i - 1] === ">" || code[i - 1] === "<" || code[i + 1] === ">") {
          i += 1;
          continue;
        }
        break;
      }
      if (code.startsWith("$((", i)) {
        i = closeAt(i + 1, "(", ")");
        continue;
      }
      if (
        code.startsWith("$(", i) ||
        code.startsWith("<(", i) ||
        code.startsWith(">(", i)
      )
        break;
      if (code.startsWith("${", i)) {
        i = closeAt(i + 1, "{", "}");
        continue;
      }
      i += 1;
    }
    if (i === start) {
      i += 1;
      continue;
    }
    const word = code.slice(start, i);
    if (word === "[[" || word === "((") {
      // A test or an arithmetic command: one command, to its close (its | and && are its own).
      const close = word === "[[" ? "]]" : "))";
      let k = i;
      while (k < n && !(code.startsWith(close, k) && !isData(k))) k++;
      out.push({ word, at: start, end: Math.min(k + 2, n) });
      i = Math.min(k + 2, n);
      continue;
    }
    out.push({ word, at: start, end: i });
  }
  return out;
}

/** A simple command: its name, its words as written, where it starts, and whether it reads a pipe. */
export interface PipedCommand {
  name: string;
  args: string[];
  at: number;
  reader: boolean;
}

const KEYWORDS_START = new Set(["if", "then", "else", "elif", "do", "!", "time"]);
const CLOSERS = new Set(["done", "fi", "esac", "}"]);
/** Prefixes before the command's name: [name, how many plain words they take before it]. */
const PREFIX_WORDS: Record<string, number> = {
  env: 0,
  command: 0,
  exec: 0,
  nohup: 0,
  nice: 0,
  sudo: 0,
  builtin: 0,
  timeout: 1,
};
/** Options of a prefix that take the next word. */
const PREFIX_ARG_OPTS: Record<string, Set<string>> = {
  env: new Set(["-u", "-C", "-S"]),
  nice: new Set(["-n"]),
  sudo: new Set(["-u", "-g"]),
  timeout: new Set(["-s", "-k"]),
};

/** Every simple command in a shell text, with whether it reads the previous command's output. */
export function pipedCommands(text: string): PipedCommand[] {
  const { code, data } = lexShell(text);
  const toks = tokens(code, data);
  const found: PipedCommand[] = [];
  type Frame = {
    kind: "subst" | "group" | "brace" | "paren";
    readerNext: boolean;
    atStart: boolean;
    cur: PipedCommand | null;
  };
  const stack: Frame[] = [];
  let readerNext = false;
  let atStart = true;
  let cur: PipedCommand | null = null;
  let lastOp = "\n";
  // case … in: words up to `in` are no command; patterns up to `)` are no command either.
  let caseHead = false;
  let casePattern = false;
  let caseDepth = 0;
  // for/select x in …: the words up to the separator are no command.
  let skipToSep = false;
  // A prefix being read: the words it still takes before the command's name.
  let prefix: { name: string; plain: number; argNext: boolean } | null = null;

  const end = () => {
    cur = null;
    prefix = null;
  };
  for (const t of toks) {
    if ("op" in t) {
      const op = t.op;
      if (op === "\n" && (lastOp === "|" || lastOp === "&&" || lastOp === "||")) continue;
      lastOp = op;
      if (casePattern) {
        if (op === ")") {
          casePattern = false;
          readerNext = false;
          atStart = true;
          end();
        }
        continue;
      }
      if (op === "\n" || op === ";" || op === "&&" || op === "||" || op === ";;") {
        end();
        readerNext = false;
        atStart = true;
        skipToSep = false;
        caseHead = false;
        if (op === ";;" && caseDepth > 0) casePattern = true;
      } else if (op === "|") {
        end();
        readerNext = true;
        atStart = true;
      } else if (op === "$(") {
        stack.push({ kind: "subst", readerNext, atStart, cur });
        cur = null;
        prefix = null;
        readerNext = false;
        atStart = true;
      } else if (op === "(") {
        if (atStart) {
          stack.push({ kind: "group", readerNext, atStart, cur });
          end();
          atStart = true;
        } else stack.push({ kind: "paren", readerNext, atStart, cur });
      } else if (op === ")") {
        const f = stack.pop();
        if (f === undefined) {
          // A case pattern's `)` when the case started outside what is read (no `in` seen).
          end();
          readerNext = false;
          atStart = true;
        } else if (f.kind === "subst") {
          readerNext = f.readerNext;
          atStart = f.atStart;
          cur = f.cur;
        } else if (f.kind === "group") {
          end();
          readerNext = false;
          atStart = false;
        }
      }
      continue;
    }
    lastOp = "";
    const w = t.word;
    const original = text.slice(t.at, t.end);
    if (casePattern) {
      if (w === "esac") {
        casePattern = false;
        caseDepth = Math.max(0, caseDepth - 1);
        end();
        readerNext = false;
        atStart = false;
      }
      continue;
    }
    if (caseHead) {
      if (w === "in") {
        caseHead = false;
        casePattern = true;
      }
      continue;
    }
    if (skipToSep) continue;
    if (!atStart) {
      if (cur !== null) (cur as PipedCommand).args.push(original);
      continue;
    }
    if (prefix !== null) {
      const p = prefix as { name: string; plain: number; argNext: boolean };
      if (p.argNext) {
        p.argNext = false;
        continue;
      }
      if (w.startsWith("-")) {
        p.argNext = PREFIX_ARG_OPTS[p.name]?.has(w) ?? false;
        continue;
      }
      if (p.name === "env" && /^[A-Z_]\w*=/i.test(w)) continue;
      if (p.plain > 0) {
        p.plain -= 1;
        continue;
      }
      prefix = null;
    }
    if (/^[A-Z_]\w*(?:\[[^\]]*\])?\+?=/i.test(w)) continue; // an assignment before the name
    if (KEYWORDS_START.has(w)) {
      if (w !== "!" && w !== "time" && w !== "if") readerNext = false;
      continue;
    }
    if (w === "while" || w === "until") {
      // A loop reading the pipe reads it line by line to its end.
      readerNext = false;
      continue;
    }
    if (w === "case") {
      caseHead = true;
      caseDepth += 1;
      continue;
    }
    if (w === "for" || w === "select") {
      skipToSep = true;
      continue;
    }
    if (w === "function") continue;
    if (w === "{") {
      stack.push({ kind: "brace", readerNext, atStart, cur });
      continue;
    }
    if (CLOSERS.has(w)) {
      if (w === "}" && stack.length > 0 && stack[stack.length - 1].kind === "brace")
        stack.pop();
      if (w === "esac") caseDepth = Math.max(0, caseDepth - 1);
      end();
      readerNext = false;
      atStart = false;
      continue;
    }
    const name = w.replace(/^.*\//, "");
    if (name in PREFIX_WORDS) {
      prefix = { name, plain: PREFIX_WORDS[name], argNext: false };
      continue;
    }
    cur = { name, args: [], at: t.at, reader: readerNext };
    found.push(cur);
    atStart = false;
  }
  return found;
}

/** A quoted word's text: the quotes taken off ('…', "…", $'…'). */
function unquote(word: string): string {
  return word.replace(
    /\$'((?:[^'\\]|\\.)*)'|'([^']*)'|"((?:[^"\\]|\\.)*)"/g,
    (_m, a, b, c) => String(a ?? b ?? c ?? "")
  );
}

/** Short options of a command in a cluster (`-qE` → q, E), up to `--` or the first operand. */
function shortFlags(args: string[], takesArg: Set<string>): string {
  let letters = "";
  for (let k = 0; k < args.length; k++) {
    const a = unquote(args[k]);
    if (a === "--") break;
    if (!/^-[A-Z]/i.test(a) || a.startsWith("--")) continue;
    for (let j = 1; j < a.length; j++) {
      letters += a[j];
      if (takesArg.has(a[j])) {
        if (j === a.length - 1) k += 1;
        break;
      }
    }
  }
  return letters;
}

/** The scripts given to sed or awk: `-e X`, `-f` not readable, else the first operand. */
function programs(args: string[], argOpts: Set<string>, scriptOpt: string): string[] {
  const scripts: string[] = [];
  let operand: string | null = null;
  for (let k = 0; k < args.length; k++) {
    const a = unquote(args[k]);
    if (/^\d*[<>]/.test(a)) continue; // a redirection
    if (a === scriptOpt || a === "--expression") {
      scripts.push(unquote(args[k + 1] ?? ""));
      k += 1;
    } else if (a.startsWith("--expression="))
      scripts.push(a.slice("--expression=".length));
    else if (argOpts.has(a)) k += 1;
    else if (/^-/.test(a)) continue;
    else if (operand === null) operand = a;
  }
  return scripts.length > 0 ? scripts : operand === null ? [] : [operand];
}

/** awk's program without its END blocks (an exit there comes after the whole input is read). */
function withoutEnd(program: string): string {
  let out = program;
  for (;;) {
    const m = /\bEND\s*\{/.exec(out);
    if (!m) return out;
    let depth = 0;
    let k = m.index + m[0].length - 1;
    for (; k < out.length; k++) {
      if (out[k] === "{") depth++;
      else if (out[k] === "}" && --depth === 0) break;
    }
    out = out.slice(0, m.index) + out.slice(k + 1);
  }
}

/** Why a command reading a pipe can exit before its writer is done, or null if it reads to the end. */
export function earlyReader(cmd: PipedCommand): string | null {
  const { name, args } = cmd;
  const plain = args.map(unquote);
  const toDevNull = plain.some(
    (a, k) =>
      /^(?:1|&)?>\/dev\/null$/.test(a) ||
      (/^(?:1|&)?>$/.test(a) && plain[k + 1] === "/dev/null")
  );
  switch (name) {
    case "grep":
    case "egrep":
    case "fgrep":
    case "zgrep": {
      const f = shortFlags(args, new Set(["e", "f", "m", "A", "B", "C", "d", "D"]));
      if (/q/.test(f) || plain.some((a) => a === "--quiet" || a === "--silent"))
        return "`grep -q` stops at its first match";
      if (/m/.test(f) || plain.some((a) => a.startsWith("--max-count")))
        return "`grep -m` stops at its count";
      if (/l/i.test(f) || plain.some((a) => /^--files-with(?:out)?-match/.test(a)))
        return "`grep -l`/`-L` stops at its first match";
      if (toDevNull)
        return "a grep writing to /dev/null stops at its first match (GNU grep), as -q does";
      return null;
    }
    case "head":
      return "`head` stops after its lines or bytes";
    case "sed": {
      const ps = programs(args, new Set(["-f", "--file", "-l"]), "-e");
      return ps.some((p) =>
        /(?:^|[;{}\d$/!\s])q(?:\s*\d+)?\s*(?:[;}\n]|$)/i.test(p.replace(/\\./g, "  "))
      )
        ? "`sed …q` quits before the end"
        : null;
    }
    case "awk":
    case "gawk":
    case "mawk":
    case "nawk": {
      const ps = programs(args, new Set(["-F", "-v", "-f"]), "--source");
      return ps.some((p) => /\bexit\b/.test(withoutEnd(p)))
        ? "`awk` with `exit` outside END stops before the end"
        : null;
    }
    case "read":
      return "`read` takes one line";
    case "mapfile":
    case "readarray":
      return shortFlags(args, new Set(["n", "O", "s", "u", "C", "c", "d"])).includes("n")
        ? "`mapfile -n` stops at its count"
        : null;
    case "true":
    case "false":
    case ":":
      return `\`${name}\` reads nothing`;
    case "cmp":
      return "`cmp` stops at the first difference";
    case "dd":
      return plain.some((a) => a.startsWith("count="))
        ? "`dd count=` stops at its count"
        : null;
    case "sort":
      return /c/i.test(shortFlags(args, new Set(["k", "t", "o", "S", "T"])))
        ? "`sort -c` stops at the first disorder"
        : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Where pipefail is in force.
// ---------------------------------------------------------------------------------------------

/** The offsets of a text from which pipefail is on (true) or off (false), in order. */
export function pipefailSwitches(text: string): { at: number; on: boolean }[] {
  const { code } = lexShell(text);
  const out: { at: number; on: boolean }[] = [];
  const re = /(?<=^|[\s;&|(`!{])set((?:[ \t]+[-+][A-Za-z]*(?:[ \t]+[a-z]+)?)+)/gm;
  for (const m of code.matchAll(re)) {
    const words = m[1].trim().split(/[ \t]+/);
    for (let k = 0; k < words.length; k++) {
      const w = words[k];
      if (/^[-+][A-Za-z]*o$/.test(w) && words[k + 1] === "pipefail")
        out.push({ at: m.index ?? 0, on: w.startsWith("-") });
    }
  }
  return out;
}

/** Every reader that can stop early, in a text, where pipefail is in force. */
export function pipefailProblems(
  label: string,
  text: string,
  options: { pipefailFromStart?: boolean; firstLine?: number } = {}
): string[] {
  const switches = pipefailSwitches(text);
  // pipefail set anywhere and never unset: in force for the whole text (a function defined above
  // the `set` runs after it).
  const everOff = switches.some((s) => !s.on);
  const onAt = (at: number) => {
    if (switches.length > 0 && !everOff) return true;
    let on = options.pipefailFromStart === true;
    for (const s of switches) if (s.at <= at) on = s.on;
    return on;
  };
  const first = options.firstLine ?? 1;
  const out: string[] = [];
  for (const cmd of pipedCommands(text)) {
    if (!cmd.reader || !onAt(cmd.at)) continue;
    const why = earlyReader(cmd);
    if (why === null) continue;
    const line = first + text.slice(0, cmd.at).split("\n").length - 1;
    const shown = [cmd.name, ...cmd.args].join(" ").replace(/\s+/g, " ").slice(0, 80);
    out.push(
      `${label}:${line}: \`${shown}\` reads a pipe under pipefail and ${why}: its writer's SIGPIPE (exit 141) can fail the pipeline — capture the output first (out=$(…), then grep -q … <<<"$out"), or let the reader read to the end`
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// What the repository runs.
// ---------------------------------------------------------------------------------------------

/** One `run:` step of a workflow file: its label, text, first line and whether its shell sets pipefail. */
export interface RunStep {
  label: string;
  text: string;
  firstLine: number;
  pipefailFromStart: boolean;
}

const getIn = (n: YamlNode | null | undefined, key: string): YamlNode | null => {
  if (!isMap(n)) return null;
  const v = n.get(key, true) as YamlNode | undefined;
  return v ?? null;
};
const scalar = (n: YamlNode | null): string | undefined =>
  isScalar(n) && n.value !== null && n.value !== undefined ? String(n.value) : undefined;

/** Every `run:` step of a YAML file with steps (a workflow, a template, a composite action). */
export function runSteps(file: string, source: string): RunStep[] {
  const doc = parseDocument(source);
  const root = doc.contents as YamlNode | null;
  const lineAt = (offset: number) => source.slice(0, offset).split("\n").length;
  const shellOf = (n: YamlNode | null) =>
    scalar(getIn(getIn(getIn(n, "defaults"), "run"), "shell"));
  const out: RunStep[] = [];
  const fromSteps = (
    steps: YamlNode | null,
    where: string,
    inherited: string | undefined
  ) => {
    if (!isSeq(steps)) return;
    steps.items.forEach((s, i) => {
      const run = getIn(s as YamlNode, "run");
      if (!isScalar(run) || typeof run.value !== "string" || !run.range) return;
      const shell = scalar(getIn(s as YamlNode, "shell")) ?? inherited;
      if (shell !== undefined && !/^(?:bash|sh)\b/.test(shell)) return; // pwsh, python: no shell here
      const at = run.range[0];
      const block = /^[|>]/.test(source.slice(at));
      const name =
        scalar(getIn(s as YamlNode, "name")) ?? scalar(getIn(s as YamlNode, "id"));
      out.push({
        label: `${file} ${where} step ${i + 1}${name ? ` "${name}"` : ""}`,
        text: run.value,
        firstLine: lineAt(at) + (block ? 1 : 0),
        pipefailFromStart: shell === "bash" || /pipefail/.test(shell ?? ""),
      });
    });
  };
  const jobs = getIn(root, "jobs");
  if (isMap(jobs))
    for (const item of jobs.items) {
      const id = scalar(item.key as YamlNode) ?? "?";
      const job = item.value as YamlNode;
      fromSteps(getIn(job, "steps"), `job ${id}`, shellOf(job) ?? shellOf(root));
    }
  fromSteps(getIn(getIn(root, "runs"), "steps"), "composite action", undefined);
  return out;
}

/** The shell strings in a TypeScript or JavaScript source that set pipefail (each literal's text). */
export function pipefailLiterals(
  fileName: string,
  source: string
): { text: string; line: number }[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: { text: string; line: number }[] = [];
  const visit = (n: ts.Node) => {
    let text: string | null = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    else if (ts.isTemplateExpression(n))
      text = n.head.text + n.templateSpans.map((s) => "x" + s.literal.text).join("");
    if (text !== null && /pipefail/.test(text)) {
      out.push({ text, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1 });
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** This file: its self-tests' fixtures are the violations it plants. */
const SELF = "__tests__/pipefail-readers.test.ts";

/** Every problem in a repository: its scripts, its workflows' steps, its code's shell strings. */
export function repositoryProblems(root: string): {
  problems: string[];
  scanned: string[];
} {
  const problems: string[] = [];
  const scanned: string[] = [];
  for (const f of shellScripts(root)) {
    scanned.push(f);
    problems.push(...pipefailProblems(f, readFileSync(join(root, f), "utf8")));
  }
  const relOf = (p: string) => relative(root, p).split(sep).join("/");
  for (const p of walkFiles(root, (n) => /\.ya?ml$/.test(n))) {
    const f = relOf(p);
    const source = readFileSync(p, "utf8");
    if (!/^\s*(?:jobs|runs)\s*:/m.test(source)) continue;
    const steps = runSteps(f, source);
    if (steps.length > 0) scanned.push(f);
    for (const s of steps)
      problems.push(
        ...pipefailProblems(f, s.text, {
          pipefailFromStart: s.pipefailFromStart,
          firstLine: s.firstLine,
        }).map((m) => `${m} (${s.label})`)
      );
  }
  for (const p of walkFiles(root, (n) => /\.(?:ts|tsx|mts|cts|mjs|cjs|js)$/.test(n))) {
    const f = relOf(p);
    if (f === SELF) continue;
    const source = readFileSync(p, "utf8");
    if (!source.includes("pipefail")) continue;
    scanned.push(f);
    for (const lit of pipefailLiterals(f, source))
      problems.push(...pipefailProblems(f, lit.text, { firstLine: lit.line }));
  }
  return { problems, scanned };
}

// ---------------------------------------------------------------------------------------------
// The tests.
// ---------------------------------------------------------------------------------------------

describe("no pipeline under pipefail reads with a reader that stops early (TASK-218)", () => {
  it("reads the repository's shell: its scripts and every workflow's run steps", () => {
    const { scanned } = repositoryProblems(ROOT);
    expect(scanned).toEqual(
      expect.arrayContaining([
        "scripts/migration-replay.sh",
        "scripts/pull-base-image.sh",
        ".github/workflows/ci.yml",
      ])
    );
  });

  it("no early reader where pipefail is in force", () => {
    expect(repositoryProblems(ROOT).problems).toEqual([]);
  });
});

describe("the pipefail scan's self-tests (TASK-218)", () => {
  it("[self-test] the race is real: under pipefail a writer outliving `head` fails the pipeline", () => {
    // The writer outlives the reader by far more than a pipe buffer (64 KiB on Linux and macOS),
    // so this is not a race here: grep -q matches line 1 and exits, seq's next write fails.
    const run = (script: string) =>
      spawnSync("bash", ["-c", `set -o pipefail; ${script}; echo "exit $?"`], {
        encoding: "utf8",
      }).stdout.trim();
    expect(run("seq 1 200000 | grep -q '^1$'")).toBe("exit 141");
    expect(
      pipefailProblems("t.sh", "set -o pipefail\nseq 1 200000 | grep -q '^1$'")
    ).toHaveLength(1);
    // The fixed form: the output captured, then tested.
    expect(run("out=$(seq 1 200000); grep -q '^1$' <<<\"$out\"")).toBe("exit 0");
    expect(
      pipefailProblems(
        "t.sh",
        "set -o pipefail\nout=$(seq 1 200000); grep -q '^1$' <<<\"$out\""
      )
    ).toEqual([]);
  });

  it("[self-test] each early reader is refused under pipefail, with its line", () => {
    const cases: [string, RegExp, number][] = [
      ["set -euo pipefail\ndocker logs app 2>&1 | grep -q '^x' || exit 1", /grep -q/, 2],
      ["set -o pipefail\nps | grep -qx foo", /grep -q/, 2],
      ["set -o pipefail\nps | grep --quiet foo", /grep -q/, 2],
      ["set -o pipefail\nps | grep -m1 foo", /grep -m/, 2],
      ["set -o pipefail\nps | grep -l foo", /grep -l/, 2],
      ["set -o pipefail\nps | grep foo >/dev/null", /dev\/null/, 2],
      ["set -o pipefail\nps | grep foo > /dev/null 2>&1", /dev\/null/, 2],
      ["set -o pipefail\nx=$(ls | head -n 1)", /head/, 2],
      ["set -o pipefail\nls | head -1 | tr a b", /head/, 2],
      ["set -o pipefail\nls | sed 1q", /sed/, 2],
      ["set -o pipefail\nls | sed -n '/x/{p;q}'", /sed/, 2],
      ["set -o pipefail\nls | awk '{print; exit}'", /awk/, 2],
      ["set -o pipefail\nls | read -r first", /read/, 2],
      ["set -o pipefail\nls | true", /reads nothing/, 2],
      ["set -o pipefail\nls | cmp -s - file", /cmp/, 2],
      ["set -o pipefail\nif psql -c 1 | grep -q 1; then :; fi", /grep -q/, 2],
      ["set -o pipefail\n{ a; b; } | grep -q x", /grep -q/, 2],
      ["set -o pipefail\nfor x in a; do echo; done | head -1", /head/, 2],
      ['set -o pipefail\nv="$(ls | head -1)"', /head/, 2],
      ["set -o pipefail\nls |\n  grep -q x", /grep -q/, 3],
      ["set -o pipefail\nenv -u CI ls | env LC_ALL=C grep -q x", /grep -q/, 2],
      ["f() { ls | grep -q x; }\nset -o pipefail\nf", /grep -q/, 1],
    ];
    for (const [text, re, line] of cases) {
      const found = pipefailProblems("t.sh", text);
      expect([text, found.length]).toEqual([text, 1]);
      expect(found[0]).toMatch(re);
      expect([text, found[0].split(":")[1]]).toEqual([text, String(line)]);
    }
  });

  it("[self-test] what reads to the end, or runs without pipefail, is not refused", () => {
    const fine = [
      "set -o pipefail\nout=$(docker logs app 2>&1)\ngrep -q '^x' <<<\"$out\"",
      "set -o pipefail\nls | grep -c x",
      "set -o pipefail\nls | grep x | wc -l",
      "set -o pipefail\nls | sed -n 1p",
      "set -o pipefail\nls | sed 's/q/x/g'",
      "set -o pipefail\nls | awk 'NR==1'",
      "set -o pipefail\nls | awk '{n++} END {exit n == 0}'",
      "set -o pipefail\nls | tail -n 200",
      'set -o pipefail\nls | while read -r l; do echo "$l"; done',
      "set -o pipefail\ngrep -q x file",
      "set -o pipefail\nhead -n 1 file",
      'set -o pipefail\nread -r a b <<<"$x"',
      "set -o pipefail\n[[ $x =~ a|b ]] && head -1 f",
      "set -o pipefail\ncase $x in true|false) head -1 f;; esac",
      "set -o pipefail\necho 'a | grep -q b'",
      "set -o pipefail\nls || head -1 f",
      "ls | grep -q x",
      "set -o pipefail\nset +o pipefail\nls | grep -q x",
      "set -o pipefail\nx=$(cat <<'EOF'\nls | head -1\nEOF\n)",
    ];
    for (const text of fine)
      expect([text, pipefailProblems("t.sh", text)]).toEqual([text, []]);
  });

  it("[self-test] a step whose shell is bash runs under pipefail; one with no shell, only if it sets it", () => {
    const wf = [
      "on: push",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-24.04",
      "    steps:",
      "      - name: Explicit bash",
      "        shell: bash",
      "        run: |",
      "          echo start",
      "          docker logs app | grep -q done",
      "      - name: Default shell",
      "        run: docker logs app | grep -q done",
      "      - name: Sets it",
      "        run: |",
      "          set -euo pipefail",
      "          docker logs app | head -n 1",
      "  b:",
      "    runs-on: ubuntu-24.04",
      "    defaults:",
      "      run:",
      "        shell: bash",
      "    steps:",
      "      - run: docker logs app | grep -q done",
      "",
    ].join("\n");
    const steps = runSteps("w.yml", wf);
    expect(steps.map((s) => [s.pipefailFromStart, s.firstLine])).toEqual([
      [true, 9],
      [false, 12],
      [false, 15],
      [true, 23],
    ]);
    const found = steps.flatMap((s) =>
      pipefailProblems("w.yml", s.text, {
        pipefailFromStart: s.pipefailFromStart,
        firstLine: s.firstLine,
      })
    );
    expect(found.map((m) => m.split(":")[1])).toEqual(["10", "16", "23"]);
  });

  it("[self-test] a shell string in code that sets pipefail is read; one that does not is not", () => {
    const src = [
      'spawnSync("bash", ["-c", "set -o pipefail; ls | grep -q x"]);',
      'spawnSync("bash", ["-c", "ls | grep -q x"]);',
      "const s = `set -euo pipefail\\nps | head -1 ${y}`;",
    ].join("\n");
    const lits = pipefailLiterals("x.ts", src);
    expect(lits.map((l) => l.line)).toEqual([1, 3]);
    expect(
      lits.flatMap((l) => pipefailProblems("x.ts", l.text, { firstLine: l.line }))
    ).toEqual([
      expect.stringMatching(/^x\.ts:1: .*grep -q/),
      expect.stringMatching(/^x\.ts:4: .*head/),
    ]);
  });

  it("[self-test] the whole scan finds a planted script and workflow step in a scratch repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "pipefail-"));
    try {
      mkdirSync(join(dir, "scripts"));
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(dir, "scripts", "a.sh"),
        "#!/usr/bin/env bash\nset -euo pipefail\npsql -c 1 | grep -q 1\n"
      );
      writeFileSync(
        join(dir, ".github", "workflows", "w.yml"),
        "on: push\njobs:\n  j:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: |\n          set -euo pipefail\n          pg_lsclusters | grep -q .\n"
      );
      const { problems } = repositoryProblems(dir);
      expect(problems).toEqual([
        expect.stringMatching(/^scripts\/a\.sh:3: /),
        expect.stringMatching(
          /^\.github\/workflows\/w\.yml:8: .*\(\.github\/workflows\/w\.yml job j step 1\)$/
        ),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
