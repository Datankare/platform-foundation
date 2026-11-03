/**
 * @jest-environment node
 */
/**
 * __tests__/command-bar-coded-results.test.ts — every failed command-bar result carries a code of
 * the error-code contract (TASK-199; TASK-194 rebase review round 2, finding 2)
 *
 * @guard a command-bar failure that is not a coded result with its params
 *
 * What a command-bar action returns reaches POST /api/admin/ai/execute and the admin's screen.
 * A refusal's free text ("User not found", `Role "x" not found`, a database's message) is no
 * answer a screen can translate or act on, and a caught exception's text can leak a table or a
 * constraint. So:
 *
 *   1. statically: every object literal `{ success: false, … }` in the command bar and its
 *      handlers (app/api/admin/ai/command-bar.ts, app/api/admin/ai/handlers/*.ts, the search
 *      filters and the Users list route that share their checks) names a `code`, and a literal code
 *      — there, the first argument of `coded(…)`, or of a route's `apiError(…)` — is one of the
 *      registry's (platform/errors/registry.ts), given every required param, each of the registry's
 *      kind; a handler never refuses through `refusal()` of a literal; a filter check's refusal
 *      (`{ ok: false, field, allowed }`, answered as request.invalid_value) gives `allowed` as a
 *      list; a held result (`held: true`) is no failure and carries none, nor does a route's
 *      audited outcome whose `response` is a coded answer — `apiError(…)` (read as such) or
 *      `internalError(…)`; any other response is no answer. scanSource is the scan of one
 *      source, self-tested on planted lines;
 *   2. at the boundary: the execute route turns a failed, unheld result with no registered code —
 *      one passed through from another module the scan cannot read — into internal.error, its
 *      text logged, never returned (codedResult).
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import * as ts from "typescript";
import { ERROR_CODES } from "@/platform/errors/registry";

const ROOT = join(__dirname, "..");
const FILES = [
  "app/api/admin/ai/command-bar.ts",
  "app/api/admin/ai/execute/route.ts",
  ...readdirSync(join(ROOT, "app/api/admin/ai/handlers"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `app/api/admin/ai/handlers/${f}`),
  // The checks the search and the Users list share, and the list's refusals (round 5, item 4).
  "app/api/admin/ai/search-filters.ts",
  "app/api/admin/users/route.ts",
  // The config assistant's results, and the approvals they file and decide (round 13, I-C): a
  // failure there answered a 422 with no code.
  "platform/admin/config-handlers.ts",
  "platform/admin/config-approval.ts",
  "app/api/admin/config-ai/execute/route.ts",
];

/**
 * The config files' coding helpers (platform/admin/config-handlers.ts): a failure that spreads a
 * call to one names its code there; `refused(code, params, text)` itself is read as coded().
 */
const CODED_HELPERS = new Set([
  "refused",
  "keyNotFound",
  "valueRefused",
  "scopeRefused",
  "writeFailure",
  "staleResult",
  "scheduleRequired",
]);

interface Failure {
  readonly site: string;
  readonly code: string | undefined;
  readonly literalCode: boolean;
  /** The params' keys, when they are an object literal (undefined: none given, or not literal). */
  readonly paramKeys?: readonly string[] | null;
  /** Each literal param's kind, as its syntax shows it (round 4, item 8). */
  readonly paramKinds?: Readonly<Record<string, ParamKind | "unknown">>;
  /** A refusal() of an object literal: a handler refusal that bypasses coded()'s types. */
  readonly literalRefusal?: boolean;
}

type ParamKind = "list" | "number" | "id";

/**
 * A value's kind through its declaration (round 7, N-6): an identifier — or a shorthand
 * property — is read by the nearest declaration in scope: a variable's initializer, or a
 * parameter's type (`string[]` / `readonly string[]` a list, `string` an id, `number` a number).
 * "unknown" when neither says: the scan flags what it cannot kind-check.
 */
