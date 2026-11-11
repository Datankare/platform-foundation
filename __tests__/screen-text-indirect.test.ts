/**
 * @jest-environment node
 */
/**
 * __tests__/screen-text-indirect.test.ts — screen text that reaches the page indirectly comes from
 * the catalog too (TASK-205, ADR-051 D4)
 *
 * @guard English text on a screen that reaches it through a constant, a map, a prop or a hook
 *
 * __tests__/screen-literals-ratchet.test.ts counts a literal written where the screen shows it:
 * JSX text, a label attribute, a JSX expression's string, a state setter's sentence. Text kept
 * elsewhere and shown through a name passed it by: a mode table (`MODE_CONFIG[mode].label`), a
 * provider list mapped into buttons, a component's default prop, a library's label map imported
 * into a tag, a function that builds a line, a hook's notification, a heading passed to a table.
 * Two rules, each at 0:
 *
 *   A. Flow. From every text position (a JSX child expression, a label attribute's expression) the
 *      names in it are followed — a variable, a property chain (`a.b[k].c`), an alias
 *      (`const s = MAP[k]`), a `.map`/`.find` callback's parameter (an element), a destructured
 *      parameter's default, a function's returned values, an import (relative or `@/`) — to the
 *      string literals they can hold. A literal with words found that way is reported where it is.
 *   B. Screen code. Every string literal shaped like words for a person in app/ (but app/api, the
 *      routes: their answers are the API error guards'), components/ and hooks/ (.ts and .tsx) and
 *      in platform/'s .tsx files, other than: a catalog call's argument
 *      (`t`, `msg`, `renderMessage` and a file's helpers over it), a log line, an Error's message,
 *      a comparison or `case` (a value tested, not shown), an import, a type, a technical attribute
 *      or property (className, id, key, data-*, role, type, href, style values…). A string shaped
 *      like code — a CSS class list or value, a cookie, a dotted key, a path or URL, an identifier —
 *      is not words. Text reaching a screen through a component's prop or a hook's state is caught
 *      here, where rule A cannot follow it.
 *
 *   C. API answers (TASK-206, N-102). Rule B's scan over app/api, the routes: an answer a screen
 *      shows is the catalog's key and values (platform/errors/shown-text.ts) or a coded error,
 *      never English written there. Besides rule B's exclusions, code a route needs is not words:
 *      SQL, an HTTP header's name, a server-sent event's frame, a log's `context`, an alert
 *      (raiseAlert, captureError); and text for the model is not a screen's: a JSON schema's
 *      `description` (an object with `type`, `properties` or `input_schema`) and what a function
 *      or constant marked `@modelText` in its doc comment returns. A template's words are its
 *      fixed parts, each on its own (`op_${a}_${b}` is an id). And every literal key a
 *      `shown(…)` names, in app/api, platform/ and components/, is one English has.
 *
 *   E. A label stands where a label stands (TASK-208, N-111). A held change's one line
 *      (describeWhat: "Erase the account ann@…", "Setting signups_enabled") and an action's
 *      (describeAction) are labels, not nouns: given to a template that builds a sentence around
 *      them they read "Approve Erase the account … again", "Erase the account … is held for
 *      approval". So such a line is passed to a catalog call only as its `label` or `what`, and
 *      every `{label}` and `{what}` in the catalogs (the platform's and the app's) stands where a
 *      label stands: at the start of the message or after ": ", followed by its end, ":", ".",
 *      ",", " —" or a closing quote.
 *
 * ALLOWED holds "<file>:<text>" with why a reported string is not screen text: none.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import * as ts from "typescript";
import { renderMessage } from "@/platform/errors/messages";

const ROOT = join(__dirname, "..");
const LABEL_ATTRS = new Set(["placeholder", "aria-label", "title", "alt", "label"]);

/** "<file>:<literal text>": why it is not screen text. None. */
const ALLOWED: Readonly<Record<string, string>> = {};

// ── What counts as words ──────────────────────────────────────────────

/** Shapes of code, not words: CSS (classes, values), cookies, keys, paths, URLs, identifiers. */
export function isCodeShaped(text: string): boolean {
  const t = text.trim();
  if (!/[a-z]{2,}/i.test(t)) return true;
  if (/^(?:https?:|mailto:|\.?\/|[@#])/.test(t)) return true;
  if (/\w=/.test(t)) return true; // a cookie or a query: key=value
  if (/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+\.?$/.test(t)) return true; // a.b.c, snake_case, kebab-case
  if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(t)) return true; // camelCase
  if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(t)) return true; // CONSTANT_CASE
  if (/^[A-Z]{2,4}$/.test(t)) return true; // an ISO code: USD, UTC
  if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(t)) return true; // an HTTP method
  const tokens = t.split(/\s+/);
  const css = (x: string) =>
    /^-?[\d.]+(?:px|rem|em|%|vh|vw|s|ms|deg)?,?$/.test(x) ||
    /^[!a-z0-9:\-/[\].#%_()&>*=,'"]+$/.test(x);
  if (tokens.every(css) && tokens.some((x) => /[-:[\d]/.test(x))) return true;
  return false;
}

/** Words for a person: not code-shaped. Single lower-case words count (an enum shown as text). */
export function isWords(text: string): boolean {
  return !isCodeShaped(text);
}

/**
 * A phrase (rule B): words with a space, or a capitalised word. A lone lower-case word in code is
 * usually a value (`"error"`, `"text"`); one that is shown is found by rule A, from where it shows.
 */
export function isPhrase(text: string): boolean {
  const t = text.trim();
  return isWords(t) && (/\s/.test(t) || /^[A-Z][a-z]/.test(t) || /^[A-Z]{2,}$/.test(t));
}

// ── Files ─────────────────────────────────────────────────────────────

/** A set of source files: read from disk, or given (the self-tests). */
interface Sources {
  read(file: string): string | undefined;
  list(): string[];
}

function diskSources(): Sources {
  const walk = (dir: string, pattern: RegExp): string[] =>
    existsSync(dir)
      ? readdirSync(dir).flatMap((n) => {
          const p = join(dir, n);
          if (statSync(p).isDirectory())
            return n === "__tests__" ||
              n === "node_modules" ||
              p === join(ROOT, "app", "api")
              ? []
              : walk(p, pattern);
          return pattern.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
        })
      : [];
  return {
    read: (f) =>
      existsSync(f) && statSync(f).isFile() ? readFileSync(f, "utf8") : undefined,
    list: () => [
      ...["app", "components", "hooks"].flatMap((d) => walk(join(ROOT, d), /\.tsx?$/)),
      ...walk(join(ROOT, "platform"), /\.tsx$/),
    ],
  };
}

/** app/api's files (rule C). */
function apiSources(): Sources {
  const walk = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir).flatMap((n) => {
          const p = join(dir, n);
          if (statSync(p).isDirectory()) return n === "__tests__" ? [] : walk(p);
          return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
        })
      : [];
  return {
    read: (f) =>
      existsSync(f) && statSync(f).isFile() ? readFileSync(f, "utf8") : undefined,
    list: () => walk(join(ROOT, "app", "api")),
  };
}

/** The server's code (rule C, SQL): app/api, platform/ and lib/ — .ts files, not tests. */
function serverSources(): Sources {
  const walk = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir).flatMap((n) => {
          const p = join(dir, n);
          if (statSync(p).isDirectory())
            return n === "__tests__" || n === "node_modules" ? [] : walk(p);
          return /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
        })
      : [];
  return {
    read: (f) =>
      existsSync(f) && statSync(f).isFile() ? readFileSync(f, "utf8") : undefined,
    list: () => [
      ...walk(join(ROOT, "app", "api")),
      ...walk(join(ROOT, "platform")),
      ...walk(join(ROOT, "lib")),
    ],
  };
}

/**
 * Rule F's code: the server's (serverSources) and the screens' (diskSources) — a screen that sends
 * a stored note (a change comment) is a writer of it too.
 */
function noteSources(): Sources {
  const server = serverSources();
  const screens = diskSources();
  return {
    read: (f) => server.read(f),
    list: () => [...new Set([...server.list(), ...screens.list()])],
  };
}

/** Every literal key a `shown(…)` names (rule C), with where it is. */
export function shownKeys(
  files: readonly string[],
  read: (f: string) => string
): string[] {
  const out: string[] = [];
  for (const f of files) {
    for (const m of read(f).matchAll(
      /\bshown(?:Text)?\(\s*"((?:screens|errors)\.[\w.]+)"/g
    ))
      out.push(`${relative(ROOT, f)}:${m[1]}`);
  }
  return out;
}

function parser(src: Sources) {
  const cache = new Map<string, ts.SourceFile | undefined>();
  return (file: string) => {
    if (!cache.has(file)) {
      const text = src.read(file);
      cache.set(
        file,
        text === undefined
          ? undefined
          : ts.createSourceFile(
              file,
              text,
              ts.ScriptTarget.Latest,
              true,
              file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
            )
      );
    }
    return cache.get(file);
  };
}

const strip = (e: ts.Expression): ts.Expression => {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e)
  )
    e = e.expression;
  return e;
};

/** The text a literal shows: a string, or a template's fixed parts. */
const literalText = (e: ts.Node): string | undefined =>
  ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)
    ? e.text
    : ts.isTemplateExpression(e)
      ? e.head.text + e.templateSpans.map((s) => " " + s.literal.text).join("")
      : undefined;

/** A catalog call: renderMessage, or a helper `(key…) => renderMessage(\`….${key}\`…)`. */
function isCatalogFunction(fn: ts.Node | undefined): boolean {
  if (!fn) return false;
  const body =
    ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)
      ? fn.body
      : undefined;
  if (!body) return false;
  const call = ts.isBlock(body)
    ? body.statements.length === 1 && ts.isReturnStatement(body.statements[0])
      ? body.statements[0].expression
      : undefined
    : body;
  return (
    !!call &&
    ts.isCallExpression(strip(call)) &&
    ts.isIdentifier((strip(call) as ts.CallExpression).expression) &&
    ((strip(call) as ts.CallExpression).expression as ts.Identifier).text ===
      "renderMessage"
  );
}

// ── Rule A: flow ──────────────────────────────────────────────────────

const ELEMENT_METHODS = new Set(["find", "findLast", "at"]);
const SAME_METHODS = new Set([
  "filter",
  "slice",
  "sort",
  "toSorted",
  "reverse",
  "concat",
]);
const CALLBACK_METHODS = new Set([
  "map",
  "flatMap",
  "forEach",
  "filter",
  "find",
  "some",
  "every",
]);

