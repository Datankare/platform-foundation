/**
 * __tests__/shell-portability.test.ts — the shell the tests run works on macOS (TASK-213, T-1)
 *
 * @guard a shell script, or a workflow step a test runs, that macOS's bash 3.2 or BSD tools cannot run
 *
 * The owner runs every commit script on a Mac, and its test step is `npm test`. macOS ships bash
 * 3.2.57 as /bin/bash (GPLv2; Apple has never moved it) and BSD versions of sed, grep, date, stat,
 * readlink, sort, head, xargs and base64. On 2026-11-10 the 55d script failed there: the sync
 * guard used `case` inside `$( )`, which bash 3.2 cannot parse — it finds the end of a command
 * substitution by counting parentheses, so a case pattern's `)` ends it early. Every gate had run
 * on Linux (bash 5, GNU tools), so nothing caught it.
 *
 * This scan reads every shell script in the repository (`*.sh`, `*.bash`, and any file whose first
 * line is a bash or sh shebang) and every workflow `run:` step a Jest test executes, and refuses:
 *
 *   - bash 3.2's parser: `case` inside `$( )`, and a comment inside `$( )` (a quote or a
 *     parenthesis in it derails the same paren-counting scan);
 *   - bash 4 and later: `mapfile`/`readarray`, `coproc`, `declare`/`local`/`typeset` with `-A`
 *     (associative arrays), `-n` (namerefs), `-g`, `-l` or `-u`; `${x,,}` `${x^^}` (case
 *     modification), `${x@Q}` (transformations), `${a[-1]}` and `${x:0:-1}` (negative subscripts
 *     and lengths), `|&`, `&>>`, `;;&` and `;&`, `[[ -v name ]]`, `wait -n`, `$EPOCHSECONDS`,
 *     `$EPOCHREALTIME`, `$BASHPID`, `$SRANDOM`, `$BASH_ARGV0`, and the shopt options bash 3.2 lacks
 *     (`globstar`, `lastpipe`, `inherit_errexit` and the rest);
 *   - under `set -u`, an array expanded bare (`"${a[@]}"`): bash before 4.4 calls an empty array
 *     unbound and exits. Write `${a[@]+"${a[@]}"}`, or let every assignment give it an element
 *     (`a=(HEAD)`, `a=("$x")`, then only `a+=(…)`);
 *   - GNU-only options: `sed -i` without a suffix (BSD reads the next word as the suffix; write
 *     `-i.bak` and remove the copy), `grep -P`, `date -d`/`--date`, `readlink -f`/`-e`/`-m`,
 *     `stat -c`/`--format`, `sort -V`, `head -n -N`/`-c -N`, `xargs -r`, `base64 -w`, `find -printf`
 *     and `-regextype`; and the GNU tools macOS does not have: `timeout`, `tac`, `nproc`,
 *     `stdbuf`, `numfmt`.
 *
 * Which workflow steps a test executes is listed below (`EXECUTED_STEPS`, by test file); every test
 * file that runs `bash -c` or `sh -c` with a string that is not written in the call must have its
 * entry, and a literal one is scanned where it stands. A file that runs a shell string any other
 * way (`execSync`, `exec`, `shell: true`) is refused. Each failure names the file, the line and
 * what to write instead.
 *
 * A static scan is a floor, not proof: the macOS workflow (`.github/workflows/macos.yml`) runs
 * `npm test` on macOS with the tests' `bash` resolved to /bin/bash, and with REQUIRE_BASH_3_2=1
 * the last test here fails unless that is so. A script a test writes at run time (a stub `gh`) is
 * not a repository file; that run is its check.
 *
 * Sources: GNU bash NEWS and CHANGES (bash-4.0 to bash-5.2: the features above, with the version
 * each arrived in; bash-4.0 "the parser now understands complete commands inside $( )"); Apple's
 * macOS manual pages for sed(1), grep(1), date(1), stat(1), readlink(1), sort(1), head(1),
 * xargs(1), base64(1) and find(1); the runner image list (actions/runner-images, "macOS 26 Arm64":
 * Bash 3.2.57).
 */
import { spawnSync } from "child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "fs";
import { join, relative, sep } from "path";
import { parseDocument } from "yaml";
import { walkFiles } from "./helpers/repo-files";

const ROOT = join(__dirname, "..");
// ---------------------------------------------------------------------------------------------
// The lexer: the code bash runs, with what is only data blanked out.
// ---------------------------------------------------------------------------------------------

export interface Lexed {
  /** The text, same length, with comments, quoted literal text and here-document bodies blanked. */
  code: string;
  /** 1 at each offset inside a command substitution `$( )` (or backticks inside one). */
  inSubst: Uint8Array;
  /** Each comment: its offset and whether it sits inside a command substitution. */
  comments: { at: number; inSubst: boolean }[];
}

type Frame = { kind: "root" | "subst" | "arith" | "bt" | "dq"; depth: number };

