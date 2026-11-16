/**
 * __tests__/url-parameters.test.ts — a URL carries ids, codes and numbers, never what a person
 * typed (TASK-215, audit A-17)
 *
 * @guard a route reading, or a screen sending, a URL query parameter that no register classifies, or one classified as free text
 *
 * A URL is kept by every proxy, CDN and access log on its way, and in the browser's history; a
 * request body is not — MITRE's CWE-598, "Use of HTTP Request With Sensitive Query String" (MITRE
 * Corporation). The Users
 * screen sent its search box — part of an address or a name — as `GET /api/admin/users?q=…`. Now
 * a search text goes in a POST body (POST /api/admin/users/search), and every query parameter a
 * route reads (`searchParams.get|getAll|has("…")`, by name or through a loop over a list of names)
 * and every one a screen puts in an `/api/` URL is classified here: an id, a code, a number, a
 * date, a host name, a single-use handle, or a path of this site (the page sign-in returns to —
 * the address the person was already on; TASK-222). `body-only` names a text a route reads from parameters
 * built from a body, which its GET refuses in a URL. A new parameter fails here
 * until it is classified; a free-text one cannot be. A screen building a query with
 * URLSearchParams is refused outright (it is how the search text got there).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { productionSources } from "./helpers/route-policy";

const ROOT = join(__dirname, "..");

type Kind = "id" | "code" | "number" | "date" | "host" | "handle" | "path" | "body-only";

/** Every query parameter name, what it carries, and why that may be in a URL. */
export const URL_PARAMETERS: Readonly<Record<string, { kind: Kind; why: string }>> = {
  sort: { kind: "code", why: "a sort key from a fixed list" },
  dir: { kind: "code", why: "a sort direction" },
  limit: { kind: "number", why: "a page size" },
  offset: { kind: "number", why: "a page offset" },
  role: {
    kind: "code",
    why: "a role's name from the catalog (checked, at most 64 characters)",
  },
  status: { kind: "code", why: "a standing or a state from a fixed list" },
  signed_in_within_days: { kind: "number", why: "a day count" },
  created_within_days: { kind: "number", why: "a day count" },
  category: { kind: "code", why: "a setting category" },
  enhanced: { kind: "code", why: "a flag" },
  view: { kind: "code", why: "which view of a list" },
  key: { kind: "code", why: "a setting's key" },
  host: { kind: "host", why: "a tenant's own address (tenant routing, not a person's)" },
  userId: { kind: "id", why: "an account id (pseudonymous; ids are in route paths too)" },
  targetUserId: { kind: "id", why: "an account id (checked to be one)" },
  claimedBy: { kind: "id", why: "an account id (checked to be one)" },
  source: { kind: "code", why: "a review case's source" },
  priority: { kind: "code", why: "a review case's priority" },
  since: { kind: "date", why: "a time bound" },
  before: { kind: "date", why: "a time bound" },
  q: {
    kind: "body-only",
    why: "a search: the Users list reads it from a POST body (GET refuses it in a URL); the audit log takes only an account id or part of an action's name (a code), and refuses anything else",
  },
  text: {
    kind: "body-only",
    why: "a search text: read from a POST body only (GET /api/admin/users refuses it in a URL)",
  },
  redirect: {
    kind: "path",
    why: "the page sign-in returns to: a path of this site only, checked as one (platform/auth/return-path.ts) — the address the person was already on, never what they typed (TASK-222, E-113)",
  },
  request: {
    kind: "handle",
    why: "an agent delegation request's single-use code, which expires in minutes (the device flow's own URL)",
  },
};

/** The parameter names a route source reads, with their lines. */
export function readParameters(
  source: string,
  file = "probe.ts"
): { line: number; name: string }[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: { line: number; name: string }[] = [];
  const constArrays = new Map<string, string[]>();
  const literals = (e: ts.Expression | undefined): string[] | undefined => {
    if (!e) return undefined;
    let x = e;
    while (
      ts.isAsExpression(x) ||
      ts.isSatisfiesExpression(x) ||
      ts.isParenthesizedExpression(x)
    )
      x = x.expression;
    if (ts.isArrayLiteralExpression(x)) {
      const names = x.elements.filter(ts.isStringLiteralLike).map((l) => l.text);
      return names.length === x.elements.length ? names : undefined;
    }
    if (ts.isIdentifier(x)) return constArrays.get(x.text);
    return undefined;
  };
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const names = literals(n.initializer);
      if (names) constArrays.set(n.name.text, names);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  // The names a loop variable takes: `for (const x of [..])` or of a const array of names.
  const loopNames = (id: ts.Identifier): string[] | undefined => {
    for (let p: ts.Node | undefined = id.parent; p; p = p.parent) {
      if (
        ts.isForOfStatement(p) &&
        ts.isVariableDeclarationList(p.initializer) &&
        p.initializer.declarations.some(
          (d) => ts.isIdentifier(d.name) && d.name.text === id.text
        )
      )
        return literals(p.expression);
    }
    return undefined;
  };
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      /^(?:get|getAll|has)$/.test(n.expression.name.text) &&
      /(?:searchParams|params)$/i.test(n.expression.expression.getText(sf))
    ) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) out.push({ line, name: arg.text });
      else if (arg && ts.isIdentifier(arg)) {
        const names = loopNames(arg);
        if (names) for (const name of names) out.push({ line, name });
        else out.push({ line, name: `<${arg.text}: not a known list of names>` });
      } else if (arg) out.push({ line, name: `<${arg.getText(sf)}>` });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** What a template literal's placeholder reads as: a value, never a parameter's name. */