/** What a name resolves to: a value (an initializer) or a function. */
type Decl = { kind: "value"; init: ts.Expression } | { kind: "function"; fn: ts.Node };

/** How a flow judges what it finds (rule A: words; rule F: anything not a key). */
interface FlowOptions {
  /** Whether a literal found is reported. */
  readonly accept?: (text: string) => boolean;
  /**
   * Rule F: a string method's receiver (`\`…\`.slice(0, 500)`, `note.trim()`) is followed to its
   * literals, as the value it returns is made of them.
   */
  readonly receivers?: boolean;
}

/** A string method whose result is made of its receiver's text (rule F). */
const STRING_METHODS = new Set([
  "slice",
  "substring",
  "trim",
  "trimStart",
  "trimEnd",
  "toString",
  "padStart",
  "padEnd",
  "toLowerCase",
  "toUpperCase",
]);

/**
 * The flow from an expression back to the string literals it can hold (rule A; rule F reuses it):
 * names, property chains, aliases, callbacks' elements, destructured defaults, functions'
 * returned values and imports, each followed to its literals; `report` keeps those `accept`ed.
 */
function flowOf(src: Sources, root: string, options: FlowOptions = {}) {
  const accept = options.accept ?? isWords;
  const parse = parser(src);
  const resolveImport = (from: string, spec: string): string | undefined => {
    const base = spec.startsWith("@/")
      ? join(root, spec.slice(2))
      : spec.startsWith(".")
        ? resolve(dirname(from), spec)
        : undefined;
    if (!base) return undefined;
    for (const c of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      join(base, "index.ts"),
      join(base, "index.tsx"),
    ])
      if (src.read(c) !== undefined) return c;
    return undefined;
  };
  /** The declaration `name` names in `sf` (any scope), else what the file imports by that name. */
  const findDecl = (sf: ts.SourceFile, name: string, depth = 0): Decl | undefined => {
    let found: Decl | undefined;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === name &&
        n.initializer
      ) {
        const init = strip(n.initializer);
        found =
          ts.isArrowFunction(init) || ts.isFunctionExpression(init)
            ? { kind: "function", fn: init }
            : { kind: "value", init: n.initializer };
      } else if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) {
        found = { kind: "function", fn: n };
      } else if (
        ts.isBindingElement(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === name &&
        n.initializer
      ) {
        found = { kind: "value", init: n.initializer }; // a destructured parameter's default
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (found || depth > 3) return found;
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier))
        continue;
      const b = st.importClause?.namedBindings;
      if (!b || !ts.isNamedImports(b)) continue;
      const spec = st.moduleSpecifier.text;
      for (const el of b.elements) {
        if (el.name.text !== name) continue;
        const target = resolveImport(sf.fileName, spec);
        const tsf = target ? parse(target) : undefined;
        if (tsf) return findDecl(tsf, (el.propertyName ?? el.name).text, depth + 1);
      }
    }
    return undefined;
  };
  /**
   * The declaration an identifier names where it is used (TASK-209): the nearest enclosing scope's
   * — a block's or a file's statements, a function's parameters — so two locals of one name in a
   * file are not confused. A parameter (no value to follow) is "param". Undefined when no
   * enclosing scope declares it (an import: findDecl).
   */
  const declAt = (id: ts.Identifier): Decl | "param" | undefined => {
    const name = id.text;
    const fromStatements = (statements: ts.NodeArray<ts.Statement>): Decl | undefined => {
      for (const st of statements) {
        if (ts.isVariableStatement(st))
          for (const d of st.declarationList.declarations)
            if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) {
              const init = strip(d.initializer);
              return ts.isArrowFunction(init) || ts.isFunctionExpression(init)
                ? { kind: "function", fn: init }
                : { kind: "value", init: d.initializer };
            }
        if (ts.isFunctionDeclaration(st) && st.name?.text === name && st.body)
          return { kind: "function", fn: st };
      }
      return undefined;
    };
    for (let p: ts.Node | undefined = id.parent; p; p = p.parent) {
      if (
        ts.isBlock(p) ||
        ts.isSourceFile(p) ||
        ts.isModuleBlock(p) ||
        ts.isCaseClause(p)
      ) {
        const d = fromStatements(p.statements);
        if (d) return d;
      }
      if (ts.isFunctionLike(p))
        for (const q of p.parameters) {
          if (ts.isIdentifier(q.name) && q.name.text === name) return "param";
          if (ts.isObjectBindingPattern(q.name) || ts.isArrayBindingPattern(q.name))
            for (const el of q.name.elements)
              if (
                ts.isBindingElement(el) &&
                ts.isIdentifier(el.name) &&
                el.name.text === name
              )
                return el.initializer ? { kind: "value", init: el.initializer } : "param";
        }
      if (ts.isCatchClause(p) && p.variableDeclaration?.name.getText() === name)
        return "param";
    }
    return undefined;
  };
  /** If `id` is the first parameter of a callback given to `X.map(…)` (etc.), the `X`. */
  const callbackSource = (id: ts.Identifier): ts.Expression | undefined => {
    for (let p: ts.Node | undefined = id.parent; p; p = p.parent) {
      if (
        (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) &&
        p.parameters.some((q) => ts.isIdentifier(q.name) && q.name.text === id.text)
      ) {
        const first = p.parameters[0];
        const call = p.parent;
        if (
          ts.isIdentifier(first.name) &&
          first.name.text === id.text &&
          ts.isCallExpression(call) &&
          ts.isPropertyAccessExpression(call.expression) &&
          CALLBACK_METHODS.has(call.expression.name.text)
        )
          return call.expression.expression;
        return undefined;
      }
    }
    return undefined;
  };
  /** `a.b[k].c`, `A.find(…)?.c`, `A[k]`, a callback's parameter → its root name and path. */
  const chain = (
    e: ts.Expression
  ): { root: ts.Identifier; props: string[] } | undefined => {
    const props: string[] = [];
    for (;;) {
      e = strip(e);
      if (ts.isPropertyAccessExpression(e)) {
        props.unshift(e.name.text);
        e = e.expression;
      } else if (ts.isElementAccessExpression(e)) {
        const a = e.argumentExpression;
        props.unshift(ts.isStringLiteral(a) ? a.text : "*");
        e = e.expression;
      } else if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
        const m = e.expression.name.text;
        if (ELEMENT_METHODS.has(m)) props.unshift("*");
        else if (!SAME_METHODS.has(m)) return undefined;
        e = e.expression.expression;
      } else break;
    }
    if (!ts.isIdentifier(e)) return undefined;
    const from = callbackSource(e);
    if (from) {
      const inner = chain(from);
      return inner
        ? { root: inner.root, props: [...inner.props, "*", ...props] }
        : undefined;
    }
    return { root: e, props };
  };
  const out = new Map<string, string>();
  const report = (lit: ts.Node) => {
    const sf = lit.getSourceFile();
    const text = literalText(lit)!;
    const key = `${relative(root, sf.fileName)}:${sf.getLineAndCharacterOfPosition(lit.getStart(sf)).line + 1}`;
    if (!(`${relative(root, sf.fileName)}:${text}` in ALLOWED))
      out.set(`${key}:${lit.getStart(sf)}`, `${key} ${JSON.stringify(text)}`);
  };
  /** The literals `e` can evaluate to, at property path `props` ("*" any element or key). */
  const literalsAt = (
    e0: ts.Expression | undefined,
    props: string[],
    seen: Set<string>
  ): void => {
    if (!e0) return;
    const e = strip(e0);
    const text = literalText(e);
    if (text !== undefined) {
      if (props.length === 0 && accept(text)) report(e);
      // Rule F: a `kind:${detail}` template is a code; its detail is data, not words.
      const kindCode =
        options.receivers &&
        ts.isTemplateExpression(e) &&
        /^[a-z][a-z0-9_]*:$/.test(e.head.text) &&
        e.templateSpans.every((x) => x.literal.text === "");
      if (ts.isTemplateExpression(e) && !kindCode)
        for (const s of e.templateSpans) literalsAt(s.expression, [], seen);
      return;
    }
    if (ts.isConditionalExpression(e)) {
      literalsAt(e.whenTrue, props, seen);
      literalsAt(e.whenFalse, props, seen);
      return;
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      ) {
        literalsAt(e.left, props, seen);
        literalsAt(e.right, props, seen);
      } else if (op === ts.SyntaxKind.PlusToken) {
        literalsAt(e.left, props, seen);
        literalsAt(e.right, props, seen);
      }
      return;
    }
    if (ts.isArrayLiteralExpression(e)) {
      if (props.length > 0 && props[0] !== "*") return;
      for (const x of e.elements)
        literalsAt(ts.isSpreadElement(x) ? x.expression : x, props.slice(1), seen);
      return;
    }
    if (ts.isObjectLiteralExpression(e)) {
      for (const p of e.properties) {
        if (ts.isSpreadAssignment(p)) literalsAt(p.expression, props, seen);
        else if (ts.isPropertyAssignment(p)) {
          const key = p.name.getText(p.getSourceFile()).replace(/^["']|["']$/g, "");
          if (props.length === 0) literalsAt(p.initializer, [], seen);
          else if (props[0] === "*" || props[0] === key)
            literalsAt(p.initializer, props.slice(1), seen);
        }
      }
      return;
    }
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
      // A function's returned values (not the catalog's).
      const name = e.expression.text;
      if (name === "renderMessage" || name === "String" || name === "Number") return;
      const sf = e.getSourceFile();
      const at = declAt(e.expression);
      if (at === "param") return;
      const d = at ?? findDecl(sf, name);
      const k = `fn:${sf.fileName}:${name}`;
      if (!d || d.kind !== "function" || isCatalogFunction(d.fn) || seen.has(k)) return;
      seen.add(k);
      const fn = d.fn as ts.FunctionLikeDeclaration;
      const visit = (n: ts.Node): void => {
        if (ts.isReturnStatement(n) && n.expression)
          literalsAt(n.expression, props, seen);
        if (ts.isArrowFunction(n) && !ts.isBlock(n.body)) literalsAt(n.body, props, seen);
        ts.forEachChild(n, visit);
      };
      if (fn.body && !ts.isBlock(fn.body))
        literalsAt(fn.body as ts.Expression, props, seen);
      else if (fn.body) visit(fn.body);
      return;
    }
    if (
      options.receivers &&
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      STRING_METHODS.has(e.expression.name.text)
    ) {
      literalsAt(e.expression.expression, props, seen);
      return;
    }
    // Rule F: a joined list's text is its elements'.
    if (
      options.receivers &&
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      e.expression.name.text === "join"
    ) {
      literalsAt(e.expression.expression, ["*", ...props], seen);
      return;
    }
    const c = chain(e);
    if (!c) return;
    const sf = c.root.getSourceFile();
    const k = `${sf.fileName}:${c.root.text}:${[...c.props, ...props].join(".")}`;
    if (seen.has(k)) return;
    seen.add(k);
    const at = declAt(c.root);
    if (at === "param") return;
    const d = at ?? findDecl(sf, c.root.text);
    if (d?.kind === "value") {
      const path = [...c.props, ...props];
      literalsAt(d.init, path, seen);
      // Rule F: an array built by `name.push(…)` holds what is pushed (`parts.join(" ")`).
      if (
        options.receivers &&
        ts.isArrayLiteralExpression(strip(d.init)) &&
        path[0] === "*"
      ) {
        let scope: ts.Node | undefined = d.init.parent;
        while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope))
          scope = scope.parent;
        const pushes = (n: ts.Node): void => {
          if (
            ts.isCallExpression(n) &&
            ts.isPropertyAccessExpression(n.expression) &&
            n.expression.name.text === "push" &&
            ts.isIdentifier(n.expression.expression) &&
            n.expression.expression.text === c.root.text
          )
            for (const a of n.arguments) literalsAt(a, path.slice(1), seen);
          ts.forEachChild(n, pushes);
        };
        if (scope) pushes(scope);
      }
    }
  };
  return { parse, findDecl, literalsAt, sites: () => [...out.values()].sort() };
}

