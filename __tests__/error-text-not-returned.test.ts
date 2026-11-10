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
 *
 * TASK-205 (R-77, R-78): the whole of platform/ is scanned, not only platform/admin — a store's
 * text in an erasure record, a health answer or an audit reason reaches a person as surely as an
 * API answer. And a caught error given whole to a helper that returns its text — a local
 * `failed(err)` or `errorText(err)`, or one another scanned file exports and this one imports —
 * is its text too (R-78: Playform's export module returned `err.message` through `failed(err)`,
 * which the scan could not see). A helper is a function whose parameter's text leaves it by the
 * same rules (returned, a field, the answer of an arrow); one that only logs it (logCaught) is
 * not. platform/observability/caught-error.ts is the one way to log a caught error's text.
 * Not followed: a caught error copied to another name and read after its catch (`const e = err`);
 * none exists, and a reviewer reading a catch sees it.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";

const ROOT = join(__dirname, "..");
/**
 * The directories scanned: the platform, the API routes, and an app's own lib/ (Playform's
 * routes' helpers; round 15, I-4) where there is one. TASK-205 (R-77): all of platform/, not
 * only platform/admin.
 */
const DIRS = ["platform", "app/api", "lib"].filter((d) => existsSync(join(ROOT, d)));

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
export function returnedErrorText(
  file: string,
  text: string,
  imported: ReadonlySet<string> = new Set()
): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  // A text helper this file can call: its own, and those other files export that it imports.
  const helpers = new Set([...textHelpers(sf), ...importedNames(sf, imported)]);
  return leavingUses(sf, file, helpers, caughtErrors(sf)).map(({ node, where }) => {
    const shown = ts.isTemplateSpan(node)
      ? "$" + `{${node.expression.getText(sf)}}`
      : node.getText(sf);
    return `${where} ${shown}`;
  });
}

/** A caught error: its name, the scope that caught it, and where the climb from a use stops. */
interface Caught {
  readonly name: string;
  readonly body: ts.Node;
  readonly stop: ts.Node;
}

/** Every caught error in `sf`: a catch clause's variable, a `.catch(…)` callback's parameter. */
function caughtErrors(sf: ts.SourceFile): Caught[] {
  const out: Caught[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isCatchClause(n) &&
      n.variableDeclaration &&
      ts.isIdentifier(n.variableDeclaration.name)
    )
      out.push({ name: n.variableDeclaration.name.text, body: n.block, stop: n });
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
        out.push({ name: cb.parameters[0].name.text, body: cb.body, stop: cb });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** A named function's declaration in `sf`: `function f`, `const f = (…) =>`, a method. */
function namedFunctions(sf: ts.SourceFile): {
  name: string;
  fn: ts.SignatureDeclaration & { body?: ts.Node };
  exported: boolean;
}[] {
  const out: {
    name: string;
    fn: ts.SignatureDeclaration & { body?: ts.Node };
    exported: boolean;
  }[] = [];
  const isExported = (n: ts.Node) =>
    ts.canHaveModifiers(n) &&
    (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body)
      out.push({ name: n.name.text, fn: n, exported: isExported(n) });
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    )
      out.push({
        name: n.name.text,
        fn: n.initializer,
        exported: isExported(n.parent.parent),
      });
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name) && n.body)
      out.push({ name: n.name.text, fn: n, exported: false });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * The text helpers `sf` declares (R-78): functions one of whose parameters' text leaves them by
 * the rules a caught error's does — `const failed = (err) => ({ error: err.message })`.
 */
export function textHelpers(sf: ts.SourceFile, exportedOnly = false): Set<string> {
  const out = new Set<string>();
  for (const { name, fn, exported } of namedFunctions(sf)) {
    if (exportedOnly && !exported) continue;
    if (!fn.body) continue;
    // A parameter that can hold an error: untyped, unknown, any, or an Error type (a `string`
    // parameter's template is just the string).
    const params: Caught[] = fn.parameters
      .filter(
        (p) =>
          ts.isIdentifier(p.name) &&
          (!p.type ||
            p.type.kind === ts.SyntaxKind.UnknownKeyword ||
            p.type.kind === ts.SyntaxKind.AnyKeyword ||
            /Error\b/.test(p.type.getText(sf)))
      )
      .map((p) => ({ name: (p.name as ts.Identifier).text, body: fn.body!, stop: fn }));
    if (leavingUses(sf, sf.fileName, new Set(), params).length > 0) out.add(name);
  }
  return out;
}

