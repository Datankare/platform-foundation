/**
 * __tests__/route-status-registry.test.ts — an error status a route answers is its code's status
 * in the registry (TASK-200, rule 2)
 *
 * @guard an error status set by hand, not the registry's status for the code the body carries
 *
 * A screen acts on a refusal's status and code together (platform/errors/refusal.ts). apiError()
 * takes the status from the registry (ERROR_CODES), and docs/API_ERRORS.md is generated from it,
 * so a code's status is documented in one place. A response built by hand can drift: this reads
 * every `NextResponse.json(…)`, `Response.json(…)`, `new NextResponse(…)` and `new Response(…)` in
 * the production sources and refuses an error status (400 and above, or one it cannot read)
 * unless it is `ERROR_CODES[<code>].status` for the very code its body carries (`apiErrorBody(<code>)`,
 * in the body or a const it is or spreads), or a literal equal to the registry's status for the
 * `apiErrorBody("<code>")` its body carries. An init it cannot read — not an object literal, or one
 * a spread may set the status in — is refused too, and so is an error body (`apiErrorBody(…)`) sent
 * with no status or a success status; a const is the one its own scope declares. The few that answer a status by design (health
 * checks, a probe's stub) are listed below, each with why.
 */
import * as ts from "typescript";
import { ERROR_CODES } from "@/platform/errors/registry";
import { productionSources, read } from "./helpers/route-policy";

/** `<file> status=<expression>` → why the status is not the registry's. */
const BY_DESIGN: Readonly<Record<string, string>> = {
  "app/api/health/route.ts status=503":
    "The health report for monitors: 503 with the report when the instance is unhealthy, the status load balancers read (ADR-056 D4).",
  'app/api/health/route.ts status=report.status === "unhealthy" ? 503 : 200':
    "The health report's own status (200, or 503 when unhealthy or draining), for monitors and load balancers (ADR-056 D4).",
  "app/api/health/ready/route.ts status=readiness.ready ? 200 : 503":
    "Readiness for load balancers and the deploy smoke test: 503 takes the instance out (ADR-056 D4).",
  "platform/ai/readiness-probe.ts status=401":
    "Not an answer to a caller: the stub reply the AI probe classifies when no key is configured, so readiness reports the missing credential.",
  "platform/admin/approval-decision.ts status=failed.status":
    "Forwards a coded refusal built by errorFromResult (its status from the registry), adding withdrawn/settling to its body.",
  "app/api/admin/config-ai/execute/route.ts status=status":
    "200 or 202 here: the 422 outcomes return earlier with ERROR_CODES[f.code].status.",
  "platform/tenancy/operator-http.ts status=okStatus":
    "The success status of an operator action (200 or 201); errors go through operatorError's coded refusal.",
};

/** The expression under parentheses, `as`, `satisfies` and `!`. */
function unwrap(e: ts.Expression): ts.Expression {
  let x = e;
  while (
    ts.isParenthesizedExpression(x) ||
    ts.isAsExpression(x) ||
    ts.isSatisfiesExpression(x) ||
    ts.isNonNullExpression(x)
  )
    x = x.expression;
  return x;
}

/**
 * The initializer of the `const <name>` that `from` sees: the nearest enclosing block, case or
 * file that declares it — a function's parameter of that name hides any outer const (undefined).
 */
function constValue(name: string, from: ts.Node): ts.Expression | undefined {
  for (let at: ts.Node | undefined = from.parent; at; at = at.parent) {
    if (
      ts.isFunctionLike(at) &&
      at.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name)
    )
      return undefined;
    const statements =
      ts.isBlock(at) ||
      ts.isSourceFile(at) ||
      ts.isModuleBlock(at) ||
      ts.isCaseClause(at) ||
      ts.isDefaultClause(at)
        ? at.statements
        : undefined;
    for (const st of statements ?? []) {
      if (!ts.isVariableStatement(st)) continue;
      if ((st.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.name.text === name) return d.initializer;
    }
  }
  return undefined;
}

/**
 * The code a response body carries: the first argument of an `apiErrorBody(…)` in it (not inside
 * a function), following a const the body is, or spreads, to its value. Undefined when none.
 */
function codeOf(body: ts.Expression | undefined, depth = 0): ts.Expression | undefined {
  if (!body || depth > 5) return undefined;
  const x = unwrap(body);
  if (ts.isIdentifier(x)) return codeOf(constValue(x.text, x), depth + 1);
  let found: ts.Expression | undefined;
  const find = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "apiErrorBody"
    ) {
      found = n.arguments[0];
      return;
    }
    if (ts.isSpreadAssignment(n) && ts.isIdentifier(unwrap(n.expression))) {
      found = codeOf(n.expression, depth + 1);
      if (found) return;
    }
    if (!ts.isFunctionLike(n)) ts.forEachChild(n, find);
  };
  find(x);
  return found;
}

