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

export function indirectSites(src: Sources, root: string): string[] {
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
      if (props.length === 0 && isWords(text)) report(e);
      if (ts.isTemplateExpression(e))
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
      const d = findDecl(sf, name);
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
    const c = chain(e);
    if (!c) return;
    const sf = c.root.getSourceFile();
    const k = `${sf.fileName}:${c.root.text}:${[...c.props, ...props].join(".")}`;
    if (seen.has(k)) return;
    seen.add(k);
    const d = findDecl(sf, c.root.text);
    if (d?.kind === "value") literalsAt(d.init, [...c.props, ...props], seen);
  };
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
  return [...out.values()].sort();
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