const WORD_START = /[\s;&|()`!{}]/;

/** Reads shell text as bash's parser would, far enough to tell code from data. */
export function lexShell(text: string): Lexed {
  const out = text.split("");
  const inSubst = new Uint8Array(text.length);
  const comments: Lexed["comments"] = [];
  const stack: Frame[] = [{ kind: "root", depth: 0 }];
  const pending: { delim: string; strip: boolean }[] = [];
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const substDepth = () => stack.filter((f) => f.kind === "subst").length;
  let i = 0;
  while (i < text.length) {
    const top = stack[stack.length - 1];
    const c = text[i];
    const mark = (n: number) => {
      const s = substDepth() > 0 ? 1 : 0;
      for (let k = i; k < i + n && k < text.length; k++) inSubst[k] = s;
    };
    if (top.kind === "dq") {
      mark(1);
      if (c === "\\") {
        blank(i, i + 2);
        i += 2;
      } else if (c === '"') {
        stack.pop();
        i += 1;
      } else if (text.startsWith("$((", i)) {
        stack.push({ kind: "arith", depth: 0 });
        i += 3;
      } else if (text.startsWith("$(", i)) {
        stack.push({ kind: "subst", depth: 0 });
        i += 2;
      } else if (c === "`") {
        stack.push({ kind: "bt", depth: 0 });
        i += 1;
      } else if (text.startsWith("${", i)) {
        // A parameter expansion is kept whole (its operators are what the checks read).
        let depth = 0;
        let k = i;
        for (; k < text.length; k++) {
          if (text[k] === "{") depth++;
          else if (text[k] === "}" && --depth === 0) break;
        }
        mark(k + 1 - i);
        i = k + 1;
      } else if (c === "$") {
        // A parameter ($name, $1, $@ …) is kept: the checks read it.
        const m = /^\$(?:[A-Z_]\w*|[0-9@*#?$!-])/i.exec(text.slice(i));
        const n = m ? m[0].length : 1;
        mark(n);
        i += n;
      } else {
        blank(i, i + 1);
        i += 1;
      }
      continue;
    }
    // Code: the root, a command substitution, arithmetic or backticks.
    mark(1);
    const prev = i === 0 ? "\n" : text[i - 1];
    if (c === "\\") {
      mark(2);
      i += 2;
    } else if (c === "#" && (i === 0 || WORD_START.test(prev)) && top.kind !== "arith") {
      let k = text.indexOf("\n", i);
      if (k === -1) k = text.length;
      comments.push({ at: i, inSubst: substDepth() > 0 });
      blank(i, k);
      i = k;
    } else if (c === "'") {
      let k = text.indexOf("'", i + 1);
      if (k === -1) k = text.length;
      blank(i + 1, k);
      mark(k + 1 - i);
      i = k + 1;
    } else if (c === "$" && text[i + 1] === "'") {
      let k = i + 2;
      while (k < text.length && text[k] !== "'") k += text[k] === "\\" ? 2 : 1;
      blank(i + 2, k);
      mark(k + 1 - i);
      i = k + 1;
    } else if (c === '"') {
      stack.push({ kind: "dq", depth: 0 });
      i += 1;
    } else if (text.startsWith("$((", i)) {
      stack.push({ kind: "arith", depth: 0 });
      i += 3;
    } else if (text.startsWith("$(", i)) {
      stack.push({ kind: "subst", depth: 0 });
      mark(2);
      i += 2;
    } else if (c === "`") {
      if (top.kind === "bt") stack.pop();
      else stack.push({ kind: "bt", depth: 0 });
      i += 1;
    } else if (c === "(" && (top.kind === "subst" || top.kind === "arith")) {
      top.depth++;
      i += 1;
    } else if (c === ")" && (top.kind === "subst" || top.kind === "arith")) {
      if (top.depth === 0) stack.pop();
      else top.depth--;
      i += 1;
    } else if (text.startsWith("<<<", i)) {
      // A here-string: one word, not a here-document.
      i += 3;
    } else if (text.startsWith("<<", i) && top.kind !== "arith") {
      const m = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|\\?([A-Z_]\w*))/i.exec(text.slice(i));
      if (m) pending.push({ delim: m[2] ?? m[3] ?? m[4], strip: m[1] === "-" });
      i += 2;
    } else if (c === "\n" && pending.length > 0) {
      i += 1;
      for (const h of pending.splice(0)) {
        while (i < text.length) {
          let end = text.indexOf("\n", i);
          if (end === -1) end = text.length;
          const line = text.slice(i, end);
          blank(i, end);
          i = end + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        }
      }
    } else {
      i += 1;
    }
  }
  return { code: out.join(""), inSubst, comments };
}

// ---------------------------------------------------------------------------------------------
// The checks.
// ---------------------------------------------------------------------------------------------

const lineOf = (text: string, at: number) => text.slice(0, at).split("\n").length;

