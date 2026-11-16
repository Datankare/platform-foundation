/**
 * __tests__/e2e-awaited-requests.test.ts — a browser spec waits only for requests the app still
 * makes, and calls only routes the app still serves (TASK-217)
 *
 * @guard a browser spec waiting for a request no screen makes, or calling a method no route serves
 *
 * Batch 56c moved the Users screen's list read from `GET /api/admin/users` to
 * `POST /api/admin/users/search` (TASK-215, A-17). Playform's live Journey C still waited for the
 * GET, which nothing sends any more, and timed out on the dev deployment (Deploy smoke run
 * 43617787204): every check in the repository passed, because no check compared what a spec waits
 * for with what the screens send. This one does, from the source text, for every spec and helper
 * under e2e/ and e2e-live/ (whichever this repository has):
 *
 *   1. Waits. Each `waitForResponse(…)` / `waitForRequest(…)` predicate names a path — the
 *      pathname compared with `===`, or the URL's `endsWith` / `includes` / `startsWith` — and the
 *      method (`….method() === "POST"`): since TASK-218 a wait that names no method (by URL alone,
 *      or a predicate that compares none) is a finding — it was answered by any request to its
 *      path, so a stale wait passed while the screen sent another method there — and so is a
 *      predicate whose path the scan cannot read. Some client module (app/ but its
 *      API routes, components/, hooks/, lib/, platform/, shared/, games/) must send that path with
 *      that method: a call of a function whose name contains "fetch" (fetch, apiFetch, guestFetch,
 *      fetchWithTimeout, …), `new EventSource(…)` or `navigator.sendBeacon(…)`, with the method
 *      its init's `method` gives (GET when it gives none). A path passed on through a local
 *      helper's parameter is followed to the helper's callers.
 *   2. Direct calls. Each request a spec makes itself — `request.get/post/…(path)`,
 *      `request.fetch(path, { method })`, and a helper called with a method and then a path
 *      (`apiFetch(request, ADMIN_A, "POST", "/api/…")`) — must have a route file under app/api/
 *      that exports that method.
 *
 * A path or method is read statically: a string, a template (each `${…}` any text), a `const` of
 * the file (an object's values, a property, either side of `?:` / `??`), what a same-file function
 * returns, and the rows of a `for (const [a, b] of LIST)` over a literal list — so a loop over
 * sections checks every row; a spec helper's path parameter is followed to its callers in the
 * file. Only `/api/` paths are checked. A target the scan cannot read is a finding unless ALLOWED
 * names it with a reason; an ALLOWED entry that no longer matches anything is a finding too.
 *
 * A client request's method is read as its path is, and through the helpers that pass one on: a
 * function that sends with a method or a RequestInit (spread or whole) given by its parameter is a
 * helper, read at each of its callers, to any depth (`askSession(method)` → `readSession("POST")`;
 * `call(url, init)` → `act(label, url, { method: "POST" })`). A client request whose method still
 * cannot be read would answer a wait for any method, so it is a finding unless ANY_METHOD names it
 * with why (TASK-218; empty), and an entry that names nothing is a finding too.
 */
import { existsSync, readFileSync } from "fs";
import { join, relative, sep } from "path";
import * as ts from "typescript";
import { walkFiles } from "./helpers/repo-files";
import { routeMethods } from "./helpers/route-methods";

const ROOT = join(__dirname, "..");
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");

/** The directories whose specs and helpers are read. */
const SPEC_DIRS = ["e2e", "e2e-live"];
/** The directories whose modules run in the browser (app/api/ excepted: the routes). */
const CLIENT_DIRS = ["app", "components", "hooks", "lib", "platform", "shared", "games"];

/**
 * Targets the scan cannot read, by `<file>: <the path expression as written>`, each with why it is
 * still checked. Empty: every target in both repositories is read. Kept so that a target that
 * truly cannot be read is listed here, with its reason, and never passes silently.
 */
const ALLOWED: Readonly<Record<string, string>> = {};

/**
 * Client requests whose method the scan cannot read, by `<file>: <path as written>`, each with
 * why. Such a request answers a wait for any method, so each one is named here and a new one
 * fails. Empty: every client request's method is read — a literal, a const, an init's `method`, or
 * a method or init parameter followed to its callers (TASK-218).
 */
const ANY_METHOD: Readonly<Record<string, string>> = {};

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export interface SourceText {
  readonly file: string;
  readonly text: string;
}

/** A path as written: literal parts, with null for each `${…}` (any text). */
type PathValue = readonly (string | null)[];

/** One request a spec waits for or makes. */
interface Target {
  readonly file: string;
  readonly line: number;
  readonly kind: "wait" | "call";
  readonly mode: "equals" | "endsWith" | "includes" | "startsWith";
  readonly path: PathValue;
  /** null: any method. */
  readonly method: string | null;
}

