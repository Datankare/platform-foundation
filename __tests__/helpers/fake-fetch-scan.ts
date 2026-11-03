/**
 * __tests__/helpers/fake-fetch-scan.ts — hand-written response bodies in screen tests (TASK-200,
 * rule 3)
 *
 * A screen test that mocks `fetch` with a body written by hand tests the screen against a
 * response the real route may never send: TASK-194's fixes passed such tests while the route
 * answered another shape. This finds, in a component test (one that renders with
 * @testing-library/react and replaces fetch — assigned, spied on, defined with
 * Object.defineProperty, or through a mocked client fetch wrapper, FETCH_WRAPPERS), every object
 * or array literal that becomes a response body:
 *
 *   - a `json` member whose function returns a literal: `json: async () => ({ … })`,
 *     `json: () => Promise.resolve([ … ])`, or a block that returns one;
 *   - `Response.json(<literal>)` and `new Response(JSON.stringify(<literal>))`;
 *   - a literal passed to a reply helper of the file — a function whose `json` member (or
 *     `Response.json` / `new Response(JSON.stringify(…))`) returns one of its parameters, or that
 *     passes its parameters on to such a helper — anywhere in the call's arguments (a tuple in a
 *     list of answers too), and a same-file `const` holding a literal that is passed so.
 *
 * Bodies taken from __tests__/fixtures/route-responses (produced by the real route handlers in
 * __tests__/route-fixtures.test.ts) are identifiers imported from there: never counted.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import * as ts from "typescript";

/**
 * The client's fetch wrappers (a screen calls these, not fetch): a test that mocks one answers the
 * screen as surely as one that replaces fetch. The platform's: apiFetch
 * (platform/auth/api-fetch.ts) and fetchWithProvisioningRetry (platform/errors/refusal.ts). An app
 * lists its own in scripts/fetch-wrappers.app.json (`{ "wrappers": [{ "module", "name" }] }`, the
 * app's, not synced — as scripts/risk-tiers.app.json).
 */
export const FETCH_WRAPPERS: readonly FetchWrapper[] = [
  { module: "platform/auth/api-fetch", name: "apiFetch" },
  { module: "platform/errors/refusal", name: "fetchWithProvisioningRetry" },
];

export interface FetchWrapper {
  readonly module: string;
  readonly name: string;
}

export const APP_WRAPPERS_FILE = "scripts/fetch-wrappers.app.json";