const HOLE = "%v";

/** The parameter names a screen puts in an `/api/` URL, and every URLSearchParams it builds. */
export function sentParameters(
  source: string,
  file = "probe.tsx"
): { line: number; name: string }[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: { line: number; name: string }[] = [];
  const visit = (n: ts.Node): void => {
    const line = () => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    let text: string | undefined;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    else if (ts.isTemplateExpression(n))
      text = n.head.text + n.templateSpans.map((s) => HOLE + s.literal.text).join("");
    if (
      text !== undefined &&
      (/\/api\//.test(text) || text.startsWith(`${HOLE}/`)) &&
      text.includes("?")
    ) {
      for (const m of text.slice(text.indexOf("?")).matchAll(/[?&]([\w-]+)=/g))
        out.push({ line: line(), name: m[1] });
    }
    // Building a query from values (`new URLSearchParams({ q })`) — not reading one
    // (`new URLSearchParams(window.location.search)`).
    if (
      ts.isNewExpression(n) &&
      n.expression.getText(sf) === "URLSearchParams" &&
      n.arguments?.[0] !== undefined &&
      (ts.isObjectLiteralExpression(n.arguments[0]) ||
        ts.isArrayLiteralExpression(n.arguments[0]))
    )
      out.push({ line: line(), name: "<URLSearchParams: a query built from values>" });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** "<file>:<line> <name>" for each parameter not classified, or classified as free text. */
export function unclassifiedParameters(
  found: readonly { file: string; line: number; name: string }[],
  register: Readonly<Record<string, { kind: Kind }>> = URL_PARAMETERS
): string[] {
  return found
    .filter(({ name }) => !Object.prototype.hasOwnProperty.call(register, name))
    .map(({ file, line, name }) => `${file}:${line} ${name}`)
    .sort();
}

const isServer = (f: string) =>
  f.startsWith("app/api/") ||
  /^platform\/[\w/-]+-http\.ts$/.test(f) ||
  f.startsWith("platform/auth/mfa-routes");
const isScreen = (f: string) =>
  (f.startsWith("components/") || f.startsWith("app/") || f.startsWith("hooks/")) &&
  !f.startsWith("app/api/") &&
  /\.tsx?$/.test(f);

describe("URLs carry ids, codes and numbers, never what a person typed (TASK-215, A-17)", () => {
  const files = productionSources().map((file) => ({
    file,
    text: readFileSync(join(ROOT, file), "utf8"),
  }));

  it("finds the routes' and the screens' parameters", () => {
    const server = files
      .filter((f) => isServer(f.file))
      .flatMap((f) => readParameters(f.text, f.file));
    expect(new Set(server.map((p) => p.name)).size).toBeGreaterThan(10);
  });

  it("every parameter a route reads is classified", () => {
    const found = files
      .filter((f) => isServer(f.file))
      .flatMap((f) =>
        readParameters(f.text, f.file).map((p) => ({ ...p, file: f.file }))
      );
    expect(unclassifiedParameters(found)).toEqual([]);
  });

  it("every parameter a screen sends is classified, and none builds a query from values", () => {
    const found = files
      .filter((f) => isScreen(f.file))
      .flatMap((f) =>
        sentParameters(f.text, f.file).map((p) => ({ ...p, file: f.file }))
      );
    expect(unclassifiedParameters(found)).toEqual([]);
  });

  it("no register entry is free text", () => {
    for (const [name, { kind }] of Object.entries(URL_PARAMETERS))
      expect([
        name,
        ["id", "code", "number", "date", "host", "handle", "path", "body-only"].includes(
          kind
        ),
      ]).toEqual([name, true]);
  });

  it("[self-test] a search text read from, or sent in, a URL is reported", () => {
    const route = [
      'const term = request.nextUrl.searchParams.get("email");',
      'for (const f of ["targetUserId", "nickname"]) params.get(f);',
      "params.get(dynamicName);",
    ].join("\n");
    expect(
      unclassifiedParameters(readParameters(route).map((p) => ({ ...p, file: "r.ts" })))
    ).toEqual([
      "r.ts:1 email",
      "r.ts:2 nickname",
      "r.ts:3 <dynamicName: not a known list of names>",
    ]);
    const screen = [
      "apiFetch(`/api/admin/users?name=${encodeURIComponent(name)}&limit=10`);",
      "const qs = new URLSearchParams({ q: query });",
    ].join("\n");
    expect(
      unclassifiedParameters(sentParameters(screen).map((p) => ({ ...p, file: "s.tsx" })))
    ).toEqual(["s.tsx:1 name", "s.tsx:2 <URLSearchParams: a query built from values>"]);
  });
});
