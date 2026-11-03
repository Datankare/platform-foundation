/**
 * __tests__/feature-permissions-enforced.test.ts — every feature permission is guarded somewhere,
 * or reserved with a reason (TASK-194 round 1, finding C4)
 *
 * @guard a feature permission no guard checks and no reservation explains
 *
 * FEATURE_PERMISSIONS maps a feature to the permission it needs; the guard (requireActorWithStatus,
 * or an app's declared verifier) enforces it for the feature it is called with. A mapping no route
 * names is a permission an administrator can grant and take away to no effect — the defect C-4
 * fixed. Each key must therefore be named, as a string literal (or a const holding one), as the
 * feature argument of a guard call in production code — or be reserved: by the platform below,
 * or by the app (APP_ROUTE_POLICY.reservedFeatures), each with its reason.
 */

import ts from "typescript";
import { FEATURE_PERMISSIONS } from "@/platform/auth/feature-permissions";
import { APP_ROUTE_POLICY } from "@/platform/route-policy/app-route-policy";
import { productionSources, read } from "./helpers/route-policy";

/** Features no platform route guards on, with why. An app's route may name one. */
const PLATFORM_RESERVED: Readonly<Record<string, string>> = {
  view_profile:
    "No platform route serves a profile view (the platform's account routes are export, deletion, age and sessions); an app's profile route guards on it — Playform's app/api/profile GET.",
};

/** The guards that take the feature as their second argument. */
const GUARDS = ["requireActorWithStatus", ...APP_ROUTE_POLICY.verifiers];

/** Feature names given to a guard in `sources`, literally or through a string const. */
function guardedFeatures(
  sources: readonly { path: string; text: string }[],
  guards: readonly string[]
): Set<string> {
  const parsed = sources.map((s) =>
    ts.createSourceFile(s.path, s.text, ts.ScriptTarget.Latest, true)
  );
  const consts = new Map<string, string>();
  for (const sf of parsed) {
    const visit = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        ts.isStringLiteralLike(n.initializer)
      )
        consts.set(n.name.text, n.initializer.text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const used = new Set<string>();
  for (const sf of parsed) {
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const arg = n.arguments[1];
        if (guards.includes(n.expression.text) && arg) {
          if (ts.isStringLiteralLike(arg)) used.add(arg.text);
          else if (ts.isIdentifier(arg) && consts.has(arg.text))
            used.add(consts.get(arg.text)!);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return used;
}

const RESERVED: Readonly<Record<string, string>> = {
  ...PLATFORM_RESERVED,
  ...(APP_ROUTE_POLICY.reservedFeatures ?? {}),
};

describe("feature permissions are guarded or reserved (TASK-194 round 1, C4)", () => {
  const sources = productionSources().map((f) => ({ path: f, text: read(f) }));
  const used = guardedFeatures(sources, GUARDS);

  it("finds the guarded features it means to (self-test)", () => {
    expect(used.has("translate")).toBe(true);
    expect(used.has("update_profile")).toBe(true);
  });

  it("every FEATURE_PERMISSIONS key is named at a guard call, or reserved", () => {
    const unguarded = Object.keys(FEATURE_PERMISSIONS).filter(
      (k) => !used.has(k) && !(k in RESERVED)
    );
    expect(unguarded).toEqual([]);
  });

  it("reserves only mapped features, each with a reason", () => {
    for (const [feature, reason] of Object.entries(RESERVED)) {
      expect({
        feature,
        mapped: feature in FEATURE_PERMISSIONS,
        reasoned: reason.length > 30,
      }).toEqual({ feature, mapped: true, reasoned: true });
    }
  });

  it("an app reservation of a feature its routes guard is stale and refused", () => {
    const stale = Object.keys(APP_ROUTE_POLICY.reservedFeatures ?? {}).filter((k) =>
      used.has(k)
    );
    expect(stale).toEqual([]);
  });

  it("[self-test] counts a literal or a const, and only the guard's feature argument", () => {
    const found = guardedFeatures(
      [
        {
          path: "a.ts",
          text:
            'const F = "update_profile";\n' +
            'await requireActorWithStatus(request, "translate", {});\n' +
            "await requireActorWithStatus(request, F, {});\n" +
            'await somethingElse(request, "view_profile");\n' +
            'await requireActorWithStatus("view_profile_typo");',
        },
      ],
      ["requireActorWithStatus"]
    );
    expect([...found].sort()).toEqual(["translate", "update_profile"]);
  });
});
