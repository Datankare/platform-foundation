/**
 * __tests__/helpers/route-methods.ts — What each exported route method itself calls (TASK-194,
 * C-11)
 *
 * The route checks counted calls per FILE: a file passed the caller check if it called a verifier
 * once, and the rate-limit check if it called limiters as often as it had handlers. So a new
 * `export const DELETE` that only rate limits, added to a file whose POST verifies, passed both
 * (audit C-11). This reads each method with the TypeScript compiler API — the way
 * helpers/audited-external-scan.ts reads audited() call sites — and reports, per (file, method):
 *
 *   - every function it calls, in source order, including through the functions of the same file
 *     it calls (a local helper the method delegates to counts as the method's own body);
 *   - the awaited calls made before its first call to a verifier — the only ones a method may make
 *     before it knows who is calling are the limiters (ADR-052: rate limit before any work).
 *
 * A method is `export const GET = <wrapper>(async function GET(…) {…})` (every platform route) or
 * `export async function GET(…)`; `export const GET = <wrapper>(handle)` follows `handle` in the
 * same file. A method whose body cannot be found is reported with `readable: false`, never passed.
 */

import * as ts from "typescript";

export const ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export interface RouteMethod {
  readonly method: string;
  /** Whether the method's body was found and read. */
  readonly readable: boolean;
  /** The functions it calls, in source order (local helpers followed, each once). */
  readonly calls: readonly string[];
  /** The same calls' awaited flags: `awaited[i]` is whether `calls[i]` is awaited. */
  readonly awaited: readonly boolean[];
}

function calleeName(e: ts.Expression): string | undefined {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

type FnNode = ts.FunctionLikeDeclaration;

/** The file's own top-level functions by name: `function f` and `const f = (…) =>` / `function`. */
function localFunctions(sf: ts.SourceFile): Map<string, FnNode> {
  const fns = new Map<string, FnNode>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) fns.set(st.name.text, st);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.initializer &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        )
          fns.set(d.name.text, d.initializer);
      }
    }
  }
  return fns;
}

/** The handler function of an exported method's initializer, unwrapping wrapper calls. */
function handlerOf(
  init: ts.Expression | undefined,
  locals: Map<string, FnNode>
): FnNode | undefined {
  let e = init;
  while (e) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) {
      e = e.expression;
      continue;
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e;
    if (ts.isIdentifier(e)) return locals.get(e.text);
    if (ts.isCallExpression(e)) {
      // tenantRoute(async function GET(…) {…}) — the function is the wrapper's argument.
      const fnArg = e.arguments.find(
        (a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a) || ts.isIdentifier(a)
      );
      e = fnArg;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** The calls `fn` makes, in order, following the same file's functions it calls (each once). */
function callsOf(
  fn: FnNode,
  locals: Map<string, FnNode>
): { calls: string[]; awaited: boolean[] } {
  const out: string[] = [];
  const awaited: boolean[] = [];
  const seen = new Set<FnNode>([fn]);
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      // Arguments are evaluated before the call is made.
      n.arguments.forEach(visit);
      visit(n.expression);
      const name = calleeName(n.expression);
      const local = name ? locals.get(name) : undefined;
      if (local) {
        // A helper of the same file: its body is the method's own (inlined, once).
        if (!seen.has(local)) {
          seen.add(local);
          if (local.body) visit(local.body);
        }
      } else if (name) {
        out.push(name);
        let p: ts.Node = n.parent;
        while (ts.isParenthesizedExpression(p)) p = p.parent;
        awaited.push(ts.isAwaitExpression(p));
      }
      return;
    }
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return { calls: out, awaited };
}

/** Every exported route method of `src`, with what it calls. */
export function routeMethods(src: string, file = "route.ts"): RouteMethod[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const locals = localFunctions(sf);
  const out: RouteMethod[] = [];
  const exported = (s: ts.Statement) =>
    (ts.canHaveModifiers(s) ? ts.getModifiers(s) : undefined)?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword
    ) ?? false;
  for (const st of sf.statements) {
    if (!exported(st)) continue;
    if (ts.isFunctionDeclaration(st) && st.name && ROUTE_METHODS.includes(st.name.text)) {
      out.push({
        method: st.name.text,
        readable: !!st.body,
        ...(st.body ? callsOf(st, locals) : { calls: [], awaited: [] }),
      });
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !ROUTE_METHODS.includes(d.name.text)) continue;
        const fn = handlerOf(d.initializer, locals);
        out.push({
          method: d.name.text,
          readable: !!fn?.body,
          ...(fn ? callsOf(fn, locals) : { calls: [], awaited: [] }),
        });
      }
    }
  }
  // A re-export (`export { GET } from "./x"`) is a method this scan cannot read.
  for (const st of sf.statements) {
    if (
      ts.isExportDeclaration(st) &&
      st.exportClause &&
      ts.isNamedExports(st.exportClause)
    ) {
      for (const el of st.exportClause.elements) {
        if (ROUTE_METHODS.includes(el.name.text))
          out.push({ method: el.name.text, readable: false, calls: [], awaited: [] });
      }
    }
  }
  return out;
}

/** Why `m` does not verify its caller first, or null: no verifier, or work awaited before it. */
export function verificationProblem(
  m: RouteMethod,
  verifiers: readonly string[],
  limiters: readonly string[]
): string | null {
  if (!m.readable) return "its body could not be read";
  const first = m.calls.findIndex((c) => verifiers.includes(c));
  if (first < 0) return "calls no verifier";
  // Only limiters may be awaited before the caller is known (ADR-052: rate limit before any
  // work); synchronous helpers building their arguments are not work.
  const before = m.calls
    .slice(0, first)
    .filter((c, i) => m.awaited[i] && !limiters.includes(c));
  return before.length > 0 ? `awaits ${before.join(", ")} before verifying` : null;
}

/** Whether `m` calls one of `names` (a limiter, say) anywhere in its own body. */
export function methodCalls(m: RouteMethod, names: readonly string[]): boolean {
  return m.calls.some((c) => names.includes(c));
}