/** bash 4+ syntax, as [pattern, what it is, what to write]. Matched against the lexed code. */
const BASH4: [RegExp, string, string][] = [
  [
    /(?<=^|[\s;&|(`!{])(mapfile|readarray)(?=\s|$)/gm,
    "mapfile/readarray (bash 4.0)",
    "read the lines in a `while IFS= read -r` loop",
  ],
  [/(?<=^|[\s;&|(`!{])coproc(?=\s)/gm, "coproc (bash 4.0)", "use a named pipe or a file"],
  [
    /(?<=^|[\s;&|(`!{])(?:declare|local|typeset)\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*[Agnlu]/gm,
    "declare/local -A, -n, -g, -l or -u (bash 4.0–4.3)",
    "use indexed arrays, a plain variable, or tr for case",
  ],
  [
    /\$\{[#!]?[A-Z_]\w*(?:\[[^\]]*\])?(?:\^\^?|,,?)/gi,
    "${x,,} / ${x^^} case modification (bash 4.0)",
    "pipe through tr '[:upper:]' '[:lower:]'",
  ],
  [
    /\$\{[A-Za-z_]\w*(?:\[[^\]]*\])?@[QEPAaKkUuL]\}/g,
    "${x@Q} transformation (bash 4.4)",
    "use printf %q",
  ],
  [
    /\$\{[A-Z_]\w*\[\s*-\s*\d/gi,
    "a negative array subscript (bash 4.3)",
    "index from the length: ${a[${#a[@]}-1]}",
  ],
  [
    /\$\{[A-Z_]\w*(?:\[[^\]]*\])?:[^:}]*:\s*-/gi,
    "a negative substring length (bash 4.2)",
    "compute the length: ${x:0:${#x}-1}",
  ],
  [/\|&/g, "|& (bash 4.0)", "write 2>&1 |"],
  [/&>>/g, "&>> (bash 4.0)", "write >> file 2>&1"],
  [/;;&|(?<!;);&/g, ";;& or ;& in a case (bash 4.0)", "repeat the commands, or use if"],
  [/\[\[\s+(?:!\s+)?-v\s/g, "[[ -v name ]] (bash 4.2)", 'write [ -n "${name+x}" ]'],
  [
    /(?<=^|[\s;&|(`!{])wait\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*n/gm,
    "wait -n (bash 4.3)",
    "wait for each pid in turn",
  ],
  [
    /\$\{?(?:EPOCHSECONDS|EPOCHREALTIME|BASHPID|SRANDOM|BASH_ARGV0)\b/g,
    "a variable bash 3.2 does not set ($EPOCHSECONDS, $EPOCHREALTIME, $BASHPID, $SRANDOM, $BASH_ARGV0)",
    "use date +%s, or $$",
  ],
  [
    /(?<=^|[\s;&|(`!{])shopt\s+-s\s+(?:[^\s&;|][^;&|\n]*)?\b(?:globstar|lastpipe|autocd|checkjobs|dirspell|direxpand|inherit_errexit|localvar_inherit|localvar_unset|assoc_expand_once|globasciiranges|complete_fullquote|patsub_replacement|varredir_close|noexpand_translation|globskipdots)\b/gm,
    "a shopt option bash 3.2 does not have",
    "write it out without the option",
  ],
];

/** GNU tools macOS does not ship. */
const NOT_ON_MACOS = new Set(["timeout", "tac", "nproc", "stdbuf", "numfmt"]);

/** Prefixes before a command's name; each one's options are skipped. */
const PREFIXES = new Set([
  "sudo",
  "env",
  "command",
  "exec",
  "time",
  "nohup",
  "nice",
  "!",
]);
/** xargs options that take an argument. */
const XARGS_ARG = new Set(["-I", "-n", "-P", "-L", "-s", "-E", "-d", "-a"]);

/** The simple commands in lexed code: each command's name and its words. */
function commands(code: string): { name: string; args: string[]; at: number }[] {
  const flat = code.replace(/\\\n/g, "  ");
  const found: { name: string; args: string[]; at: number }[] = [];
  const re = /[^;&|\n(){}`]+/g;
  for (let m = re.exec(flat); m; m = re.exec(flat)) {
    const raw = m[0].replace(/^\$/, "");
    let words = raw.trim().split(/\s+/).filter(Boolean);
    const at = m.index + m[0].search(/\S|$/);
    while (words.length > 0) {
      while (words.length > 0 && /^[A-Z_]\w*(?:\[[^\]]*\])?\+?=/i.test(words[0]))
        words = words.slice(1);
      if (words.length === 0) break;
      const name = words[0].replace(/^.*\//, "");
      if (PREFIXES.has(name)) {
        let k = 1;
        while (k < words.length && (words[k].startsWith("-") || /=/.test(words[k]))) k++;
        words = words.slice(k);
        continue;
      }
      if (name === "xargs") {
        let k = 1;
        while (k < words.length && words[k].startsWith("-")) {
          k += XARGS_ARG.has(words[k]) ? 2 : 1;
        }
        found.push({ name, args: words.slice(1, k), at });
        words = words.slice(k);
        continue;
      }
      found.push({ name, args: words.slice(1), at });
      break;
    }
  }
  return found;
}

/** A GNU-only use of a command, or null. */
function gnuOnly(name: string, args: string[]): string | null {
  const cluster = (letters: RegExp) =>
    args.some(
      (a) => /^-[A-Z0-9]+/i.test(a) && !a.startsWith("--") && letters.test(a.slice(1))
    );
  const long = (re: RegExp) => args.some((a) => re.test(a));
  if (NOT_ON_MACOS.has(name)) return `\`${name}\` is a GNU tool macOS does not have`;
  switch (name) {
    case "sed":
      if (args.some((a) => /^-[A-Za-z]*i(?:''|"")?$/.test(a)) || long(/^--in-place/))
        return "`sed -i` without a suffix (BSD sed takes the next word as the suffix): write `sed -i.bak … && rm -f file.bak`";
      return null;
    case "grep":
      if (cluster(/^[A-Za-z]*P/) || long(/^--perl-regexp/))
        return "`grep -P` (BSD grep has no Perl regexps): use `grep -E`";
      return null;
    case "date":
      if (cluster(/^[A-Za-z]*d/) || long(/^--date/))
        return "`date -d` (GNU): BSD date reads a date with `-j -f`; or compute it in node";
      return null;
    case "readlink":
      if (cluster(/[fem]/) || long(/^--canonicalize/))
        return '`readlink -f` (GNU): use `cd "$(dirname …)" && pwd -P`';
      return null;
    case "stat":
      if (cluster(/^[A-Za-z]*c/) || long(/^--(?:format|printf)/))
        return "`stat -c` (GNU): BSD stat formats with `-f`; or use `wc -c`, `ls` or node";
      return null;
    case "sort":
      if (cluster(/^[A-Za-z]*V/) || long(/^--version-sort/))
        return "`sort -V` (GNU): compare the fields numerically (`sort -t. -k1,1n -k2,2n -k3,3n`)";
      return null;
    case "head":
      if (
        args.some((a, k) => /^-[nc]$/.test(a) && /^-\d/.test(args[k + 1] ?? "")) ||
        args.some((a) => /^-[nc]-\d/.test(a)) ||
        long(/^--(?:lines|bytes)=-/)
      )
        return "`head -n -N` (GNU: all but the last N): use `sed '$d'` or awk";
      return null;
    case "xargs":
      if (cluster(/r/) || long(/^--no-run-if-empty/))
        return "`xargs -r` (GNU): test for empty input first (BSD xargs already runs nothing on none)";
      return null;
    case "base64":
      if (cluster(/^[A-Za-z]*w/) || long(/^--wrap/))
        return "`base64 -w` (GNU): BSD base64 does not wrap by default; pipe through `tr -d '\\n'`";
      return null;
    case "find":
      if (args.some((a) => a === "-printf" || a === "-fprintf" || a === "-regextype"))
        return "`find -printf`/`-regextype` (GNU): use `-exec` or `-print` and a pipe";
      return null;
    default:
      return null;
  }
}

/** Arrays a script can show to be never empty: every assignment gives an element, none clears. */
function neverEmpty(code: string, name: string): boolean {
  const n = name.replace(/[$^.*+?()[\]{}|\\]/g, "\\$&");
  const before = "(?:^|[\\s;&|(])";
  if (
    new RegExp(
      `${before}(?:unset\\s+(?:-v\\s+)?${n}\\b|read\\s+[^;&|\\n]*-a\\s*${n}\\b)`,
      "m"
    ).test(code)
  )
    return false;
  if (
    new RegExp(
      `${before}(?:declare|local|typeset)\\s+(?:-[a-zA-Z]+\\s+)*${n}(?=\\s|;|$)`,
      "m"
    ).test(code)
  )
    return false;
  const sets = [...code.matchAll(new RegExp(`${before}${n}=\\(([^)]*)\\)`, "gm"))];
  if (sets.length === 0) return false;
  return sets.every((m) => {
    const words = m[1].trim();
    if (words.startsWith('"')) {
      // A double-quoted word is one element, unless it expands a list ("$@", "${a[@]}").
      const end = words.indexOf('"', 1);
      return end > 0 && !/\$@|\$\*|\[[@*]\]/.test(words.slice(0, end + 1));
    }
    return /^[\w./:=%+,-]+(?=\s|$)/.test(words);
  });
}

/** Every problem in one shell text, as `<label>:<line>: <what> — <what to write>`. */
export function shellProblems(label: string, text: string): string[] {
  const { code, inSubst, comments } = lexShell(text);
  const out: string[] = [];
  const at = (offset: number, what: string) =>
    out.push(`${label}:${lineOf(text, offset)}: ${what}`);

  for (const m of code.matchAll(/(?<=^|[\s;&|(`!{])case(?=\s)/gm)) {
    const offset = m.index ?? 0;
    if (inSubst[offset])
      at(
        offset,
        "`case` inside `$( )` — bash 3.2 cannot parse its `)`: compute it outside, or use if/[[ ]]"
      );
  }
  for (const c of comments)
    if (c.inSubst)
      at(
        c.at,
        "a comment inside `$( )` — bash 3.2 cannot parse a quote or `)` in it: move it above the line"
      );
  for (const [re, what, instead] of BASH4)
    for (const m of code.matchAll(re))
      at(m.index ?? 0, `${what} — macOS has bash 3.2: ${instead}`);

  if (/(?:^|[\s;&|(])set\s+(?:-[A-Za-tv-z]*u[A-Za-z]*|-o\s+nounset)\b/m.test(code)) {
    // The guarded form `${a[@]+"${a[@]}"}` (or `:+`) is safe: blank it before looking.
    let scan = code;
    for (const g of code.matchAll(/\$\{[A-Z_]\w*\[[@*]\]:?\+/gi)) {
      let depth = 0;
      let k = g.index ?? 0;
      for (; k < scan.length; k++) {
        if (scan[k] === "{") depth++;
        else if (scan[k] === "}" && --depth === 0) break;
      }
      scan =
        scan.slice(0, g.index) + " ".repeat(k + 1 - (g.index ?? 0)) + scan.slice(k + 1);
    }
    for (const m of scan.matchAll(/\$\{([A-Z_]\w*)\[[@*]\]\}/gi))
      if (!neverEmpty(code, m[1])) {
        const bare = "$" + "{" + m[1] + "[@]}";
        const guarded = "$" + "{" + m[1] + '[@]+"' + bare + '"}';
        at(
          m.index ?? 0,
          `"${bare}" under set -u — bash before 4.4 exits on an empty array: write ${guarded}`
        );
      }
  }

  for (const cmd of commands(code)) {
    const problem = gnuOnly(cmd.name, cmd.args);
    if (problem) at(cmd.at, problem);
  }
  return out.sort((a, b) => Number(a.split(":")[1]) - Number(b.split(":")[1]));
}

// ---------------------------------------------------------------------------------------------
// What the repository runs.
// ---------------------------------------------------------------------------------------------

/** A workflow step a test executes: its workflow file, and its name or id. */
export interface ExecutedStep {
  workflow: string;
  name?: string;
  id?: string;
  /** An app's copy of a template: absent from platform-foundation. */
  appCopy?: boolean;
}

/**
 * The workflow steps each test file executes with `bash -c`. A test file that runs a step must be
 * listed here (the completeness test below), and each entry must name a step that exists.
 */
export const EXECUTED_STEPS: Record<string, ExecutedStep[]> = {
  "__tests__/workflow-hygiene.test.ts": [
    {
      workflow: "docs/templates/sync-from-foundation.yml",
      name: "Close sync pull requests that would roll back",
    },
    {
      workflow: "docs/templates/sync-from-foundation.yml",
      name: "Open the pull request",
    },
    {
      workflow: ".github/workflows/sync-from-foundation.yml",
      name: "Close sync pull requests that would roll back",
      appCopy: true,
    },
    {
      workflow: ".github/workflows/sync-from-foundation.yml",
      name: "Open the pull request",
      appCopy: true,
    },
  ],
  "__tests__/live-and-e2e-gates.test.ts": [
    {
      workflow: ".github/workflows/ci.yml",
      name: "Layer 3 — The key the translation journeys need",
    },
    { workflow: ".github/workflows/deploy-smoke.yml", id: "secrets" },
  ],
};

interface Step {
  name?: string;
  id?: string;
  run?: string;
}

/** The step a reference names, with its run text, or null. */
export function findStep(root: string, ref: ExecutedStep): Step | null {
  const p = join(root, ref.workflow);
  if (!existsSync(p)) return null;
  const wf = parseDocument(readFileSync(p, "utf8")).toJS() as {
    jobs?: Record<string, { steps?: Step[] }>;
  };
  for (const job of Object.values(wf.jobs ?? {}))
    for (const s of job.steps ?? [])
      if (
        (ref.name !== undefined && s.name === ref.name) ||
        (ref.id !== undefined && s.id === ref.id)
      )
        return s;
  return null;
}

/** Every shell script of the repository: `*.sh`, `*.bash`, or an extensionless file with a shell shebang. */
export function shellScripts(root: string): string[] {
  const shebang = (p: string) => {
    const fd = openSync(p, "r");
    try {
      const buf = Buffer.alloc(64);
      const n = readSync(fd, buf, 0, 64, 0);
      return /^#!\s*(?:\/usr\/bin\/env\s+)?(?:\/(?:usr\/)?bin\/)?(?:ba)?sh\b/.test(
        buf.subarray(0, n).toString("utf8")
      );
    } finally {
      closeSync(fd);
    }
  };
  return walkFiles(root, (n) => /\.(?:sh|bash)$/.test(n) || !n.includes("."))
    .filter((p) => /\.(?:sh|bash)$/.test(p) || shebang(p))
    .map((p) => relative(root, p).split(sep).join("/"))
    .sort();
}

/** The repository's test sources: test files, their helpers and fixtures' scripts under `__tests__/`. */
export function testSources(root: string): string[] {
  return walkFiles(root, (n) => /\.(?:ts|tsx|mjs|cjs|js)$/.test(n))
    .filter((p) => /[\\/]__tests__[\\/]/.test(p))
    .map((p) => relative(root, p).split(sep).join("/"))
    .sort();
}

/** How a test source runs a shell, as found in its text. */
export interface ShellUse {
  /** It spawns bash or sh at all (a script or a string). */
  runsShell: boolean;
  /** `bash -c` / `sh -c` strings written in the call, to scan where they stand. */
  literals: string[];
  /** It runs `-c` with a string it builds (a workflow step): it must be in EXECUTED_STEPS. */
  dynamic: boolean;
  /** It runs a shell string another way (`execSync`, `exec`, `shell: true`). */
  other: string[];
}

const SPAWN =
  /\b(?:spawnSync|spawn|execFileSync|execFile)\(\s*["'`](?:\/bin\/)?(?:ba)?sh["'`]/;
const DASH_C =
  /\b(?:spawnSync|spawn|execFileSync|execFile)\(\s*["'`](?:\/bin\/)?(?:ba)?sh["'`]\s*,\s*\[\s*["']-c["']\s*,\s*/g;

export function shellUse(text: string): ShellUse {
  const literals: string[] = [];
  let dynamic = false;
  for (const m of text.matchAll(DASH_C)) {
    const rest = text.slice((m.index ?? 0) + m[0].length);
    const lit =
      /^(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`)\s*[,\]]/.exec(
        rest
      );
    if (lit) literals.push((lit[1] ?? lit[2] ?? lit[3]).replace(/\$\{[^}]*\}/g, "x"));
    else dynamic = true;
  }
  const other: string[] = [];
  if (/\bexecSync\(/.test(text)) other.push("execSync");
  if (/(?<![.\w])exec\(\s*[`"']/.test(text)) other.push("exec");
  if (/\bshell:\s*(?:true|["'`])/.test(text)) other.push("shell: true");
  return { runsShell: SPAWN.test(text) || literals.length > 0, literals, dynamic, other };
}

/** A JavaScript string literal's value ("…" or '…'), its escapes read. */
function stringValue(lit: string): string {
  return lit
    .slice(1, -1)
    .replace(/\\(?:[ntr]|(.))/g, (m: string, c?: string) =>
      m === "\\n" ? "\n" : m === "\\t" ? "\t" : m === "\\r" ? "\r" : (c ?? "")
    );
}

const SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+)?(?:\/(?:usr\/)?bin\/)?(?:ba)?sh\b/;
const STRING_ALT = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'`;
const STRING_LIT = `(?:${STRING_ALT})`;

/**
 * The shell scripts a test source writes at run time (a stub `gh`, `git`, `curl`): a template
 * literal, or an array of string literals joined with "\n", whose text starts with a bash or sh
 * shebang. A `${…}` in a template is read as a plain word. They run where the tests run — on the
 * owner's Mac under its bash — so they are held to the same list.
 */
export function writtenScripts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`(#![^`]*)`/g))
    if (SHEBANG.test(m[1]))
      out.push(
        stringValue(`"${m[1].replace(/\$\{[^}]*\}/g, "x")}"`.replace(/\n/g, "\\n"))
      );
  const arrays = new RegExp(
    String.raw`\[\s*(${STRING_LIT}(?:\s*,\s*${STRING_LIT})*)(?:\s*,)?\s*\]\s*\.join\(\s*"\\n"\s*\)`,
    "g"
  );
  for (const m of text.matchAll(arrays)) {
    const lines = [...m[1].matchAll(new RegExp(STRING_ALT, "g"))].map((e) =>
      stringValue(e[0])
    );
    if (lines.length > 0 && SHEBANG.test(lines[0])) out.push(lines.join("\n"));
  }
  return out;
}

/** Problems in the macOS workflow, as messages (`file` is its path, for the messages). */
export function macosWorkflowProblems(
  file: string,
  text: string,
  mustTrigger: string[]
): string[] {
  const out: string[] = [];
  const wf = parseDocument(text).toJS() as {
    on?: { push?: { paths?: string[]; branches?: string[] } };
    jobs?: Record<
      string,
      { "runs-on"?: unknown; env?: Record<string, unknown>; steps?: Step[] }
    >;
  };
  const jobs = Object.entries(wf.jobs ?? {}).filter(
    ([, j]) => j["runs-on"] === MACOS_RUNNER_IMAGE
  );
  if (jobs.length === 0) out.push(`${file}: no job runs on ${MACOS_RUNNER_IMAGE}`);
  for (const [id, job] of jobs) {
    const runs = (job.steps ?? []).map((s) => s.run ?? "");
    const label = `${file} job ${id}`;
    if (!runs.some((r) => /(?:^|\n)\s*npm ci\b/.test(r) || /\bnpm ci &&/.test(r)))
      out.push(`${label}: no step runs npm ci`);
    if (
      !runs.some((r) =>
        /(?:^|\n)\s*env -u CI npm test(?: -- --json --outputFile=jest-results-[\w.-]+\.json)?\s*(?:\n|$)/.test(
          r
        )
      )
    )
      out.push(
        `${label}: no step runs \`env -u CI npm test\` (the owner's run: no CI, no database)`
      );
    if (String(job.env?.REQUIRE_BASH_3_2 ?? "") !== "1")
      out.push(
        `${label}: env REQUIRE_BASH_3_2 must be "1", so the tests prove they ran under bash 3.2`
      );
    if (!runs.some((r) => /ln -sf? \/bin\/bash /.test(r) && /GITHUB_PATH/.test(r)))
      out.push(
        `${label}: no step puts /bin/bash first on PATH as \`bash\` (ln -s /bin/bash … >> "$GITHUB_PATH")`
      );
    if (!runs.some((r) => /bash --version/.test(r)))
      out.push(`${label}: no step prints \`bash --version\``);
    for (const k of ["DATABASE_URL", "TEST_DATABASE_URL", "REQUIRE_DB_TESTS", "CI"])
      if (job.env && k in job.env)
        out.push(`${label}: env ${k} — the owner's run has none`);
  }
  const paths = wf.on?.push?.paths;
  if (paths !== undefined) {
    const covered = (f: string) =>
      paths.some((p) => {
        // GitHub's path globs: "**/" any directories (or none), "**" anything, "*" within a segment.
        const re = new RegExp(
          `^${p
            .split(/(\*\*\/|\*\*|\*)/)
            .map((t) =>
              t === "**/"
                ? "(?:.*/)?"
                : t === "**"
                  ? ".*"
                  : t === "*"
                    ? "[^/]*"
                    : t.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
            )
            .join("")}$`
        );
        return re.test(f);
      });
    for (const f of mustTrigger)
      if (!covered(f))
        out.push(
          `${file}: on.push.paths does not cover ${f}, which the macOS run must test`
        );
  }
  return out;
}

/** The macOS runner image the macOS job is pinned to (workflow-hygiene allows exactly this one). */
export const MACOS_RUNNER_IMAGE = "macos-26";

// ---------------------------------------------------------------------------------------------
// The tests.
// ---------------------------------------------------------------------------------------------

describe("the shell the tests run works on macOS: bash 3.2, BSD tools (TASK-213)", () => {
  const scripts = shellScripts(ROOT);
  const sources = testSources(ROOT);

  it("finds the scripts the tests run", () => {
    for (const f of [
      "docs/templates/sync-carried-guard.sh",
      "docs/templates/sync-version-guard.sh",
      "scripts/load-test-target.sh",
      "scripts/pull-base-image.sh",
    ])
      expect(scripts).toContain(f);
  });

  it("every shell script in the repository runs on bash 3.2 and BSD tools", () => {
    expect(
      scripts.flatMap((f) => shellProblems(f, readFileSync(join(ROOT, f), "utf8")))
    ).toEqual([]);
  });

  it("every workflow step a test executes runs on bash 3.2 and BSD tools, and exists", () => {
    const problems: string[] = [];
    for (const [test, refs] of Object.entries(EXECUTED_STEPS)) {
      if (!existsSync(join(ROOT, test))) continue;
      for (const ref of refs) {
        const what = `${ref.workflow} step "${ref.name ?? ref.id}"`;
        if (ref.appCopy && !existsSync(join(ROOT, ref.workflow))) continue;
        const step = findStep(ROOT, ref);
        if (!step?.run) {
          problems.push(
            `${test} runs ${what}, which does not exist: correct EXECUTED_STEPS`
          );
          continue;
        }
        problems.push(...shellProblems(what, step.run));
      }
    }
    expect(problems).toEqual([]);
  });

  it("every test that runs a shell string is accounted for: literal ones scanned, built ones listed", () => {
    const problems: string[] = [];
    for (const f of sources) {
      if (f === "__tests__/shell-portability.test.ts") continue;
      const use = shellUse(readFileSync(join(ROOT, f), "utf8"));
      for (const lit of use.literals)
        problems.push(...shellProblems(`${f} (bash -c)`, lit));
      for (const script of writtenScripts(readFileSync(join(ROOT, f), "utf8")))
        problems.push(...shellProblems(`${f} (a script it writes)`, script));
      if (use.dynamic && !(f in EXECUTED_STEPS))
        problems.push(
          `${f} runs bash -c with a string built at run time: list the workflow steps it runs in EXECUTED_STEPS`
        );
      for (const o of use.other)
        problems.push(
          `${f} runs a shell string with ${o}: use execFileSync/spawnSync with an argument list`
        );
    }
    expect(problems).toEqual([]);
  });

  it("the macOS workflow runs npm test as the owner does, under /bin/bash, on every change to what it tests", () => {
    const file = ".github/workflows/macos.yml";
    expect(existsSync(join(ROOT, file))).toBe(true);
    // The image is the one workflow-hygiene's runner pin allows, and in this file only.
    expect(
      readFileSync(join(ROOT, "__tests__/workflow-hygiene.test.ts"), "utf8")
    ).toContain(`export const MACOS_RUNNER_IMAGE = "${MACOS_RUNNER_IMAGE}";`);
    expect(
      macosWorkflowProblems(file, readFileSync(join(ROOT, file), "utf8"), mustTrigger())
    ).toEqual([]);
  });
});

describe("the shell scan's self-tests (TASK-213)", () => {
  it("[self-test] each bash 3.2 incompatibility is refused, with its line", () => {
    const planted: [string, RegExp, number?][] = [
      ['x=$(case "$a" in b) echo 1;; esac)', /`case` inside `\$\( \)`/],
      ['x="$(case "$a" in\n  b) echo 1;;\nesac)"', /`case` inside `\$\( \)`/],
      ["x=$(\n  # it's here\n  echo 1)", /a comment inside `\$\( \)`/, 3],
      ["mapfile -t lines < f", /mapfile\/readarray/],
      ["readarray lines < f", /mapfile\/readarray/],
      ["coproc cat", /coproc/],
      ["declare -A m", /-A, -n, -g/],
      ["local -n ref=x", /-A, -n, -g/],
      ["declare -g x=1", /-A, -n, -g/],
      ['echo "${x,,}"', /case modification/],
      ['echo "${x^^}"', /case modification/],
      ['echo "${x@Q}"', /transformation/],
      ['echo "${a[-1]}"', /negative array subscript/],
      ['echo "${x:0:-1}"', /negative substring length/],
      ["make |& tee log", /\|& \(bash 4\.0\)/],
      ["make &>> log", /&>> \(bash 4\.0\)/],
      ["case $x in a) echo;;& b) echo;; esac", /;;& or ;&/],
      ["case $x in a) echo;& b) echo;; esac", /;;& or ;&/],
      ["if [[ -v HOME ]]; then :; fi", /\[\[ -v name \]\]/],
      ["wait -n", /wait -n/],
      ["echo $EPOCHSECONDS", /a variable bash 3\.2 does not set/],
      ["echo ${BASHPID}", /a variable bash 3\.2 does not set/],
      ["shopt -s globstar", /a shopt option/],
      ["shopt -s inherit_errexit", /a shopt option/],
      ['set -euo pipefail\nfor x in "${list[@]}"; do :; done', /under set -u/, 3],
      ['set -o nounset\nls "${list[*]}"', /under set -u/, 3],
      [
        'set -euo pipefail\nlist=()\nfor x in "${list[@]}"; do :; done',
        /under set -u/,
        4,
      ],
      ['set -euo pipefail\nlist=("$@")\nrun "${list[@]}"', /under set -u/, 4],
      ['set -euo pipefail\nlist=(HEAD)\nunset list\nrun "${list[@]}"', /under set -u/, 5],
      [
        'while read -r l; do :; done <<< "$x"\nsed -i s/a/b/ f',
        /`sed -i` without a suffix/,
        3,
      ],
      ["cat <<EOF\nbody\nEOF\ntac f", /`tac` is a GNU tool/, 5],
      ["sed -i 's/a/b/' f", /`sed -i` without a suffix/],
      ["sed -i '' 's/a/b/' f", /`sed -i` without a suffix/],
      ["sed -Ei 's/a/b/' f", /`sed -i` without a suffix/],
      ["sed --in-place=.bak 's/a/b/' f", /`sed -i` without a suffix/],
      ["grep -oP '\\d+' f", /`grep -P`/],
      ["grep --perl-regexp x f", /`grep -P`/],
      ['date -d "yesterday" +%F', /`date -d`/],
      ["date --date=@0", /`date -d`/],
      ['here=$(readlink -f "$0")', /`readlink -f`/],
      ["stat -c %s f", /`stat -c`/],
      ["sort -V versions", /`sort -V`/],
      ["printf 'a\\nb\\n' | sort -rV", /`sort -V`/],
      ["head -n -1 f", /`head -n -N`/],
      ["head -n-1 f", /`head -n -N`/],
      ["head -c -3 f", /`head -n -N`/],
      ["ls | xargs -r rm", /`xargs -r`/],
      ["find . -print0 | xargs -0r rm", /`xargs -r`/],
      ["base64 -w0 f", /`base64 -w`/],
      ["find . -printf '%p\\n'", /`find -printf`/],
      ["timeout 5 sleep 9", /`timeout` is a GNU tool/],
      ["tac f", /`tac` is a GNU tool/],
      ["n=$(nproc)", /`nproc` is a GNU tool/],
      ["sudo sed -i 's/a/b/' f", /`sed -i` without a suffix/],
      ["X=1 xargs -n 1 sed -i 's/a/b/' < list", /`sed -i` without a suffix/],
    ];
    for (const [text, finding, line = 2] of planted) {
      const found = shellProblems("t.sh", `#!/usr/bin/env bash\n${text}\n`);
      expect([text, found]).toEqual([text, [expect.stringMatching(finding)]]);
      expect([text, found[0].split(":")[1]]).toEqual([text, String(line)]);
    }
  });

  it("[self-test] what bash 3.2 and BSD tools run is not refused", () => {
    const fine = [
      // case outside a substitution, if/[[ ]] inside one
      'case "$a" in b) echo 1 ;; esac',
      'x=$(if [[ "$a" == b ]]; then echo 1; fi)',
      // quoted or commented words are data
      "echo 'x=$(case a in b) c;; esac)'",
      "# sed -i s/a/b/ f and readarray and $(case)",
      'echo "use sed -i.bak, not sed -i"',
      "msg=$'mapfile\\n'",
      // a here-document body is data
      "cat <<'EOF'\ndate -d now\nsed -i x f\nEOF\necho done",
      "cat <<-EOF\n\treadlink -f x\n\tEOF",
      // a comment outside the substitution, nested substitutions, arithmetic
      'v=$(echo "$(printf %s "$a")") # case here is fine',
      "n=$(( (a + 1) * 2 ))",
      // guarded and never-empty arrays under set -u
      'set -euo pipefail\nfor x in ${list[@]+"${list[@]}"}; do :; done',
      'set -euo pipefail\nrefs=(HEAD)\nrefs+=(x)\ngit log "${refs[@]}"',
      'set -euo pipefail\nPSQL=(psql -X -q)\n"${PSQL[@]}" -c 1',
      'set -euo pipefail\nargs=("$1")\nrun "${args[@]}"',
      'set -euo pipefail\nargs=("a b" c)\nrun "${args[@]}"',
      'while read -r l; do :; done <<< "$OPEN"\necho ok',
      // arrays without set -u
      'for x in "${list[@]}"; do :; done',
      // the portable forms
      "sed -i.bak 's/a/b/' f && rm -f f.bak",
      "sed -n 's/a/b/p' f",
      "grep -E '[0-9]+' f",
      "date -u +%Y-%m-%dT%H:%M:%SZ",
      'here=$(cd "$(dirname "$0")" && pwd -P)',
      "sort -t. -k1,1n -k2,2n v",
      "head -n 1 f",
      "tail -n +2 f",
      "xargs -0 -n 1 echo < list",
      "base64 < f | tr -d '\\n'",
      "find . -name '*.sh' -print",
      "git -C x log --format='%H%x09%s' HEAD",
      'IFS=. read -r a b c <<<"$v"',
      "while IFS=$'\\t' read -r sha subject; do :; done < <(git log)",
      'echo "${x%%:*}" "${y:0:7}" "${#a[@]}" "${z:-default}"',
      "case $x in a) echo ;; b) echo ;; esac",
      "echo hi >&2; echo there 2>&1 | cat",
    ];
    for (const text of fine)
      expect([text, shellProblems("t.sh", `${text}\n`)]).toEqual([text, []]);
  });

  it("[self-test] a test's shell use is classified: a literal is scanned, a built string must be listed, execSync refused", () => {
    expect(shellUse('execFileSync("sh", ["-c", "command -v git"])')).toEqual({
      runsShell: true,
      literals: ["command -v git"],
      dynamic: false,
      other: [],
    });
    expect(shellUse('spawnSync("bash", ["-c", `readarray x < ${f}`])').literals).toEqual([
      "readarray x < x",
    ]);
    expect(shellUse('spawnSync("bash", ["-c", step.run ?? ""], {})')).toMatchObject({
      runsShell: true,
      dynamic: true,
    });
    expect(shellUse('spawnSync("bash", [SCRIPT, "a"])')).toMatchObject({
      runsShell: true,
      dynamic: false,
      literals: [],
    });
    expect(shellUse('execSync("ls | wc -l")').other).toEqual(["execSync"]);
    expect(shellUse('spawn("ls", [], { shell: true })').other).toEqual(["shell: true"]);
    expect(shellUse("exec(`rm -rf ${dir}`)").other).toEqual(["exec"]);
    expect(shellUse('/x/.exec("a"); spawnSync("node", [S])')).toEqual({
      runsShell: false,
      literals: [],
      dynamic: false,
      other: [],
    });
    expect(
      shellProblems(
        "t (bash -c)",
        shellUse('spawnSync("sh", ["-c", "tac f"])').literals[0]
      )
    ).toEqual([expect.stringMatching(/`tac` is a GNU tool/)]);
  });

  it("[self-test] a script a test writes at run time is found and scanned (template or joined array)", () => {
    const src = [
      'writeFileSync(p, `#!/usr/bin/env bash\\necho ${x}\\nreadlink -f "$0"\\n`);',
      `writeFileSync(q, ["#!/bin/bash", 'echo "$*" >> "$LOG"', "x=$(case $1 in a) :;; esac)", ""].join("\\n"));`,
      'writeFileSync(r, ["#!/bin/sh", "exec \\"$REAL\\" \\"$@\\""].join("\\n"));',
      'const notAScript = ["a", "b"].join("\\n"); const t = `plain ${x}`;',
    ].join("\n");
    const found = writtenScripts(src);
    expect(found).toEqual([
      '#!/usr/bin/env bash\necho x\nreadlink -f "$0"\n',
      '#!/bin/bash\necho "$*" >> "$LOG"\nx=$(case $1 in a) :;; esac)\n',
      '#!/bin/sh\nexec "$REAL" "$@"',
    ]);
    expect(found.flatMap((t) => shellProblems("w", t))).toEqual([
      expect.stringMatching(/`readlink -f`/),
      expect.stringMatching(/`case` inside `\$\( \)`/),
    ]);
  });

  it("[self-test] a missing or changed executed step is reported, and a found one is scanned", () => {
    const step = findStep(ROOT, EXECUTED_STEPS["__tests__/workflow-hygiene.test.ts"][0]);
    expect(step?.run).toMatch(/gh api/);
    expect(
      findStep(ROOT, {
        workflow: "docs/templates/sync-from-foundation.yml",
        name: "No such step",
      })
    ).toBeNull();
    expect(findStep(ROOT, { workflow: "nope.yml", id: "x" })).toBeNull();
    expect(shellProblems("s", `${step?.run}\nhead -n -1 f\n`)).toEqual([
      expect.stringMatching(/`head -n -N`/),
    ]);
  });

  it("[self-test] the macOS workflow is refused without the owner's run, /bin/bash, or a trigger for what it tests", () => {
    const good = [
      "on:",
      "  push:",
      '    paths: ["**/*.sh", ".github/workflows/**", "__tests__/a.test.ts"]',
      "jobs:",
      "  macos:",
      `    runs-on: ${MACOS_RUNNER_IMAGE}`,
      "    env:",
      '      REQUIRE_BASH_3_2: "1"',
      "    steps:",
      "      - run: |",
      '          ln -sf /bin/bash "$RUNNER_TEMP/b/bash"',
      '          echo "$RUNNER_TEMP/b" >> "$GITHUB_PATH"',
      "          bash --version",
      "      - run: npm ci",
      "      - run: env -u CI npm test",
    ].join("\n");
    const must = ["scripts/x.sh", ".github/workflows/ci.yml", "__tests__/a.test.ts"];
    expect(macosWorkflowProblems("m.yml", good, must)).toEqual([]);
    expect(
      macosWorkflowProblems("m.yml", good, [
        ...must,
        "__tests__/b.test.ts",
        "docs/templates/s.yml",
      ])
    ).toEqual([
      "m.yml: on.push.paths does not cover __tests__/b.test.ts, which the macOS run must test",
      "m.yml: on.push.paths does not cover docs/templates/s.yml, which the macOS run must test",
    ]);
    expect(
      macosWorkflowProblems("m.yml", good.replace("macos-26", "macos-15"), must)
    ).toEqual(["m.yml: no job runs on macos-26"]);
    expect(
      macosWorkflowProblems("m.yml", good.replace("env -u CI npm test", "npm test"), must)
    ).toEqual([expect.stringMatching(/no step runs `env -u CI npm test`/)]);
    expect(macosWorkflowProblems("m.yml", good.replace('"1"', '"0"'), must)).toEqual([
      expect.stringMatching(/REQUIRE_BASH_3_2 must be "1"/),
    ]);
    expect(
      macosWorkflowProblems(
        "m.yml",
        good.replace("ln -sf /bin/bash", "ln -sf /opt/homebrew/bin/bash"),
        must
      )
    ).toEqual([expect.stringMatching(/no step puts \/bin\/bash first on PATH/)]);
    expect(
      macosWorkflowProblems(
        "m.yml",
        good.replace(
          '      REQUIRE_BASH_3_2: "1"',
          '      REQUIRE_BASH_3_2: "1"\n      REQUIRE_DB_TESTS: "1"'
        ),
        must
      )
    ).toEqual([expect.stringMatching(/env REQUIRE_DB_TESTS — the owner's run has none/)]);
    expect(
      macosWorkflowProblems("m.yml", good.replace("      - run: npm ci\n", ""), must)
    ).toEqual([expect.stringMatching(/no step runs npm ci/)]);
  });

  it("the bash the tests run is 3.2 where the macOS job requires it (REQUIRE_BASH_3_2=1)", () => {
    const r = spawnSync(
      "bash",
      ["-c", 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]} $BASH"'],
      {
        encoding: "utf8",
      }
    );
    expect(r.status).toBe(0);
    if (process.env.REQUIRE_BASH_3_2 === "1") expect(r.stdout.trim()).toMatch(/^3\.2 /);
  });
});

/** What a push must change for the macOS workflow to run (when it filters by path). */
export function mustTrigger(root: string = ROOT): string[] {
  const shellTests = testSources(root).filter((f) => {
    const text = readFileSync(join(root, f), "utf8");
    return shellUse(text).runsShell || writtenScripts(text).length > 0;
  });
  const stepFiles = Object.entries(EXECUTED_STEPS)
    .filter(([t]) => existsSync(join(root, t)))
    .flatMap(([, refs]) => refs.map((r) => r.workflow))
    .filter((w) => existsSync(join(root, w)));
  return [
    ...new Set([
      ...shellScripts(root),
      ...shellTests,
      ...stepFiles,
      "__tests__/shell-portability.test.ts",
    ]),
  ].sort();
}