/** One request a client module sends. */
interface Sent {
  readonly file: string;
  readonly path: PathValue;
  /** null: a method the scan cannot read (it matches any). */
  readonly method: string | null;
}

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pathSource = (p: PathValue) => p.map((x) => x ?? "${…}").join("");
const pathRx = (p: PathValue) => p.map((x) => (x === null ? ".*" : escapeRx(x))).join("");
const sample = (p: PathValue) => p.map((x) => x ?? "x1").join("");
const noQuery = (s: string) => s.replace(/[?#].*$/, "");

function lineOf(sf: ts.SourceFile, n: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
}

function strip(e: ts.Expression): ts.Expression {
  let x = e;
  while (
    ts.isAsExpression(x) ||
    ts.isParenthesizedExpression(x) ||
    ts.isNonNullExpression(x) ||
    ts.isSatisfiesExpression(x) ||
    ts.isTypeAssertionExpression(x)
  )
    x = x.expression;
  return x;
}

/** The names a binding binds, with their place: index (array pattern) or property (object). */
function bindingSlots(
  b: ts.BindingName
): { name: string; slot: number | string | null }[] {
  if (ts.isIdentifier(b)) return [{ name: b.text, slot: null }];
  if (ts.isArrayBindingPattern(b))
    return b.elements.flatMap((el, i) =>
      ts.isBindingElement(el) && ts.isIdentifier(el.name)
        ? [{ name: el.name.text, slot: i }]
        : []
    );
  return b.elements.flatMap((el) =>
    ts.isIdentifier(el.name)
      ? [
          {
            name: el.name.text,
            slot:
              el.propertyName && ts.isIdentifier(el.propertyName)
                ? el.propertyName.text
                : el.name.text,
          },
        ]
      : []
  );
}

/** A function's name: its own, or the const it is assigned to. */
function functionName(fn: ts.FunctionLikeDeclaration): string | undefined {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
  if (fn.parent && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name))
    return fn.parent.name.text;
  return undefined;
}

/** Values bound for one row of the enclosing `for … of` loops. */
type Env = ReadonlyMap<string, ts.Expression>;

/**
 * Reads expressions of one file statically: strings, templates, consts in scope, object values,
 * and the rows of literal for-of loops (through `env`).
 */
class Reader {
  /**
   * `elsewhere`: the Reader of the one other module that declares an exported function of a name
   * (client modules only): a path a function of another module returns is read there (TASK-216:
   * the console's section registry, components/admin/ui/sections.ts, gives each section's read).
   */
  constructor(
    readonly sf: ts.SourceFile,
    private readonly elsewhere?: (name: string) => Reader | undefined
  ) {}

  /** Whether this file imports `name` by that name (`import { name } from "…"`). */
  imports(name: string): boolean {
    return this.sf.statements.some(
      (st) =>
        ts.isImportDeclaration(st) &&
        !!st.importClause?.namedBindings &&
        ts.isNamedImports(st.importClause.namedBindings) &&
        st.importClause.namedBindings.elements.some(
          (el) => el.name.text === name && !el.propertyName
        )
    );
  }

  /** The exported functions this file declares, by name. */
  exportedFunctions(): string[] {
    const out: string[] = [];
    for (const st of this.sf.statements)
      if (
        ts.isFunctionDeclaration(st) &&
        st.name &&
        st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      )
        out.push(st.name.text);
    return out;
  }

  /** The const (or let with an initializer) `name` visible from `at`, if any. */
  declaration(name: string, at: ts.Node): ts.Expression | undefined {
    for (let n: ts.Node | undefined = at; n; n = n.parent) {
      const stmts =
        ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n)
          ? n.statements
          : ts.isCaseClause(n) || ts.isDefaultClause(n)
            ? n.statements
            : undefined;
      if (!stmts) continue;
      for (const st of stmts) {
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations)
          if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer)
            return d.initializer;
      }
    }
    return undefined;
  }

  /** The file's function `name` (declared, or a const arrow / function expression). */
  fn(name: string): ts.FunctionLikeDeclaration | undefined {
    let found: ts.FunctionLikeDeclaration | undefined;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (
        (ts.isFunctionDeclaration(n) ||
          ts.isArrowFunction(n) ||
          ts.isFunctionExpression(n)) &&
        functionName(n) === name
      )
        found = n;
      ts.forEachChild(n, visit);
    };
    visit(this.sf);
    return found;
  }

  /** What a function returns: its expression body, or each `return` of its own body. */
  returns(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
    if (!fn.body) return [];
    if (!ts.isBlock(fn.body)) return [fn.body];
    const out: ts.Expression[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isFunctionLike(n)) return;
      if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(fn.body, visit);
    return out;
  }

  /** Whether `name` is a parameter of a function enclosing `at`. */
  parameterOf(name: string, at: ts.Node): ts.FunctionLikeDeclaration | undefined {
    for (let n: ts.Node | undefined = at; n; n = n.parent)
      if (ts.isFunctionLike(n) && (n as ts.FunctionLikeDeclaration).parameters)
        for (const p of (n as ts.FunctionLikeDeclaration).parameters)
          if (bindingSlots(p.name).some((s) => s.name === name))
            return n as ts.FunctionLikeDeclaration;
    return undefined;
  }

  /** The element list `e` stands for: an array literal, directly or through a const. */
  list(e: ts.Expression, at: ts.Node, depth = 0): readonly ts.Expression[] | undefined {
    const x = strip(e);
    if (ts.isArrayLiteralExpression(x)) return x.elements;
    if (ts.isIdentifier(x) && depth < 5) {
      const init = this.declaration(x.text, at);
      if (init) return this.list(init, at, depth + 1);
    }
    return undefined;
  }

  /** One Env per row of every literal `for … of` loop around `at` (innermost last). */
  envs(at: ts.Node): Env[] {
    let out: Map<string, ts.Expression>[] = [new Map()];
    const loops: ts.ForOfStatement[] = [];
    for (let n: ts.Node | undefined = at.parent; n; n = n.parent)
      if (
        ts.isForOfStatement(n) &&
        n.statement.pos <= at.pos &&
        at.end <= n.statement.end
      )
        loops.unshift(n);
    for (const loop of loops) {
      const init = loop.initializer;
      if (!ts.isVariableDeclarationList(init) || init.declarations.length !== 1) continue;
      const rows = this.list(loop.expression, loop);
      if (!rows) continue;
      const slots = bindingSlots(init.declarations[0].name);
      const next: Map<string, ts.Expression>[] = [];
      for (const env of out)
        for (const row of rows) {
          const e = new Map(env);
          const r = strip(row);
          for (const { name, slot } of slots) {
            if (slot === null) e.set(name, r);
            else if (typeof slot === "number" && ts.isArrayLiteralExpression(r)) {
              const v = r.elements[slot];
              if (v) e.set(name, v);
            } else if (typeof slot === "string" && ts.isObjectLiteralExpression(r)) {
              const p = r.properties.find(
                (q) =>
                  ts.isPropertyAssignment(q) &&
                  (ts.isIdentifier(q.name) || ts.isStringLiteral(q.name)) &&
                  q.name.text === slot
              ) as ts.PropertyAssignment | undefined;
              if (p) e.set(name, p.initializer);
            }
          }
          next.push(e);
        }
      out = next.slice(0, 500);
    }
    return out;
  }

  /** The strings (as PathValues) `e` may be; undefined when it cannot be read. */
  values(e: ts.Expression, at: ts.Node, env: Env, depth = 0): PathValue[] | undefined {
    if (depth > 8) return undefined;
    const x = strip(e);
    if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return [[x.text]];
    // null: no request at all (a section that reads for itself: `… ? SECTION_READS[id] : null`).
    if (x.kind === ts.SyntaxKind.NullKeyword) return [];
    if (ts.isTemplateExpression(x)) {
      const parts: (string | null)[] = [x.head.text];
      for (const span of x.templateSpans) parts.push(null, span.literal.text);
      return [parts.filter((p) => p !== "")];
    }
    if (ts.isConditionalExpression(x)) {
      const a = this.values(x.whenTrue, at, env, depth + 1);
      const b = this.values(x.whenFalse, at, env, depth + 1);
      return a && b ? [...a, ...b] : undefined;
    }
    if (
      ts.isBinaryExpression(x) &&
      x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      const a = this.values(x.left, at, env, depth + 1);
      const b = this.values(x.right, at, env, depth + 1);
      return a && b ? [...a, ...b] : undefined;
    }
    if (ts.isIdentifier(x)) {
      const bound = env.get(x.text);
      if (bound) return this.values(bound, at, env, depth + 1);
      const init = this.declaration(x.text, at);
      return init ? this.values(init, at, env, depth + 1) : undefined;
    }
    if (ts.isCallExpression(x) && ts.isIdentifier(x.expression)) {
      // A call of the file's own function, or of one it imports from another client module:
      // whatever it returns, read in its own file.
      const name = x.expression.text;
      const own = this.fn(name);
      const home: Reader | undefined = own
        ? this
        : this.imports(name)
          ? this.elsewhere?.(name)
          : undefined;
      const fn = own ?? home?.fn(name);
      const rets = fn && home ? home.returns(fn) : [];
      if (!fn || !home || !rets.length) return undefined;
      const all: PathValue[] = [];
      for (const ret of rets) {
        const v = home.values(ret, ret, new Map(), depth + 1);
        if (!v) return undefined;
        all.push(...v);
      }
      return all;
    }
    const object = (o: ts.Expression) => {
      const s = strip(o);
      if (ts.isObjectLiteralExpression(s)) return s;
      if (ts.isIdentifier(s)) {
        const init = this.declaration(s.text, at);
        if (init && ts.isObjectLiteralExpression(strip(init)))
          return strip(init) as ts.ObjectLiteralExpression;
      }
      return undefined;
    };
    if (ts.isElementAccessExpression(x)) {
      // MAP[key]: any of the map's values.
      const o = object(x.expression);
      if (!o) return undefined;
      const all: PathValue[] = [];
      for (const p of o.properties) {
        if (!ts.isPropertyAssignment(p)) return undefined;
        const v = this.values(p.initializer, at, env, depth + 1);
        if (!v) return undefined;
        all.push(...v);
      }
      return all;
    }
    if (ts.isPropertyAccessExpression(x)) {
      const o = object(x.expression);
      const p = o?.properties.find(
        (q) =>
          ts.isPropertyAssignment(q) &&
          (ts.isIdentifier(q.name) || ts.isStringLiteral(q.name)) &&
          q.name.text === x.name.text
      ) as ts.PropertyAssignment | undefined;
      return p ? this.values(p.initializer, at, env, depth + 1) : undefined;
    }
    return undefined;
  }

  /** The single string `e` is, when it is one. */
  text(e: ts.Expression, at: ts.Node, env: Env): string[] | undefined {
    const v = this.values(e, at, env);
    if (!v || v.some((p) => p.length !== 1 || p[0] === null)) return undefined;
    return v.map((p) => p[0] as string);
  }
}

