/**
 * TASK-197 (audit D-4, D-5): every failed answer from an external dependency is recorded.
 *
 * @guard an external call's failure branch that reports nothing
 *
 * A Google 403 (key restricted, billing off), an exhausted quota or a rotated token ended as a
 * plain Error: the route answered 500 `internal.error` and wrote one log line, so nobody learned
 * that a credential or a plan had to be fixed. The rule now: an external call that fails reports
 * through platform/observability/external-failure.ts (`externalFailure` / `reportExternalFailure`
 * — a metric always, an alert for a credential, quota or retired-model failure; the route then
 * answers the coded `service.unavailable`), or raises an alert itself.
 *
 * Statically, with the TypeScript compiler API, in every production file that makes an external
 * call — it calls fetchWithTimeout (the outbound wrapper) or the global fetch (review round 1,
 * L-6: plain fetch too; the browser's same-origin callers are listed in CLIENT_FILES):
 *
 *   - a failure branch is an `if` whose condition reads a failed answer: `!x.ok`,
 *     `x.ok === false`, a status compared with an error status (`x.status >= 400`,
 *     `x.status === 403`, `x.status !== 200`), or a provider's in-body code (`x.code !== 0`);
 *   - it reports only when EVERY way out of it reports (L-6): each `return` and `throw` in it
 *     comes after a reporter call or carries one, and a branch that falls through has reported;
 *   - a branch that legitimately does not report is exempt by (file, branch id) — the id is the
 *     enclosing function and the condition (L-6), so one exemption cannot cover another
 *     function's branch with the same condition — with its reason. An entry for a file this
 *     repository does not have, or has without an external call (a consumer's own file of the
 *     same name), is ignored; an entry whose branch now reports, or no longer exists, is stale
 *     and fails.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import * as ts from "typescript";

const ROOT = join(__dirname, "..");

/** Files that call fetch only in the browser, to the app's own routes: not external calls. */
const CLIENT_FILES: Readonly<Record<string, string>> = {
  "platform/auth/api-fetch.ts":
    "the browser's own-origin fetch with the session cookie and its forgery token",
  "platform/auth/context.tsx":
    "the browser's session context, calling the app's own auth routes",
  "lib/refusal-notify.ts":
    "Playform's screens: re-mints a guest token from the app's own /api/auth/guest",
};

/** file → branch id (`function: condition`) → why that failed-answer branch need not report. */
const EXEMPT: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "platform/cache/redis-cache.ts": {
    "execute: !response.ok":
      "the shared cache: the required readiness probe (createCacheReadinessProbe) takes the instance out of rotation and reports it; a per-call alert would page on every cache miss path",
    "pipeline: !response.ok":
      "the shared cache's pipeline: as its single commands, the required readiness probe reports it",
  },
  "platform/auth/jwt-verification.ts": {
    "poolKeyStore: !response.ok":
      "the pool's JWKS: a failure is JwksUnavailableError, which token verification answers as unavailable (fail closed, 503) and the pool-shape readiness probe reports",
  },
  "platform/observability/health.ts": {
    "check: response.status === 401":
      "the Anthropic health probe: its unhealthy answer is the report — readiness takes the instance out of rotation and the deploy smoke and monitors read it",
  },
  "platform/auth/cognito-provider.ts": {
    "callCognito: !response.ok":
      "Cognito answers a user's own mistakes (a wrong password, an expired code) with HTTP 400; the platform's failures among them, a refused client secret, are told apart, coded service.unavailable and alerted in codedFailure (cognito-secret-hash test)",
    "verifyToken: !signed || !signed.ok":
      "the AWS signer had no credentials to sign with: a configuration refusal the caller answers, not an answer from AWS",
  },
};

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      return name === "__tests__" || name === "node_modules" || name.startsWith(".")
        ? []
        : walk(p);
    }
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

