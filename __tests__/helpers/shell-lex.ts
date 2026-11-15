/**
 * __tests__/helpers/shell-lex.ts — reading shell text as bash's parser does, for the guards that
 * scan the repository's shell (TASK-213's macOS scan, TASK-218's pipefail scan).
 *
 * Moved here from __tests__/shell-portability.test.ts (TASK-218) so both guards read shell the
 * same way; the macOS scan's behaviour is unchanged. `data` (new) marks quoted text, so a scan can
 * tell a word's quoted spaces and `|` from the separators and operators between commands.
 */
import { closeSync, openSync, readSync } from "fs";
import { relative, sep } from "path";
import { walkFiles } from "./repo-files";

export interface Lexed {
  /** The text, same length, with comments, quoted literal text and here-document bodies blanked. */
  code: string;
  /** 1 at each offset inside a command substitution `$( )` (or backticks inside one). */
  inSubst: Uint8Array;
  /** Each comment: its offset and whether it sits inside a command substitution. */
  comments: { at: number; inSubst: boolean }[];
  /**
   * 1 at each offset that is quoted text — a quote character or what it quotes (blanked in
   * `code`): one word with its neighbours, never a space between words or an operator.
   */
  data: Uint8Array;
}

type Frame = { kind: "root" | "subst" | "arith" | "bt" | "dq"; depth: number };

const WORD_START = /[\s;&|()`!{}]/;

/** Reads shell text as bash's parser would, far enough to tell code from data. */
export function lexShell(text: string): Lexed {
  const out = text.split("");
  const inSubst = new Uint8Array(text.length);
  const data = new Uint8Array(text.length);
  const quoted = (from: number, to: number) => {
    for (let k = from; k < to && k < text.length; k++) data[k] = 1;
  };
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
        quoted(i, i + 2);
        i += 2;
      } else if (c === '"') {
        quoted(i, i + 1);
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
        quoted(i, i + 1);
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
      quoted(i, k + 1);
      mark(k + 1 - i);
      i = k + 1;
    } else if (c === "$" && text[i + 1] === "'") {
      let k = i + 2;
      while (k < text.length && text[k] !== "'") k += text[k] === "\\" ? 2 : 1;
      blank(i + 2, k);
      quoted(i, k + 1);
      mark(k + 1 - i);
      i = k + 1;
    } else if (c === '"') {
      quoted(i, i + 1);
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
  return { code: out.join(""), inSubst, comments, data };
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
