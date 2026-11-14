/**
 * __tests__/helpers/whole-row-scan.ts — finds SQL that reads a whole table row (TASK-215, S3)
 *
 * A statement that names no columns takes every column the table has now and every column a later
 * migration adds — an address, a parent's email, a token — into memory, a response or an export,
 * without anyone deciding that it should (audit S3: the tenant export, the profile export, the
 * audit-log read and the password-policy reads all did). The rule: a statement names the columns it
 * reads. What reads a whole row:
 *
 *   select *, select distinct *, `x.*` in a select list     every column of what it reads
 *   returning *                                              every column of what it wrote
 *   to_jsonb(x), to_json(x), row_to_json(x), json_agg(x),    a row turned into a document — when
 *   jsonb_agg(x), array_agg(x), hstore(x), row(x.*)          `x` is a table row: a table's alias
 *                                                            or name in the statement's from/join/
 *                                                            update, or a trigger's new / old
 *
 * `x` that is a column, a parameter, or a derived table — `(select a, b from t) x`, whose columns
 * are named — is not a row of a table. A `select *` over a VALUES list reads literals, not a row.
 * A `*` inside count(*) is no column.
 *
 * Used by __tests__/whole-row-reads.test.ts (source and migrations) and
 * __tests__/db/whole-row-functions.db.test.ts (the functions and views a replayed database holds).
 */

import * as ts from "typescript";

export interface WholeRowFinding {
  /** 1-based line in the scanned text (or in the source file, for a TypeScript literal). */
  readonly line: number;
  /** What was found: the construct, as written. */
  readonly what: string;
}