const rel = (p: string) => relative(ROOT, p).split(sep).join("/");
const CALLS =
  /\bfetchWithTimeout\s*\(|(?<![.\w])fetch\s*\(|\b(?:globalThis|window|self)\.fetch\s*\(/;

/** Files that make external calls: they call fetchWithTimeout, or the global fetch. */
function externalCallers(): string[] {
  return ["app", "platform", "lib"]
    .flatMap((d) => walk(join(ROOT, d)))
    .filter((f) => rel(f) !== "lib/fetchWithTimeout.ts" && !CLIENT_FILES[rel(f)])
    .filter((f) => CALLS.test(readFileSync(f, "utf8")));
}

interface Branch {
  readonly id: string;
  readonly line: number;
  readonly reports: boolean;
}

const num = (n: ts.Expression): number | null =>
  ts.isNumericLiteral(n) ? Number(n.text) : null;

/** Whether `e` reads a failed answer (see the header). */
function readsFailure(e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e)) return readsFailure(e.expression);
  if (
    ts.isPrefixUnaryExpression(e) &&
    e.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isPropertyAccessExpression(e.operand) &&
    e.operand.name.text === "ok"
  ) {
    return true;
  }
  if (!ts.isBinaryExpression(e)) return false;
  const op = e.operatorToken.kind;
  if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken) {
    return readsFailure(e.left) || readsFailure(e.right);
  }
  const prop = ts.isPropertyAccessExpression(e.left) ? e.left.name.text : "";
  const value = num(e.right);
  const eq =
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsToken;
  const ne =
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken;
  if (prop === "ok") return eq && e.right.kind === ts.SyntaxKind.FalseKeyword;
  if (prop === "status" && value !== null) {
    if ((eq || op === ts.SyntaxKind.GreaterThanEqualsToken) && value >= 400) return true;
    if (op === ts.SyntaxKind.GreaterThanToken && value >= 399) return true;
    if (ne && value >= 200 && value < 300) return true;
    // Below 200 (round 2): `status < 200 || status >= 300`.
    if (op === ts.SyntaxKind.LessThanToken && value <= 200) return true;
  }
  // A provider's in-body code: ACRCloud's `status.code !== 0`.
  if (prop === "code" && ne && value === 0) return true;
  return false;
}

const REPORTER_NAMES = new Set([
  "externalFailure",
  "reportExternalFailure",
  "raiseAlert",
]);

/**
 * Whether `node` calls a reporter on every way through it — in code, never in a comment or a
 * string (round 2), not in a nested function (which may never run), and not in only one arm of
 * a conditional (round 3): `cond ? externalFailure(…) : x`, `a && reportExternalFailure(…)`,
 * `x ?? raiseAlert(…)` report on one path only, so they do not count.
 */
function callsReporter(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found || ts.isFunctionLike(n)) return;
    if (ts.isConditionalExpression(n)) {
      visit(n.condition);
      if (!found && callsReporter(n.whenTrue) && callsReporter(n.whenFalse)) found = true;
      return;
    }
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        n.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      visit(n.left);
      return;
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      if (REPORTER_NAMES.has(name)) found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

interface Flow {
  /** Every return and throw on the way reported first (or carries a reporter). */
  readonly ok: boolean;
  /** Control can reach the end of the statement. */
  readonly falls: boolean;
  /** When it falls through: a reporter has run on every path to the end. */
  readonly reported: boolean;
}

/**
 * Path analysis over statements (round 2: switch, try, loops — every exit). A loop's body may run
 * zero times, a catch from where the try began, a switch's clause from its start.
 */