/** Of `exported` (text helpers other files export), the names `sf` imports. */
function importedNames(sf: ts.SourceFile, exported: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    const bindings = st.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const el of bindings.elements)
        if (exported.has((el.propertyName ?? el.name).text)) out.push(el.name.text);
  }
  return out;
}

/** Each use of a caught error's text, in `caught`, that leaves its scope other than by a log. */
function leavingUses(
  sf: ts.SourceFile,
  file: string,
  helpers: ReadonlySet<string>,
  caught: readonly Caught[]
): { node: ts.Node; where: string }[] {
  const out: { node: ts.Node; where: string }[] = [];
  /** Uses of `name`'s text within `body`, the scope that caught it (`stop` ends the climb). */
  const scan = (name: string, body: ts.Node, stop: ts.Node) => {
    const inBlock = (u: ts.Node) => {
      const callee =
        ts.isCallExpression(u) &&
        (ts.isIdentifier(u.expression)
          ? u.expression.text
          : ts.isPropertyAccessExpression(u.expression) &&
              u.expression.expression.kind === ts.SyntaxKind.ThisKeyword
            ? u.expression.name.text
            : undefined);
      const isUse =
        (ts.isPropertyAccessExpression(u) &&
          u.name.text === "message" &&
          isName(u.expression, name)) ||
        (ts.isCallExpression(u) &&
          ts.isIdentifier(u.expression) &&
          u.expression.text === "String" &&
          u.arguments.length === 1 &&
          isName(u.arguments[0], name)) ||
        (ts.isTemplateSpan(u) && isName(u.expression, name)) ||
        // A helper that returns its parameter's text, given the caught error (R-78).
        (ts.isCallExpression(u) &&
          typeof callee === "string" &&
          helpers.has(callee) &&
          u.arguments.some((a) => isName(a, name)));
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
            out.push({
              node: u,
              where: `${file}:${sf.getLineAndCharacterOfPosition(u.getStart(sf)).line + 1}`,
            });
        }
      }
      ts.forEachChild(u, inBlock);
    };
    inBlock(body);
  };
  for (const c of caught) scan(c.name, c.body, c.stop);
  return out;
}

/** The text helpers every scanned file exports (R-78), for the files that import them. */
function exportedTextHelpers(files: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    const sf = ts.createSourceFile(
      f,
      readFileSync(join(ROOT, f), "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    for (const name of textHelpers(sf, true)) out.add(name);
  }
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

  it("[self-test] follows a caught error into a helper that returns its text (R-78)", () => {
    const planted = [
      "const failed = (err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) });",
      "async function a() { try { x(); } catch (err) { return failed(err); } }",
      "const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));",
      "async function b() { try { x(); } catch (err) { const m = errorText(err); return m; } }",
      "function quiet(err: unknown) { logger.error('x', { error: (err as Error).message }); return 'fixed'; }",
      "async function c() { try { x(); } catch (err) { return { error: quiet(err) }; } }",
      "async function d() { try { x(); } catch (err) { logger.error('x', { error: errorText(err) }); } }",
      "class K { private text(e: unknown) { return (e as Error).message; } async m() { try { x(); } catch (err) { return this.text(err); } } }",
      "async function e() { try { x(); } catch (err) { return { error: imported(err) }; } }",
      // A string parameter's template is not error text: `named` is no helper.
      "function named(err: unknown, op: string) { logger.warn('x', { error: String(err) }); return `${op} failed`; }",
      'import { imported } from "./elsewhere";',
      "async function f() { try { x(); } catch (err) { return { error: named(err, 'op') }; } }",
    ].join("\n");
    const found = returnedErrorText("planted.ts", planted, new Set(["imported"]));
    // The helpers' own bodies are not reported: their callers are.
    expect(found).toEqual([
      "planted.ts:2 failed(err)",
      "planted.ts:4 errorText(err)",
      "planted.ts:8 this.text(err)",
      "planted.ts:9 imported(err)",
    ]);
    // A helper another file exports is followed only where it is imported.
    expect(returnedErrorText("planted.ts", planted)).not.toContain(
      "planted.ts:9 imported(err)"
    );
  });

  it("none in platform/, app/api or lib/, but where ALLOWED says why (R-77: baseline 0)", () => {
    const scanned = DIRS.flatMap(files);
    const exported = exportedTextHelpers(scanned);
    const found = scanned.flatMap((f) =>
      returnedErrorText(f, readFileSync(join(ROOT, f), "utf8"), exported)
    );
    expect(found).toEqual([]);
  });
});
