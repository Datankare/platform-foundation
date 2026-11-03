/**
 * __tests__/irreversible-routes.test.ts — every irreversible route is dual-controlled or says why
 * not (TASK-194, audit C-6)
 *
 * An account's erasure (POST /api/admin/gdpr) took one admin, while a reversible role change took
 * two: dual control covered only the command bar's actions, and the erasure was a direct route.
 * This is the route-effect registry. The irreversible effects are named below; every function
 * that reaches one — through any production file, resolved to a fixed point by name with the
 * TypeScript compiler API — is irreversible too. Every route method that reaches one must be in
 * IRREVERSIBLE_ROUTES, either:
 *
 *   - `held`: it only asks for the effect, which runs once a second person approves (and the
 *     test checks the method calls the named hold function — and, for a command-bar action,
 *     that the action is one ALWAYS_HELD_ACTIONS holds whatever the governed list says); or
 *   - `single`: an accepted single-actor effect, with the reason.
 *
 * A `held` method that also reaches the effect directly — the erasure route's dry run — names the
 * guard (`directOnlyWhen`): every direct call to an irreversible function in the method must be
 * reachable only when that flag is true — by branch semantics (round 2): the then-branch of
 * `if (x.dryRun)`, the else of `if (!x.dryRun)`, a conjunction — and not inside a closure, which
 * may run anywhere (round 3, L5). TASK-194 round 1, A4: removing the dry-run guard made the direct
 * call erase, and the registry still passed; round 2: an inverted guard still named the flag.
 */

import { readFileSync } from "node:fs";
import ts from "typescript";
import { apiRoutes, read } from "./helpers/route-policy";
import { buildCallGraph, reaching } from "./helpers/call-graph";
import { routeMethods } from "./helpers/route-methods";
import { ALWAYS_HELD_ACTIONS } from "@/app/api/admin/ai/command-bar";

/** Effects that cannot be undone: an account's data erased or anonymised, a tenant purged. */
const IRREVERSIBLE_EFFECTS = [
  "softDeleteUser",
  "hardPurgeUser",
  "purgeDueErasures",
  "createPlatformPurgePipeline",
  "purgeDueTenants",
];

type Entry =
  | {
      readonly held: string;
      readonly action?: string;
      /** The flag every direct irreversible call in the method is guarded by. */
      readonly directOnlyWhen?: string;
      readonly why: string;
    }
  | { readonly single: string };

/** "file METHOD" → how the route's irreversible effect is governed. */
const IRREVERSIBLE_ROUTES: Readonly<Record<string, Entry>> = {
  "app/api/admin/gdpr/route.ts POST": {
    held: "runCommandBarAction",
    action: "purge_user_data",
    directOnlyWhen: "dryRun",
    why: "An admin's erasure of an account is proposed here and runs only once a second holder of admin_purge_user_data approves it; the direct call is the dry run, which changes nothing.",
  },
  "app/api/account/delete/route.ts POST": {
    single:
      "Self-service: a signed-in user deleting their own account (GDPR Art. 17) — the subject's own decision, after their own confirmation; no second person may stand between a user and the erasure they ask for.",
  },
  "app/api/operator/purge/route.ts POST": {
    single:
      "Purges only tenants whose deletion was already dual-controlled — requested by one operator, approved by another (decideTenantDeletion refuses the requester) — and whose retention period has passed; the job runs the same function on its schedule.",
  },
};

const IRREVERSIBLE = reaching(buildCallGraph(), IRREVERSIBLE_EFFECTS);

/**
 * The direct calls to `names` in `method`'s own body (its function named `method`) that are NOT
 * in the then-branch of an `if` whose condition mentions `flag` (no flag: every one), as
 * "callee@line".
 */