function flow(node: ts.Statement | undefined, reported: boolean): Flow {
  if (!node) return { ok: true, falls: true, reported };
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
    return { ok: reported || callsReporter(node), falls: false, reported: true };
  }
  if (ts.isBlock(node)) return seq(node.statements, reported);
  if (ts.isIfStatement(node)) {
    const reportsInTest = reported || callsReporter(node.expression);
    return joinFlows([
      flow(node.thenStatement, reportsInTest),
      flow(node.elseStatement, reportsInTest),
    ]);
  }
  if (ts.isTryStatement(node)) {
    const t = seq(node.tryBlock.statements, reported);
    const c = node.catchClause ? seq(node.catchClause.block.statements, reported) : null;
    const body = c ? joinFlows([t, c]) : t;
    if (!node.finallyBlock) return body;
    const f = seq(node.finallyBlock.statements, reported);
    return {
      ok: body.ok && f.ok,
      falls: body.falls && f.falls,
      reported: body.reported || f.reported,
    };
  }
  if (ts.isSwitchStatement(node)) {
    const start = reported || callsReporter(node.expression);
    const clauses = node.caseBlock.clauses.map((cl) => seq(cl.statements, start));
    const hasDefault = node.caseBlock.clauses.some((cl) => ts.isDefaultClause(cl));
    const all = joinFlows([
      ...clauses,
      ...(hasDefault ? [] : [{ ok: true, falls: true, reported: start }]),
    ]);
    // A clause that ends with `break` falls out of the switch (conservatively, so does one that
    // falls into the next).
    return all;
  }
  if (
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  ) {
    const body = flow(node.statement, reported);
    return { ok: body.ok, falls: true, reported };
  }
  if (ts.isLabeledStatement(node)) return flow(node.statement, reported);
  if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
    return { ok: true, falls: true, reported };
  }
  return { ok: true, falls: true, reported: reported || callsReporter(node) };
}

function seq(statements: readonly ts.Statement[], reported: boolean): Flow {
  let done = reported;
  let ok = true;
  for (const st of statements) {
    const f = flow(st, done);
    ok = ok && f.ok;
    if (!f.falls) return { ok, falls: false, reported: true };
    done = f.reported;
  }
  return { ok, falls: true, reported: done };
}

function joinFlows(flows: readonly Flow[]): Flow {
  const falling = flows.filter((f) => f.falls);
  return {
    ok: flows.every((f) => f.ok),
    falls: falling.length > 0,
    reported: falling.every((f) => f.reported),
  };
}

/** Whether every way out of a failure branch reports (L-6, round 2). */
function reportsOnEveryPath(node: ts.Statement): boolean {
  const f = flow(node, false);
  return f.ok && (!f.falls || f.reported);
}

/** The name of the function `node` is in ("(top)" when none). */
function enclosingName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) {
      return n.name.getText();
    }
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      const p = n.parent;
      if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p))
        return p.name.getText();
    }
  }
  return "(top)";
}

