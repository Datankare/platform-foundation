/**
 * __tests__/api-route-body-schema.test.ts — every route reads its JSON body against a declared
 * schema first (TASK-200, rule 5)
 *
 * @guard a route reading a JSON body's fields without checking its keys against a declared schema
 *
 * TASK-194's command bar and config tools refuse an input key their schema does not name (S1's
 * input-keys guard); a route reading a field its schema never declared — or taking keys nobody
 * declared — was a recurring finding. The rule for every API route that reads a JSON body: read
 * it with `readJsonBody(request, SCHEMA)` (platform/errors/request-body.ts), which refuses a key
 * the schema does not name before any field is read. A call to `readJsonObject` (the read without
 * a schema) or `request.json()` outside platform/errors is refused, except the sites counted per
 * file in body-schema-baseline.json (repository root, per repository) — the routes written before
 * the rule. Here a file over its count fails and one under it must lower it
 * (`UPDATE_BODY_SCHEMA_BASELINE=1 npx jest __tests__/api-route-body-schema.test.ts` lowers it);
 * that the baseline itself never rises — no count above the base branch's, no file added — is
 * scripts/process-check.mjs's (CI Layer 0f), which compares it with the merge base.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import * as ts from "typescript";
import { productionSources, read } from "./helpers/route-policy";

const ROOT = join(__dirname, "..");
const BASELINE_FILE = join(ROOT, "body-schema-baseline.json");
const READER = "platform/errors/request-body.ts";

interface Baseline {
  $comment?: string;
  count: number;
  files: Record<string, number>;
}

/** The expression under parentheses, `as`, `satisfies`, `!` and `<T>`. */
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

/** A parameter or variable type that is a request: Request, NextRequest, JsonRequest, …Request. */
const REQUEST_TYPE = /\b\w*Request\b/;

/**
 * Lines that read a JSON body without a schema: `readJsonObject(…)` however it is named (an
 * import alias, `errors.readJsonObject(…)`, a const bound to it); `.json()` on a request — a
 * name `request` / `req`, any parameter or variable typed as a request, a name bound from one,
 * and through `.clone()`; `new Response(request.body).json()`; `JSON.parse(await request.text())`;
 * and a `readJsonBody` given no schema. (A body read as text and not parsed — a webhook's
 * signature check — is not a JSON read.)
 */
export function schemalessReads(text: string, name = "probe.ts"): number[] {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const objectReaders = new Set(["readJsonObject"]);
  const bodyReaders = new Set(["readJsonBody"]);
  const requests = new Set(["request", "req"]);
  // Names: import aliases, consts bound to a reader or a request, parameters typed as requests.
  const bind = (n: ts.Node): void => {
    if (ts.isImportSpecifier(n)) {
      const imported = (n.propertyName ?? n.name).text;
      if (imported === "readJsonObject") objectReaders.add(n.name.text);
      if (imported === "readJsonBody") bodyReaders.add(n.name.text);
    }
    if (ts.isParameter(n) && ts.isIdentifier(n.name) && n.type)
      if (REQUEST_TYPE.test(n.type.getText(sf))) requests.add(n.name.text);
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = unwrap(n.initializer);
      if (ts.isIdentifier(n.name)) {
        if (n.type && REQUEST_TYPE.test(n.type.getText(sf))) requests.add(n.name.text);
        const src = ts.isPropertyAccessExpression(init)
          ? init.name.text
          : init.getText(sf);
        if (objectReaders.has(src)) objectReaders.add(n.name.text);
        if (bodyReaders.has(src)) bodyReaders.add(n.name.text);
        if (isRequest(init)) requests.add(n.name.text);
      } else if (ts.isObjectBindingPattern(n.name)) {
        for (const el of n.name.elements) {
          const key = (el.propertyName ?? el.name).getText(sf);
          if (!ts.isIdentifier(el.name)) continue;
          if (key === "readJsonObject") objectReaders.add(el.name.text);
          if (key === "readJsonBody") bodyReaders.add(el.name.text);
        }
      }
    }
    ts.forEachChild(n, bind);
  };
  // A request: a known name, or `<request>.clone()`.
  function isRequest(e: ts.Expression): boolean {
    const x = unwrap(e);
    if (ts.isIdentifier(x)) return requests.has(x.text);
    if (
      ts.isCallExpression(x) &&
      x.arguments.length === 0 &&
      ts.isPropertyAccessExpression(x.expression) &&
      x.expression.name.text === "clone"
    )
      return isRequest(x.expression.expression);
    return false;
  }
  // The name a call is made by: `f(…)` → f; `ns.f(…)` → f.
  const calledName = (callee: ts.Expression): string | undefined => {
    const x = unwrap(callee);
    if (ts.isIdentifier(x)) return x.text;
    if (ts.isPropertyAccessExpression(x)) return x.name.text;
    return undefined;
  };
  // Bindings first, twice (a const may be bound from a name bound later in the walk).
  bind(sf);
  bind(sf);
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      const called = calledName(callee);
      if (called !== undefined && objectReaders.has(called)) lines.push(at(n));
      // `.json()` — or `["json"]()` — on a request, a request's clone, or a name bound to one.
      const member =
        ts.isPropertyAccessExpression(callee) && callee.name.text === "json"
          ? callee.expression
          : ts.isElementAccessExpression(callee) &&
              ts.isStringLiteralLike(callee.argumentExpression) &&
              callee.argumentExpression.text === "json"
            ? callee.expression
            : undefined;
      if (member && n.arguments.length === 0 && isRequest(member)) lines.push(at(n));
      // `new Response(request.body).json()` (or of the request itself): the body re-read raw.
      if (member && n.arguments.length === 0) {
        const wrapped = unwrap(member);
        if (
          ts.isNewExpression(wrapped) &&
          /^(?:Response|NextResponse|Request)$/.test(wrapped.expression.getText(sf)) &&
          wrapped.arguments?.[0] !== undefined &&
          (isRequest(wrapped.arguments[0]) ||
            (ts.isPropertyAccessExpression(unwrap(wrapped.arguments[0])) &&
              (unwrap(wrapped.arguments[0]) as ts.PropertyAccessExpression).name.text ===
                "body" &&
              isRequest(
                (unwrap(wrapped.arguments[0]) as ts.PropertyAccessExpression).expression
              )))
        )
          lines.push(at(n));
      }
      // `JSON.parse(await request.text())`: the body read as text and parsed by hand.
      if (callee.getText(sf) === "JSON.parse" && n.arguments[0] !== undefined) {
        let arg = unwrap(n.arguments[0]);
        if (ts.isAwaitExpression(arg)) arg = unwrap(arg.expression);
        if (
          ts.isCallExpression(arg) &&
          ts.isPropertyAccessExpression(unwrap(arg.expression)) &&
          (unwrap(arg.expression) as ts.PropertyAccessExpression).name.text === "text" &&
          isRequest((unwrap(arg.expression) as ts.PropertyAccessExpression).expression)
        )
          lines.push(at(n));
      }
      // A schema'd read must pass its schema.
      if (called !== undefined && bodyReaders.has(called) && n.arguments.length < 2)
        lines.push(at(n));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...new Set(lines)].sort((a, b) => a - b);
}