export function indirectSites(src: Sources, root: string): string[] {
  const { parse, literalsAt, sites } = flowOf(src, root);
  /** The expressions in a text position that carry a value from elsewhere. */
  const sources = (
    e0: ts.Expression | undefined,
    acc: ts.Expression[] = []
  ): ts.Expression[] => {
    if (!e0) return acc;
    const e = strip(e0);
    if (ts.isConditionalExpression(e)) {
      sources(e.whenTrue, acc);
      return sources(e.whenFalse, acc);
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.PlusToken
      ) {
        sources(e.left, acc);
        return sources(e.right, acc);
      }
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return sources(e.right, acc);
      return acc;
    }
    if (ts.isTemplateExpression(e)) {
      for (const s of e.templateSpans) sources(s.expression, acc);
      return acc;
    }
    if (
      ts.isIdentifier(e) ||
      ts.isPropertyAccessExpression(e) ||
      ts.isElementAccessExpression(e) ||
      ts.isCallExpression(e)
    )
      acc.push(e);
    return acc;
  };
  for (const file of src.list().filter((f) => f.endsWith(".tsx"))) {
    const sf = parse(file);
    if (!sf) continue;
    const visit = (n: ts.Node): void => {
      const exprs: (ts.Expression | undefined)[] = [];
      if (
        ts.isJsxExpression(n) &&
        (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))
      )
        exprs.push(n.expression);
      if (
        ts.isJsxAttribute(n) &&
        LABEL_ATTRS.has(n.name.getText(sf)) &&
        n.initializer &&
        ts.isJsxExpression(n.initializer)
      )
        exprs.push(n.initializer.expression);
      for (const e of exprs) for (const s of sources(e)) literalsAt(s, [], new Set());
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return sites();
}

// ── Rule B: screen code ───────────────────────────────────────────────

const TECH_ATTRS =
  /^(?:className|class|id|key|ref|role|type|name|value|defaultValue|href|src|htmlFor|method|action|target|rel|autoComplete|inputMode|accept|encType|lang|dir|style|data-[\w-]+|aria-(?!label$)[\w-]+|variant|size|mode|testId|pattern|form|sizes|media|as|crossOrigin|referrerPolicy|integrity|nonce|charSet|httpEquiv|content|property)$/;
const TECH_PROPS =
  /^(?:className|class|id|key|testId|href|url|path|route|method|headers|Content-Type|Authorization|fontFamily|fontSize|fontWeight|padding|margin|width|height|background|backgroundColor|border\w*|cursor|display|gap|lineHeight|textAlign|transition|boxShadow|outline|zIndex|flex\w*|maxWidth|minHeight|whiteSpace|wordBreak|overflow\w*)$/;
/** Rule C: an alert to the operators or the error reporter, never an answer. */
const API_CALL = /(?:^|\.)(?:raiseAlert|captureError|captureMessage)$/;
const LOG_CALL =
  /^(?:logger|console|log)\.\w+$|^(?:t|tx|msg|renderMessage|apiError|internalError|require|fetch|apiFetch|guestFetch|jest|expect)$|\.(?:getItem|setItem|removeItem|includes|startsWith|endsWith|test|match|split|join|replace|replaceAll|querySelector|querySelectorAll|getElementById|addEventListener|removeEventListener|get|has|delete|indexOf|lastIndexOf|localeCompare|padStart|padEnd|toLocaleString|toLocaleDateString|toLocaleTimeString|formatToParts|push|postMessage|dispatchEvent|setAttribute|getAttribute|createElement|open)$/;