/** SQL with its comments replaced by spaces (positions and line numbers kept). */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (quote) {
      out += c;
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'") {
      quote = "'";
      out += c;
      i += 1;
      continue;
    }
    if (two === "--") {
      while (i < sql.length && sql[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      out += sql.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** An identifier's alternatives, for a capture group of its own. */
const IDENT_ALT = String.raw`"[^"]+"|[a-z_%$][\w$%]*`;
const IDENT = String.raw`(?:${IDENT_ALT})`;
/** A table reference: an optional schema, then the name (`public.%I` for a dynamic one). */
const TABLE_REF = String.raw`(?:${IDENT}\s*\.\s*)?${IDENT}`;
/** Words that may follow a table reference and are not its alias. */
const NOT_ALIAS = new Set([
  "where",
  "on",
  "join",
  "left",
  "right",
  "inner",
  "outer",
  "full",
  "cross",
  "natural",
  "using",
  "order",
  "group",
  "limit",
  "offset",
  "for",
  "set",
  "returning",
  "union",
  "except",
  "intersect",
  "having",
  "window",
  "with",
  "as",
  "values",
  "select",
  "lateral",
  "tablesample",
  "only",
  "then",
  "loop",
  "and",
  "or",
  "into",
  "default",
]);

/**
 * The names that stand for a table row in a statement: every table (and its alias) after from,
 * join, update, into and delete from — not a derived table `(…) x`, and not a function call
 * `f(…) x` (a set-returning function's columns are its own declaration; `select *` from it is
 * caught as `select *`).
 */
export function rowNames(statement: string): Set<string> {
  const s = statement.toLowerCase();
  const names = new Set<string>(["new", "old"]);
  const re = new RegExp(
    String.raw`\b(?:from|join|update|into)\s+(?:only\s+)?(${TABLE_REF})(\s*\()?(?:\s+(?:as\s+)?(${IDENT_ALT}))?`,
    "g"
  );
  for (const m of s.matchAll(re)) {
    if (m[2]) continue; // a function call, not a table
    const table = m[1].replace(/\s+/g, "");
    const bare = table.split(".").pop() as string;
    if (NOT_ALIAS.has(bare)) continue;
    names.add(bare.replace(/"/g, ""));
    const alias = m[3]?.replace(/"/g, "");
    if (alias && !NOT_ALIAS.has(alias)) names.add(alias);
  }
  // A comma-joined table: `from a x, b y`.
  const comma = new RegExp(
    String.raw`,\s*(?:only\s+)?(${TABLE_REF})(\s*\()?(?:\s+(?:as\s+)?(${IDENT_ALT}))?(?=\s*(?:,|where|$|\)|join|left|inner|order|group|limit))`,
    "g"
  );
  for (const m of s.matchAll(comma)) {
    if (m[2]) continue;
    const before = s.slice(0, m.index);
    // Only inside a from list: the last clause keyword before it is `from`.
    const last = before.match(
      /\b(select|from|where|set|values|returning|order|group)\b(?![\s\S]+\b(select|from|where|set|values|returning|order|group)\b)/
    );
    if (!last || last[1] !== "from") continue;
    const bare = (m[1].replace(/\s+/g, "").split(".").pop() as string).replace(/"/g, "");
    if (!NOT_ALIAS.has(bare)) names.add(bare);
    const alias = m[3]?.replace(/"/g, "");
    if (alias && !NOT_ALIAS.has(alias)) names.add(alias);
  }
  return names;
}

const line = (text: string, index: number): number =>
  text.slice(0, index).split("\n").length;

/**
 * Whole-row reads in one piece of SQL (a statement, a function body, a migration file): each with
 * its line in `sql`. Comments are ignored; the text inside quotes is scanned too (a dynamic
 * statement is SQL in a string: `format('select to_jsonb(r) from public.%I r …')`).
 */
export function wholeRowFindings(sql: string): WholeRowFinding[] {
  const text = stripSqlComments(sql);
  const lower = text.toLowerCase();
  const found: WholeRowFinding[] = [];
  // The statement around a position: from the last `;` before it to the next one.
  const statementAt = (i: number): string => {
    const start = lower.lastIndexOf(";", i) + 1;
    const end = lower.indexOf(";", i);
    return lower.slice(start, end < 0 ? lower.length : end);
  };
  // select * / select distinct * / select x.* (and `, x.*` in a select list)
  for (const m of lower.matchAll(
    /\bselect\s+(?:distinct\s+(?:on\s*\([^)]*\)\s*)?|all\s+)?\*/g
  )) {
    const after = lower.slice((m.index as number) + m[0].length);
    if (/^\s*from\s*\(\s*values\b/.test(after)) continue; // literals, not a row
    found.push({ line: line(text, m.index as number), what: m[0].replace(/\s+/g, " ") });
  }
  for (const m of lower.matchAll(
    new RegExp(String.raw`(?:\bselect\s+|,\s*)(${IDENT_ALT})\s*\.\s*\*`, "g")
  )) {
    found.push({
      line: line(text, m.index as number),
      what: `${m[1]}.*`,
    });
  }
  for (const m of lower.matchAll(/\breturning\s+\*/g)) {
    found.push({ line: line(text, m.index as number), what: "returning *" });
  }
  for (const m of lower.matchAll(
    new RegExp(
      String.raw`\b(to_jsonb|to_json|row_to_json|jsonb_agg|json_agg|array_agg|hstore)\s*\(\s*(${IDENT_ALT})\s*[),]`,
      "g"
    )
  )) {
    const name = m[2].replace(/"/g, "");
    if (!rowNames(statementAt(m.index as number)).has(name)) continue;
    found.push({ line: line(text, m.index as number), what: `${m[1]}(${name})` });
  }
  for (const m of lower.matchAll(
    new RegExp(String.raw`\brow\s*\(\s*(${IDENT_ALT})\s*\.\s*\*\s*\)`, "g")
  )) {
    found.push({ line: line(text, m.index as number), what: `row(${m[1]}.*)` });
  }
  // One finding per construct and line.
  const seen = new Set<string>();
  return found.filter((f) => {
    const k = `${f.line}|${f.what}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Text that reads as SQL: a statement keyword and a clause that only SQL has. */
const SQLISH =
  /\b(?:select|insert\s+into|update|delete\s+from|returning|to_jsonb|row_to_json|to_json)\b[\s\S]+\b(?:from|set|values|into|returning|where|to_jsonb|row_to_json|to_json)\b/i;

/**
 * The SQL-looking string and template literals of a TypeScript or JavaScript source, each with the
 * line it starts on (a template's placeholders read as `%s`).
 */
export function sqlLiterals(
  source: string,
  fileName = "probe.ts"
): { line: number; sql: string }[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: { line: number; sql: string }[] = [];
  const visit = (n: ts.Node): void => {
    let text: string | undefined;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    else if (ts.isTemplateExpression(n))
      text = n.head.text + n.templateSpans.map((s) => `%s${s.literal.text}`).join("");
    if (text !== undefined && SQLISH.test(text)) {
      out.push({
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        sql: text,
      });
    }
    // A template's spans are visited for nested literals; its own text was taken above.
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Whole-row reads in a TypeScript or JavaScript source, by the source's lines. */
export function sourceFindings(source: string, fileName = "probe.ts"): WholeRowFinding[] {
  return sqlLiterals(source, fileName).flatMap(({ line: at, sql }) =>
    wholeRowFindings(sql).map((f) => ({ line: at + f.line - 1, what: f.what }))
  );
}

/** A function or view a migration defines: what identifies it, and its definition's span. */
interface Definition {
  readonly key: string;
  readonly file: string;
  readonly start: number;
  readonly end: number;
}

/** A function's identity: its name and its argument types (names and defaults dropped). */
export function functionKey(name: string, args: string): string {
  const types = splitTopLevel(args)
    .map((a) =>
      a
        .replace(/\bdefault\b[\s\S]*$/i, "")
        .replace(/=[\s\S]*$/, "")
        .trim()
    )
    .filter(Boolean)
    .map((a) => {
      const words = a.replace(/^(?:in|out|inout|variadic)\s+/i, "").split(/\s+/);
      // `p_table text` → text; `text` → text; `trajectory_scope` → trajectory_scope.
      return (words.length > 1 ? words.slice(1) : words).join(" ").toLowerCase();
    });
  return `${name
    .toLowerCase()
    .replace(/^public\./, "")
    .replace(/"/g, "")}(${types.join(",")})`;
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "(") depth += 1;
    if (c === ")") depth -= 1;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** The end of a function definition: past its dollar-quoted body and the statement's `;`. */
function definitionEnd(text: string, from: number): number {
  const asAt = text.slice(from).search(/\bas\s+(\$[a-z_]*\$)/i);
  if (asAt < 0) return text.indexOf(";", from) + 1 || text.length;
  const tagMatch = /\bas\s+(\$[a-z_]*\$)/i.exec(text.slice(from)) as RegExpExecArray;
  const tag = tagMatch[1];
  const bodyStart = from + asAt + tagMatch[0].length;
  const bodyEnd = text.indexOf(tag, bodyStart);
  const semi = text.indexOf(";", bodyEnd < 0 ? bodyStart : bodyEnd + tag.length);
  return semi < 0 ? text.length : semi + 1;
}

/**
 * Whole-row reads the migrations leave live, in apply order (file name order). A function's
 * definition counts only while no later migration replaces it (create or replace, the same name and
 * argument types) or drops it; a view's likewise. Everything else a migration runs — a one-time
 * update, a DO block — counts where it is.
 */
export function migrationFindings(
  files: readonly { readonly name: string; readonly text: string }[]
): { file: string; line: number; what: string }[] {
  const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : 1));
  const definitions: Definition[] = [];
  const live = new Map<string, Definition>();
  for (const f of ordered) {
    const text = stripSqlComments(f.text);
    const lower = text.toLowerCase();
    for (const m of lower.matchAll(
      /\bcreate\s+(?:or\s+replace\s+)?function\s+((?:"?\w+"?\.)?"?\w+"?)\s*\(/g
    )) {
      const open = (m.index as number) + m[0].length;
      let depth = 1;
      let i = open;
      while (i < lower.length && depth > 0) {
        if (lower[i] === "(") depth += 1;
        if (lower[i] === ")") depth -= 1;
        i += 1;
      }
      const key = functionKey(m[1], text.slice(open, i - 1));
      const d = {
        key,
        file: f.name,
        start: m.index as number,
        end: definitionEnd(lower, i),
      };
      definitions.push(d);
      live.set(key, d);
    }
    for (const m of lower.matchAll(
      /\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+((?:"?\w+"?\.)?"?\w+"?)/g
    )) {
      const key = `view ${m[1].replace(/^public\./, "").replace(/"/g, "")}`;
      const d = {
        key,
        file: f.name,
        start: m.index as number,
        end: lower.indexOf(";", m.index) + 1 || lower.length,
      };
      definitions.push(d);
      live.set(key, d);
    }
    for (const m of lower.matchAll(
      /\bdrop\s+function\s+(?:if\s+exists\s+)?((?:"?\w+"?\.)?"?\w+"?)\s*\(([^)]*)\)/g
    )) {
      live.delete(functionKey(m[1], m[2]));
    }
    for (const m of lower.matchAll(
      /\bdrop\s+(?:materialized\s+)?view\s+(?:if\s+exists\s+)?((?:"?\w+"?\.)?"?\w+"?)/g
    )) {
      live.delete(`view ${m[1].replace(/^public\./, "").replace(/"/g, "")}`);
    }
  }
  const liveSet = new Set(live.values());
  const out: { file: string; line: number; what: string }[] = [];
  for (const f of ordered) {
    const text = stripSqlComments(f.text);
    const mine = definitions.filter((d) => d.file === f.name);
    for (const finding of wholeRowFindings(text)) {
      const inside = mine.find((d) => offsetWithin(text, d, finding.line));
      if (inside && !liveSet.has(inside)) continue; // a definition a later migration replaced
      out.push({ file: f.name, line: finding.line, what: finding.what });
    }
  }
  return out;
}

/** Whether `lineNo` (1-based) of `text` falls inside definition `d`. */
function offsetWithin(text: string, d: Definition, lineNo: number): boolean {
  const first = text.slice(0, d.start).split("\n").length;
  const last = text.slice(0, d.end).split("\n").length;
  return lineNo >= first && lineNo <= last;
}