/** A code expression's text, a string literal as its value: `"a.b"` and `'a.b'` alike. */
function codeText(e: ts.Expression): string {
  const x = unwrap(e);
  return ts.isStringLiteralLike(x) ? `"${x.text}"` : x.getText().replace(/\s+/g, "");
}

/** A literal code's value, or undefined. */
function literalCode(e: ts.Expression | undefined): string | undefined {
  const x = e ? unwrap(e) : undefined;
  return x && ts.isStringLiteralLike(x) ? x.text : undefined;
}

/**
 * Each hand-built response whose status is not the registry's: `file status=<expression>` (line).
 * An init that is not an object literal (`NextResponse.json(b, init)`), or whose status a spread
 * may set (`{ ...opts }`, `{ status: 400, ...opts }`), cannot be read: it is a finding too.
 */
export function statusFindings(
  file: string,
  text: string
): { key: string; line: number }[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: { key: string; line: number }[] = [];
  const report = (n: ts.Node, what: string) =>
    out.push({
      key: `${file} status=${what.replace(/\s+/g, " ")}`,
      line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
    });
  const visit = (n: ts.Node): void => {
    const callee =
      ts.isCallExpression(n) || ts.isNewExpression(n) ? n.expression.getText(sf) : "";
    const isResponse =
      (ts.isCallExpression(n) && /^(?:NextResponse|Response)\.json$/.test(callee)) ||
      (ts.isNewExpression(n) && /^(?:NextResponse|Response)$/.test(callee));
    if (isResponse) {
      const args = (n as ts.CallExpression).arguments ?? [];
      const given = args[1];
      // The init, through a const it names.
      let init = given ? unwrap(given) : undefined;
      if (init && ts.isIdentifier(init) && init.text !== "undefined")
        init = constValue(init.text, init) ?? init;
      init = init ? unwrap(init) : undefined;
      const bodyCode = codeOf(args[0]);
      const noStatus =
        !init ||
        (ts.isIdentifier(init) && init.text === "undefined") ||
        (ts.isObjectLiteralExpression(init) &&
          !init.properties.some(
            (p) => ts.isSpreadAssignment(p) || p.name?.getText(sf) === "status"
          ));
      if (noStatus) {
        // No status: 200. An error body sent as a success is refused.
        if (bodyCode !== undefined) report(n, `<none: 200 for ${codeText(bodyCode)}>`);
      } else if (init && !ts.isObjectLiteralExpression(init)) {
        // Not a literal: its status cannot be read (`undefined` is no init).
        if (!(ts.isIdentifier(init) && init.text === "undefined"))
          report(n, `<init ${given!.getText(sf)}>`);
      } else if (init) {
        const props = init.properties;
        const statusAt = props.findIndex((p) => p.name?.getText(sf) === "status");
        const lastSpread = props.reduce(
          (last, p, i) => (ts.isSpreadAssignment(p) ? i : last),
          -1
        );
        if (lastSpread > statusAt) {
          // A spread after the status, or with none: it may set the status.
          report(n, `<spread ${props[lastSpread].getText(sf)}>`);
        } else if (statusAt >= 0) {
          const prop = props[statusAt];
          const named = ts.isShorthandPropertyAssignment(prop)
            ? prop.name.text
            : ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)
              ? prop.initializer.text
              : undefined;
          const expr =
            (named !== undefined ? constValue(named, prop) : undefined) ??
            (ts.isPropertyAssignment(prop) ? prop.initializer : undefined);
          const text = expr ? expr.getText(sf) : (named ?? "status");
          const numbers = [...text.matchAll(/\b\d{3}\b/g)].map((m) => Number(m[0]));
          const onlyLiterals =
            expr !== undefined && /^[\d\s?:]*$/.test(text.replace(/[\w.]+\s*\?/, ""));
          const status = expr ? unwrap(expr) : undefined;
          // `ERROR_CODES[<code>].status`: the registry's — for the code the body carries, no other.
          const index =
            status &&
            ts.isPropertyAccessExpression(status) &&
            status.name.text === "status" &&
            ts.isElementAccessExpression(status.expression) &&
            status.expression.expression.getText(sf) === "ERROR_CODES"
              ? status.expression.argumentExpression
              : undefined;
          const code = codeOf(args[0]);
          let ok = false;
          if (index) {
            ok = code !== undefined && codeText(index) === codeText(code);
          } else if (status && ts.isNumericLiteral(status)) {
            const s = Number(status.text);
            const c = literalCode(code);
            ok =
              (s < 400 && code === undefined) ||
              (c !== undefined &&
                c in ERROR_CODES &&
                ERROR_CODES[c as keyof typeof ERROR_CODES].status === s);
          } else if (onlyLiterals)
            ok = code === undefined && numbers.every((s) => s < 400);
          if (!ok) report(n, text);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("a route's error status is the registry's (TASK-200, rule 2)", () => {
  const findings = productionSources().flatMap((f) => statusFindings(f, read(f)));

  it("every hand-built error status is the registry's for its code, or listed by design", () => {
    expect(
      findings.filter((f) => !BY_DESIGN[f.key]).map((f) => `${f.key} (line ${f.line})`)
    ).toEqual([]);
  });

  it("lists nothing that is not found, and gives each a reason", () => {
    const keys = new Set(findings.map((f) => f.key));
    expect(Object.keys(BY_DESIGN).filter((k) => !keys.has(k))).toEqual([]);
    expect(Object.entries(BY_DESIGN).filter(([, why]) => why.length < 40)).toEqual([]);
  });

  it("[self-test] reports a planted status that is not its code's, an uncoded error and an unread one", () => {
    const planted = [
      'return NextResponse.json(apiErrorBody("auth.permission_denied"), { status: 401 });',
      'return NextResponse.json({ error: "nope" }, { status: 500 });',
      "return NextResponse.json(body, { status: someStatus });",
      'return NextResponse.json(apiErrorBody("auth.permission_denied"), { status: 403 });',
      "return NextResponse.json({ ...apiErrorBody(code) }, { status: ERROR_CODES[code].status });",
      "return NextResponse.json({ ok: true }, { status: held ? 202 : 200 });",
      "function f(r: R) {",
      "  const status = ERROR_CODES[r.code].status;",
      "  return NextResponse.json(apiErrorBody(r.code), { status });",
      "}",
    ].join("\n");
    expect(statusFindings("app/api/planted/route.ts", planted)).toEqual([
      { key: "app/api/planted/route.ts status=401", line: 1 },
      { key: "app/api/planted/route.ts status=500", line: 2 },
      { key: "app/api/planted/route.ts status=someStatus", line: 3 },
    ]);
    expect(ERROR_CODES["auth.permission_denied"].status).toBe(403);
  });

  it("[self-test] reports the registry's status for another code, an init it cannot read, and a const from another function", () => {
    const planted = [
      'return NextResponse.json(apiErrorBody("auth.permission_denied"), { status: ERROR_CODES["service.unavailable"].status });',
      "return NextResponse.json(apiErrorBody(a.code), { status: ERROR_CODES[b.code].status });",
      "return NextResponse.json(body, init);",
      "return NextResponse.json(body, { ...opts });",
      "return NextResponse.json(body, { status: 400, ...opts });",
      "return new Response(text, responseInit);",
      "function one() {",
      "  const status = 200;",
      "  return NextResponse.json({ ok: true }, { status });",
      "}",
      "function two() {",
      '  return NextResponse.json({ error: "x" }, { status });',
      "}",
      // What passes: the registry's for the body's own code, through a const and a spread.
      "function three(f: F) {",
      "  const body = apiErrorBody(f.code, { request });",
      "  return NextResponse.json({ ...body, data }, { status: ERROR_CODES[f.code].status });",
      "}",
      "return NextResponse.json({ ...opts, ok: true }, { ...headersOnly, status: 200 });",
      // An error body sent as a success: no init, an init without a status, a 200.
      'return NextResponse.json(apiErrorBody("auth.permission_denied"));',
      'return NextResponse.json(apiErrorBody("auth.permission_denied"), { headers });',
      'return NextResponse.json({ ...apiErrorBody("auth.permission_denied") }, { status: 200 });',
    ].join("\n");
    expect(statusFindings("app/api/planted/route.ts", planted)).toEqual([
      {
        key: 'app/api/planted/route.ts status=ERROR_CODES["service.unavailable"].status',
        line: 1,
      },
      { key: "app/api/planted/route.ts status=ERROR_CODES[b.code].status", line: 2 },
      { key: "app/api/planted/route.ts status=<init init>", line: 3 },
      { key: "app/api/planted/route.ts status=<spread ...opts>", line: 4 },
      { key: "app/api/planted/route.ts status=<spread ...opts>", line: 5 },
      { key: "app/api/planted/route.ts status=<init responseInit>", line: 6 },
      { key: "app/api/planted/route.ts status=status", line: 12 },
      {
        key: 'app/api/planted/route.ts status=<none: 200 for "auth.permission_denied">',
        line: 19,
      },
      {
        key: 'app/api/planted/route.ts status=<none: 200 for "auth.permission_denied">',
        line: 20,
      },
      { key: "app/api/planted/route.ts status=200", line: 21 },
    ]);
  });
});