export function failedAnswerBranches(file: string, text: string): Branch[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: Branch[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && readsFailure(node.expression)) {
      out.push({
        id: `${enclosingName(node)}: ${node.expression.getText(sf)}`,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        reports: reportsOnEveryPath(node.thenStatement),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("external failures are recorded (TASK-197, audit D-4/D-5)", () => {
  const files = externalCallers();

  it("finds the external callers (the scan is not vacuous)", () => {
    const names = files.map(rel);
    expect(names).toEqual(expect.arrayContaining(["platform/ai/provider.ts"]));
    expect(files.length).toBeGreaterThan(5);
  });

  it("every failed-answer branch of an external call reports on every path, or is exempt with a reason", () => {
    const unreported: string[] = [];
    for (const f of files) {
      const exempt = EXEMPT[rel(f)] ?? {};
      for (const b of failedAnswerBranches(f, readFileSync(f, "utf8"))) {
        if (!b.reports && !exempt[b.id]) unreported.push(`${rel(f)}:${b.line} ${b.id}`);
      }
    }
    expect(unreported).toEqual([]);
  });

  it("no exemption is stale (its branch exists and still does not report)", () => {
    const stale: string[] = [];
    for (const [file, entries] of Object.entries(EXEMPT)) {
      const path = join(ROOT, file);
      // A file this repository does not have, or has as its own (a consumer's provider of the
      // same name that makes no external call), is not this entry's.
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf8");
      if (!CALLS.test(text)) continue;
      const branches = failedAnswerBranches(path, text);
      for (const [id, reason] of Object.entries(entries)) {
        expect(reason.length).toBeGreaterThan(20);
        const live = branches.filter((b) => b.id === id);
        if (live.length === 0 || live.every((b) => b.reports))
          stale.push(`${file}: ${id}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("client-only files are listed with a reason and still exist", () => {
    for (const [file, reason] of Object.entries(CLIENT_FILES)) {
      expect(reason.length).toBeGreaterThan(20);
      if (existsSync(join(ROOT, file))) {
        expect(CALLS.test(readFileSync(join(ROOT, file), "utf8"))).toBe(true);
      }
    }
  });

  it("[self-test] the scan sees each kind of failed answer, and a branch that reports on only one path", () => {
    const text = [
      "async function a(){ const r = await fetchWithTimeout(u); if (!r.ok) { throw new Error('x'); } }",
      "async function b(){ const r = await fetch(u); if (r.ok === false) throw externalFailure('s','credential','m'); }",
      "async function c(){ const r = await fetch(u); if (r.status >= 400) { if (r.status === 401) { throw externalFailure('s','credential','m'); } return null; } }",
      "async function d(){ const r = await fetch(u); if (r.status !== 200) { reportExternalFailure(e); return null; } }",
      "function e(data){ if (data.status.code !== 0) { throw new Error('in-body'); } }",
      "const f = (r) => { if (r.status === 404) { return raiseAlert(x); } };",
      "function g(r){ if (!r.ok) { log(r); } }",
      // Round 2: a reporter in a comment is not one; switch, try and loop exits count.
      "function h(r){ if (!r.ok) { /* externalFailure(x) */ throw new Error('x'); } }",
      "function i(r){ if (!r.ok) { switch (r.status) { case 401: throw externalFailure('s','credential','m'); default: return null; } } }",
      "function j(r){ if (!r.ok) { switch (r.status) { case 401: throw externalFailure('s','credential','m'); default: throw externalFailure('s','rejected','m'); } } }",
      "function k(r){ if (!r.ok) { try { reportExternalFailure(e); } catch { return null; } return null; } }",
      "function l(r){ if (!r.ok) { for (const x of xs) { return x; } reportExternalFailure(e); } }",
      "async function m(){ const r = await globalThis.fetch(u); if (r.status < 200 || r.status >= 300) { throw new Error('x'); } }",
      // Round 3: a reporter in one arm of a conditional is on one path only.
      "function n(r){ if (!r.ok) { return r.status === 401 ? externalFailure('s','credential','m') : null; } }",
      "function o(r){ if (!r.ok) { throw r.status === 401 ? externalFailure('s','credential','m') : externalFailure('s','rejected','m'); } }",
      "function q(r){ if (!r.ok) { r.status === 401 && reportExternalFailure(e); return null; } }",
    ].join("\n");
    const found = failedAnswerBranches("x.ts", text).map((b) => [b.id, b.reports]);
    expect(found).toEqual([
      ["a: !r.ok", false],
      ["b: r.ok === false", true],
      ["c: r.status >= 400", false],
      ["c: r.status === 401", true],
      ["d: r.status !== 200", true],
      ["e: data.status.code !== 0", false],
      ["f: r.status === 404", true],
      ["g: !r.ok", false],
      ["h: !r.ok", false],
      ["i: !r.ok", false],
      ["j: !r.ok", true],
      ["k: !r.ok", false],
      ["l: !r.ok", false],
      ["m: r.status < 200 || r.status >= 300", false],
      ["n: !r.ok", false],
      ["o: !r.ok", true],
      ["q: !r.ok", false],
    ]);
    expect(CALLS.test("await globalThis.fetch(u)")).toBe(true);
    expect(CALLS.test("await window.fetch(u)")).toBe(true);
  });
});
