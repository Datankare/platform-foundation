/**
 * __tests__/no-client-tokens.test.ts — no credential where page script can read it (ADR-057 D1,
 * TASK-214, SEC-016)
 *
 * @guard a token read or written by client code in browser storage, a script-readable cookie or a response body
 *
 * SEC-016 was the session's access token in localStorage: any script in the page could take it
 * and act as the user. The session is now a server-side record behind an HttpOnly cookie, and
 * this guard keeps a credential from coming back to where script can read it. Four scans, parsed
 * (TypeScript's own parser), so a name in a comment is not a use:
 *
 *   storage    `localStorage`, `sessionStorage` and `indexedDB` in any production source: refused,
 *              except (a) platform/auth/legacy-session-cleanup.ts, which may only DELETE the keys
 *              a pre-ADR-057 sign-in left (removeItem, key, length — never getItem or setItem),
 *              and (b) a key listed in client-credential-register.json with what it holds — used
 *              only through a string constant equal to that key, and never one whose name or
 *              holding says token, secret, credential, password or session cookie.
 *   cookies    `document.cookie` in any production source: refused (script neither reads nor
 *              writes a cookie). And every cookie the server sets is HttpOnly, unless the call
 *              is clearing it (maxAge 0).
 *   bodies     client code — every "use client" file, every page and component, and everything
 *              they import at run time — never touches a property named like a token
 *              (accessToken, refreshToken, idToken, access_token, refresh_token, id_token,
 *              token, bearer), never writes an Authorization header and never builds "Bearer …".
 *              `csrfToken` is not one: the session's forgery token is useless without the
 *              HttpOnly cookie, and the page must send it back (platform/auth/session.ts). Nor
 *              are `mfaSession` / `challengeSession`: a sign-in challenge's handle, which signs
 *              no one in without the second factor it asks for.
 *   responses  no API route or platform module answers a body with such a property
 *              (NextResponse.json / Response.json of an object literal), except a route listed
 *              in the register's tokenResponses — a machine credential issued to a machine.
 *
 * The register is per repository (not synced): the platform's is empty.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { productionSources } from "./helpers/route-policy";
import { resolveSpecifier } from "./helpers/import-graph";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

export const LEGACY_CLEANUP = "platform/auth/legacy-session-cleanup.ts";

/** Property names that are a token. Exact, case-sensitive but for the last. */
const TOKEN_NAMES = new Set([
  "accessToken",
  "refreshToken",
  "idToken",
  "access_token",
  "refresh_token",
  "id_token",
  "token",
  "bearer",
  "Bearer",
]);
/** What a storage key or its holding may never say. */
const CREDENTIAL_WORDS =
  /token|jwt|bearer|secret|credential|password|passwd|cookie|csrf|api[\s_-]?key/i;