/** Whether `e` reads a request's URL or pathname (or a name bound to one in `aliases`). */
function urlish(
  e: ts.Expression,
  sf: ts.SourceFile,
  aliases: ReadonlySet<string>
): boolean {
  const x = strip(e);
  if (ts.isIdentifier(x)) return aliases.has(x.text);
  const t = x.getText(sf);
  return /\.pathname$|\.url\(\)$|\.href$/.test(t);
}

const isMethodRead = (e: ts.Expression, sf: ts.SourceFile) =>
  /\.method\(\)$/.test(strip(e).getText(sf));

/** Whether `n` sits under a negation (`!…`) within `root`. */
function negated(n: ts.Node, root: ts.Node): boolean {
  for (let p: ts.Node | undefined = n.parent; p && p !== root; p = p.parent)
    if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken)
      return true;
  return false;
}

/** The function a wait's first argument is: inline, or a const of the file. */
function predicateOf(
  arg: ts.Expression,
  r: Reader
): ts.FunctionLikeDeclaration | undefined {
  const x = strip(arg);
  if (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) return x;
  if (ts.isIdentifier(x)) {
    const init = r.declaration(x.text, x);
    if (init && (ts.isArrowFunction(strip(init)) || ts.isFunctionExpression(strip(init))))
      return strip(init) as ts.FunctionLikeDeclaration;
  }
  return undefined;
}

export interface SpecScan {
  readonly targets: Target[];
  /** `<file>: <expression>` for each target the scan could not read, with its line. */
  readonly unread: { key: string; line: number }[];
  /** Each wait that names no method (by URL alone, or a predicate with no method compared). */
  readonly unnamed: { file: string; line: number; targets: Target[] }[];
}

