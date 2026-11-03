/**
 * @jest-environment node
 */
/**
 * __tests__/error-text-not-returned.test.ts — a caught error's own text is logged, never returned
 * (TASK-194 round 14, item 12)
 *
 * @guard a caught error's text returned to a caller or logged as data
 *
 * An error's message can name a table, a constraint, a host or a stack's detail; a result field
 * carrying it reaches an answer (config-approval returned `err.message` to the config route). In
 * platform/admin and app/api, every use of a caught error's `.message` or `String(err)` in a
 * catch block must be inside a log call (logger.*, console.*) or internalError(…) — which logs
 * it and answers a coded 500 — or a test of the error (`if (err.message.includes(…))`); one that
 * goes into an object's field, a returned value, an assignment or another call is reported, unless
 * ALLOWED says why it is safe. A `.catch(…)` callback's parameter is a caught error too, and a cast
 * (`(err as Error).message`) or a template (`${err}`) its text (round 15, I-4).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";

const ROOT = join(__dirname, "..");
/**
 * The directories scanned: the admin platform, the API routes, and an app's own lib/ (Playform's
 * routes' helpers; round 15, I-4) where there is one. The rest of platform/ is residual R-77 (a
 * class sweep of its own).
 */
const DIRS = ["platform/admin", "app/api", "lib"].filter((d) =>
  existsSync(join(ROOT, d))
);

/**
 * "<file>#<function>": why a returned error text there is safe. None (round 15, I-5: resumeFailure
 * returns fixed text and logs the error's).
 */
const ALLOWED: Readonly<Record<string, string>> = {};

const LOGGERS = /^(?:logger|console)\.\w+$|^internalError$/;

function files(dir: string): string[] {
  const full = join(ROOT, dir);
  return readdirSync(full).flatMap((name) => {
    const p = join(full, name);
    if (statSync(p).isDirectory())
      return name === "__tests__" ? [] : files(relative(ROOT, p));
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [relative(ROOT, p)] : [];
  });
}

function enclosingFunction(n: ts.Node): string {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    if (
      (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) &&
      ts.isVariableDeclaration(p.parent) &&
      ts.isIdentifier(p.parent.name)
    )
      return p.parent.name.text;
    if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  }
  return "?";
}

/** `e` without its parentheses, casts and non-null assertions: `(err as Error)` is `err`. */
function bare(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e)
  )
    e = e.expression;
  return e;
}

const isName = (e: ts.Expression, name: string) => {
  const b = bare(e);
  return ts.isIdentifier(b) && b.text === name;
};

/**
 * Each use of a caught error's text that leaves the catch other than through a log. A caught error
 * is a catch clause's variable, or a `.catch(…)` callback's parameter (round 15, I-4). Its text is
 * `err.message` (through a cast: `(err as Error).message`), `String(err)` or `${err}`; it leaves
 * when it is returned, put in a field, assigned, given to a call that is not a log, or is the
 * value of an arrow function (a `.catch` callback's answer).
 */
