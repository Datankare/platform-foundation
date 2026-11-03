/**
 * __tests__/helpers/owner-scan.ts — Who can run their own SQL on the owner connection (TASK-194,
 * C-12)
 *
 * data-sql-hygiene allowlisted the files that call withOwnerTx/withOwnerSnapshot by name, so a
 * function that LENDS an owner transaction to its caller — catalogTx(fn) runs `fn` on the owner
 * connection — let any file that called it run outside row-level security with no review: the
 * literal text `withOwnerTx(` was in the allowlisted file, not in the caller (audit C-12).
 *
 * This reads every production source with the TypeScript compiler API and finds the lenders: a
 * function that passes a callback it was given — the parameter itself, or a function that calls
 * it — to withOwnerTx, withOwnerSnapshot or another lender. Resolved to a fixed point, so a lender
 * of a lender is one too. Every file that calls a lender is then an owner caller and must be on
 * the reviewed list. A function that runs only its own fixed statements on the owner connection
 * is not a lender: its callers cannot choose what runs there, and its own file is on the list.
 *
 * Round 1 (TASK-194, A5): a lender may also be an object literal's property (`{ run: (fn) =>
 * withOwnerTx(fn) }`) or method, take its callback destructured (`({ work }) => …`) or inside an
 * object (`opts.work`), and hand it on as a property (`withOwnerTx(opts.work)`), inside an object
 * or array argument (`lend({ work: fn })`), or by calling it through a property with the
 * transaction inside an object (`(tx) => opts.work({ tx })`). Limits, by design: a callback
 * reached through a variable assigned in the body (`const f = opts.work; withOwnerTx(f)`), a
 * computed property name, a function stored in a Map, or a lender called through a bound or
 * re-exported alias under another name is not traced — each would need data-flow analysis; the
 * reviewed OWNER_CALLERS list and code review cover them.
 *
 * It also lists every parameter typed ConfigWriteTarget that is optional or defaulted: where a
 * config write goes (the platform default is written on the owner connection) is the caller's
 * explicit choice, never a default (audit C-12: setConfigWithHistory's target defaulted to the
 * platform default).
 */

import * as ts from "typescript";

export interface SourceText {
  readonly path: string;
  readonly text: string;
}

export const OWNER_PRIMITIVES = ["withOwnerTx", "withOwnerSnapshot"] as const;

type Fn = ts.FunctionLikeDeclaration;

function calleeName(e: ts.Expression): string | undefined {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

/** Every named function of a file: declarations, `const f = …` functions, class methods. */
function namedFunctions(sf: ts.SourceFile): { name: string; fn: Fn }[] {
  const out: { name: string; fn: Fn }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body)
      out.push({ name: n.name.text, fn: n });
    else if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    )
      out.push({ name: n.name.text, fn: n.initializer });
    else if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name) && n.body)
      out.push({ name: n.name.text, fn: n });
    // An object literal's function-valued property (`{ run: (fn) => … }`, A5).
    else if (
      ts.isPropertyAssignment(n) &&
      ts.isIdentifier(n.name) &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    )
      out.push({ name: n.name.text, fn: n.initializer });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The names a binding introduces: `a`, and each name destructured from `{ a, b: { c } }`. */
function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) out.add(name.text);
  else
    for (const el of name.elements)
      if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
}

function paramNames(fn: Fn): Set<string> {
  const out = new Set<string>();
  for (const p of fn.parameters) bindingNames(p.name, out);
  return out;
}

/** The identifier an access chain starts from: `a` for `a`, `a.b`, `a.b[c]`, `a.b.c`. */
function rootName(e: ts.Expression): string | undefined {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e))
    return rootName(e.expression);
  return undefined;
}

/** Whether any identifier inside `n` is one of `names`. */
function mentions(n: ts.Node, names: Set<string>): boolean {
  if (ts.isIdentifier(n) && names.has(n.text)) return true;
  let found = false;
  ts.forEachChild(n, (c) => {
    if (!found && mentions(c, names)) found = true;
  });
  return found;
}

/**
 * Whether `arg` hands the owner transaction to the caller's callback: it is a callback parameter
 * itself (it receives the transaction), or a function that passes its own parameter (the
 * transaction) to one — `(tx) => fn(tx)`. A sink the function only writes results to (a chunk
 * writer) is not given the transaction.
 */