/** Rule C's code shapes: SQL, an HTTP header's name, a server-sent event's frame. */
export function isApiCode(text: string): boolean {
  const t = text.trim();
  if (/^\(?\s*(?:select|insert|update|delete|with|case\s+when)\b/i.test(t)) return true;
  if (
    !/[A-Z][a-z]/.test(t) &&
    /\$\d|::[a-z]|\b[a-z]{1,3}\.[a-z_]+\b|\bcount\(\*\)|\|\|/.test(t)
  )
    return true;
  if (/^[A-Z][a-z]+(?:-[A-Z][a-z]+)+$/.test(t)) return true; // Cache-Control
  if (/^data: /.test(t)) return true; // an event-stream frame
  return false;
}

/**
 * Rule C, SQL (TASK-207, N-107): the words a statement would write — its quoted string literals
 * (`'…'`, a doubled quote one quote) that are a phrase for a person. A duplicated role's
 * description was `'Duplicated from ' || $3`: English the database stored and every screen showed.
 */
export function sqlPhrases(sql: string): string[] {
  const found: string[] = [];
  for (const m of sql.matchAll(/(?<!\w)[EN]?'((?:[^']|'')*)'/gi)) {
    const text = m[1].replace(/''/g, "'");
    // A single word is a token or a setting's name (`'failed'`, `'TimeZone'`), and a JSON
    // literal is data: words for a person have a space between them.
    if (/^\s*[[{]/.test(text) || !/[A-Z]\s+[A-Z]/i.test(text)) continue;
    if (isPhrase(text) && !isApiCode(text)) found.push(text);
  }
  return found;
}

/**
 * Rule C, SQL: every statement in `src` (a literal shaped as SQL — isApiCode — or a template whose
 * text is) whose string literals hold words for a person, as "<file>:<line> SQL <text>".
 */
export function sqlWordSites(src: Sources, root: string): string[] {
  const parse = parser(src);
  const out: string[] = [];
  for (const file of src.list()) {
    const sf = parse(file);
    if (!sf) continue;
    const visit = (n: ts.Node): void => {
      const text = ts.isTemplateExpression(n)
        ? [n.head.text, ...n.templateSpans.map((x) => x.literal.text)].join(" ")
        : literalText(n);
      if (text !== undefined && isApiCode(text)) {
        for (const phrase of sqlPhrases(text))
          out.push(
            `${relative(root, file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} SQL ${JSON.stringify(phrase)}`
          );
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/**
 * Rule D (TASK-207, N-107): no screen shows an API answer as JSON. A JSX child that is, or holds, a
 * `JSON.stringify(…)` puts the answer's field names, codes and any English the server wrote on
 * the page (Playform's agent console showed its whole answer so). A screen shows the answer's
 * fields, each in the catalog's words or as data. "<file>:<line> <the child's text>".
 */
export function jsonDumpSites(src: Sources, root: string): string[] {
  const parse = parser(src);
  const out: string[] = [];
  // Within a child's own expression: a nested child is judged (and reported) on its own.
  const dumps = (n: ts.Node): boolean =>
    (ts.isCallExpression(n) && n.expression.getText() === "JSON.stringify") ||
    (!ts.isJsxAttribute(n) &&
      !ts.isJsxExpression(n) &&
      ts.forEachChild(n, dumps) === true);
  for (const file of src.list()) {
    const sf = parse(file);
    if (!sf) continue;
    const visit = (n: ts.Node): void => {
      if (
        ts.isJsxExpression(n) &&
        !ts.isJsxAttribute(n.parent) &&
        n.expression &&
        dumps(n.expression)
      ) {
        out.push(
          `${relative(root, file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${n.expression.getText(sf).slice(0, 80)}`
        );
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** Whether a node sits in a declaration whose doc comment says `@modelText`. */
function isModelText(n: ts.Node, sf: ts.SourceFile): boolean {
  for (let p: ts.Node | undefined = n; p; p = p.parent) {
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isVariableStatement(p) ||
      ts.isMethodDeclaration(p)
    ) {
      const docs = ts
        .getJSDocTags(p)
        .concat(
          ts.isVariableStatement(p)
            ? p.declarationList.declarations.flatMap((d) => [...ts.getJSDocTags(d)])
            : []
        );
      if (docs.some((d) => d.tagName.text === "modelText")) return true;
      if (/@modelText\b/.test(sf.text.slice(p.getFullStart(), p.getStart(sf))))
        return true;
    }
  }
  return false;
}

/** A JSON schema's object (a tool's or a property's): its `description` is the model's. */
function isSchemaObject(o: ts.Node, sf: ts.SourceFile): boolean {
  return (
    ts.isObjectLiteralExpression(o) &&
    o.properties.some(
      (p) =>
        ts.isPropertyAssignment(p) &&
        /^(?:type|properties|input_schema|inputSchema)$/.test(
          p.name.getText(sf).replace(/^["']|["']$/g, "")
        )
    )
  );
}

export function screenCodeSites(
  src: Sources,
  root: string,
  options: { readonly api?: boolean } = {}
): string[] {
  const parse = parser(src);
  const out: string[] = [];
  for (const file of src.list()) {
    const sf = parse(file);
    if (!sf) continue;
    // The file's catalog helpers: `const x = (key…) => renderMessage(…)`.
    const helpers = new Set<string>();
    const findHelpers = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        isCatalogFunction(strip(n.initializer))
      )
        helpers.add(n.name.text);
      if (ts.isFunctionDeclaration(n) && n.name && isCatalogFunction(n))
        helpers.add(n.name.text);
      ts.forEachChild(n, findHelpers);
    };
    findHelpers(sf);
    const visit = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isTypeNode(n))
        return;
      if (ts.isCaseClause(n)) {
        n.statements.forEach(visit); // the case's value is tested, not shown
        return;
      }
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(sf);
        if (LOG_CALL.test(callee) || helpers.has(callee) || /Error$/.test(callee)) return;
        if (options.api && API_CALL.test(callee)) return;
      }
      if (options.api) {
        if (
          ts.isPropertyAssignment(n) &&
          (n.name.getText(sf) === "context" ||
            (n.name.getText(sf) === "description" && isSchemaObject(n.parent, sf)))
        )
          return;
        if (
          (ts.isFunctionDeclaration(n) || ts.isVariableStatement(n)) &&
          isModelText(n, sf)
        )
          return;
      }
      if (ts.isNewExpression(n) && /Error$/.test(n.expression.getText(sf))) return;
      if (ts.isJsxAttribute(n) && TECH_ATTRS.test(n.name.getText(sf))) return;
      if (
        ts.isPropertyAssignment(n) &&
        TECH_PROPS.test(n.name.getText(sf).replace(/^["']|["']$/g, ""))
      )
        return;
      // An assignment to a technical property (`headers.Authorization = …`).
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(n.left) &&
        TECH_PROPS.test(n.left.name.text)
      )
        return;
      if (
        ts.isBinaryExpression(n) &&
        [
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
          ts.SyntaxKind.InKeyword,
        ].includes(n.operatorToken.kind)
      )
        return;
      if (ts.isElementAccessExpression(n)) return visit(n.expression);
      const text = literalText(n);
      if (
        text !== undefined &&
        !(ts.isStringLiteral(n) && ts.isExpressionStatement(n.parent))
      ) {
        // A directive ("use client") is a statement of a string, never shown. Rule C: a template's
        // fixed parts are judged each on its own, and code a route needs is not words.
        const words = options.api
          ? ts.isTemplateExpression(n)
            ? [n.head.text, ...n.templateSpans.map((x) => x.literal.text)].some(
                (part) => isPhrase(part) && !isApiCode(part)
              ) && !isApiCode(text)
            : isPhrase(text) && !isApiCode(text)
          : isPhrase(text);
        if (words && !(`${relative(root, file)}:${text}` in ALLOWED))
          out.push(
            `${relative(root, file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${JSON.stringify(text)}`
          );
        if (ts.isTemplateExpression(n))
          n.templateSpans.forEach((s) => visit(s.expression));
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

// ── Rule E: a label stands where a label stands (TASK-208, N-111) ─────

/** The functions whose result is a label (a held change's or an action's one line). */
const LABEL_SOURCES = new Set(["describeWhat", "describeAction"]);
/** A catalog call: its second argument is the message's values. */
const CATALOG_CALLS = new Set(["t", "d", "tr", "msg", "renderMessage", "shown"]);
/** The values a label may be passed as. */
const LABEL_VALUES = new Set(["label", "what"]);

/**
 * Every `{label}` / `{what}` in `catalog` not standing where a label stands, as
 * "<key>: <message>". A select or plural branch is checked as its own text.
 */
export function misplacedLabels(catalog: unknown, prefix = ""): string[] {
  if (typeof catalog === "string") {
    const out: string[] = [];
    for (const m of catalog.matchAll(/\{(label|what)\}/g)) {
      const before = catalog.slice(0, m.index);
      const after = catalog.slice(m.index + m[0].length);
      const start = before === "" || /(?:^|[{}])$/.test(before) || /: $/.test(before);
      const end = after === "" || /^(?:[:.,”}]| —)/.test(after);
      if (!start || !end) out.push(`${prefix}: ${catalog}`);
    }
    return out;
  }
  if (!catalog || typeof catalog !== "object") return [];
  return Object.entries(catalog).flatMap(([k, v]) =>
    misplacedLabels(v, prefix ? `${prefix}.${k}` : k)
  );
}

/**
 * Every place in `src` a label (LABEL_SOURCES' result: directly, or through a const bound to it
 * in the same function) is given to a call's values object under another name than LABEL_VALUES,
 * as "<file>:<line> <name>".
 */
export function labelAsNounSites(src: Sources, root: string): string[] {
  const parse = parser(src);
  const out: string[] = [];
  const isLabelCall = (e: ts.Node): boolean =>
    ts.isCallExpression(e) &&
    ts.isIdentifier(e.expression) &&
    LABEL_SOURCES.has(e.expression.text);
  for (const file of src.list()) {
    const sf = parse(file);
    if (!sf) continue;
    // Names bound to a label, per enclosing function (or the file).
    const scopeOf = (n: ts.Node): ts.Node => {
      let p = n.parent;
      while (p && !ts.isFunctionLike(p) && !ts.isSourceFile(p)) p = p.parent;
      return p ?? sf;
    };
    const bound = new Map<ts.Node, Set<string>>();
    const collect = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        isLabelCall(strip(n.initializer))
      ) {
        const scope = scopeOf(n);
        if (!bound.has(scope)) bound.set(scope, new Set());
        bound.get(scope)!.add(n.name.text);
      }
      ts.forEachChild(n, collect);
    };
    collect(sf);
    const isBound = (e: ts.Node, name: string): boolean => {
      for (let p: ts.Node | undefined = e; p; p = p.parent)
        if (bound.get(p)?.has(name)) return true;
      return false;
    };
    const visit = (n: ts.Node): void => {
      // A values object: an object literal given to a catalog call (t("k", {…}), d(…),
      // renderMessage(…), shown(…)).
      if (
        ts.isObjectLiteralExpression(n) &&
        n.parent &&
        ts.isCallExpression(n.parent) &&
        ts.isIdentifier(n.parent.expression) &&
        CATALOG_CALLS.has(n.parent.expression.text)
      ) {
        for (const prop of n.properties) {
          let name: string;
          let value: ts.Node;
          if (ts.isPropertyAssignment(prop)) {
            name = prop.name.getText(sf);
            value = strip(prop.initializer);
          } else if (ts.isShorthandPropertyAssignment(prop)) {
            name = prop.name.text;
            value = prop.name;
          } else continue;
          if (LABEL_VALUES.has(name)) continue;
          const label =
            isLabelCall(value) || (ts.isIdentifier(value) && isBound(prop, value.text));
          if (label)
            out.push(
              `${relative(root, file)}:${sf.getLineAndCharacterOfPosition(prop.getStart(sf)).line + 1} ${name}`
            );
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

// ── Rule F: a record's notes are the catalog's key, never English (TASK-209, N-112) ─────

/**
 * The columns that keep a record's note or comment: what a person wrote, as written — the
 * platform's own words go beside it as a catalog key and values (a ShownText column:
 * decision_shown, review_shown, change_shown, ban_note…). Nothing TypeScript composed is stored
 * here, not even a token ("revised" is shown as it is).
 */
export const STORED_NOTE_COLUMNS = new Set([
  "decision_note",
  "ban_reason",
  "review_comment",
  "change_comment",
  "impact_summary",
  "status_reason",
  "reviewer_notes",
  "appeal_reason",
  "note",
]);

/**
 * The columns that keep a code: why a run or a call failed, a reason from a list. A code or a
 * catalog key is stored there (`approvals.run_failed`, `sqlstate:57014`, `legal-order`) and
 * rendered from the catalog; never a sentence.
 */
export const STORED_CODE_COLUMNS = new Set([
  "last_run_error",
  "reason",
  "error",
  "last_error",
  "last_purge_error",
]);

/** The same, as a record's field (camelCase), in an object TypeScript stores. */
export const STORED_NOTE_FIELDS = new Set([
  // The moderation pipeline's reasons, stored with a decision and shown to moderators (TASK-209):
  // a list of catalog keys and values; the context factors; an explanation chain's conclusion.
  "reasoning",
  "contextFactors",
  "factors",
  "conclusion",
  "decisionNote",
  "banReason",
  "reviewComment",
  "changeComment",
  "impactSummary",
  "statusReason",
  "reviewerNotes",
  "appealReason",
]);
export const STORED_CODE_FIELDS = new Set([
  "lastRunError",
  "lastError",
  "lastPurgeError",
]);

/** A run step's output fields (agent_trajectories.steps: exported, rendered): a note; a reason. */
const STEP_NOTE_FIELDS = new Set(["note"]);
const STEP_CODE_FIELDS = new Set(["reason", "error"]);

/**
 * An audit record's details (TASK-209): an object given as `details` — to writeAuditLog,
 * recordAudit, audited — or nested in one. Every value in it is a code, an id, a number, a value,
 * a catalog key and values, or a person's text; never a sentence TypeScript composed. Raw text from
 * a provider, a model or an error goes only under a key named `raw…` (AUDIT_RAW_FIELD), which no
 * screen or export shows as text.
 */
export const AUDIT_RAW_FIELD = /^raw[A-Z]/;

/**
 * Is `obj` (an object literal) an audit record's details, or nested in them: the value of a
 * `details` property of an object that also names its `action` (an AuditEntry; a health answer's
 * `details` is not one)?
 */
export function inAuditDetails(obj: ts.Node): boolean {
  let n: ts.Node = obj;
  while (ts.isObjectLiteralExpression(n) && ts.isPropertyAssignment(n.parent)) {
    const entry = n.parent.parent;
    if (
      n.parent.name.getText().replace(/^["']|["']$/g, "") === "details" &&
      ts.isObjectLiteralExpression(entry) &&
      entry.properties.some((p) => p.name?.getText() === "action")
    )
      return true;
    n = entry;
  }
  return false;
}

/** A catalog render whose words, stored, are frozen in one locale. */
const CATALOG_RENDERS = new Set([
  "renderShown",
  "renderMessage",
  "renderRecorded",
  "decisionWords",
  "t",
  "msg",
]);

/**
 * Rule F's judgement: a literal reaching a record's note is reported unless it is empty, has no
 * letter, or is a code or catalog key (`approvals.run_failed`, `screens.records.note_erased`). A
 * lone token is reported too: "revised" or "rejected_after_run_failed" stored as a note is shown
 * as it is.
 */
export function isStoredWords(text: string): boolean {
  const t = text.trim();
  if (!/[a-z]/i.test(t)) return false;
  return !/^[a-z][\w-]*(?:\.[\w-]+)+$/i.test(t) && !isKindCode(text);
}

/** A `kind:detail` code (`sqlstate:57014`, `reported:x`): its kind, its detail data. */
export function isKindCode(text: string): boolean {
  return /^[a-z][a-z0-9_]*:\S*$/.test(text);
}

/**
 * In a code column (STORED_CODE_COLUMNS), a sentence is reported; a code — a token, a dotted key,
 * a `kind:detail` — is what belongs there.
 */
export function isCodeColumnWords(text: string): boolean {
  const t = text.trim();
  return /[a-z]{2,}[,.;:]?\s+[a-z]{2,}/i.test(t) && !isKindCode(t) && !isApiCode(t);
}

/** The text between a position and the end of its expression in SQL (a comma or a clause at depth 0). */
function sqlExpressionAt(sql: string, from: number): string {
  let depth = 0;
  let quoted = false;
  for (let i = from; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") quoted = !quoted;
    if (quoted) continue;
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) return sql.slice(from, i);
      depth--;
    } else if (c === "," && depth === 0) return sql.slice(from, i);
    else if (
      depth === 0 &&
      /^\s(?:where|returning|from|on\s+conflict)\b/i.test(sql.slice(i, i + 14))
    )
      return sql.slice(from, i);
  }
  return sql.slice(from);
}

/** Split a parenthesised list's inside at its top-level commas. */
function sqlList(inside: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < inside.length; i++) {
    const c = inside[i];
    if (c === "'") quoted = !quoted;
    if (quoted) continue;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(inside.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inside.slice(start));
  return out.map((x) => x.trim());
}

/** The parenthesised text starting at `open` (an opening parenthesis), without its parentheses. */
function sqlParens(sql: string, open: number): string {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")" && --depth === 0) return sql.slice(open + 1, i);
  }
  return sql.slice(open + 1);
}

/**
 * The parameters (1-based) a statement writes into a record's note: `col = …$n…` (an update's
 * set, a case included), an insert's `(…col…) values (…$n…)`, and a JSON note
 * `jsonb_build_object(…, 'note', $n …)`.
 */
export function sqlNoteParams(
  sql: string,
  columns: ReadonlySet<string> = STORED_NOTE_COLUMNS,
  jsonKeys: RegExp = /'(note)'\s*,\s*/g
): number[] {
  const found = new Set<number>();
  const params = (text: string) => {
    for (const m of text.matchAll(/\$(\d+)/g)) found.add(Number(m[1]));
  };
  for (const m of sql.matchAll(/(?<![\w.'])(\w+)\s*=(?![=>])\s*/g)) {
    if (columns.has(m[1].toLowerCase()))
      params(sqlExpressionAt(sql, m.index + m[0].length));
  }
  for (const m of sql.matchAll(/\binsert\s+into\s+[\w.]+\s*\(/gi)) {
    const open = m.index + m[0].length - 1;
    const cols = sqlList(sqlParens(sql, open));
    const rest = sql.slice(open + cols.join(",").length);
    const v = /\)\s*values\s*\(/i.exec(rest);
    if (!v) continue;
    const vals = sqlList(sqlParens(rest, v.index + v[0].length - 1));
    cols.forEach((c, i) => {
      if (columns.has(c.replace(/"/g, "").toLowerCase()) && vals[i]) params(vals[i]);
    });
  }
  for (const m of sql.matchAll(jsonKeys))
    params(sqlExpressionAt(sql, m.index + m[0].length));
  return [...found].sort((a, b) => a - b);
}

/** The parameters a statement writes into a code column (or a JSON reason or error). */
export const sqlCodeParams = (sql: string): number[] =>
  sqlNoteParams(sql, STORED_CODE_COLUMNS, /'(reason|error)'\s*,\s*/g);

/**
 * An object that is a table of codes (`{ changeComment: "text", status: "code", … }`: a field's
 * kind), not a record: three or more properties, every value a code-shaped literal.
 */
/** A stored field assigned (`acc.reasoning = …`): its value as a sink (TASK-209), or undefined. */
function assignedField(n: ts.Node): [ts.Expression, string[], boolean] | undefined {
  if (
    !ts.isBinaryExpression(n) ||
    n.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isPropertyAccessExpression(n.left)
  )
    return undefined;
  const field = n.left.name.text;
  const strict = STORED_NOTE_FIELDS.has(field);
  if (!strict && !STORED_CODE_FIELDS.has(field)) return undefined;
  if (ts.isObjectLiteralExpression(strip(n.right)) || inReaderRender(n)) return undefined;
  return [n.right, [], strict];
}

/**
 * Is `n` inside a function that words a record for its reader (`renderStep`, `renderRecords`: a
 * copy made for an export or a screen, never stored)?
 */
function inReaderRender(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent)
    if (
      (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) &&
      p.name &&
      /^render[A-Z]/.test(p.name.getText())
    )
      return true;
  return false;
}

/**
 * Is `o` (an object literal) not a record but a description of one — an input schema's
 * `properties` — or the values a catalog render is given (`msg("conclusion", { conclusion })`)?
 */
function isSchemaOrRenderValues(o: ts.Node): boolean {
  if (!ts.isObjectLiteralExpression(o)) return false;
  const p = o.parent;
  if (ts.isPropertyAssignment(p) && p.name.getText() === "properties") return true;
  if (ts.isCallExpression(p)) {
    const e = strip(p.expression);
    const name = ts.isIdentifier(e)
      ? e.text
      : ts.isPropertyAccessExpression(e)
        ? e.name.text
        : undefined;
    return !!name && CATALOG_RENDERS.has(name) && p.arguments.indexOf(o) > 0;
  }
  return false;
}

function isCodeTable(o: ts.Node): boolean {
  return (
    ts.isObjectLiteralExpression(o) &&
    o.properties.length >= 3 &&
    o.properties.every(
      (p) =>
        ts.isPropertyAssignment(p) &&
        (ts.isStringLiteral(p.initializer) ||
          ts.isNoSubstitutionTemplateLiteral(p.initializer)) &&
        !isPhrase(p.initializer.text)
    )
  );
}

/**
 * Where a function's parameter carries a record's note: its index, in an object the path, and
 * whether a note (strict) or a code column takes it.
 */
interface NoteParam {
  readonly index: number;
  readonly path: readonly string[];
  readonly strict: boolean;
}

/**
 * A class's constructor parameter kept as its field (`readonly reason: string`): a sink that reads
 * the field (`err.reason`, `err.reason.slice(…)`) reaches every `new Class(…)`'s argument there —
 * a run failure's reason carried by its error into an audit record (TASK-209). The classes the
 * receiver is are known, never guessed by the field's name: a parameter typed as one, an
 * `instanceof` test that holds where it is read, or a `new` it was given. Answers, for a sink's
 * value, the constructor arguments it reads.
 */
function classFieldArgs(
  files: readonly string[],
  parse: (file: string) => ts.SourceFile | undefined
): (e: ts.Expression) => ts.Expression[] {
  const ctorFields = new Map<string, { cls: string; index: number }[]>();
  const constructions: ts.NewExpression[] = [];
  for (const file of files) {
    const sf = parse(file);
    if (!sf) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isClassDeclaration(n) && n.name)
        for (const m of n.members)
          if (ts.isConstructorDeclaration(m))
            m.parameters.forEach((p, index) => {
              if (ts.isIdentifier(p.name) && ts.getModifiers(p)?.length) {
                const list = ctorFields.get(p.name.text) ?? [];
                list.push({ cls: n.name!.text, index });
                ctorFields.set(p.name.text, list);
              }
            });
      if (ts.isNewExpression(n)) constructions.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  /**
   * The field a sink's value reads off an object (`x.reason`, through string methods), and the
   * classes `x` is known to be: a parameter typed as one, an `instanceof` test that holds where it
   * is read, or a `new` it was given — never a guess by the field's name alone.
   */
  const fieldRead = (
    e0: ts.Expression
  ): { field: string; classes: string[] } | undefined => {
    let e = strip(e0);
    while (
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      STRING_METHODS.has(e.expression.name.text)
    )
      e = strip(e.expression.expression);
    if (!ts.isPropertyAccessExpression(e)) return undefined;
    const recv = strip(e.expression);
    if (!ts.isIdentifier(recv)) return undefined;
    const name = recv.text;
    const classes = new Set<string>();
    const typeNames = (t: ts.TypeNode | undefined): void => {
      if (!t) return;
      if (ts.isTypeReferenceNode(t)) classes.add(t.typeName.getText());
      else if (ts.isUnionTypeNode(t)) t.types.forEach(typeNames);
    };
    for (let n: ts.Node | undefined = e; n; n = n.parent) {
      if (ts.isFunctionLike(n))
        for (const p of n.parameters)
          if (ts.isIdentifier(p.name) && p.name.text === name) typeNames(p.type);
      const test = ts.isIfStatement(n)
        ? n.expression
        : ts.isConditionalExpression(n)
          ? n.condition
          : undefined;
      if (test) {
        const look = (x: ts.Node): void => {
          if (
            ts.isBinaryExpression(x) &&
            x.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
            ts.isIdentifier(strip(x.left)) &&
            (strip(x.left) as ts.Identifier).text === name
          )
            classes.add(x.right.getText());
          ts.forEachChild(x, look);
        };
        look(test);
      }
      if (ts.isBlock(n) || ts.isSourceFile(n))
        for (const st of n.statements)
          if (ts.isVariableStatement(st))
            for (const d of st.declarationList.declarations)
              if (
                ts.isIdentifier(d.name) &&
                d.name.text === name &&
                d.initializer &&
                ts.isNewExpression(strip(d.initializer))
              )
                classes.add(
                  (strip(d.initializer) as ts.NewExpression).expression.getText()
                );
    }
    return { field: e.name.text, classes: [...classes] };
  };
  return (e: ts.Expression): ts.Expression[] => {
    const read = fieldRead(e);
    if (!read) return [];
    const out: ts.Expression[] = [];
    for (const { cls, index } of ctorFields.get(read.field) ?? [])
      if (read.classes.includes(cls))
        for (const c of constructions) {
          const callee = strip(c.expression);
          const arg = c.arguments?.[index];
          if (
            ts.isIdentifier(callee) &&
            callee.text === cls &&
            arg &&
            !ts.isSpreadElement(arg)
          )
            out.push(arg);
        }
    return out;
  };
}

/** One place a value is stored: the expression, the path inside it, and which judgement holds. */
type Sink = [ts.Expression, string[], boolean];

/**
 * Rule F (TASK-209, N-112): no TypeScript in app/api, platform/ or lib/ writes words into a
 * record's note, reason, comment or error — a held change's decision note, a run's last error, a
 * ban's reason, an approval's review comment, a setting's change comment, a tenant's status
 * reason, a run step's note — as "<file>:<line> <text>". A sink is:
 *
 *   - a stored field in an object literal (STORED_NOTE_FIELDS, STORED_CODE_FIELDS; a step
 *     output's note, reason or error: an object given as `output`) — not a schema's or a ShownText
 *     (an object), nor a table of codes;
 *   - a statement's parameter written into a note or code column (sqlNoteParams, sqlCodeParams),
 *     its SQL a literal, a template or a constant;
 *   - an argument given where a function takes a note it stores — found from the sinks above, by
 *     following each function's parameters (an object parameter's property too) through its
 *     locals to a sink, to a fixed point; a call is matched by the function's or method's name.
 *
 * From each sink the flow (rule A's) is followed to its literals: in a note, each one
 * isStoredWords; in a code column, each sentence (isCodeColumnWords). A `kind:${detail}` template
 * is a code, its detail data. A catalog render reaching a sink is reported too, as
 * "<file>:<line> rendered <call>": its words would be stored in one locale. A person's note (a
 * parameter, a request's field) is no literal and is never reported.
 */
export function storedNoteSites(src: Sources, root: string): string[] {
  const strictFlow = flowOf(src, root, { accept: isStoredWords, receivers: true });
  const codeFlow = flowOf(src, root, { accept: isCodeColumnWords, receivers: true });
  const parse = strictFlow.parse;
  const files = src.list().filter((f) => /\.tsx?$/.test(f));
  type Fn = ts.FunctionLikeDeclaration;
  // A function's key: "method:<name>" for a class's or an object's method (called `x.name(…)`),
  // "function:<name>" for a declared or bound function (called `name(…)`) — so a screen's local
  // `submit` is not taken for a store's `submit` method.
  const fns: { name: string; fn: Fn }[] = [];
  for (const file of files) {
    const sf = parse(file);
    if (!sf) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name && n.body)
        fns.push({ name: `function:${n.name.getText(sf)}`, fn: n });
      else if (ts.isMethodDeclaration(n) && n.body)
        fns.push({ name: `method:${n.name.getText(sf)}`, fn: n });
      else if (
        (ts.isVariableDeclaration(n) || ts.isPropertyAssignment(n)) &&
        n.initializer &&
        (ts.isArrowFunction(strip(n.initializer)) ||
          ts.isFunctionExpression(strip(n.initializer)))
      )
        fns.push({
          name: `${ts.isPropertyAssignment(n) ? "method" : "function"}:${n.name.getText(sf)}`,
          fn: strip(n.initializer) as Fn,
        });
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const noteParams = new Map<string, NoteParam[]>();
  const calleeName = (c: ts.CallExpression | ts.NewExpression): string | undefined => {
    const e = strip(c.expression);
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) return e.name.text;
    return undefined;
  };
  /** A call's key in noteParams (see fns). */
  const calleeKey = (c: ts.CallExpression | ts.NewExpression): string | undefined => {
    const e = strip(c.expression);
    if (ts.isIdentifier(e)) return `function:${e.text}`;
    if (ts.isPropertyAccessExpression(e)) return `method:${e.name.text}`;
    return undefined;
  };
  /** The SQL text a `query` call's first argument holds (a literal, a template, a constant). */
  const sqlOf = (e: ts.Expression | undefined): string | undefined => {
    if (!e) return undefined;
    const x = strip(e);
    if (ts.isTemplateExpression(x))
      return x.head.text + x.templateSpans.map((s) => " ? " + s.literal.text).join("");
    const text = literalText(x);
    if (text !== undefined) return text;
    if (ts.isIdentifier(x)) {
      const d = strictFlow.findDecl(x.getSourceFile(), x.text);
      return d?.kind === "value" ? sqlOf(d.init) : undefined;
    }
    return undefined;
  };
  /** Every sink in `scope`. */
  const sinks = (scope: ts.Node): Sink[] => {
    const out: Sink[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) {
        const key = n.name.getText().replace(/^["']|["']$/g, "");
        const obj = n.parent;
        const inOutput =
          ts.isObjectLiteralExpression(obj) &&
          ts.isPropertyAssignment(obj.parent) &&
          obj.parent.name.getText() === "output";
        const value = ts.isPropertyAssignment(n)
          ? n.initializer
          : (n.name as ts.Expression);
        const strict =
          STORED_NOTE_FIELDS.has(key) || (inOutput && STEP_NOTE_FIELDS.has(key));
        const code =
          STORED_CODE_FIELDS.has(key) ||
          (inOutput && STEP_CODE_FIELDS.has(key)) ||
          (inAuditDetails(obj) && !AUDIT_RAW_FIELD.test(key));
        // A schema's property or a ShownText (an object) is not a stored text; nor is a table.
        if (
          (strict || code) &&
          !ts.isObjectLiteralExpression(strip(value)) &&
          !isCodeTable(obj) &&
          !isSchemaOrRenderValues(obj)
        )
          out.push([value, [], strict]);
      }
      // A stored field assigned (`acc.reasoning = parts.join(" ")`, TASK-209).
      const assigned = assignedField(n);
      if (assigned) out.push(assigned);
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const name = calleeName(n);
        const args = n.arguments ?? ts.factory.createNodeArray<ts.Expression>();
        if (name === "query" && ts.isCallExpression(n) && args.length >= 2) {
          const sql = sqlOf(args[0]);
          const values = strip(args[1]);
          if (sql && isApiCode(sql) && ts.isArrayLiteralExpression(values)) {
            const at = (k: number, strict: boolean) => {
              const v = values.elements[k - 1];
              if (v && !ts.isSpreadElement(v)) out.push([v, [], strict]);
            };
            for (const k of sqlNoteParams(sql)) at(k, true);
            for (const k of sqlCodeParams(sql)) at(k, false);
          }
        }
        const fnKey = calleeKey(n);
        for (const p of (fnKey && noteParams.get(fnKey)) || []) {
          const a = args[p.index];
          // A text the function stores is never an object literal: that is another function of
          // the same name (a screen's `submit(reason)` beside a store's `submit(item)`).
          if (!a || ts.isSpreadElement(a)) continue;
          if (p.path.length === 0 && ts.isObjectLiteralExpression(strip(a))) continue;
          out.push([a, [...p.path], p.strict]);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(scope);
    return out;
  };
  /** The parameters of `fn` (index, path) that `e` carries, through `fn`'s own locals. */
  const origins = (fn: Fn, e0: ts.Expression, depth = 0): Omit<NoteParam, "strict">[] => {
    if (depth > 6) return [];
    const e = strip(e0);
    const out: Omit<NoteParam, "strict">[] = [];
    const param = (name: string, path: string[]): void => {
      fn.parameters.forEach((p, index) => {
        if (ts.isIdentifier(p.name) && p.name.text === name) out.push({ index, path });
        else if (ts.isObjectBindingPattern(p.name))
          for (const el of p.name.elements)
            if (ts.isIdentifier(el.name) && el.name.text === name)
              out.push({
                index,
                path: [(el.propertyName ?? el.name).getText(), ...path],
              });
      });
    };
    const local = (name: string): ts.Expression | undefined => {
      let found: ts.Expression | undefined;
      const visit = (n: ts.Node): void => {
        if (found) return;
        if (
          ts.isVariableDeclaration(n) &&
          ts.isIdentifier(n.name) &&
          n.name.text === name &&
          n.initializer
        )
          found = n.initializer;
        else ts.forEachChild(n, visit);
      };
      if (fn.body) visit(fn.body);
      return found;
    };
    /** `const { name } = x` (or `{ prop: name }`) in `fn`: what it is taken from, and the key. */
    const destructured = (
      name: string
    ): { from: ts.Expression; prop: string } | undefined => {
      let found: { from: ts.Expression; prop: string } | undefined;
      const visit = (n: ts.Node): void => {
        if (found) return;
        if (
          ts.isVariableDeclaration(n) &&
          ts.isObjectBindingPattern(n.name) &&
          n.initializer
        )
          for (const el of n.name.elements)
            if (ts.isIdentifier(el.name) && el.name.text === name)
              found = {
                from: n.initializer,
                prop: (el.propertyName ?? el.name).getText(),
              };
        if (!found) ts.forEachChild(n, visit);
      };
      if (fn.body) visit(fn.body);
      return found;
    };
    if (ts.isIdentifier(e)) {
      param(e.text, []);
      if (out.length === 0) {
        const init = local(e.text);
        if (init) out.push(...origins(fn, init, depth + 1));
        const d = init ? undefined : destructured(e.text);
        if (d)
          for (const o of origins(fn, d.from, depth + 1))
            out.push({ index: o.index, path: [...o.path, d.prop] });
      }
      return out;
    }
    if (ts.isPropertyAccessExpression(e)) {
      const path: string[] = [];
      let x: ts.Expression = e;
      while (ts.isPropertyAccessExpression(x)) {
        path.unshift(x.name.text);
        x = strip(x.expression);
      }
      if (ts.isIdentifier(x)) param(x.text, path);
      return out;
    }
    if (ts.isTemplateExpression(e)) {
      for (const s of e.templateSpans) out.push(...origins(fn, s.expression, depth + 1));
      return out;
    }
    if (ts.isConditionalExpression(e))
      return [
        ...origins(fn, e.whenTrue, depth + 1),
        ...origins(fn, e.whenFalse, depth + 1),
      ];
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (
        op === ts.SyntaxKind.PlusToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      )
        return [...origins(fn, e.left, depth + 1), ...origins(fn, e.right, depth + 1)];
      return out;
    }
    if (
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      STRING_METHODS.has(e.expression.name.text)
    )
      return origins(fn, e.expression.expression, depth + 1);
    if (
      ts.isCallExpression(e) &&
      ts.isIdentifier(e.expression) &&
      e.expression.text === "String"
    )
      return e.arguments[0] ? origins(fn, e.arguments[0], depth + 1) : out;
    return out;
  };
  const key = (p: NoteParam) => `${p.index}:${p.path.join(".")}:${p.strict}`;
  for (let changed = true, round = 0; changed && round < 20; round++) {
    changed = false;
    for (const { name, fn } of fns) {
      if (!fn.body) continue;
      const known = noteParams.get(name) ?? [];
      const seen = new Set(known.map(key));
      for (const [expr, path, strict] of sinks(fn.body))
        for (const o of origins(fn, expr)) {
          const p = { index: o.index, path: [...o.path, ...path], strict };
          if (!seen.has(key(p))) {
            seen.add(key(p));
            known.push(p);
            changed = true;
          }
        }
      if (known.length) noteParams.set(name, known);
    }
  }
  /** A catalog render in a sink's value, through its locals: its words would be stored. */
  const rendered: string[] = [];
  const renders = (e0: ts.Expression | undefined, depth = 0): void => {
    if (!e0 || depth > 6) return;
    const e = strip(e0);
    if (ts.isCallExpression(e)) {
      const name = calleeName(e);
      if (name && CATALOG_RENDERS.has(name)) {
        const sf = e.getSourceFile();
        rendered.push(
          `${relative(root, sf.fileName)}:${sf.getLineAndCharacterOfPosition(e.getStart(sf)).line + 1} rendered ${name}(…)`
        );
        return;
      }
      if (
        ts.isPropertyAccessExpression(e.expression) &&
        STRING_METHODS.has(e.expression.name.text)
      )
        renders(e.expression.expression, depth + 1);
      return;
    }
    if (ts.isTemplateExpression(e))
      e.templateSpans.forEach((s) => renders(s.expression, depth + 1));
    else if (ts.isConditionalExpression(e)) {
      renders(e.whenTrue, depth + 1);
      renders(e.whenFalse, depth + 1);
    } else if (ts.isBinaryExpression(e)) {
      renders(e.left, depth + 1);
      renders(e.right, depth + 1);
    } else if (ts.isIdentifier(e)) {
      let p: ts.Node | undefined = e.parent;
      while (p && !ts.isFunctionLike(p) && !ts.isSourceFile(p)) p = p.parent;
      const visit = (n: ts.Node): void => {
        if (
          ts.isVariableDeclaration(n) &&
          ts.isIdentifier(n.name) &&
          n.name.text === e.text &&
          n.initializer
        )
          renders(n.initializer, depth + 1);
        else ts.forEachChild(n, visit);
      };
      if (p) visit(p);
    }
  };
  const fieldArgs = classFieldArgs(files, parse);
  for (const file of files) {
    const sf = parse(file);
    if (!sf) continue;
    for (const [expr, path, strict] of sinks(sf)) {
      (strict ? strictFlow : codeFlow).literalsAt(expr, path, new Set());
      if (path.length === 0) renders(expr);
      if (path.length === 0)
        for (const arg of fieldArgs(expr))
          (strict ? strictFlow : codeFlow).literalsAt(arg, [], new Set());
    }
  }
  return [...new Set([...strictFlow.sites(), ...codeFlow.sites(), ...rendered])].sort();
}

// ── Tests ─────────────────────────────────────────────────────────────

/** A virtual source set rooted at /v. */
function virtual(files: Record<string, string>): Sources {
  return {
    read: (f) => files[relative("/v", f)],
    list: () => Object.keys(files).map((f) => join("/v", f)),
  };
}

describe("screen text reached indirectly comes from the catalog (TASK-205)", () => {
  it("rule A: no literal reaches a text position through a name", () => {
    expect(indirectSites(diskSources(), ROOT)).toEqual([]);
  });

  it("rule B: no words for a person in the screens' code outside the catalog", () => {
    expect(screenCodeSites(diskSources(), ROOT)).toEqual([]);
  });

  it("rule C: no words for a person in app/api's answers outside the catalog (TASK-206)", () => {
    expect(screenCodeSites(apiSources(), ROOT, { api: true })).toEqual([]);
  });

  it("rule C: no SQL in app/api, platform/ or lib/ writes words for a person (TASK-207, TASK-208)", () => {
    // TASK-208 (N-110): the ten known sites (a withdrawn approval's note, an abandoned run's
    // reason, an erased note's placeholder, a carried-over ban's reason, who acted in an audit
    // export) store a catalog key and values (platform/errors/recorded-text.ts). None is known:
    // a new one fails.
    expect(sqlWordSites(serverSources(), ROOT)).toEqual([]);
  });

  it("[self-test] rule C, SQL: a statement's words are found; its codes, keys and casts are not", () => {
    const found = sqlWordSites(
      virtual({
        "app/api/x/route.ts": [
          "const a = `insert into roles (description) select 'Duplicated from ' || $3 from roles s`;",
          "const b = \"update jobs set status = 'failed', note = $2::jsonb where id = $1\";",
          "const c = \"select coalesce(r.description, '') from roles r where r.name = 'admin'\";",
          "const d = \"select make_interval(days => $1::int), '30 days'::interval from x\";",
          "const e = \"select jsonb_build_object('key', 'screens.admin_console.roles.duplicated_from')\";",
          "const f = \"update t set reason = 'Marked executed by the owner' where id = $1\";",
        ].join("\n"),
      }),
      "/v"
    );
    expect(found).toEqual([
      'app/api/x/route.ts:1 SQL "Duplicated from "',
      'app/api/x/route.ts:6 SQL "Marked executed by the owner"',
    ]);
  });

  it("rule E: every {label} and {what} in the catalogs stands where a label stands (TASK-208)", () => {
    const catalogs = ["messages/en.json", "messages/app/en.json"].filter((f) =>
      existsSync(join(ROOT, f))
    );
    expect(catalogs).toContain("messages/en.json");
    expect(
      catalogs.flatMap((f) =>
        misplacedLabels(JSON.parse(readFileSync(join(ROOT, f), "utf8")))
      )
    ).toEqual([]);
  });

  it("rule E: a held change's or an action's line is given only as a label (TASK-208)", () => {
    expect(labelAsNounSites(diskSources(), ROOT)).toEqual([]);
  });

  it("[self-test] rule E: a label inside a sentence is found; one in a label's place is not", () => {
    expect(
      misplacedLabels({
        a: "Approve: {what}",
        b: "{label}: done.",
        c: "Approved: {what}. It took effect.",
        d: "{what} — held for approval",
        e: "{label} is held for approval.",
        f: "Approve {label} again: verified",
        g: "Mark {label} executed",
        h: "{n, select, one {Withdraw: {label}} other {{label}}}",
        i: { j: "Approve the held change {label}" },
        k: "Group health: {label}, score {score}",
      })
    ).toEqual([
      "e: {label} is held for approval.",
      "f: Approve {label} again: verified",
      "g: Mark {label} executed",
      "i.j: Approve the held change {label}",
    ]);
    const found = labelAsNounSites(
      virtual({
        "components/x/A.tsx": [
          'const a = t("held", { key: describeWhat(h) });',
          'const b = t("done", { label: describeWhat(h) });',
          'function f() { const what = describeWhat(h); return t("x", { what, other: what }); }',
          'function g() { const key = describeAction(x); return t("y", { key }); }',
          "const c = setStatus({ text: describeWhat(h) });",
          "const d = refusedDecisionText(l, r, o, describeWhat(h));",
        ].join("\n"),
      }),
      "/v"
    );
    expect(found).toEqual([
      "components/x/A.tsx:1 key",
      "components/x/A.tsx:3 other",
      "components/x/A.tsx:4 key",
    ]);
  });

  it("rule D: no screen shows an API answer as JSON (TASK-207)", () => {
    expect(jsonDumpSites(diskSources(), ROOT)).toEqual([]);
  });

  it("[self-test] rule D: a JSON dump in a screen's text is found; one in an attribute or a body is not", () => {
    const found = jsonDumpSites(
      virtual({
        "app/x/Page.tsx": [
          "export const A = () => <pre>{JSON.stringify(resp, null, 2)}</pre>;",
          "export const B = () => <p>{ok ? JSON.stringify(v) : null}</p>;",
          "export const C = () => <i data-v={JSON.stringify(v)}>{label}</i>;",
          "const body = JSON.stringify({ a: 1 });",
          'export const D = () => <p>{t("x")}</p>;',
          "export const E = () => <div>{r && <pre>{JSON.stringify(r)}</pre>}</div>;",
        ].join("\n"),
      }),
      "/v"
    );
    expect(found).toEqual([
      "app/x/Page.tsx:1 JSON.stringify(resp, null, 2)",
      "app/x/Page.tsx:2 ok ? JSON.stringify(v) : null",
      "app/x/Page.tsx:6 JSON.stringify(r)",
    ]);
  });

  it("rule C: every key a shown(…) names is one English has", () => {
    const files = ["app", "platform", "components", "lib", "hooks"].flatMap((d) => {
      const walk = (dir: string): string[] =>
        existsSync(dir)
          ? readdirSync(dir).flatMap((n) => {
              const p = join(dir, n);
              if (statSync(p).isDirectory())
                return n === "node_modules" || n === "__tests__" ? [] : walk(p);
              return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
            })
          : [];
      return walk(join(ROOT, d));
    });
    const keys = shownKeys(files, (f) => readFileSync(f, "utf8"));
    expect(keys.length).toBeGreaterThan(40);
    expect(
      keys.filter((k) => renderMessage(k.split(":")[1]) === k.split(":")[1])
    ).toEqual([]);
  });

  it("[self-test] rule C: answers' English is found; SQL, headers, logs, schemas and model text are not", () => {
    const found = screenCodeSites(
      virtual({
        "app/api/x/route.ts": [
          'const q = "select id, name from roles where id = $1::uuid";',
          'const order = "s.created_at desc, s.id";',
          'res.headers.set("Cache-Control", "no-store");',
          'return { success: true, result: `Role "${name}" deleted` };',
          'return { error: "The change could not be written." };',
          'internalError(e, { request, context: "Sign in failed" });',
          'raiseAlert({ name: "x", message: "An erasure request was refused." });',
          'const tool = { name: "x", description: "Update a config entry.", input_schema: { type: "object" } };',
          "/** @modelText the model's context */",
          "function ctx() { return `Current roles: ${a}`; }",
          "const id = `op_${t}_${i}`;",
          'const frame = "data: [DONE]\\n\\n";',
        ].join("\n"),
      }),
      "/v",
      { api: true }
    );
    expect(found.map((f) => f.replace(/^(\S+) /, "$1|"))).toEqual([
      'app/api/x/route.ts:4|"Role \\" \\" deleted"',
      'app/api/x/route.ts:5|"The change could not be written."',
    ]);
  });

  it("[self-test] rule A follows tables, aliases, callbacks, defaults, functions and imports", () => {
    const found = indirectSites(
      virtual({
        "lib/meta.ts":
          'export const META = { A: { label: "Conversational", color: "bg-gray-600" } };',
        "components/X.tsx": [
          'import { META } from "@/lib/meta";',
          'const MODES = { text: { label: "Text", aria: "Text input mode" } };',
          'const OPTS = [{ value: "a", label: "Private" }];',
          'const STATUS = ["pending"];',
          'function line(s: string) { return s ? `possibly ${s}` : ""; }',
          "const t = (key: string) => renderMessage(`screens.x.${key}`);",
          'export function X({ title = "PLAYFORM", mode }: { title?: string; mode: "text" }) {',
          "  const m = META[mode];",
          "  return (<div title={MODES[mode].aria}>{MODES[mode].label}{title}{m.label}",
          "    {OPTS.map((o) => <i key={o.value}>{o.label}</i>)}{STATUS.map((s) => <b key={s}>{s}</b>)}",
          '    {line("x")}{t("k")}<i className={m.color} /></div>);',
          "}",
        ].join("\n"),
      }),
      "/v"
    );
    expect(found.map((f) => f.replace(/^(\S+) /, "$1|"))).toEqual(
      [
        'components/X.tsx:2|"Text"',
        'components/X.tsx:2|"Text input mode"',
        'components/X.tsx:3|"Private"',
        'components/X.tsx:4|"pending"',
        'components/X.tsx:5|"possibly  "',
        'components/X.tsx:7|"PLAYFORM"',
        'lib/meta.ts:1|"Conversational"',
      ].sort()
    );
  });

  it("[self-test] rule B finds a hook's message and a prop's heading; code shapes are not words", () => {
    const found = screenCodeSites(
      virtual({
        "hooks/useX.ts": [
          'setNotification(makeNotification("Upload failed. Please try again.", "error"));',
          'const NETWORK_ERROR = "Unable to reach the server.";',
          'logger.warn("Upload failed", { route: "hooks/useX" });',
          'if (state === "Ready now") throw new Error("Something broke here");',
          'document.cookie = "pf_has_session=true; path=/; max-age=60";',
          'const k = "screens.app.x"; const p = "permission.unknown_tool";',
        ].join("\n"),
        "components/T.tsx": [
          '"use client";',
          "const t = (key: string) => renderMessage(`screens.t.${key}`);",
          'export const T = () => (<DataTable headers={["Code", "Name"]} emptyMessage="No groups yet."',
          '  className="flex mt-2 text-gray-400" style={{ padding: "0.5rem 1.5rem", fontFamily: "system-ui, sans-serif" }}',
          '  data-testid="x" aria-live="polite">{t("ok")}<span className={`break-words ${a ? "font-mono text-xs" : ""}`} /></DataTable>);',
        ].join("\n"),
      }),
      "/v"
    );
    expect(found.map((f) => f.replace(/^(\S+) /, "$1|"))).toEqual([
      'hooks/useX.ts:1|"Upload failed. Please try again."',
      'hooks/useX.ts:2|"Unable to reach the server."',
      'components/T.tsx:3|"Code"',
      'components/T.tsx:3|"Name"',
      'components/T.tsx:3|"No groups yet."',
    ]);
  });

  it("[self-test] code shapes", () => {
    for (const s of [
      "flex mt-2",
      "0.5rem 1.5rem",
      "a=b; path=/",
      "screens.app.x",
      "snake_case",
      "kebab-case",
      "camelCase",
      "CONST_X",
      "USD",
      "/api/x",
      "https://x.io",
    ])
      expect([s, isWords(s)]).toEqual([s, false]);
    for (const s of [
      "Private",
      "pending",
      "Continue with Google",
      "possibly ",
      "Max 2500 characters",
    ])
      expect([s, isWords(s)]).toEqual([s, true]);
  });
});

describe("records written by TypeScript carry a catalog key (TASK-209, rule F)", () => {
  it("rule F: no TypeScript writes words into a record's note, reason, comment or error (TASK-209)", () => {
    // TASK-209 (N-112): a lapsed or undecided hold's note, a decision's default note, a superseded
    // or duplicate hold's note, a run's recorded error, "marked executed by …", a strike ban's
    // reason, a withdrawn approval's review comment are a catalog key and values
    // (platform/errors/recorded-text.ts). None is known: a new one fails.
    expect(storedNoteSites(noteSources(), ROOT)).toEqual([]);
  });

  it("[self-test] rule F: words reaching a record's note are found; codes, keys and a person's note are not", () => {
    const found = storedNoteSites(
      virtual({
        "platform/x/store.ts": [
          "export class S {",
          "  async decide(id: string, by: string, note?: string) {",
          '    await tx.query("update proposals set decided_by = $2, decision_note = $3 where id = $1", [id, by, note]);',
          "  }",
          "  async fail(id: string, why: string) {",
          "    return this.move(id, { lastRunError: why });",
          "  }",
          "}",
          "export const lapsed = (days: number) => `expired: not run within ${days} days`;",
          "async function sweep(days: number) {",
          '  await tx.query("update proposals set decision_note = $2 where x < $1", [days, lapsed(days)]);',
          '  await tx.query("insert into user_strikes (user_id, reason) values ($1, $2)", [u, "Automatic ban for spam"]);',
          '  await tx.query("update users set ban_reason = case when $1::boolean then $2 else ban_reason end", [true, "strike threshold"]);',
          "}",
          "function step(note: string) {",
          '  return { output: { note: `marked executed: ${note}`, status: "done", error: "sqlstate:57014" } };',
          "}",
          "async function route(body: { note?: string }) {",
          '  await new S().decide("p", "a", body.note?.trim() || "rejected_after_run_failed");',
          '  await new S().decide("p", "a", body.note ?? "approvals.run_failed");',
          '  await new S().fail("p", `run failed: ${code}`.slice(0, 500));',
          '  await new S().decide("p", "a", body.note);',
          '  const label = "Not a note at all";',
          '  return { label, changeComment: "Use the platform default" };',
          "}",
          "function impact() {",
          "  const parts: string[] = [];",
          '  parts.push("This is a safety-critical setting.");',
          '  return { impactSummary: parts.join(" "), reviewComment: renderShown(x) };',
          "}",
          'const KINDS = { changeComment: "text", status: "code", reason: "text" };',
          'const SCHEMA = { properties: { changeComment: { type: "string", description: "Why it changed" } } };',
          "function code(k: string) {",
          '  return { lastRunError: `reported:${k}`, lastError: "lease_expired" };',
          "}",
        ].join("\n"),
      }),
      "/v"
    );
    expect(found).toEqual([
      'platform/x/store.ts:12 "Automatic ban for spam"',
      'platform/x/store.ts:13 "strike threshold"',
      'platform/x/store.ts:16 "marked executed:  "',
      'platform/x/store.ts:19 "rejected_after_run_failed"',
      'platform/x/store.ts:21 "run failed:  "',
      'platform/x/store.ts:24 "Use the platform default"',
      'platform/x/store.ts:28 "This is a safety-critical setting."',
      "platform/x/store.ts:29 rendered renderShown(…)",
      'platform/x/store.ts:9 "expired: not run within   days"',
    ]);
    expect(
      sqlNoteParams(
        "update t set status = $1, decision_note = $2, note = $4 where id = $3"
      )
    ).toEqual([2, 4]);
    expect(
      sqlNoteParams(
        "insert into config_pending_approvals (id, review_comment, status) values ($1, coalesce($2, 'x'), $3)"
      )
    ).toEqual([2]);
    expect(sqlNoteParams("select jsonb_build_object('note', $5, 'by', $6)")).toEqual([5]);
    expect(
      sqlCodeParams("update proposals set last_run_error = $3 where id = $1")
    ).toEqual([3]);
    expect(isStoredWords("revised")).toBe(true);
    expect(isStoredWords("refused: x")).toBe(true);
    expect(isStoredWords("screens.records.note_erased")).toBe(false);
    expect(isStoredWords("approvals.run_failed")).toBe(false);
    expect(isStoredWords("sqlstate:57014")).toBe(false);
    expect(isStoredWords(" ")).toBe(false);
    expect(isCodeColumnWords("run failed, approval kept")).toBe(true);
    expect(isCodeColumnWords("lease_expired")).toBe(false);
    expect(isCodeColumnWords("reported:x")).toBe(false);
  });

  it("[self-test] rule F, moderation reasons: words in a decision's reasoning, factors or conclusion are found; keys, schemas and render values are not", () => {
    const found = storedNoteSites(
      virtual({
        "platform/x/guardian.ts": [
          "function screen(empty: boolean) {",
          "  const reasonParts: string[] = [];",
          '  reasonParts.push("Classifier unavailable — withheld.");',
          '  if (empty) return { action: "allow", reasoning: "Empty text — no content to screen.", contextFactors: [] };',
          '  return { action: "block", reasoning: reasonParts.join(" "), contextFactors: ["ai-output: strikes not attributed to user"] };',
          "  acc.reasoning = `Blocklist hit: ${cats}.`;",
          "}",
          "function keyed() {",
          '  return { reasoning: [shown("screens.moderation.reasons.declined")], factors: [shown("screens.moderation.factors.ai_output")] };',
          "}",
          'const S = { type: "string" };',
          'const SCHEMA = { type: "object", properties: { reasoning: S, conclusion: S } };',
          "function view(c: string) {",
          '  return msg("conclusion", { conclusion: c });',
          "}",
          'function chain() { return builder.build({ conclusion: "Answer generated" }); }',
        ].join("\n"),
      }),
      "/v"
    );
    expect(found).toEqual([
      'platform/x/guardian.ts:16 "Answer generated"',
      'platform/x/guardian.ts:3 "Classifier unavailable — withheld."',
      'platform/x/guardian.ts:4 "Empty text — no content to screen."',
      'platform/x/guardian.ts:5 "ai-output: strikes not attributed to user"',
      'platform/x/guardian.ts:6 "Blocklist hit:  ."',
    ]);
  });

  it("[self-test] rule F, audit details: a sentence or an error's composed reason is found; codes, raw fields and a health answer's details are not", () => {
    const found = storedNoteSites(
      virtual({
        "platform/x/audit.ts": [
          "export class RunFailed extends Error {",
          "  constructor(readonly label: string, readonly reason: string) { super(label); }",
          "}",
          "export class Other extends Error {",
          "  constructor(readonly reason: string) { super(reason); }",
          "}",
          'const RAISED = "the run raised an error";',
          "function run() {",
          '  throw new RunFailed("t", RAISED);',
          "}",
          'function other() { throw new Other("an unrelated sentence here"); }',
          "async function record(err: RunFailed, why: string) {",
          "  await writeAuditLog({",
          '    action: "admin_action",',
          '    details: { type: "approved_run_failed", reason: err.reason.slice(0, 500), note: "Applied by the system", nested: { cause: "it went away" } },',
          "  });",
          '  await writeAuditLog({ action: "admin_action", details: { reason: why, rawReply: "model text, kept raw", code: "screens.records.run_raised" } });',
          "}",
          "async function unknown(e: unknown) {",
          '  await writeAuditLog({ action: "x", details: { reason: (e as Other).reason } });',
          "}",
          'function health() { return { name: "db", details: { detail: "the check did not complete" } }; }',
        ].join("\n"),
      }),
      "/v"
    );
    expect(found).toEqual([
      'platform/x/audit.ts:15 "Applied by the system"',
      'platform/x/audit.ts:15 "it went away"',
      'platform/x/audit.ts:7 "the run raised an error"',
    ]);
  });
});
