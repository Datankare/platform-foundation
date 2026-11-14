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
 *   1. Waits. Each `waitForResponse(…)` / `waitForRequest(…)` predicate that names a path — the
 *      pathname compared with `===`, or the URL's `endsWith` / `includes` / `startsWith` — and,
 *      where it names one, the method (`….method() === "POST"`). Some client module (app/ but its
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
 * names it with a reason; an ALLOWED entry that no longer matches anything is a finding too. The
 * one leniency: a client request whose method the scan cannot read (a spread init, a method
 * variable) matches any method.
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
  constructor(readonly sf: ts.SourceFile) {}

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
      // A call of the file's own function: whatever it returns.
      const fn = this.fn(x.expression.text);
      const rets = fn ? this.returns(fn) : [];
      if (!fn || !rets.length) return undefined;
      const all: PathValue[] = [];
      for (const ret of rets) {
        const v = this.values(ret, ret, new Map(), depth + 1);
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
}

/** The requests the specs wait for and make. */
export function specTargets(specs: readonly SourceText[]): SpecScan {
  const targets: Target[] = [];
  const unread: { key: string; line: number }[] = [];
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
                add(n, "wait", "endsWith", arg, [null], env);
                continue;
              }
            }
            const fn = predicateOf(arg, r);
            if (!fn || !fn.body) continue;
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
            for (const [mode, expr, at] of paths)
              add(at, "wait", mode, expr, methods.length ? methods : [null], env);
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
  return { targets, unread };
}

/** The requests the client modules send (path and method, as far as they can be read). */
export function clientRequests(clients: readonly SourceText[]): Sent[] {
  const sent: Sent[] = [];
  /** Local helpers that pass a parameter on as a request's path: name → [path param, method]. */
  const helpers = new Map<string, { index: number; methods: (string | null)[] }>();
  const methodOf = (
    r: Reader,
    init: ts.Expression | undefined,
    at: ts.Node,
    env: Env
  ) => {
    if (!init) return ["GET"];
    const o = strip(init);
    if (!ts.isObjectLiteralExpression(o)) return [null];
    const p = o.properties.find(
      (q) =>
        (ts.isPropertyAssignment(q) || ts.isShorthandPropertyAssignment(q)) &&
        ts.isIdentifier(q.name) &&
        q.name.text === "method"
    );
    if (!p) return o.properties.some((q) => ts.isSpreadAssignment(q)) ? [null] : ["GET"];
    if (ts.isShorthandPropertyAssignment(p)) return [null];
    return (
      r
        .text((p as ts.PropertyAssignment).initializer, at, env)
        ?.map((m) => m.toUpperCase()) ?? [null]
    );
  };
  const parsed = clients.map(({ file, text }) => ({
    file,
    sf: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
  }));
  // Two passes: the first finds the requests and the helpers; the second, the helpers' callers.
  for (const pass of [1, 2]) {
    for (const { file, sf } of parsed) {
      const r = new Reader(sf);
      const visit = (n: ts.Node): void => {
        if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && n.arguments?.[0]) {
          const callee = ts.isIdentifier(n.expression)
            ? n.expression.text
            : ts.isPropertyAccessExpression(n.expression)
              ? n.expression.name.text
              : "";
          const args = n.arguments;
          let path: ts.Expression | undefined;
          let methods: (string | null)[] = [];
          let initExpr: ts.Expression | undefined;
          if (ts.isNewExpression(n) && callee === "EventSource") {
            path = args[0];
            methods = ["GET"];
          } else if (ts.isCallExpression(n) && callee === "sendBeacon") {
            path = args[0];
            methods = ["POST"];
          } else if (ts.isCallExpression(n) && /fetch/i.test(callee)) {
            path = args[0];
            initExpr = args[1];
          } else if (pass === 2 && ts.isCallExpression(n) && helpers.has(callee)) {
            const h = helpers.get(callee)!;
            path = args[h.index];
            methods = h.methods;
          }
          if (path) {
            for (const env of r.envs(n)) {
              const ms = methods.length ? methods : methodOf(r, initExpr, n, env);
              const values = r.values(path, n, env);
              if (values) {
                if (pass === 1 || helpers.has(callee))
                  for (const v of values)
                    for (const method of ms) sent.push({ file, path: v, method });
                continue;
              }
              // A parameter passed on as the path: the enclosing function is a helper.
              const p = strip(path);
              const pname = ts.isIdentifier(p) ? p.text : undefined;
              const fn = pname ? r.parameterOf(pname, n) : undefined;
              if (pass === 1 && fn && pname) {
                const index = fn.parameters.findIndex((q) =>
                  bindingSlots(q.name).some((s) => s.name === pname)
                );
                const name = functionName(fn);
                if (name && !/fetch/i.test(name))
                  helpers.set(name, { index, methods: ms });
              }
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
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
  allowed: Readonly<Record<string, string>> = ALLOWED
): string[] {
  const { targets, unread } = specTargets(specs);
  const sent = clientRequests(clients);
  const served = apiRoutes(routes);
  const out = new Set<string>();
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
      "e2e/planted.spec.ts:3: waits for any method /api/y (equals) — no screen or client module sends it",
      "e2e/planted.spec.ts:6: calls PUT /api/items/7 — its route exports no PUT",
      "e2e/planted.spec.ts:7: calls POST /api/gone — no route file serves it",
    ]);
  });
});