function kindThrough(e: ts.Expression, at: ts.Node): ParamKind | "unknown" {
  const direct = kindOf(e);
  if (direct) return direct;
  if (!ts.isIdentifier(e)) return "unknown";
  for (let n: ts.Node | undefined = at; n; n = n.parent) {
    let found: ParamKind | "unknown" | undefined;
    const look = (c: ts.Node): void => {
      if (found) return;
      if (
        ts.isVariableDeclaration(c) &&
        ts.isIdentifier(c.name) &&
        c.name.text === e.text
      ) {
        found = c.initializer ? (kindOf(c.initializer) ?? "unknown") : "unknown";
      } else if (ts.isParameter(c) && ts.isIdentifier(c.name) && c.name.text === e.text) {
        found = kindOfType(c.type);
      } else if (!ts.isFunctionLike(c) || c === n) {
        ts.forEachChild(c, look);
      }
    };
    if (ts.isFunctionLike(n) || ts.isBlock(n) || ts.isSourceFile(n)) {
      ts.forEachChild(n, look);
      if (found) return found;
    }
  }
  return "unknown";
}

/** A declared type's kind: a string array a list, a string an id, a number a number. */
function kindOfType(t: ts.TypeNode | undefined): ParamKind | "unknown" {
  if (!t) return "unknown";
  if (ts.isTypeOperatorNode(t)) return kindOfType(t.type);
  if (ts.isArrayTypeNode(t)) return "list";
  if (t.kind === ts.SyntaxKind.StringKeyword) return "id";
  if (t.kind === ts.SyntaxKind.NumberKeyword) return "number";
  return "unknown";
}

/** A param value's kind from its syntax, or undefined when the syntax does not say. */
function kindOf(e: ts.Expression): ParamKind | undefined {
  if (ts.isArrayLiteralExpression(e)) return "list";
  if (ts.isNumericLiteral(e)) return "number";
  if (ts.isStringLiteralLike(e) || ts.isTemplateExpression(e)) return "id";
  // `xs.join(", ")`: a string where a list may belong.
  if (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    e.expression.name.text === "join"
  ) {
    return "id";
  }
  return undefined;
}