/** The app's own fetch wrappers (scripts/fetch-wrappers.app.json), none when it has no list. */
export function appFetchWrappers(root = process.cwd()): FetchWrapper[] {
  const file = join(root, APP_WRAPPERS_FILE);
  if (!existsSync(file)) return [];
  const json = JSON.parse(readFileSync(file, "utf8")) as { wrappers?: FetchWrapper[] };
  return (json.wrappers ?? []).filter(
    (w) => typeof w.module === "string" && typeof w.name === "string"
  );
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
const GLOBAL = String.raw`(?:global|globalThis|window)`;
/** `global`, `(global as any)`, `(globalThis as unknown as X)`, `window`, … */
const GLOBAL_REF = String.raw`(?:\b${GLOBAL}|\(\s*${GLOBAL}\s+as\s+[^)]*\))`;

/**
 * The ways a test replaces fetch: assigning it (`global.fetch =`, `(global as any).fetch =`,
 * `global["fetch"] =`), spying on it, defining it (`Object.defineProperty(global, "fetch", …)`),
 * passing a mock as `fetch:`, mocking a client fetch wrapper's module
 * (`jest.mock("@/platform/auth/api-fetch", …)`) or spying on the wrapper.
 */
export function replacesFetch(wrappers: readonly FetchWrapper[]): RegExp {
  const modules = wrappers
    .map((w) => escape(w.module.split("/").pop() as string))
    .join("|");
  const names = wrappers.map((w) => escape(w.name)).join("|");
  const wrapperModule = String.raw`(?:@\/|(?:\.{1,2}\/)+)(?:[\w.-]+\/)*(?:${modules})`;
  return new RegExp(
    [
      String.raw`${GLOBAL_REF}\s*\.\s*fetch\s*=(?!=)`,
      String.raw`${GLOBAL_REF}\s*\[\s*["'\x60]fetch["'\x60]\s*\]\s*=(?!=)`,
      String.raw`spyOn\(\s*${GLOBAL_REF}\s*,\s*["']fetch["']`,
      String.raw`defineProperty\(\s*${GLOBAL_REF}\s*,\s*["']fetch["']`,
      String.raw`\bfetch:\s*(?:jest\.fn|fetchMock|mockFetch)`,
      String.raw`jest\.(?:mock|doMock)\(\s*["'\x60]${wrapperModule}["'\x60]`,
      String.raw`spyOn\(\s*[\w.]+\s*,\s*["'](?:${names})["']`,
    ].join("|")
  );
}

/**
 * Whether a test file renders components and replaces fetch (or a client fetch wrapper: the
 * platform's, and the app's own from scripts/fetch-wrappers.app.json unless given).
 */
export function isComponentFetchTest(
  text: string,
  wrappers: readonly FetchWrapper[] = [...FETCH_WRAPPERS, ...appFetchWrappers()]
): boolean {
  return (
    /from\s+["']@testing-library\/react["']/.test(text) &&
    replacesFetch(wrappers).test(text)
  );
}

const isLiteral = (
  e: ts.Node
): e is ts.ObjectLiteralExpression | ts.ArrayLiteralExpression =>
  ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e);

function unwrap(e: ts.Expression): ts.Expression {
  let x = e;
  while (
    ts.isParenthesizedExpression(x) ||
    ts.isAsExpression(x) ||
    ts.isSatisfiesExpression(x) ||
    ts.isTypeAssertionExpression(x) ||
    ts.isNonNullExpression(x)
  )
    x = x.expression;
  return x;
}

/** What a function returns: its expression body, or each `return` of its block. */
function returned(fn: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration) {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [unwrap(fn.body)];
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) && n !== fn) return;
    if (ts.isReturnStatement(n) && n.expression) out.push(unwrap(n.expression));
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn.body, visit);
  return out;
}

/** `Promise.resolve(x)` → x. */
function resolvedValue(e: ts.Expression): ts.Expression {
  if (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    e.expression.getText() === "Promise.resolve" &&
    e.arguments.length === 1
  )
    return unwrap(e.arguments[0]);
  return e;
}

/** The body expression of a `json` member, `Response.json(x)` or `new Response(JSON.stringify(x))`. */
function bodyExpressions(node: ts.Node): ts.Expression[] {
  if (
    ts.isPropertyAssignment(node) &&
    node.name.getText() === "json" &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  )
    return returned(node.initializer).map(resolvedValue);
  if (ts.isMethodDeclaration(node) && node.name.getText() === "json" && node.body)
    return returned(node as unknown as ts.FunctionExpression).map(resolvedValue);
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    /^(?:Response|NextResponse)\.json$/.test(node.expression.getText()) &&
    node.arguments.length > 0
  )
    return [unwrap(node.arguments[0])];
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Response" &&
    node.arguments?.length
  ) {
    const a = unwrap(node.arguments[0]);
    if (
      ts.isCallExpression(a) &&
      a.expression.getText() === "JSON.stringify" &&
      a.arguments.length > 0
    )
      return [unwrap(a.arguments[0])];
  }
  return [];
}

type Fn = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

function namedFunctions(sf: ts.SourceFile): Map<string, Fn> {
  const out = new Map<string, Fn>();
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) out.set(n.name.text, n);
    else if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(unwrap(n.initializer)) ||
        ts.isFunctionExpression(unwrap(n.initializer)))
    )
      out.set(n.name.text, unwrap(n.initializer) as Fn);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function paramNames(fn: Fn): Set<string> {
  const names = new Set<string>();
  const add = (b: ts.BindingName): void => {
    if (ts.isIdentifier(b)) names.add(b.text);
    else b.elements.forEach((e) => ts.isBindingElement(e) && add(e.name));
  };
  fn.parameters.forEach((p) => add(p.name));
  return names;
}