/** The requests the specs wait for and make. */
export function specTargets(specs: readonly SourceText[]): SpecScan {
  const targets: Target[] = [];
  const unread: { key: string; line: number }[] = [];
  const unnamed: { file: string; line: number; targets: Target[] }[] = [];
  for (const { file, text } of specs) {
    const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const r = new Reader(sf);
    /** A helper's path parameter: the paths its callers in the file pass (all, or none read). */
    const fromCallers = (
      e: ts.Expression,
      at: ts.Node,
      env: Env
    ): PathValue[] | undefined => {
      const x = strip(e);
      if (!ts.isIdentifier(x) || env.has(x.text)) return undefined;
      const fn = r.parameterOf(x.text, at);
      const name = fn && functionName(fn);
      if (!fn || !name) return undefined;
      const index = fn.parameters.findIndex((p) =>
        bindingSlots(p.name).some((b) => b.name === x.text)
      );
      const out: PathValue[] = [];
      let calls = 0;
      let unreadable = false;
      const visit = (n: ts.Node): void => {
        if (
          ts.isCallExpression(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === name &&
          n.arguments[index]
        ) {
          calls++;
          for (const callEnv of r.envs(n)) {
            const v = r.values(n.arguments[index], n, callEnv);
            if (v) out.push(...v);
            else unreadable = true;
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
      return calls && !unreadable ? out : undefined;
    };
    const add = (
      at: ts.Node,
      kind: Target["kind"],
      mode: Target["mode"],
      pathExpr: ts.Expression,
      methods: (string | null)[],
      env: Env
    ) => {
      const paths = r.values(pathExpr, at, env) ?? fromCallers(pathExpr, at, env);
      if (!paths) {
        unread.push({
          key: `${file}: ${strip(pathExpr).getText(sf)}`,
          line: lineOf(sf, at),
        });
        return;
      }
      for (const path of paths) {
        const s = sample(path);
        if (!s.includes("/api/")) continue;
        // A path built on an origin (`${base}/api/…`): from its /api/ on.
        const i = path.findIndex((p) => p !== null && p.includes("/api/"));
        const from: PathValue = [
          (path[i] as string).slice((path[i] as string).indexOf("/api/")),
          ...path.slice(i + 1),
        ];
        for (const method of methods)
          targets.push({ file, line: lineOf(sf, at), kind, mode, path: from, method });
      }
    };
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const name = n.expression.name.text;
        const receiver = n.expression.expression.getText(sf);
        // 1. Waits.
        if ((name === "waitForResponse" || name === "waitForRequest") && n.arguments[0]) {
          const arg = strip(n.arguments[0]);
          for (const env of r.envs(n)) {
            if (
              ts.isStringLiteral(arg) ||
              ts.isTemplateExpression(arg) ||
              ts.isIdentifier(arg)
            ) {
              const fn = ts.isIdentifier(arg) ? predicateOf(arg, r) : undefined;
              if (!fn) {
                // By URL alone: it names no method.
                const from = targets.length;
                add(n, "wait", "endsWith", arg, [null], env);
                unnamed.push({ file, line: lineOf(sf, n), targets: targets.slice(from) });
                continue;
              }
            }
            const fn = predicateOf(arg, r);
            if (!fn || !fn.body) {
              unread.push({ key: `${file}: ${arg.getText(sf)}`, line: lineOf(sf, n) });
              continue;
            }
            const aliases = new Set<string>();
            const paths: [Target["mode"], ts.Expression, ts.Node][] = [];
            const methods: string[] = [];
            const look = (m: ts.Node): void => {
              if (
                ts.isVariableDeclaration(m) &&
                ts.isIdentifier(m.name) &&
                m.initializer &&
                urlish(m.initializer, sf, aliases)
              )
                aliases.add(m.name.text);
              if (
                ts.isBinaryExpression(m) &&
                (m.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
                  m.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken) &&
                !negated(m, fn)
              ) {
                for (const [a, b] of [
                  [m.left, m.right],
                  [m.right, m.left],
                ]) {
                  if (urlish(a, sf, aliases)) paths.push(["equals", b, m]);
                  if (isMethodRead(a, sf)) {
                    const t = r.text(b, m, env);
                    if (t) methods.push(...t);
                  }
                }
              }
              if (
                ts.isCallExpression(m) &&
                ts.isPropertyAccessExpression(m.expression) &&
                ["endsWith", "includes", "startsWith"].includes(m.expression.name.text) &&
                m.arguments[0] &&
                urlish(m.expression.expression, sf, aliases) &&
                !negated(m, fn)
              )
                paths.push([m.expression.name.text as Target["mode"], m.arguments[0], m]);
              ts.forEachChild(m, look);
            };
            look(fn.body);
            if (paths.length === 0)
              unread.push({ key: `${file}: ${arg.getText(sf)}`, line: lineOf(sf, n) });
            const from = targets.length;
            for (const [mode, expr, at] of paths)
              add(at, "wait", mode, expr, methods.length ? methods : [null], env);
            if (methods.length === 0)
              unnamed.push({ file, line: lineOf(sf, n), targets: targets.slice(from) });
          }
        }
        // 2. Direct calls on a request context: request.get(path), page.request.fetch(path, …).
        if (/(?:^|\.)request$/.test(receiver) && n.arguments[0]) {
          const verb = name.toUpperCase();
          const arg = strip(n.arguments[0]);
          const helperBody = ts.isIdentifier(arg) && r.parameterOf(arg.text, n);
          if (!helperBody && (METHODS.includes(verb) || name === "fetch"))
            for (const env of r.envs(n)) {
              let methods: (string | null)[] = [METHODS.includes(verb) ? verb : "GET"];
              if (name === "fetch") {
                const init = n.arguments[1] && strip(n.arguments[1]);
                const prop =
                  init && ts.isObjectLiteralExpression(init)
                    ? (init.properties.find(
                        (p) =>
                          ts.isPropertyAssignment(p) &&
                          ts.isIdentifier(p.name) &&
                          p.name.text === "method"
                      ) as ts.PropertyAssignment | undefined)
                    : undefined;
                methods = prop ? (r.text(prop.initializer, n, env) ?? [null]) : ["GET"];
              }
              add(n, "call", "equals", arg, methods, env);
            }
        }
      }
      // 2. Direct calls through a helper: a method, then a path (`apiFetch(req, who, "GET", p)`).
      if (ts.isCallExpression(n) && n.arguments.length >= 2) {
        const callee = n.expression.getText(sf);
        if (!/waitFor|\.request\.|^request\./.test(callee))
          for (const env of r.envs(n))
            n.arguments.forEach((a, i) => {
              const next = n.arguments[i + 1];
              if (!next) return;
              const m = r.text(a, n, env);
              if (!m || !m.every((x) => METHODS.includes(x))) return;
              const p = strip(next);
              if (ts.isIdentifier(p) && r.parameterOf(p.text, n) && !env.has(p.text))
                return;
              add(n, "call", "equals", next, m, env);
            });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { targets, unread, unnamed };
}

/**
 * How a request's method is given, as far as the scan reads it: known methods (null: unreadable),
 * or a parameter of the enclosing function — a method string, or a RequestInit whose `method` it
 * gives (GET when its caller passes none) — resolved at that function's callers.
 */
type MethodSpec =
  | { readonly kind: "fixed"; readonly methods: readonly (string | null)[] }
  | { readonly kind: "param"; readonly index: number }
  /** An options parameter whose `method` is sent; `fallback` when the caller's gives none. */
  | { readonly kind: "init"; readonly index: number; readonly fallback: string };
/** How a request's path is given: read values, or a parameter of the enclosing function. */
type PathSpec =
  | { readonly kind: "fixed"; readonly values: readonly PathValue[] }
  | { readonly kind: "param"; readonly index: number }
  | { readonly kind: "unread" };
/**
 * The function whose parameter a spec reads — not always the nearest enclosing one: a parameter
 * read inside a callback (an effect, a `.then`) is still its own function's (TASK-216: the
 * console's panel reads call adminCall inside useCallback).
 */
type Owned<T> = T & { readonly owner?: ts.FunctionLikeDeclaration };

/** A spec without the function it was read from (helpers are compared as JSON). */
function bare<T extends object>(spec: Owned<T>): T {
  const { owner: _owner, ...rest } = spec;
  void _owner;
  return rest as T;
}

/** A function that sends a request with a path or method its callers give. */
interface Helper {
  readonly path: PathSpec;
  readonly method: MethodSpec;
}

/** The requests the client modules send (path and method, as far as they can be read). */
export function clientRequests(clients: readonly SourceText[]): Sent[] {
  const parsed = clients.map(({ file, text }) => ({
    file,
    sf: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
  }));
  /** Helpers by `<file>#<name>`, and by name alone (for a helper imported from another module). */
  const helpers = new Map<string, Helper[]>();
  const helperOf = (file: string, name: string): Helper[] | undefined =>
    helpers.get(`${file}#${name}`) ??
    (() => {
      const all = [...helpers.entries()].filter(([k]) => k.endsWith(`#${name}`));
      return all.length === 1 ? all[0][1] : undefined;
    })();

  // Each exported function's module, where exactly one client module exports that name.
  const readers = new Map<string, Reader>();
  const exporters = new Map<string, Reader[]>();
  const elsewhere = (name: string) => {
    const by = exporters.get(name);
    return by?.length === 1 ? by[0] : undefined;
  };
  for (const { file, sf } of parsed) {
    const reader = new Reader(sf, elsewhere);
    readers.set(file, reader);
    for (const name of reader.exportedFunctions())
      exporters.set(name, [...(exporters.get(name) ?? []), reader]);
  }

  let sent: Sent[] = [];
  for (let pass = 0; pass < 8; pass++) {
    sent = [];
    let grew = false;
    const addHelper = (key: string, h: Helper) => {
      const list = helpers.get(key) ?? [];
      if (list.some((x) => JSON.stringify(x) === JSON.stringify(h))) return;
      helpers.set(key, [...list, h]);
      grew = true;
    };
    for (const { file } of parsed) {
      const r = readers.get(file)!;
      const sf = r.sf;
      /** The parameter index `e` names in the function enclosing `at`, with that function. */
      const param = (e: ts.Expression | undefined, at: ts.Node) => {
        const x = e && strip(e);
        if (!x || !ts.isIdentifier(x)) return undefined;
        const fn = r.parameterOf(x.text, at);
        if (!fn) return undefined;
        const index = fn.parameters.findIndex((q) =>
          bindingSlots(q.name).some((s) => s.name === x.text)
        );
        return { fn, index };
      };
      const methodExpr = (e: ts.Expression, at: ts.Node, env: Env): Owned<MethodSpec> => {
        const t = r.text(e, at, env);
        if (t) return { kind: "fixed", methods: t.map((m) => m.toUpperCase()) };
        const p = param(e, at);
        if (p) return { kind: "param", index: p.index, owner: p.fn };
        // An options parameter's own method — `options.method`, or `options.method ?? "GET"`:
        // the method its caller's argument gives, or the fallback when it gives none (TASK-216:
        // adminCall).
        let x = strip(e);
        let fallback = "GET";
        if (
          ts.isBinaryExpression(x) &&
          x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ) {
          const f = r.text(x.right, at, env);
          if (f?.length !== 1) return { kind: "fixed", methods: [null] };
          fallback = f[0].toUpperCase();
          x = strip(x.left);
        }
        if (ts.isPropertyAccessExpression(x) && x.name.text === "method") {
          const o = param(x.expression, at);
          if (o) return { kind: "init", index: o.index, fallback, owner: o.fn };
        }
        return { kind: "fixed", methods: [null] };
      };
      const initSpec = (
        e: ts.Expression | undefined,
        at: ts.Node,
        env: Env,
        depth = 0,
        fallback = "GET"
      ): Owned<MethodSpec> => {
        if (!e) return { kind: "fixed", methods: [fallback] };
        const o = strip(e);
        if (ts.isIdentifier(o)) {
          const p = param(o, at);
          if (p) return { kind: "init", index: p.index, fallback, owner: p.fn };
          const init = depth < 4 ? r.declaration(o.text, at) : undefined;
          return init
            ? initSpec(init, at, env, depth + 1, fallback)
            : { kind: "fixed", methods: [null] };
        }
        if (!ts.isObjectLiteralExpression(o)) return { kind: "fixed", methods: [null] };
        const prop = o.properties.find(
          (q) =>
            (ts.isPropertyAssignment(q) || ts.isShorthandPropertyAssignment(q)) &&
            ts.isIdentifier(q.name) &&
            q.name.text === "method"
        );
        if (prop)
          return methodExpr(
            ts.isShorthandPropertyAssignment(prop)
              ? prop.name
              : (prop as ts.PropertyAssignment).initializer,
            at,
            env
          );
        const spreads = o.properties.filter(ts.isSpreadAssignment);
        if (spreads.length === 0) return { kind: "fixed", methods: [fallback] };
        if (spreads.length === 1)
          return initSpec(spreads[0].expression, at, env, depth + 1, fallback);
        return { kind: "fixed", methods: [null] };
      };
      /** A helper's spec at one call: the caller's arguments put in for its parameters. */
      const atCall = (
        h: Helper,
        args: readonly ts.Expression[],
        at: ts.Node,
        env: Env
      ) => {
        let path: Owned<PathSpec>;
        if (h.path.kind === "param") {
          const e = args[h.path.index];
          const v = e ? r.values(e, at, env) : undefined;
          const p = v ? undefined : param(e, at);
          path = v
            ? { kind: "fixed", values: v }
            : p
              ? { kind: "param", index: p.index, owner: p.fn }
              : { kind: "unread" };
        } else path = h.path;
        let method: Owned<MethodSpec>;
        if (h.method.kind === "param") {
          const e = args[h.method.index];
          method = e ? methodExpr(e, at, env) : { kind: "fixed", methods: [null] };
        } else if (h.method.kind === "init")
          method = initSpec(args[h.method.index], at, env, 0, h.method.fallback);
        else method = h.method;
        return { path, method };
      };
      const visit = (n: ts.Node): void => {
        if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && n.arguments?.[0]) {
          const callee = ts.isIdentifier(n.expression)
            ? n.expression.text
            : ts.isPropertyAccessExpression(n.expression)
              ? n.expression.name.text
              : "";
          const args = n.arguments;
          const specs: Helper[] = [];
          if (ts.isNewExpression(n) && callee === "EventSource")
            specs.push({
              path: { kind: "param", index: 0 },
              method: { kind: "fixed", methods: ["GET"] },
            });
          else if (ts.isCallExpression(n) && callee === "sendBeacon")
            specs.push({
              path: { kind: "param", index: 0 },
              method: { kind: "fixed", methods: ["POST"] },
            });
          else if (ts.isCallExpression(n) && /fetch/i.test(callee))
            specs.push({
              path: { kind: "param", index: 0 },
              method: { kind: "init", index: 1, fallback: "GET" },
            });
          else if (ts.isCallExpression(n)) specs.push(...(helperOf(file, callee) ?? []));
          for (const h of specs)
            for (const env of r.envs(n)) {
              const { path, method } = atCall(h, args, n, env);
              if (path.kind === "param" || method.kind !== "fixed") {
                // Given by its function's callers — the function whose parameter it is, however
                // deep in a callback the request is sent: a helper, read at each call (a
                // fetch-named one is already read as fetch(path, init) where it is called). A
                // path and a method from two different functions' parameters cannot be.
                const owners = [path.owner, method.owner].filter(
                  (o): o is ts.FunctionLikeDeclaration => o !== undefined
                );
                const owner = owners.every((o) => o === owners[0])
                  ? owners[0]
                  : undefined;
                const name = owner && functionName(owner);
                if (name && !/fetch/i.test(name)) {
                  addHelper(`${file}#${name}`, {
                    path: bare(path),
                    method: bare(method),
                  });
                  continue;
                }
              }
              if (path.kind !== "fixed") continue;
              const methods = method.kind === "fixed" ? method.methods : [null];
              for (const v of path.values)
                for (const m of methods) sent.push({ file, path: v, method: m });
            }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    if (!grew) break;
  }
  return sent;
}

/** The API routes: each route file's path (as a pattern) and the methods it exports. */
export function apiRoutes(
  files: readonly SourceText[]
): { rx: RegExp; methods: string[] }[] {
  return files.map(({ file, text }) => {
    const dir = file.replace(/^app/, "").replace(/\/route\.tsx?$/, "");
    const rx = dir
      .split("/")
      .filter((s) => s && !/^\(.*\)$/.test(s))
      .map((s) =>
        /^\[\[?\.\.\./.test(s) ? ".+" : /^\[.*\]$/.test(s) ? "[^/]+" : escapeRx(s)
      )
      .join("/");
    return {
      rx: new RegExp(`^/${rx}/?$`),
      methods: routeMethods(text, file).map((m) => m.method),
    };
  });
}

/** Whether a client request `s` answers the spec's target `t`. */
function answers(t: Target, s: Sent): boolean {
  if (t.method !== null && s.method !== null && t.method !== s.method) return false;
  const full = sample(s.path);
  const bare = noQuery(full);
  const want = pathRx(t.path);
  switch (t.mode) {
    case "equals":
      return (
        new RegExp(`^${want}$`).test(bare) ||
        new RegExp(`^${noQuery(pathRx(s.path))}$`).test(noQuery(sample(t.path)))
      );
    case "endsWith":
      return new RegExp(`${want}$`).test(bare) || new RegExp(`${want}$`).test(full);
    case "startsWith":
      return new RegExp(`^${want}`).test(full);
    case "includes":
      return new RegExp(want).test(full);
  }
}

/**
 * Every finding: a wait no client request answers, a call no route serves, a target the scan
 * cannot read that ALLOWED does not name, and an ALLOWED entry that names nothing.
 */
export function awaitedRequestFindings(
  specs: readonly SourceText[],
  clients: readonly SourceText[],
  routes: readonly SourceText[],
  allowed: Readonly<Record<string, string>> = ALLOWED,
  anyMethod: Readonly<Record<string, string>> = ANY_METHOD
): string[] {
  const { targets, unread, unnamed } = specTargets(specs);
  const sent = clientRequests(clients);
  const served = apiRoutes(routes);
  const out = new Set<string>();
  // A wait must name its method: one that names none is answered by any request to its path,
  // so it passes while the screen sends that path with another method (56c3's blind spot).
  const byWait = new Map<string, Set<string>>();
  for (const u of unnamed) {
    const key = `${u.file}:${u.line}`;
    const methods = byWait.get(key) ?? new Set<string>();
    for (const t of u.targets)
      for (const s of sent)
        if (answers({ ...t, method: null }, s))
          methods.add(s.method ?? "a method the scan cannot read");
    byWait.set(key, methods);
  }
  for (const [key, methods] of byWait)
    out.add(
      `${key}: a wait that names no method — compare r.request().method() with the one the screen sends${
        methods.size ? ` (here: ${[...methods].sort().join(" or ")})` : ""
      }`
    );
  // A client request whose method cannot be read matches any method: each one is listed.
  const anyKeys = new Set<string>();
  for (const s of sent)
    if (s.method === null && sample(s.path).includes("/api/")) {
      const key = `${s.file}: ${pathSource(s.path)}`;
      anyKeys.add(key);
      if (!(key in anyMethod))
        out.add(
          `${key}: a request whose method the scan cannot read (it would answer a wait for any method) — make it readable, or list it in ANY_METHOD with why`
        );
    }
  for (const key of Object.keys(anyMethod))
    if (!anyKeys.has(key))
      out.add(`ANY_METHOD "${key}": names no request with an unread method — remove it`);
  for (const t of targets) {
    const what = `${t.method ?? "any method"} ${pathSource(t.path)}`;
    if (t.kind === "wait" && !sent.some((s) => answers(t, s)))
      out.add(
        `${t.file}:${t.line}: waits for ${what} (${t.mode}) — no screen or client module sends it`
      );
    if (t.kind === "call") {
      const p = noQuery(sample(t.path));
      const route = served.filter((r) => r.rx.test(p));
      if (!route.length)
        out.add(`${t.file}:${t.line}: calls ${what} — no route file serves it`);
      else if (t.method !== null && !route.some((r) => r.methods.includes(t.method!)))
        out.add(`${t.file}:${t.line}: calls ${what} — its route exports no ${t.method}`);
    }
  }
  for (const u of unread)
    if (!(u.key in allowed))
      out.add(
        `${u.key} (line ${u.line}): a request path the scan cannot read — not in ALLOWED`
      );
  const used = new Set(unread.map((u) => u.key));
  for (const key of Object.keys(allowed))
    if (!used.has(key))
      out.add(`ALLOWED "${key}": names no unreadable target — remove it`);
  return [...out].sort();
}

const read = (p: string): SourceText => ({ file: rel(p), text: readFileSync(p, "utf8") });
const isSource = (n: string) => /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n);

function repoSpecs(): SourceText[] {
  return SPEC_DIRS.flatMap((d) => walkFiles(join(ROOT, d), isSource)).map(read);
}
function repoClients(): SourceText[] {
  return CLIENT_DIRS.flatMap((d) => walkFiles(join(ROOT, d), isSource))
    .filter((p) => !/[\\/]__tests__[\\/]/.test(p) && !rel(p).startsWith("app/api/"))
    .map(read);
}
function repoRoutes(): SourceText[] {
  const api = join(ROOT, "app", "api");
  return existsSync(api) ? walkFiles(api, (n) => /^route\.tsx?$/.test(n)).map(read) : [];
}

describe("browser specs wait for requests the app makes (TASK-217)", () => {
  const specs = repoSpecs();
  const clients = repoClients();
  const routes = repoRoutes();

  it("reads the specs' waits and calls, and the screens' requests (self-test before any absence counts)", () => {
    const { targets } = specTargets(specs);
    expect(targets.filter((t) => t.kind === "wait").length).toBeGreaterThan(20);
    expect(targets.filter((t) => t.kind === "call").length).toBeGreaterThan(20);
    expect(clientRequests(clients).length).toBeGreaterThan(40);
    expect(routes.length).toBeGreaterThan(40);
  });

  it("every awaited request is sent by a screen, and every called route serves its method", () => {
    expect(awaitedRequestFindings(specs, clients, routes)).toEqual([]);
  });

  it("[self-test] reports a wait for a request the screen no longer makes (56c's Journey C), and passes the one it makes", () => {
    const spec = (body: string): SourceText => ({
      file: "e2e-live/planted.spec.ts",
      text: body,
    });
    const screen: SourceText = {
      file: "components/admin/Planted.tsx",
      text: [
        `void apiFetch("/api/admin/users/search", { method: "POST", body: "{}" });`,
        `await apiFetch("/api/admin/users", { method: "PATCH", body: "{}" });`,
      ].join("\n"),
    };
    const stale = spec(
      `const users = page.waitForResponse(\n  (r) =>\n    new URL(r.url()).pathname === "/api/admin/users" && r.request().method() === "GET"\n);`
    );
    expect(awaitedRequestFindings([stale], [screen], [], {})).toEqual([
      "e2e-live/planted.spec.ts:3: waits for GET /api/admin/users (equals) — no screen or client module sends it",
    ]);
    const current = spec(
      `const SEARCH = "/api/admin/users/search";\nconst users = page.waitForResponse(\n  (r) => new URL(r.url()).pathname === SEARCH && r.request().method() === "POST"\n);`
    );
    expect(awaitedRequestFindings([current], [screen], [], {})).toEqual([]);
  });

  it("[self-test] reads loops, maps, templates and helpers; reports an unserved call, an unreadable path and an unused ALLOWED entry", () => {
    const specs: SourceText[] = [
      {
        file: "e2e/planted.spec.ts",
        text: [
          `const ROWS = [["a", "/api/x"], ["b", "/api/y"]] as const;`,
          `for (const [, path] of ROWS) {`,
          `  const read = page.waitForResponse((r) => { const p = new URL(r.url()).pathname; return p === path; });`,
          `}`,
          `page.waitForResponse((r) => r.url().includes("/api/items/") && r.request().method() === "DELETE");`,
          `const got = await apiFetch(request, ADMIN, "PUT", "/api/items/7");`,
          `const res = await request.post("/api/gone");`,
          `page.waitForResponse((r) => new URL(r.url()).pathname === somewhere());`,
        ].join("\n"),
      },
    ];
    const clients: SourceText[] = [
      {
        file: "app/admin/page.tsx",
        text: [
          `const ENDPOINTS: Record<string, string> = { x: "/api/x?offset=0" };`,
          `const endpoint = ENDPOINTS[panel];`,
          `const res = await apiFetch(endpoint);`,
          `function remove(url: string) { return fetch(url, { method: "DELETE" }); }`,
          "remove(`/api/items/${id}`);",
        ].join("\n"),
      },
    ];
    const routes: SourceText[] = [
      { file: "app/api/items/[id]/route.ts", text: "export async function GET() {}" },
    ];
    expect(
      awaitedRequestFindings(specs, clients, routes, {
        "e2e/planted.spec.ts: ROWS": "planted",
      })
    ).toEqual([
      'ALLOWED "e2e/planted.spec.ts: ROWS": names no unreadable target — remove it',
      "e2e/planted.spec.ts: somewhere() (line 8): a request path the scan cannot read — not in ALLOWED",
      "e2e/planted.spec.ts:3: a wait that names no method — compare r.request().method() with the one the screen sends (here: GET)",
      "e2e/planted.spec.ts:3: waits for any method /api/y (equals) — no screen or client module sends it",
      "e2e/planted.spec.ts:6: calls PUT /api/items/7 — its route exports no PUT",
      "e2e/planted.spec.ts:7: calls POST /api/gone — no route file serves it",
      "e2e/planted.spec.ts:8: a wait that names no method — compare r.request().method() with the one the screen sends",
    ]);
  });
  it("[self-test] a wait must name its method: the pre-56c sections row (no method, a path the screen still PATCHes) is caught (TASK-218)", () => {
    // 56c3's planted check: e2e/admin-routes.spec.ts's Users row put back to /api/admin/users, with
    // the loop's wait naming no method, passed — the Users screen still sends PATCH there.
    const screen: SourceText = {
      file: "components/admin/UsersPanel.tsx",
      text: [
        `void apiFetch("/api/admin/users/search", { method: "POST", body: "{}" });`,
        `await apiFetch("/api/admin/users", { method: "PATCH", body: "{}" });`,
      ].join("\n"),
    };
    const loop = (rows: string, check: string): SourceText => ({
      file: "e2e/admin-routes.spec.ts",
      text: [
        `const sections = [${rows}] as const;`,
        `for (const [name, method, path] of sections) {`,
        `  const read = page.waitForResponse((r) => new URL(r.url()).pathname === path${check});`,
        `}`,
      ].join("\n"),
    });
    const preFix = loop(`[/^Users$/, "GET", "/api/admin/users"]`, "");
    expect(awaitedRequestFindings([preFix], [screen], [], {})).toEqual([
      "e2e/admin-routes.spec.ts:3: a wait that names no method — compare r.request().method() with the one the screen sends (here: PATCH)",
    ]);
    const stale = loop(
      `[/^Users$/, "GET", "/api/admin/users"]`,
      " && r.request().method() === method"
    );
    expect(awaitedRequestFindings([stale], [screen], [], {})).toEqual([
      "e2e/admin-routes.spec.ts:3: waits for GET /api/admin/users (equals) — no screen or client module sends it",
    ]);
    const current = loop(
      `[/^Users$/, "POST", "/api/admin/users/search"]`,
      " && r.request().method() === method"
    );
    expect(awaitedRequestFindings([current], [screen], [], {})).toEqual([]);
    // A wait by URL alone (a string or glob) names no method either.
    const byUrl: SourceText = {
      file: "e2e/url.spec.ts",
      text: `const read = page.waitForResponse("**/api/admin/users/search");`,
    };
    expect(awaitedRequestFindings([byUrl], [screen], [], {})).toEqual([
      "e2e/url.spec.ts:1: a wait that names no method — compare r.request().method() with the one the screen sends (here: POST)",
    ]);
    // A predicate the scan cannot read is a finding, not a pass.
    const opaque: SourceText = {
      file: "e2e/opaque.spec.ts",
      text: `const read = page.waitForResponse(isUsersRead(path));`,
    };
    expect(awaitedRequestFindings([opaque], [screen], [], {})).toEqual([
      "e2e/opaque.spec.ts: isUsersRead(path) (line 1): a request path the scan cannot read — not in ALLOWED",
    ]);
  });

  it("[self-test] a client request's method is read through helpers' method and init parameters; one it cannot read must be listed (TASK-218)", () => {
    const session: SourceText = {
      file: "platform/auth/context.tsx",
      text: [
        `function askSession(method: "GET" | "POST") {`,
        `  return fetch("/api/auth/session", { method, credentials: "same-origin" });`,
        `}`,
        `async function readSession(method: "GET" | "POST") { return askSession(method); }`,
        `readSession("GET");`,
        `readSession("POST");`,
      ].join("\n"),
    };
    const panel: SourceText = {
      file: "components/admin/JobsPanels.tsx",
      text: [
        `async function call(url: string, init?: RequestInit) {`,
        `  return apiFetch(url, { ...init, headers: { a: "b" } });`,
        `}`,
        `const act = async (label: string, url: string, init: RequestInit) => call(url, init);`,
        `call("/api/operator/jobs");`,
        'act("x", `/api/operator/jobs/${id}/run`, { method: "POST" });',
      ].join("\n"),
    };
    const sent = clientRequests([session, panel]).map(
      (x) => `${x.method} ${x.path.map((p) => p ?? "*").join("")}`
    );
    expect([...new Set(sent)].sort()).toEqual([
      "GET /api/auth/session",
      "GET /api/operator/jobs",
      "POST /api/auth/session",
      "POST /api/operator/jobs/*/run",
    ]);
    const waitFor = (method: string): SourceText => ({
      file: "e2e/s.spec.ts",
      text: `page.waitForResponse((r) => r.url().endsWith("/api/auth/session") && r.request().method() === "${method}");`,
    });
    expect(awaitedRequestFindings([waitFor("POST")], [session], [], {}, {})).toEqual([]);
    expect(awaitedRequestFindings([waitFor("DELETE")], [session], [], {}, {})).toEqual([
      "e2e/s.spec.ts:1: waits for DELETE /api/auth/session (endsWith) — no screen or client module sends it",
    ]);
    // A method the scan cannot read answers any wait, so it is a finding until listed with why;
    // a listed entry that names nothing is a finding too.
    const opaque: SourceText = {
      file: "components/X.tsx",
      text: `void apiFetch("/api/x", { method: pickMethod() });`,
    };
    expect(awaitedRequestFindings([], [opaque], [], {}, {})).toEqual([
      "components/X.tsx: /api/x: a request whose method the scan cannot read (it would answer a wait for any method) — make it readable, or list it in ANY_METHOD with why",
    ]);
    expect(
      awaitedRequestFindings(
        [],
        [opaque],
        [],
        {},
        { "components/X.tsx: /api/x": "planted" }
      )
    ).toEqual([]);
    expect(
      awaitedRequestFindings(
        [],
        [session],
        [],
        {},
        { "components/X.tsx: /api/x": "planted" }
      )
    ).toEqual([
      'ANY_METHOD "components/X.tsx: /api/x": names no request with an unread method — remove it',
    ]);
  });

  it("[self-test] an options parameter's method, and a parameter read inside a callback, are followed to the callers (TASK-216)", () => {
    // The console's call helper and its panel reads, as written: `options.method ?? "GET"`, and
    // the call made inside useCallback — a parameter of the hook, not of the callback.
    const call: SourceText = {
      file: "components/admin/ui/admin-call.ts",
      text: [
        `export async function adminCall(url: string, options: CallOptions = {}) {`,
        `  return apiFetch(url, { method: options.method ?? "GET", ...(options.json ? { body: "" } : {}) });`,
        `}`,
      ].join("\n"),
    };
    const panel: SourceText = {
      file: "components/admin/ui/PanelState.tsx",
      text: [
        `export function usePanelRead(url: string | null, again: unknown = 0) {`,
        `  const send = useCallback(() => (url === null ? null : adminCall(url)), [url]);`,
        `  return usePanelAnswer(send, again);`,
        `}`,
        `export function usePanelSearch(url: string, body: string, again: unknown = 0) {`,
        `  const send = useCallback(() => adminCall(url, { method: "POST", json: JSON.parse(body) }), [url, body]);`,
        `  return usePanelAnswer(send, again);`,
        `}`,
      ].join("\n"),
    };
    const screens: SourceText = {
      file: "components/admin/Screens.tsx",
      text: [
        `usePanelRead("/api/admin/tenant", 0);`,
        `usePanelSearch("/api/admin/users/search", "{}", 0);`,
        `void adminCall("/api/admin/users", { method: "PATCH", json: {} });`,
        `void adminCall("/api/admin/gdpr?userId=1");`,
      ].join("\n"),
    };
    const sent = clientRequests([call, panel, screens]).map(
      (x) => `${x.method} ${x.path.map((p) => p ?? "*").join("")}`
    );
    expect([...new Set(sent)].sort()).toEqual([
      "GET /api/admin/gdpr?userId=1",
      "GET /api/admin/tenant",
      "PATCH /api/admin/users",
      "POST /api/admin/users/search",
    ]);
    // Without the callback's owner the panel reads were never seen: a wait on the search had no
    // sender, and one for GET on it would not be refused.
    const waitFor = (method: string): SourceText => ({
      file: "e2e/s.spec.ts",
      text: `page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/users/search" && r.request().method() === "${method}");`,
    });
    expect(
      awaitedRequestFindings([waitFor("POST")], [call, panel, screens], [], {}, {})
    ).toEqual([]);
    expect(
      awaitedRequestFindings([waitFor("GET")], [call, panel, screens], [], {}, {})
    ).toEqual([
      "e2e/s.spec.ts:1: waits for GET /api/admin/users/search (equals) — no screen or client module sends it",
    ]);
    // A path another client module's function returns is read in that module — a literal map,
    // and null for "no request" (the console's section registry and its console).
    const registry: SourceText = {
      file: "components/admin/ui/sections.ts",
      text: [
        `const SECTION_READS = { roles: "/api/admin/roles", audit: "/api/admin/audit?offset=0" } as const;`,
        `export function sectionEndpoint(id: string): string | null {`,
        `  return id in SECTION_READS ? SECTION_READS[id as keyof typeof SECTION_READS] : null;`,
        `}`,
      ].join("\n"),
    };
    const console_: SourceText = {
      file: "components/admin/SectionConsole.tsx",
      text: [
        `import { sectionEndpoint } from "@/components/admin/ui/sections";`,
        `const endpoint = sectionEndpoint(section);`,
        `const { read } = usePanelRead(endpoint, refresh);`,
      ].join("\n"),
    };
    expect(
      clientRequests([call, panel, registry, console_])
        .map((x) => `${x.method} ${x.path.join("")}`)
        .filter((x) => !x.includes("*"))
        .sort()
    ).toEqual(["GET /api/admin/audit?offset=0", "GET /api/admin/roles"]);
    // Not imported by that name: not read (a same-named function elsewhere is not this one).
    const unrelated: SourceText = {
      ...console_,
      text: console_.text.replace(
        `import { sectionEndpoint } from "@/components/admin/ui/sections";`,
        ""
      ),
    };
    expect(clientRequests([call, panel, registry, unrelated])).toEqual([]);

    // A fallback that is not one method cannot be read: the request is a finding.
    const opaque: SourceText = {
      file: "components/Y.tsx",
      text: [
        `async function send(url: string, options: { method?: string }) {`,
        `  return apiFetch(url, { method: options.method ?? pick() });`,
        `}`,
        `void send("/api/y", {});`,
      ].join("\n"),
    };
    expect(awaitedRequestFindings([], [opaque], [], {}, {})).toEqual([
      "components/Y.tsx: /api/y: a request whose method the scan cannot read (it would answer a wait for any method) — make it readable, or list it in ANY_METHOD with why",
    ]);
  });
});