export function returnedErrorText(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  /** Uses of `name`'s text within `body`, the scope that caught it (`stop` ends the climb). */
  const scan = (name: string, body: ts.Node, stop: ts.Node) => {
    const inBlock = (u: ts.Node) => {
      const isUse =
        (ts.isPropertyAccessExpression(u) &&
          u.name.text === "message" &&
          isName(u.expression, name)) ||
        (ts.isCallExpression(u) &&
          ts.isIdentifier(u.expression) &&
          u.expression.text === "String" &&
          u.arguments.length === 1 &&
          isName(u.arguments[0], name)) ||
        (ts.isTemplateSpan(u) && isName(u.expression, name));
      if (isUse) {
        let leaves = false;
        let p: ts.Node = u.parent;
        for (; p && !ts.isBlock(p) && p !== stop; p = p.parent) {
          if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
            const callee = p.expression.getText(sf);
            if (LOGGERS.test(callee) || callee === "Error") {
              leaves = false;
              break;
            }
            leaves = true;
          }
          if (
            ts.isPropertyAssignment(p) ||
            ts.isReturnStatement(p) ||
            ts.isArrowFunction(p) ||
            ts.isVariableDeclaration(p) ||
            (ts.isBinaryExpression(p) &&
              p.operatorToken.kind === ts.SyntaxKind.EqualsToken)
          )
            leaves = true;
          // A test of the error (`if (err.message.includes(…))`, `… ? : `) returns nothing.
          const within = (e: ts.Node) => e.pos <= u.pos && u.end <= e.end;
          if (
            (ts.isIfStatement(p) && within(p.expression)) ||
            (ts.isConditionalExpression(p) && within(p.condition))
          ) {
            leaves = false;
            break;
          }
        }
        // The value of a `.catch` arrow's expression body is its answer: it leaves.
        if (p === stop && ts.isArrowFunction(stop) && !ts.isBlock(stop.body)) {
          const logged = (() => {
            for (let q: ts.Node = u.parent; q !== stop; q = q.parent)
              if (
                (ts.isCallExpression(q) || ts.isNewExpression(q)) &&
                (LOGGERS.test(q.expression.getText(sf)) ||
                  q.expression.getText(sf) === "Error")
              )
                return true;
            return false;
          })();
          if (!logged) leaves = true;
        }
        if (leaves) {
          const where = `${file}#${enclosingFunction(u)}`;
          if (!(where in ALLOWED))
            out.push(
              `${file}:${sf.getLineAndCharacterOfPosition(u.getStart(sf)).line + 1} ${
                ts.isTemplateSpan(u)
                  ? "$" + `{${u.expression.getText(sf)}}`
                  : u.getText(sf)
              }`
            );
        }
      }
      ts.forEachChild(u, inBlock);
    };
    inBlock(body);
  };
  const visit = (n: ts.Node) => {
    if (
      ts.isCatchClause(n) &&
      n.variableDeclaration &&
      ts.isIdentifier(n.variableDeclaration.name)
    )
      scan(n.variableDeclaration.name.text, n.block, n);
    // `.catch((err) => …)`, `.catch(function (err) { … })` (round 15, I-4).
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "catch" &&
      n.arguments.length >= 1
    ) {
      const cb = n.arguments[0];
      if (
        (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) &&
        cb.parameters[0] &&
        ts.isIdentifier(cb.parameters[0].name)
      )
        scan(cb.parameters[0].name.text, cb.body, cb);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("a caught error's text is logged, never returned (round 14, item 12)", () => {
  it("[self-test] catches the planted forms", () => {
    const planted = [
      "async function a() { try { x(); } catch (err) { return { success: false, error: err instanceof Error ? err.message : 'x' }; } }",
      "async function b() { try { x(); } catch (err) { logger.error('x', { error: err instanceof Error ? err.message : String(err) }); return { success: false }; } }",
      "async function c() { try { x(); } catch (err) { return internalError(String(err), {}); } }",
      "async function d() { try { x(); } catch (e) { if (e.message.includes('idx')) return 1; throw e; } }",
      "async function f() { try { x(); } catch (err) { const msg = String(err); return msg; } }",
      // Round 15, I-4: a .catch callback's parameter, an assignment, a cast, a template.
      "function g() { return p.catch((err) => ({ kind: 'failed', error: err instanceof Error ? err.message : String(err) })); }",
      "function h() { return p.catch(function (e) { return { error: e.message }; }); }",
      "function i() { let out; try { x(); } catch (err) { out.error = err.message; } return out; }",
      "function j() { try { x(); } catch (err) { return { error: (err as Error).message }; } }",
      "function k() { try { x(); } catch (err) { return { error: `failed: ${err}` }; } }",
      "function l() { return p.catch((err) => logger.error('x', { error: (err as Error).message })); }",
      "function m() { return p.catch((err) => err.message); }",
    ].join("\n");
    expect(returnedErrorText("planted.ts", planted)).toEqual([
      "planted.ts:1 err.message",
      "planted.ts:5 String(err)",
      "planted.ts:6 err.message",
      "planted.ts:6 String(err)",
      "planted.ts:7 e.message",
      "planted.ts:8 err.message",
      "planted.ts:9 (err as Error).message",
      "planted.ts:10 ${err}",
      "planted.ts:12 err.message",
    ]);
  });

  it("none in platform/admin or app/api, but where ALLOWED says why", () => {
    const found = DIRS.flatMap(files).flatMap((f) =>
      returnedErrorText(f, readFileSync(join(ROOT, f), "utf8"))
    );
    expect(found).toEqual([]);
  });
});