/** The functions of the file that turn an argument into a response body. */
function replyHelpers(fns: Map<string, Fn>): Set<string> {
  const helpers = new Set<string>();
  // A helper's own body returns a parameter (or a name bound from one) as the body.
  for (const [name, fn] of fns) {
    const params = paramNames(fn);
    let direct = false;
    const visit = (n: ts.Node): void => {
      // `const [s, b] = list[i]` and the like: names bound from a parameter are its parts.
      if (ts.isVariableDeclaration(n) && n.initializer) {
        const src = n.initializer.getText();
        if ([...params].some((p) => new RegExp(`\\b${p}\\b`).test(src))) {
          const add = (b: ts.BindingName): void => {
            if (ts.isIdentifier(b)) params.add(b.text);
            else b.elements.forEach((e) => ts.isBindingElement(e) && add(e.name));
          };
          add(n.name);
        }
      }
      for (const e of bodyExpressions(n)) {
        if (ts.isIdentifier(e) && params.has(e.text)) direct = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(fn);
    if (direct) helpers.add(name);
  }
  // A function that calls a helper with one of its parameters is one too.
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, fn] of fns) {
      if (helpers.has(name)) continue;
      const params = paramNames(fn);
      let forwards = false;
      const visit = (n: ts.Node): void => {
        if (ts.isVariableDeclaration(n) && n.initializer) {
          const src = n.initializer.getText();
          if ([...params].some((p) => new RegExp(`\\b${p}\\b`).test(src))) {
            const add = (b: ts.BindingName): void => {
              if (ts.isIdentifier(b)) params.add(b.text);
              else b.elements.forEach((e) => ts.isBindingElement(e) && add(e.name));
            };
            add(n.name);
          }
        }
        if (
          ts.isCallExpression(n) &&
          ts.isIdentifier(n.expression) &&
          helpers.has(n.expression.text) &&
          n.arguments.some((a) =>
            [...params].some((p) => new RegExp(`\\b${p}\\b`).test(a.getText()))
          )
        )
          forwards = true;
        ts.forEachChild(n, visit);
      };
      visit(fn);
      if (forwards) {
        helpers.add(name);
        changed = true;
      }
    }
  }
  return helpers;
}

/** Each literal in an argument tree: the argument itself, or inside an array or tuple of them. */
function literalsIn(
  e: ts.Expression,
  consts: Map<string, ts.Expression>,
  out: Set<ts.Node>
) {
  const x = unwrap(e);
  if (ts.isObjectLiteralExpression(x)) out.add(x);
  else if (
    ts.isArrayLiteralExpression(x) &&
    x.elements.length === 2 &&
    ts.isNumericLiteral(unwrap(x.elements[0] as ts.Expression))
  ) {
    // One answer, `[status, body]`: the body is what counts.
    literalsIn(x.elements[1] as ts.Expression, consts, out);
  } else if (ts.isArrayLiteralExpression(x)) {
    // A list of answers ([status, body] tuples): the bodies are the literals inside.
    const tuples = x.elements.every((el) =>
      ts.isArrayLiteralExpression(unwrap(el as ts.Expression))
    );
    if (tuples) x.elements.forEach((el) => literalsIn(el as ts.Expression, consts, out));
    else out.add(x);
  } else if (ts.isIdentifier(x) && consts.has(x.text)) out.add(consts.get(x.text)!);
}

/** Same-file `const X = <literal>` declarations, by name. */
function literalConsts(sf: ts.SourceFile): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const v = unwrap(n.initializer);
      if (isLiteral(v)) out.set(n.name.text, v);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The 1-based lines of each hand-written response body in a component test's source. */
export function handWrittenBodies(
  text: string,
  name = "probe.test.tsx",
  wrappers: readonly FetchWrapper[] = [...FETCH_WRAPPERS, ...appFetchWrappers()]
): number[] {
  if (!isComponentFetchTest(text, wrappers)) return [];
  const sf = ts.createSourceFile(
    name,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const fns = namedFunctions(sf);
  const helpers = replyHelpers(fns);
  const consts = literalConsts(sf);
  const found = new Set<ts.Node>();
  const visit = (n: ts.Node): void => {
    for (const e of bodyExpressions(n)) literalsIn(e, consts, found);
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      helpers.has(n.expression.text)
    )
      n.arguments.forEach((a) => literalsIn(a, consts, found));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...found]
    .map((n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1)
    .sort((a, b) => a - b);
}