function unguardedCalls(
  src: string,
  method: string,
  names: ReadonlySet<string>,
  flag: string | undefined
): string[] {
  const sf = ts.createSourceFile("route.ts", src, ts.ScriptTarget.Latest, true);
  const bodies: ts.Node[] = [];
  const findFn = (n: ts.Node): void => {
    if (
      (ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) &&
      n.name?.text === method &&
      n.body
    )
      bodies.push(n.body);
    ts.forEachChild(n, findFn);
  };
  findFn(sf);
  if (bodies.length !== 1) return [`<${bodies.length} bodies named ${method}>`];
  /**
   * Round 2: by branch semantics, not text — whether `cond` being true (`whenTrue`) or false
   * implies the flag is true. `x.dryRun`, `dryRun`, `x.dryRun === true`, a parenthesised one, its
   * negation (which flips), and a conjunction (true only if every term is) are understood;
   * anything else implies nothing.
   */
  const implies = (cond: ts.Expression, whenTrue: boolean): boolean => {
    let e: ts.Expression = cond;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken)
      return implies(e.operand, !whenTrue);
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken)
        return whenTrue && (implies(e.left, true) || implies(e.right, true));
      if (op === ts.SyntaxKind.BarBarToken)
        return !whenTrue && (implies(e.left, false) || implies(e.right, false));
      if (
        (op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          op === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
        e.right.kind === ts.SyntaxKind.TrueKeyword
      )
        return implies(
          e.left,
          op === ts.SyntaxKind.EqualsEqualsEqualsToken ? whenTrue : !whenTrue
        );
      return false;
    }
    const isFlag =
      (ts.isIdentifier(e) && e.text === flag) ||
      (ts.isPropertyAccessExpression(e) && e.name.text === flag);
    return isFlag && whenTrue;
  };
  const guarded = (n: ts.Node): boolean => {
    if (!flag) return false;
    for (let at: ts.Node = n; at.parent; at = at.parent) {
      const parent = at.parent;
      // A closure is not guarded by an `if` around its definition: it may run anywhere later
      // (round 3, L5). The walk stops at the first function-like node.
      if (ts.isFunctionLike(parent)) return false;
      if (ts.isIfStatement(parent)) {
        if (parent.thenStatement === at && implies(parent.expression, true)) return true;
        if (parent.elseStatement === at && implies(parent.expression, false)) return true;
      }
    }
    return false;
  };
  const out: string[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      const name = ts.isIdentifier(e)
        ? e.text
        : ts.isPropertyAccessExpression(e)
          ? e.name.text
          : undefined;
      if (name && names.has(name) && !guarded(n)) {
        out.push(`${name}@${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(bodies[0]);
  return out;
}

describe("irreversible routes are dual-controlled or accepted single-actor (TASK-194, C-6)", () => {
  it("finds the irreversible functions it means to (self-test)", () => {
    for (const name of [...IRREVERSIBLE_EFFECTS, "handlePurgeUserData"])
      expect({ name, irreversible: IRREVERSIBLE.has(name) }).toEqual({
        name,
        irreversible: true,
      });
    expect(IRREVERSIBLE.has("handleChangeUserRole")).toBe(false);
  });

  const found: string[] = [];
  for (const file of apiRoutes()) {
    for (const m of routeMethods(readFileSync(file, "utf8"), file)) {
      if (m.calls.some((c) => IRREVERSIBLE.has(c))) found.push(`${file} ${m.method}`);
    }
  }

  it("every route method reaching an irreversible effect is in the registry", () => {
    expect(found.length).toBeGreaterThan(2);
    expect(found.filter((r) => !(r in IRREVERSIBLE_ROUTES)).sort()).toEqual([]);
  });

  it("lists no route that does not reach one, and gives each a reason", () => {
    for (const [route, entry] of Object.entries(IRREVERSIBLE_ROUTES)) {
      const reason = "single" in entry ? entry.single : entry.why;
      expect({
        route,
        found: found.includes(route),
        reasoned: reason.length > 40,
      }).toEqual({
        route,
        found: true,
        reasoned: true,
      });
    }
  });

  it.each(
    Object.entries(IRREVERSIBLE_ROUTES).filter(([, e]) => "held" in e) as [
      string,
      Extract<Entry, { held: string }>,
    ][]
  )("%s asks for its effect through a hold that is always held", (route, entry) => {
    const [file, method] = route.split(" ");
    const m = routeMethods(readFileSync(file, "utf8"), file).find(
      (x) => x.method === method
    );
    expect(m?.calls).toContain(entry.held);
    if (entry.action) {
      expect(ALWAYS_HELD_ACTIONS.has(entry.action as never)).toBe(true);
      expect(read(file)).toContain(`tool: "${entry.action}"`);
    }
    // Every direct irreversible call is behind its guard; with none named, there is none.
    const direct = new Set([...IRREVERSIBLE].filter((n) => n !== entry.held));
    const unguarded = unguardedCalls(read(file), method, direct, entry.directOnlyWhen);
    expect({ route, unguarded }).toEqual({ route, unguarded: [] });
  });

  describe("the guard check (self-test)", () => {
    const names = new Set(["handlePurgeUserData"]);
    const route = (body: string) =>
      `export const POST = tenantRoute(async function POST(request) { ${body} });`;
    it("passes a direct call inside `if (input.dryRun)`", () => {
      expect(
        unguardedCalls(
          route("if (input.dryRun) { await handlePurgeUserData(input, admin); }"),
          "POST",
          names,
          "dryRun"
        )
      ).toEqual([]);
    });
    it("fails the same call with the guard removed, or in the else branch", () => {
      expect(
        unguardedCalls(
          route("await handlePurgeUserData(input, admin);"),
          "POST",
          names,
          "dryRun"
        )
      ).toEqual(["handlePurgeUserData@1"]);
      expect(
        unguardedCalls(
          route(
            "if (input.dryRun) { x(); } else { await handlePurgeUserData(input, admin); }"
          ),
          "POST",
          names,
          "dryRun"
        )
      ).toEqual(["handlePurgeUserData@1"]);
      expect(
        unguardedCalls(
          route("if (input.other) { await handlePurgeUserData(input, admin); }"),
          "POST",
          names,
          "dryRun"
        )
      ).toEqual(["handlePurgeUserData@1"]);
    });
    // Round 2: the guard inverted still names the flag — the text check passed it.
    it.each([
      "if (!input.dryRun) { await handlePurgeUserData(input, admin); }",
      "if (input.dryRun !== true) { await handlePurgeUserData(input, admin); }",
      "if (input.dryRun || other) { await handlePurgeUserData(input, admin); }",
      "if (input.dryRun) { x(); } else { await handlePurgeUserData(input, admin); }",
      // Round 3, L5: a closure defined under the guard and called outside it.
      "let later = async () => {}; if (input.dryRun) { later = async () => { await handlePurgeUserData(input, admin); }; } await later();",
    ])("fails a call reachable when the flag is false: %s", (body) => {
      expect(unguardedCalls(route(body), "POST", names, "dryRun")).toEqual([
        "handlePurgeUserData@1",
      ]);
    });
    it.each([
      "if (input.dryRun === true) { await handlePurgeUserData(input, admin); }",
      "if (!input.dryRun) { x(); } else { await handlePurgeUserData(input, admin); }",
      "if (input.dryRun && ok) { await handlePurgeUserData(input, admin); }",
      "if (!(input.dryRun)) { x(); } else { await handlePurgeUserData(input, admin); }",
    ])("passes a call reachable only when the flag is true: %s", (body) => {
      expect(unguardedCalls(route(body), "POST", names, "dryRun")).toEqual([]);
    });
  });
});