interface StorageKey {
  readonly file: string;
  readonly key: string;
  readonly holds: string;
  readonly reason: string;
}
interface TokenResponse {
  readonly file: string;
  readonly fields: readonly string[];
  readonly reason: string;
}
export interface Register {
  readonly storageKeys: readonly StorageKey[];
  readonly tokenResponses: readonly TokenResponse[];
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

const lineOf = (sf: ts.SourceFile, n: ts.Node) =>
  sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

/** String constants declared in the file: `const NAME = "value"`. */
function stringConstants(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isStringLiteralLike(n.initializer)
    ) {
      out.set(n.name.text, n.initializer.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const STORAGE = new Set(["localStorage", "sessionStorage", "indexedDB"]);

/** Whether an identifier is a use of the name (not a property name or a declaration of it). */
function isUse(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) {
    // `window.localStorage` and `globalThis.localStorage` are uses; `x.localStorage` is one too.
    return true;
  }
  if (ts.isPropertyAssignment(p) && p.name === id) return false;
  if (ts.isPropertySignature(p) || ts.isMethodSignature(p)) return false;
  return true;
}

/** Storage findings for one file: `<file>:<line>: <what>`. */
export function storageFindings(
  file: string,
  text: string,
  register: Register
): string[] {
  const sf = parse(file, text);
  const constants = stringConstants(sf);
  const allowedKeys = new Set(
    register.storageKeys.filter((k) => k.file === file).map((k) => k.key)
  );
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && STORAGE.has(n.text) && isUse(n)) {
      // The expression the storage object is used in: `<storage>.method(args)` or `.length`.
      let object: ts.Node = n;
      if (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)
        object = n.parent;
      const access = object.parent;
      const method =
        ts.isPropertyAccessExpression(access) && access.expression === object
          ? access.name.text
          : null;
      const call =
        method &&
        ts.isCallExpression(access.parent) &&
        access.parent.expression === access
          ? access.parent
          : null;
      const where = `${file}:${lineOf(sf, n)}`;
      if (file === LEGACY_CLEANUP) {
        if (method === null && ts.isVariableDeclaration(access)) {
          // `const storage = window.localStorage` — its uses are checked by name below.
        } else if (method !== "removeItem" && method !== "key" && method !== "length") {
          out.push(
            `${where}: ${n.text}.${method ?? "(value)"} — the cleanup may only remove`
          );
        }
      } else if (n.text === "indexedDB") {
        out.push(`${where}: indexedDB`);
      } else if (
        !call ||
        !method ||
        !["getItem", "setItem", "removeItem"].includes(method)
      ) {
        out.push(`${where}: ${n.text} used other than by getItem/setItem/removeItem`);
      } else {
        const arg = call.arguments[0];
        const key =
          arg && ts.isStringLiteralLike(arg)
            ? arg.text
            : arg && ts.isIdentifier(arg)
              ? constants.get(arg.text)
              : undefined;
        if (key === undefined) {
          out.push(
            `${where}: ${n.text}.${method} with a key that is not a string constant`
          );
        } else if (!allowedKeys.has(key)) {
          out.push(
            `${where}: ${n.text}.${method}("${key}") — not in client-credential-register.json`
          );
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (file === LEGACY_CLEANUP) {
    // An alias of the storage object in the cleanup may only remove, too.
    const aliases = new Set<string>();
    const findAliases = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        /\b(?:localStorage|sessionStorage)\b/.test(n.initializer.getText(sf))
      ) {
        aliases.add(n.name.text);
      }
      ts.forEachChild(n, findAliases);
    };
    findAliases(sf);
    const checkAliases = (n: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(n) &&
        ts.isIdentifier(n.expression) &&
        aliases.has(n.expression.text) &&
        !["removeItem", "key", "length"].includes(n.name.text)
      ) {
        out.push(
          `${file}:${lineOf(sf, n)}: ${n.getText(sf)} — the cleanup may only remove`
        );
      }
      ts.forEachChild(n, checkAliases);
    };
    checkAliases(sf);
  }
  return out;
}

/** `document.cookie`, and a cookie set without HttpOnly that is not being cleared. */
export function cookieFindings(file: string, text: string): string[] {
  const sf = parse(file, text);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(n) &&
      n.name.text === "cookie" &&
      /(?:^|\.)document$/.test(n.expression.getText(sf))
    ) {
      out.push(`${file}:${lineOf(sf, n)}: document.cookie`);
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "set" &&
      /\bcookies$/.test(n.expression.expression.getText(sf)) &&
      n.arguments.length >= 2
    ) {
      const options = n.arguments[2];
      const prop = (name: string): ts.Expression | undefined =>
        options && ts.isObjectLiteralExpression(options)
          ? options.properties.find(
              (p): p is ts.PropertyAssignment =>
                ts.isPropertyAssignment(p) && p.name.getText(sf) === name
            )?.initializer
          : undefined;
      const httpOnly = prop("httpOnly");
      const maxAge = prop("maxAge");
      const clearing = maxAge !== undefined && maxAge.getText(sf) === "0";
      // A single argument that is a whole cookie object (copying one a callee set) is not a
      // cookie this call defines.
      const defines = n.arguments.length >= 2;
      if (defines && !clearing && httpOnly?.kind !== ts.SyntaxKind.TrueKeyword) {
        out.push(`${file}:${lineOf(sf, n)}: a cookie set without httpOnly: true`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const nameOf = (sf: ts.SourceFile, n: ts.PropertyName | ts.BindingName): string | null =>
  ts.isIdentifier(n) || ts.isStringLiteralLike(n) ? n.text : null;

/** Token-named properties, Authorization headers and "Bearer …" in a client file. */
export function bodyFindings(file: string, text: string): string[] {
  const sf = parse(file, text);
  const out: string[] = [];
  const add = (n: ts.Node, what: string) => out.push(`${file}:${lineOf(sf, n)}: ${what}`);
  const visit = (n: ts.Node): void => {
    // Types describe; they neither read nor write a value.
    if (ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isTypeNode(n))
      return;
    if (ts.isPropertyAccessExpression(n) && TOKEN_NAMES.has(n.name.text)) {
      add(n, `.${n.name.text}`);
    } else if (
      ts.isElementAccessExpression(n) &&
      ts.isStringLiteralLike(n.argumentExpression) &&
      TOKEN_NAMES.has(n.argumentExpression.text)
    ) {
      add(n, `["${n.argumentExpression.text}"]`);
    } else if (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) {
      const name = nameOf(sf, n.name);
      // A function under the name is a method (the AuthProvider's `refreshToken`), not a value.
      const method =
        ts.isPropertyAssignment(n) &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer));
      if (name && TOKEN_NAMES.has(name) && !method) add(n, `{ ${name} }`);
      if (name && name.toLowerCase() === "authorization")
        add(n, "an Authorization header");
    } else if (ts.isBindingElement(n)) {
      const name = nameOf(sf, n.propertyName ?? n.name);
      if (name && TOKEN_NAMES.has(name)) add(n, `{ ${name} } destructured`);
    } else if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n)) {
      if (/^Bearer\s/.test(n.text)) add(n, '"Bearer …"');
      if (
        n.text.toLowerCase() === "authorization" &&
        ts.isCallExpression(n.parent) &&
        /\.(?:set|append)$/.test(n.parent.expression.getText(sf))
      ) {
        add(n, "an Authorization header");
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Token-named properties in an object literal answered as a response body. */
export function responseFindings(
  file: string,
  text: string,
  register: Register
): string[] {
  const sf = parse(file, text);
  const allowed = new Set(
    register.tokenResponses.filter((r) => r.file === file).flatMap((r) => r.fields)
  );
  const out: string[] = [];
  const inBody = (obj: ts.ObjectLiteralExpression): void => {
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
        const name = nameOf(sf, p.name);
        if (name && TOKEN_NAMES.has(name) && !allowed.has(name)) {
          out.push(`${file}:${lineOf(sf, p)}: a response body with "${name}"`);
        }
        if (ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer)) {
          inBody(p.initializer);
        }
      }
    }
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      const arg = n.arguments[0];
      if (/^(?:NextResponse|Response)\.json$/.test(callee) && arg) {
        if (ts.isObjectLiteralExpression(arg)) inBody(arg);
      }
      if (
        callee === "JSON.stringify" &&
        arg &&
        ts.isObjectLiteralExpression(arg) &&
        ts.isNewExpression(n.parent) &&
        /^(?:Next)?Response$/.test(n.parent.expression.getText(sf))
      ) {
        inBody(arg);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** What a register entry must not be. */
export function registerFindings(register: Register): string[] {
  const out: string[] = [];
  for (const k of register.storageKeys) {
    if (!k.file || !k.key || !k.holds || !k.reason || k.reason.trim().length < 20) {
      out.push(
        `storageKeys ${k.file}:${k.key}: file, key, holds and a reason are required`
      );
    }
    if (CREDENTIAL_WORDS.test(k.key) || CREDENTIAL_WORDS.test(k.holds)) {
      out.push(
        `storageKeys ${k.file}:${k.key}: names a credential — never in browser storage`
      );
    }
    if (!existsSync(join(ROOT, k.file))) out.push(`storageKeys ${k.file}: no such file`);
  }
  for (const r of register.tokenResponses) {
    if (!r.file || r.fields.length === 0 || !r.reason || r.reason.trim().length < 20) {
      out.push(`tokenResponses ${r.file}: file, fields and a reason are required`);
    }
    if (!/^app\/api\/agent\//.test(r.file)) {
      out.push(
        `tokenResponses ${r.file}: only a machine-client route (app/api/agent/) may answer a token`
      );
    }
    if (!existsSync(join(ROOT, r.file)))
      out.push(`tokenResponses ${r.file}: no such file`);
  }
  return out;
}

export type Resolver = (from: string, specifier: string) => string | null;

/** Run-time imports of a file (type-only ones excluded), resolved to repository files. */
export function runtimeImports(
  file: string,
  text: string,
  resolve: Resolver = resolveSpecifier
): string[] {
  const sf = parse(file, text);
  const out: string[] = [];
  const add = (specifier: string) => {
    const to = resolve(file, specifier);
    if (to) out.push(to);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteralLike(n.moduleSpecifier)) {
      const clause = n.importClause;
      const typeOnly =
        clause?.isTypeOnly === true ||
        (clause !== undefined &&
          clause.name === undefined &&
          clause.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) add(n.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(n) &&
      n.moduleSpecifier &&
      ts.isStringLiteralLike(n.moduleSpecifier) &&
      !n.isTypeOnly
    ) {
      add(n.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0])
    ) {
      add(n.arguments[0].text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const isClientEntry = (file: string, text: string): boolean =>
  /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*["']use client["']/.test(text) ||
  (file.startsWith("app/") && !file.startsWith("app/api/")) ||
  file.startsWith("components/") ||
  file.startsWith("hooks/") ||
  file.startsWith("games/");

/** Every file that can run in a browser: the client entries and what they import at run time. */
export function clientScope(
  files: readonly string[],
  readFile: (rel: string) => string,
  resolve: Resolver = resolveSpecifier
): string[] {
  const known = new Set(files);
  const seen = new Set<string>();
  const queue = files.filter((f) => isClientEntry(f, readFile(f)));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !known.has(file)) continue;
    seen.add(file);
    queue.push(...runtimeImports(file, readFile(file), resolve));
  }
  return [...seen].sort();
}

const loadRegister = (): Register =>
  JSON.parse(read("client-credential-register.json")) as Register;

describe("no credential where page script can read it (ADR-057, SEC-016)", () => {
  const sources = productionSources();
  const register = loadRegister();

  it("finds the sources and the client scope (self-test)", () => {
    expect(sources.length).toBeGreaterThan(100);
    const scope = clientScope(sources, read);
    for (const f of [
      "platform/auth/context.tsx",
      "platform/auth/api-fetch.ts",
      "platform/auth/browser-auth-provider.ts",
      LEGACY_CLEANUP,
      "components/auth/AuthPage.tsx",
    ]) {
      expect(scope).toContain(f);
    }
    // Server-only code is not in it: the session vault never reaches a browser bundle.
    expect(scope).not.toContain("platform/auth/session-vault.ts");
    expect(scope).not.toContain("platform/auth/session.ts");
    expect(scope).not.toContain("platform/auth/cognito-provider.ts");
  });

  it("the register names no credential, and every entry is a real file with a reason", () => {
    expect(registerFindings(register)).toEqual([]);
  });

  it("no production source keeps anything in browser storage beyond the register", () => {
    expect(sources.flatMap((f) => storageFindings(f, read(f), register))).toEqual([]);
  });

  it("no production source reads or writes document.cookie, and every cookie set is HttpOnly", () => {
    expect(sources.flatMap((f) => cookieFindings(f, read(f)))).toEqual([]);
  });

  it("no client code touches a token, an Authorization header or a bearer credential", () => {
    expect(clientScope(sources, read).flatMap((f) => bodyFindings(f, read(f)))).toEqual(
      []
    );
  });

  it("no response body carries a token beyond the register's machine credentials", () => {
    const server = sources.filter(
      (f) => f.startsWith("app/api/") || f.startsWith("platform/") || f.startsWith("lib/")
    );
    expect(server.flatMap((f) => responseFindings(f, read(f), register))).toEqual([]);
  });

  it("the legacy cleanup names exactly the keys a pre-ADR-057 sign-in left, and only removes", () => {
    const text = read(LEGACY_CLEANUP);
    expect(text).toMatch(/"pf_access_token", "pf_refresh_token", "pf_user"/);
    expect(text).not.toMatch(/\.getItem\(|\.setItem\(/);
  });

  const none: Register = { storageKeys: [], tokenResponses: [] };

  it("[self-test] storage: finds a token kept in localStorage, sessionStorage and indexedDB, by any spelling", () => {
    const planted = [
      'localStorage.setItem("pf_access_token", token);',
      'const t = window.localStorage.getItem("pf_access_token");',
      "sessionStorage.setItem(KEY, value);",
      "const db = indexedDB.open('auth');",
      "const s = globalThis.localStorage;",
      "// localStorage.setItem('x', 'y')",
      "const note = 'localStorage';",
      "interface X { localStorage: string }",
    ].join("\n");
    expect(storageFindings("planted.ts", planted, none)).toEqual([
      'planted.ts:1: localStorage.setItem("pf_access_token") — not in client-credential-register.json',
      'planted.ts:2: localStorage.getItem("pf_access_token") — not in client-credential-register.json',
      "planted.ts:3: sessionStorage.setItem with a key that is not a string constant",
      "planted.ts:4: indexedDB",
      "planted.ts:5: localStorage used other than by getItem/setItem/removeItem",
    ]);
  });

  it("[self-test] storage: a registered key is allowed only through its constant, in its file", () => {
    const reg: Register = {
      storageKeys: [
        {
          file: "hooks/a.ts",
          key: "app_view",
          holds: "which tab is open",
          reason: "a display preference; grants nothing",
        },
      ],
      tokenResponses: [],
    };
    const ok =
      'const KEY = "app_view";\nlocalStorage.setItem(KEY, v);\nlocalStorage.getItem("app_view");';
    expect(storageFindings("hooks/a.ts", ok, reg)).toEqual([]);
    expect(storageFindings("hooks/b.ts", ok, reg)).toHaveLength(2);
    expect(
      storageFindings("hooks/a.ts", 'localStorage.setItem("other", v);', reg)
    ).toEqual([
      'hooks/a.ts:1: localStorage.setItem("other") — not in client-credential-register.json',
    ]);
  });

  it("[self-test] storage: the legacy cleanup may remove, and nothing else", () => {
    const removes =
      "const storage = window.localStorage;\nstorage.removeItem('pf_access_token');\nstorage.key(0);\nstorage.length;";
    expect(storageFindings(LEGACY_CLEANUP, removes, none)).toEqual([]);
    const reads =
      "const storage = window.localStorage;\nconst t = storage.getItem('pf_access_token');\nlocalStorage.setItem('a', 'b');";
    expect(storageFindings(LEGACY_CLEANUP, reads, none)).toEqual([
      `${LEGACY_CLEANUP}:3: localStorage.setItem — the cleanup may only remove`,
      `${LEGACY_CLEANUP}:2: storage.getItem — the cleanup may only remove`,
    ]);
  });

  it("[self-test] register: refuses a key or holding that names a credential, an entry without a reason, and a token answered by a user route", () => {
    const bad: Register = {
      storageKeys: [
        {
          file: "proxy.ts",
          key: "pf_access_token",
          holds: "the session",
          reason: "it is convenient to keep it here",
        },
        {
          file: "proxy.ts",
          key: "prefs",
          holds: "the user's API key",
          reason: "it is convenient to keep it here",
        },
        { file: "proxy.ts", key: "view", holds: "a tab", reason: "short" },
      ],
      tokenResponses: [
        {
          file: "app/api/auth/sign-in/route.ts",
          fields: ["accessToken"],
          reason: "the browser wants it back please",
        },
      ],
    };
    expect(registerFindings(bad)).toEqual([
      "storageKeys proxy.ts:pf_access_token: names a credential — never in browser storage",
      "storageKeys proxy.ts:prefs: names a credential — never in browser storage",
      "storageKeys proxy.ts:view: file, key, holds and a reason are required",
      "tokenResponses app/api/auth/sign-in/route.ts: only a machine-client route (app/api/agent/) may answer a token",
    ]);
  });

  it("[self-test] cookies: finds document.cookie and a script-readable cookie; not a clearing, nor an HttpOnly one", () => {
    const planted = [
      "document.cookie = 'pf_has_session=true; path=/';",
      "const c = window.document.cookie;",
      'response.cookies.set("s", id, { httpOnly: false, path: "/" });',
      'response.cookies.set("s", id, { path: "/" });',
      'response.cookies.set("s", id, { httpOnly: flag });',
      'response.cookies.set("s", "", { httpOnly: false, maxAge: 0 });',
      'response.cookies.set("s", id, { httpOnly: true, secure: true });',
      "// document.cookie",
      "const doc = { cookie: 1 }; doc.cookie;",
    ].join("\n");
    expect(cookieFindings("planted.ts", planted)).toEqual([
      "planted.ts:1: document.cookie",
      "planted.ts:2: document.cookie",
      "planted.ts:3: a cookie set without httpOnly: true",
      "planted.ts:4: a cookie set without httpOnly: true",
      "planted.ts:5: a cookie set without httpOnly: true",
    ]);
  });

  it("[self-test] bodies: finds a token read from a response, sent in a header, destructured or built; not a type, a comment or the forgery token", () => {
    const planted = [
      "const a = data.accessToken;",
      'const b = data["refresh_token"];',
      "const { idToken } = await res.json();",
      "const { token: guestToken } = result;",
      "setSession({ accessToken: r.x, userId });",
      "fetch(url, { headers: { Authorization: `Bearer ${t}` } });",
      'headers.set("Authorization", value);',
      'const h = "Bearer " + t;',
      "interface R { accessToken: string }",
      "type T = { token: string };",
      "// data.accessToken",
      "const c = data.csrfToken; const m = result.mfaSession; const n = usage.maxTokens;",
      "function f(_accessToken: string) {}",
      "const provider = { refreshToken: async (_t: string) => null, token: () => 1 };",
    ].join("\n");
    expect(bodyFindings("planted.tsx", planted)).toEqual([
      "planted.tsx:1: .accessToken",
      'planted.tsx:2: ["refresh_token"]',
      "planted.tsx:3: { idToken } destructured",
      "planted.tsx:4: { token } destructured",
      "planted.tsx:5: { accessToken }",
      "planted.tsx:6: an Authorization header",
      'planted.tsx:6: "Bearer …"',
      "planted.tsx:7: an Authorization header",
      'planted.tsx:8: "Bearer …"',
    ]);
  });

  it("[self-test] responses: finds a token in a response body, nested or spread beside; allows a registered machine credential", () => {
    const planted = [
      "return NextResponse.json({ success: true, accessToken });",
      "return NextResponse.json({ session: { refresh_token: r } }, { status: 200 });",
      "return new Response(JSON.stringify({ token: t }), { status: 200 });",
      "return Response.json({ id_token: x });",
      "return NextResponse.json({ success: true, csrfToken, userId });",
      "const internal = { accessToken: a };",
    ].join("\n");
    expect(responseFindings("app/api/x/route.ts", planted, none)).toEqual([
      'app/api/x/route.ts:1: a response body with "accessToken"',
      'app/api/x/route.ts:2: a response body with "refresh_token"',
      'app/api/x/route.ts:3: a response body with "token"',
      'app/api/x/route.ts:4: a response body with "id_token"',
    ]);
    const reg: Register = {
      storageKeys: [],
      tokenResponses: [
        {
          file: "app/api/agent/t/route.ts",
          fields: ["token"],
          reason: "an agent's delegation token, to the agent",
        },
      ],
    };
    const agent = "return NextResponse.json({ token: t, accessToken: a });";
    expect(responseFindings("app/api/agent/t/route.ts", agent, reg)).toEqual([
      'app/api/agent/t/route.ts:1: a response body with "accessToken"',
    ]);
  });

  it("[self-test] scope: a file a client component imports at run time is client code; a type-only import is not", () => {
    const files: Record<string, string> = {
      "components/A.tsx":
        '"use client";\nimport { b } from "@/lib/b";\nimport type { S } from "@/platform/server";\nimport { type T } from "@/platform/types-only";',
      "lib/b.ts": 'import { c } from "./c";\nexport const b = c;',
      "lib/c.ts": "export const c = 1;",
      "platform/server.ts": "export interface S { accessToken: string }",
      "platform/types-only.ts": "export type T = string;",
      "lib/widget.tsx": "/** header */\n'use client';\nexport const w = 1;",
      "app/api/x/route.ts": "export const GET = 1;",
      "app/page.tsx": 'import { d } from "@/lib/d";',
      "lib/d.ts": "export const d = 1;",
    };
    // The planted tree's own resolver: `@/x` and `./x` to the planted file names.
    const resolve: Resolver = (from, specifier) => {
      const base = specifier.startsWith("@/")
        ? specifier.slice(2)
        : specifier.startsWith("./")
          ? `${from.slice(0, from.lastIndexOf("/"))}/${specifier.slice(2)}`
          : null;
      if (base === null) return null;
      return [`${base}.ts`, `${base}.tsx`].find((f) => f in files) ?? null;
    };
    expect(clientScope(Object.keys(files), (f) => files[f], resolve)).toEqual([
      "app/page.tsx",
      "components/A.tsx",
      "lib/b.ts",
      "lib/c.ts",
      "lib/d.ts",
      "lib/widget.tsx",
    ]);
  });
});