/** An object literal's params with a kind its syntax shows. */
function literalKinds(e: ts.Expression | undefined): Record<string, ParamKind> {
  const out: Record<string, ParamKind> = {};
  if (!e || !ts.isObjectLiteralExpression(e)) return out;
  for (const p of e.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const kind = kindOf(p.initializer);
    if (kind) out[p.name.getText().replace(/^["']|["']$/g, "")] = kind;
  }
  return out;
}

/** An object literal's keys, or null when it is not one (a variable, a call). */
function literalKeys(e: ts.Expression | undefined, sf: ts.SourceFile): string[] | null {
  if (!e) return [];
  if (ts.isParenthesizedExpression(e)) return literalKeys(e.expression, sf);
  // `cond ? {…} : {…}` (round 17): the keys both branches give — a param one branch drops is
  // missing.
  if (ts.isConditionalExpression(e)) {
    const a = literalKeys(e.whenTrue, sf);
    const b = literalKeys(e.whenFalse, sf);
    return a && b ? a.filter((k) => b.includes(k)) : null;
  }
  if (!ts.isObjectLiteralExpression(e)) return null;
  return e.properties
    .filter(
      (p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
        ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)
    )
    .map((p) => p.name.getText(sf).replace(/^["']|["']$/g, ""));
}

/** Every coded result, refusal and failure in one source (`file` names its sites). */
function scanSource(file: string, text: string): Failure[] {
  const out: Failure[] = [];
  {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      if (ts.isObjectLiteralExpression(n)) {
        const prop = (name: string) =>
          n.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && p.name.getText(sf) === name
          );
        const shorthand = n.properties.some(
          (p) => ts.isShorthandPropertyAssignment(p) && p.name.text === "code"
        );
        // A config result's code (round 13, I-C): `errorCode`, or a spread coding helper's.
        const helper = n.properties.find(
          (p): p is ts.SpreadAssignment =>
            ts.isSpreadAssignment(p) &&
            ts.isCallExpression(p.expression) &&
            ts.isIdentifier(p.expression.expression) &&
            CODED_HELPERS.has(p.expression.expression.text)
        );
        const success = prop("success");
        const applied = prop("applied");
        const notFailure = [
          "pendingConfirmation",
          "requiresApproval",
          "unchanged",
          "held",
        ].some((k) => prop(k) !== undefined);
        const held = prop("held");
        // A route's audited outcome ({ success: false, error, response }) answers by its
        // `response` when that is a coded answer — apiError(…), read below, or internalError(…)
        // — and records `error` (round 5, item 4); any other response is no answer (round 6, N-4).
        const response = prop("response")?.initializer;
        const answered = Boolean(
          response &&
          ts.isCallExpression(response) &&
          ts.isIdentifier(response.expression) &&
          (response.expression.text === "apiError" ||
            response.expression.text === "internalError")
        );
        const failed =
          (success &&
            success.initializer.kind === ts.SyntaxKind.FalseKeyword &&
            !(held && held.initializer.kind === ts.SyntaxKind.TrueKeyword)) ||
          (applied &&
            applied.initializer.kind === ts.SyntaxKind.FalseKeyword &&
            !notFailure);
        if (failed && !answered) {
          const code = prop("code") ?? prop("errorCode");
          const literal = code && ts.isStringLiteralLike(code.initializer);
          const params = prop("params") ?? prop("errorParams");
          out.push({
            paramKeys: literalKeys(params?.initializer, sf),
            paramKinds: literalKinds(params?.initializer),
            site: `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`,
            code: code
              ? literal
                ? (code.initializer as ts.StringLiteral).text
                : code.initializer.getText(sf)
              : shorthand
                ? "code"
                : helper
                  ? helper.expression.getText(sf)
                  : undefined,
            literalCode: Boolean(literal),
          });
        }
      }
      // coded("<code>", …) — the helper every handler refusal goes through (handlers/shared.ts);
      // refused("<code>", …) — the config tools' (config-handlers.ts, round 13).
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        (n.expression.text === "coded" || n.expression.text === "refused") &&
        n.arguments[0]
      ) {
        const arg = n.arguments[0];
        const literal = ts.isStringLiteralLike(arg);
        out.push({
          paramKeys: literalKeys(n.arguments[1], sf),
          paramKinds: literalKinds(n.arguments[1]),
          site: `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`,
          code: literal ? arg.text : arg.getText(sf),
          literalCode: literal,
        });
      }
      // { ok: false, field, allowed } — a filter check's refusal (search-filters.ts), which the
      // search and the Users list answer as request.invalid_value: `allowed` is its list (round 6,
      // N-3).
      if (ts.isObjectLiteralExpression(n)) {
        const ok = n.properties.find(
          (p): p is ts.PropertyAssignment =>
            ts.isPropertyAssignment(p) && p.name.getText(sf) === "ok"
        );
        // Given (`allowed: …`) or shorthand (`allowed`) — read through its declaration.
        const allowed = n.properties.find(
          (p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
            (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
            p.name.getText(sf) === "allowed"
        );
        if (ok && ok.initializer.kind === ts.SyntaxKind.FalseKeyword && allowed) {
          const kind = kindThrough(
            ts.isPropertyAssignment(allowed) ? allowed.initializer : allowed.name,
            n
          );
          out.push({
            site: `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`,
            code: "request.invalid_value",
            literalCode: true,
            paramKeys: null,
            paramKinds: { allowed: kind },
          });
        }
      }
      // apiError("<code>", { params: { … }, request }) — a route's coded answer (round 5, item 4).
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "apiError" &&
        n.arguments[0]
      ) {
        const arg = n.arguments[0];
        const literal = ts.isStringLiteralLike(arg);
        const options = n.arguments[1];
        const params =
          options && ts.isObjectLiteralExpression(options)
            ? options.properties.find(
                (p): p is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(p) && p.name.getText(sf) === "params"
              )?.initializer
            : undefined;
        out.push({
          // Options that are not a literal say nothing of the params (null: not checked).
          paramKeys:
            options && !ts.isObjectLiteralExpression(options)
              ? null
              : literalKeys(params, sf),
          paramKinds: literalKinds(params),
          site: `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`,
          code: literal ? arg.text : arg.getText(sf),
          literalCode: literal,
        });
      }
      // refusal({ code: "<code>", params: { … } }) — a rule's refusal; a literal one is a handler
      // refusal and goes through coded() (typed by the registry): round 4, item 8.
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "refusal" &&
        n.arguments[0] &&
        ts.isObjectLiteralExpression(n.arguments[0])
      ) {
        const obj = n.arguments[0];
        const prop = (name: string) =>
          obj.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && p.name.getText(sf) === name
          );
        const code = prop("code");
        const literal = Boolean(code && ts.isStringLiteralLike(code.initializer));
        out.push({
          site: `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`,
          code: literal
            ? (code!.initializer as ts.StringLiteral).text
            : code?.initializer.getText(sf),
          literalCode: literal,
          paramKeys: literalKeys(prop("params")?.initializer, sf),
          paramKinds: literalKinds(prop("params")?.initializer),
          literalRefusal: true,
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

function failures(): Failure[] {
  return FILES.flatMap((file) =>
    scanSource(file, readFileSync(join(ROOT, file), "utf8"))
  );
}

/** Each literal code's required params it lacks (round 3, I-2). */
function missingParams(found: readonly Failure[]): string[] {
  const missing: string[] = [];
  for (const f of found) {
    if (!f.literalCode || !(f.code! in ERROR_CODES) || f.paramKeys === null) continue;
    const spec = ERROR_CODES[f.code as keyof typeof ERROR_CODES].params as readonly {
      name: string;
      optional?: boolean;
    }[];
    for (const p of spec) {
      if (
        !p.optional &&
        p.name !== "requestId" &&
        !(f.paramKeys ?? []).includes(p.name)
      ) {
        missing.push(`${f.site} ${f.code} lacks ${p.name}`);
      }
    }
  }
  return missing;
}

/** Each literal param whose kind is not the registry's (round 4, item 8). */
function kindMismatches(found: readonly Failure[]): string[] {
  const wrong: string[] = [];
  for (const f of found) {
    if (!f.literalCode || !(f.code! in ERROR_CODES)) continue;
    const spec = ERROR_CODES[f.code as keyof typeof ERROR_CODES].params as readonly {
      name: string;
      kind: ParamKind;
    }[];
    for (const [name, kind] of Object.entries(f.paramKinds ?? {})) {
      const want = spec.find((p) => p.name === name)?.kind;
      if (want && want !== kind)
        wrong.push(`${f.site} ${f.code} ${name}: ${kind}, not ${want}`);
    }
  }
  return wrong;
}

/** Each refusal() of a literal (round 4, item 8). */
function literalRefusals(found: readonly Failure[]): string[] {
  return found.filter((f) => f.literalRefusal).map((f) => `${f.site} ${f.code}`);
}

describe("command-bar results are coded (TASK-199; rebase round 2, finding 2)", () => {
  const found = failures();

  it("finds the failed results it means to (self-test)", () => {
    expect(found.length).toBeGreaterThan(30);
    expect(
      found.some((f) => f.site.startsWith("app/api/admin/ai/handlers/roles.ts"))
    ).toBe(true);
    // The filter checks' refusals and the Users list's answers are read (round 6, N-3).
    for (const file of [
      "app/api/admin/ai/search-filters.ts",
      "app/api/admin/users/route.ts",
    ]) {
      expect(found.some((f) => f.site.startsWith(`${file}:`))).toBe(true);
    }
  });

  it("every failed result names a code", () => {
    expect(found.filter((f) => f.code === undefined).map((f) => f.site)).toEqual([]);
  });

  it("every literal code's params are all the registry's non-optional ones (round 3, I-2)", () => {
    // A message whose param is missing shows its raw template ("{allowed}") on the screen.
    expect(missingParams(found)).toEqual([]);
  });

  it("every literal param's kind is the registry's — a list a list, a number a number (round 4, item 8)", () => {
    expect(kindMismatches(found)).toEqual([]);
  });

  it("a handler refusal goes through coded(), never refusal() of a literal (round 4, item 8)", () => {
    // refusal() takes a rule's RoleRefusal (params all strings): a literal passed to it escapes
    // coded()'s registry types — how search's `allowed` went out as a string.
    expect(literalRefusals(found)).toEqual([]);
  });

  // Round 5, item 9: the scan over planted source — each rule catches what it means to.
  it("[self-test] catches a planted kind mismatch: a list given as a string (round 5, item 9)", () => {
    const planted = scanSource(
      "planted.ts",
      [
        'coded("request.invalid_value", { field: "x", allowed: "a" });',
        'coded("request.invalid_value", { field: "x", allowed: ["a"] });',
      ].join("\n")
    );
    expect(kindMismatches(planted)).toEqual([
      "planted.ts:1 request.invalid_value allowed: id, not list",
    ]);
  });

  it("catches a planted refusal() of a literal (round 5, item 9)", () => {
    const planted = scanSource(
      "planted.ts",
      [
        'refusal({ code: "request.invalid_value", params: { field: "x", allowed: ["a"] } });',
        "refusal(rule);",
        'coded("request.invalid_value", { field: "x", allowed: ["a"] });',
      ].join("\n")
    );
    expect(literalRefusals(planted)).toEqual(["planted.ts:1 request.invalid_value"]);
  });

  it("reads a route's apiError(code, { params }) as a coded refusal (round 5, item 4)", () => {
    const planted = scanSource(
      "planted.ts",
      [
        'apiError("request.invalid_value", { params: { field: "x", allowed: "a" }, request });',
        'apiError("request.invalid_value", { params: { field: "x", allowed: ["a"] }, request });',
        'apiError("request.invalid_value", { params: { field: "x" }, request });',
      ].join("\n")
    );
    expect(kindMismatches(planted)).toEqual([
      "planted.ts:1 request.invalid_value allowed: id, not list",
    ]);
    expect(missingParams(planted)).toEqual([
      "planted.ts:3 request.invalid_value lacks allowed",
    ]);
  });

  it("reads a filter check's refusal: `allowed` given as a string is caught (round 6, N-3)", () => {
    const planted = scanSource(
      "planted.ts",
      [
        'const a = { ok: false, field: "x", allowed: "a" };',
        'const b = { ok: false, field: "x", allowed: ["a"] };',
        "const c = { ok: true, value: 1 };",
      ].join("\n")
    );
    expect(kindMismatches(planted)).toEqual([
      "planted.ts:1 request.invalid_value allowed: id, not list",
    ]);
  });

  it("reads a shorthand `allowed` by its declaration, and flags one it cannot kind-check (round 7, N-6)", () => {
    const planted = scanSource(
      "planted.ts",
      [
        'function a(allowed: string) { return { ok: false, field: "x", allowed }; }',
        'function b(allowed: readonly string[]) { return { ok: false, field: "x", allowed }; }',
        'const c = (() => { const allowed = "a"; return { ok: false, field: "x", allowed }; })();',
        'const d = { ok: false, field: "x", allowed: pick() };',
        'const e = (() => { const allowed = ["a"]; return { ok: false, field: "x", allowed }; })();',
      ].join("\n")
    );
    expect(kindMismatches(planted)).toEqual([
      "planted.ts:1 request.invalid_value allowed: id, not list",
      "planted.ts:3 request.invalid_value allowed: id, not list",
      "planted.ts:4 request.invalid_value allowed: unknown, not list",
    ]);
  });

  it("exempts an audited outcome only when its response is a coded answer (round 6, N-4)", () => {
    const planted = scanSource(
      "planted.ts",
      [
        'const a = { success: false, error: "x", response: NextResponse.json({ error: "x" }) };',
        'const b = { success: false, error: "x", response: apiError("internal.error", { request }) };',
        'const c = { success: false, error: "x", response: internalError(e, { request }) };',
      ].join("\n")
    );
    expect(planted.filter((f) => f.code === undefined).map((f) => f.site)).toEqual([
      "planted.ts:1",
    ]);
  });

  it("reads the config tools' results: an uncoded failure is caught (round 13, I-C)", () => {
    expect(
      found.some((f) => f.site.startsWith("platform/admin/config-handlers.ts:"))
    ).toBe(true);
    const planted = scanSource(
      "planted.ts",
      [
        'const a = { applied: false, error: "Config key not found." };',
        'const b = { success: false, error: "nope" };',
        "const c = { applied: false, ...keyNotFound(key) };",
        "const d = { applied: false, pendingConfirmation: true, changeRequest };",
        'const e = { applied: false, errorCode: "admin.action_failed", error: "x" };',
        'const f = refused("request.missing_fields", {}, "x");',
      ].join("\n")
    );
    expect(planted.filter((f) => f.code === undefined).map((f) => f.site)).toEqual([
      "planted.ts:1",
      "planted.ts:2",
    ]);
    expect(missingParams(planted)).toEqual([
      "planted.ts:6 request.missing_fields lacks fields",
    ]);
  });

  it("every literal code is the registry's", () => {
    expect(
      found
        .filter((f) => f.literalCode && !(f.code! in ERROR_CODES))
        .map((f) => `${f.site} ${f.code}`)
    ).toEqual([]);
  });
});