function forwardsParam(arg: ts.Expression, params: Set<string>): boolean {
  // The callback itself, or reached through a property of a parameter (`opts.work`, A5).
  if (
    ts.isIdentifier(arg) ||
    ts.isPropertyAccessExpression(arg) ||
    ts.isElementAccessExpression(arg)
  ) {
    const root = rootName(arg);
    return root !== undefined && params.has(root);
  }
  // Inside an object or array argument (`lend({ work: fn })`, A5).
  if (ts.isObjectLiteralExpression(arg)) {
    return arg.properties.some((p) =>
      ts.isPropertyAssignment(p)
        ? forwardsParam(p.initializer, params)
        : ts.isShorthandPropertyAssignment(p)
          ? params.has(p.name.text)
          : ts.isSpreadAssignment(p)
            ? forwardsParam(p.expression, params)
            : false
    );
  }
  if (ts.isArrayLiteralExpression(arg)) {
    return arg.elements.some((e) => forwardsParam(e, params));
  }
  if (ts.isParenthesizedExpression(arg) || ts.isAsExpression(arg)) {
    return forwardsParam(arg.expression, params);
  }
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
    const own = paramNames(arg);
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      // A call of the callback — directly or through a property of a parameter — that passes
      // the transaction on, as itself or inside an object or array (`opts.work({ tx })`, A5).
      if (ts.isCallExpression(n)) {
        const root = rootName(n.expression);
        if (
          root !== undefined &&
          params.has(root) &&
          !own.has(root) &&
          n.arguments.some((a) => mentions(a, own))
        )
          found = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(arg.body);
    return found;
  }
  return false;
}

export interface OwnerScan {
  /** Lender function names, with the file that defines each. */
  readonly lenders: Readonly<Record<string, string>>;
  /** Files that call a lender (outside the lender's own file), with the lenders called. */
  readonly lenderCallers: Readonly<Record<string, readonly string[]>>;
  /** `file: function(param)` for every optional or defaulted ConfigWriteTarget parameter. */
  readonly defaultedTargets: readonly string[];
}

export function scanOwnerLenders(sources: readonly SourceText[]): OwnerScan {
  const parsed = sources.map((s) => ({
    path: s.path,
    sf: ts.createSourceFile(s.path, s.text, ts.ScriptTarget.Latest, true),
  }));
  const fns = parsed.flatMap(({ path, sf }) =>
    namedFunctions(sf).map((f) => ({ path, ...f }))
  );

  const lenders = new Map<string, string>();
  const isOwnerish = (name: string) =>
    (OWNER_PRIMITIVES as readonly string[]).includes(name) || lenders.has(name);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const { path, name, fn } of fns) {
      if (lenders.has(name) || (OWNER_PRIMITIVES as readonly string[]).includes(name))
        continue;
      const params = paramNames(fn);
      if (params.size === 0 || !fn.body) continue;
      let lends = false;
      const visit = (n: ts.Node) => {
        if (lends) return;
        if (ts.isCallExpression(n)) {
          const callee = calleeName(n.expression);
          if (
            callee &&
            isOwnerish(callee) &&
            n.arguments.some((a) => forwardsParam(a, params))
          )
            lends = true;
        }
        ts.forEachChild(n, visit);
      };
      visit(fn.body);
      if (lends) {
        lenders.set(name, path);
        progressed = true;
      }
    }
  }

  const lenderCallers: Record<string, string[]> = {};
  for (const { path, sf } of parsed) {
    const called = new Set<string>();
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = calleeName(n.expression);
        if (callee && lenders.has(callee) && lenders.get(callee) !== path)
          called.add(callee);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (called.size > 0) lenderCallers[path] = [...called].sort();
  }

  const defaultedTargets: string[] = [];
  for (const { path, name, fn } of fns) {
    for (const p of fn.parameters) {
      const typed = p.type && /\bConfigWriteTarget\b/.test(p.type.getText());
      if (typed && (p.questionToken || p.initializer))
        defaultedTargets.push(`${path}: ${name}(${p.name.getText()})`);
    }
  }

  return { lenders: Object.fromEntries(lenders), lenderCallers, defaultedTargets };
}