function current(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of productionSources()) {
    if (f === READER) continue;
    const n = schemalessReads(read(f), f).length;
    if (n > 0) out[f] = n;
  }
  return out;
}

describe("JSON bodies are read against a declared schema (TASK-200, rule 5)", () => {
  const counts = current();
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline;

  it("no file reads a body without a schema beyond its baseline; the baseline only shrinks", () => {
    const files = [
      ...new Set([...Object.keys(counts), ...Object.keys(baseline.files)]),
    ].sort();
    const over = files.filter((f) => (counts[f] ?? 0) > (baseline.files[f] ?? 0));
    const under = files.filter((f) => (counts[f] ?? 0) < (baseline.files[f] ?? 0));
    if (process.env.UPDATE_BODY_SCHEMA_BASELINE === "1" && over.length === 0) {
      const kept = Object.fromEntries(
        files.filter((f) => counts[f]).map((f) => [f, counts[f]])
      );
      const count = Object.values(kept).reduce((n, c) => n + c, 0);
      writeFileSync(
        BASELINE_FILE,
        `${JSON.stringify({ ...baseline, count, files: kept }, null, 2)}\n`
      );
      return;
    }
    expect({
      over: over.map(
        (f) =>
          `${f}: ${counts[f]} schemaless reads, ${baseline.files[f] ?? 0} allowed — use readJsonBody(request, SCHEMA)`
      ),
      under: under.map(
        (f) => `${f}: ${counts[f] ?? 0} now — lower body-schema-baseline.json`
      ),
    }).toEqual({ over: [], under: [] });
    const sum = Object.values(baseline.files).reduce((n, c) => n + c, 0);
    expect(baseline.count).toBe(sum);
  });

  it("[self-test] reports a planted schemaless read, a bare request.json() and a schema-less readJsonBody", () => {
    const planted = [
      "export async function POST(request: Request) {",
      "  const a = await readJsonObject(request);",
      "  const b = await request.json();",
      "  const c = await readJsonBody(request);",
      "  const d = await readJsonBody(request, BODY_SCHEMA);",
      "  const e = await res.json();",
      "}",
    ].join("\n");
    expect(schemalessReads(planted)).toEqual([2, 3, 4]);
  });

  it("[self-test] reports a read by another name: an alias, a namespace, any request parameter, a clone", () => {
    const planted = [
      'import { readJsonObject as readBody, readJsonBody as rb } from "@/platform/errors";',
      'import * as errors from "@/platform/errors";',
      "export async function POST(incoming: NextRequest, ctx: Ctx) {",
      "  const a = await readBody(incoming);",
      "  const b = await errors.readJsonObject(incoming);",
      "  const c = await incoming.json();",
      "  const d = await request.clone().json();",
      "  const copy = incoming.clone();",
      "  const e = await copy.json();",
      '  const f = await incoming["json"]();',
      "  const g = await rb(incoming);",
      "  const h = await errors.readJsonBody(incoming);",
      "  const read = errors.readJsonObject;",
      "  const i = await read(incoming);",
      "  const ok = await rb(incoming, SCHEMA);",
      "  const res = await fetch(url);",
      "  const j = await res.json();",
      "}",
      "async function handle(r: JsonRequest) { return (r as JsonRequest).json(); }",
      "const k = JSON.parse(await request.text());",
      "const l = await new Response(request.body).json();",
      "const m = await new Response(incoming).json();",
      "const raw = await request.text();",
      "const n = JSON.parse(someString);",
    ].join("\n");
    expect(schemalessReads(planted)).toEqual([
      4, 5, 6, 7, 9, 10, 11, 12, 14, 19, 20, 21, 22,
    ]);
  });
});
