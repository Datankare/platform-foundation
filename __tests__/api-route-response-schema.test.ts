/**
 * __tests__/api-route-response-schema.test.ts — every route handler declares the body it answers
 * with (TASK-215, audit A-13)
 *
 * @guard a route handler that answers JSON without a declared response schema
 *
 * What a route answered was whatever its handler built; no check said which fields leave (audit
 * A-13). Now every exported handler is `tenantRoute(handler, RESPONSE)` — its declared success body
 * — and the wrapper checks each JSON answer against it (errors against the registry's one error
 * body), failing outside production and removing the field in production
 * (platform/errors/response-schema.ts). Here: each exported handler of every API route passes a
 * second argument to tenantRoute; the handlers before the rule would be counted per file in
 * response-schema-baseline.json, which is at zero and only shrinks.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { apiRoutes, read } from "./helpers/route-policy";

const ROOT = join(__dirname, "..");
const METHODS = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/;

/** Exported handlers of a route source that declare no response schema: their names. */
export function undeclaredHandlers(source: string, file = "route.ts"): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !METHODS.test(d.name.text)) continue;
      const init = d.initializer;
      const declared =
        init !== undefined &&
        ts.isCallExpression(init) &&
        init.expression.getText(sf) === "tenantRoute" &&
        init.arguments.length === 2;
      if (!declared) out.push(d.name.text);
    }
  }
  for (const st of sf.statements) {
    if (
      ts.isFunctionDeclaration(st) &&
      st.name &&
      METHODS.test(st.name.text) &&
      st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    )
      out.push(st.name.text);
  }
  return out.sort();
}

describe("every route declares its response (TASK-215, A-13)", () => {
  const baseline = JSON.parse(
    readFileSync(join(ROOT, "response-schema-baseline.json"), "utf8")
  ) as {
    count: number;
    files: Record<string, number>;
  };

  it("finds a plausible number of routes", () => {
    expect(apiRoutes().length).toBeGreaterThan(50);
  });

  it("no route file has more undeclared handlers than its baseline count (zero)", () => {
    const over = apiRoutes()
      .map((f) => ({ f, n: undeclaredHandlers(read(f), f) }))
      .filter(({ f, n }) => n.length > (baseline.files[f] ?? 0))
      .map(({ f, n }) => `${f}: ${n.join(", ")}`);
    expect(over).toEqual([]);
  });

  it("the baseline is at zero", () => {
    expect(baseline.count).toBe(0);
    expect(baseline.files).toEqual({});
  });

  it("[self-test] a handler with no declared response is reported", () => {
    const src = [
      "export const GET = tenantRoute(async function GET() { return NextResponse.json({}); });",
      "export const POST = tenantRoute(async function POST() { return NextResponse.json({}); }, POST_RESPONSE);",
      "export async function DELETE() { return new Response(null); }",
    ].join("\n");
    expect(undeclaredHandlers(src)).toEqual(["DELETE", "GET"]);
  });
});
