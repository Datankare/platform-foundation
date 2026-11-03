/**
 * __tests__/helpers/call-graph.ts — Which functions reach which, by name (TASK-194)
 *
 * The production sources read with the TypeScript compiler API: every named function (a
 * declaration, a `const f = …` function, a class method) with the functions it calls by name.
 * `reaching(targets)` resolves, to a fixed point, every function name that calls one of
 * `targets` directly or through others. Calls are resolved by identifier only: a method call
 * (`x.execute()`) is not followed, so generic method names cannot join unrelated functions — an
 * effect reached only through one must be named as a target itself. Route methods (GET, POST, …)
 * and the guards passed in `opaque` never propagate: every route has a POST, and every admin
 * route calls requireAdmin.
 *
 * Used by the route-effect registry (irreversible-routes.test.ts) and the audit rule for admin
 * changes (admin-mutations-audited.test.ts).
 */

import * as ts from "typescript";
import { productionSources, read } from "./route-policy";

export type CallGraph = ReadonlyMap<string, readonly ReadonlySet<string>[]>;

/** Every named function of the production sources, with the names it calls. */
export function buildCallGraph(
  files: readonly { path: string; text: string }[] = productionSources().map((f) => ({
    path: f,
    text: read(f),
  }))
): CallGraph {
  const out = new Map<string, Set<string>[]>();
  for (const { path, text } of files) {
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const callsIn = (node: ts.Node) => {
      const calls = new Set<string>();
      const visit = (n: ts.Node) => {
        if (
          (ts.isCallExpression(n) || ts.isNewExpression(n)) &&
          ts.isIdentifier(n.expression)
        )
          calls.add(n.expression.text);
        ts.forEachChild(n, visit);
      };
      visit(node);
      return calls;
    };
    const add = (name: string, node: ts.Node) =>
      out.set(name, [...(out.get(name) ?? []), callsIn(node)]);
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name && n.body) add(n.name.text, n.body);
      else if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
      )
        add(n.name.text, n.initializer);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** The names that reach one of `targets` (the targets included), to a fixed point. */
export function reaching(
  graph: CallGraph,
  targets: readonly string[],
  opaque: readonly string[] = []
): Set<string> {
  const reach = new Set(targets);
  const skip = (name: string) =>
    /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(name) || opaque.includes(name);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, defs] of graph) {
      if (reach.has(name) || skip(name)) continue;
      if (defs.some((d) => [...d].some((c) => reach.has(c)))) {
        reach.add(name);
        grew = true;
      }
    }
  }
  return reach;
}
