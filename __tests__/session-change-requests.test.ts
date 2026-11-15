/**
 * __tests__/session-change-requests.test.ts — every state-changing request a page sends to this
 * origin waits for the session read and carries its token (TASK-219)
 *
 * @guard a browser request that changes state on this origin outside apiFetch and the auth context's sessionChange
 *
 * The server refuses a state-changing request without the session's forgery token
 * (`x-csrf-token`, ADR-057 D4). apiFetch waits for the page's read of its session before such a
 * request, sends the token, and on `auth.csrf_failed` reads the session again and sends once more;
 * the auth context sends its own (sign out, sign out everywhere, stay signed in) through
 * `sessionChange`, which does the same. The auth context's sign-out used to send the token only
 * when the page had already read it: the console's Sign out, clicked while that read was still
 * under way, was refused 403 and the page showed sign-in with the session still live (Playform's
 * Deploy smoke run 43722206512, Journey B).
 *
 * This scan reads, with the TypeScript parser, every module that can run in the browser — app/
 * (not its API routes), components/, hooks/, lib/, platform/, shared/, games/ — and finds each
 * request made without those paths: a call of the global `fetch` (`fetch`, `window.fetch`,
 * `globalThis.fetch`, `self.fetch`), of `fetchWithTimeout`, or `navigator.sendBeacon` (which can
 * send no header at all). Such a request is a finding when it may change state on this origin:
 *
 *   - its method is not read as GET, HEAD or OPTIONS (sendBeacon is a POST), and
 *   - its address is a path on this origin ("/…" — written, a const, or a template), or, in a
 *     module that runs in the browser ("use client", under app/, components/, hooks/, or one that
 *     imports the page's session, platform/auth/context), an address the scan cannot read.
 *
 * A request to another origin (an address read as "https://…", or a template that starts with a
 * base URL in a server module) is not this origin's and not checked. Each finding names the file,
 * the line and the address as written; SITES lists the sites that are the paths themselves, or
 * that have no session to send (each with why) — by file, the function they are made in and the
 * address, so another function sending to the same address is not covered by an entry — and an
 * entry that names nothing is a finding.
 */
import { readFileSync } from "fs";
import { join, relative, sep } from "path";
import * as ts from "typescript";
import { walkFiles } from "./helpers/repo-files";

const ROOT = join(__dirname, "..");

const DIRS = ["app", "components", "hooks", "lib", "platform", "shared", "games"];

/**
 * The sites allowed to send a state-changing request themselves, by `<file>: <address as
 * written>`: the two paths, and requests made where no session exists yet to wait for.
 */
export const SITES: Readonly<Record<string, string>> = {
  "platform/auth/api-fetch.ts apiFetch(): input":
    "apiFetch itself: waits for the session read (sessionForChange), sends the token, re-reads and sends once more on auth.csrf_failed",
  "platform/auth/context.tsx sessionChange.send(): path":
    "the auth context's sessionChange: the same wait, token and one re-read on auth.csrf_failed, for sign out, sign out everywhere and stay signed in",
  'platform/auth/context.tsx firstLoad(): "/api/auth/session/migrate"':
    "a browser signed in before ADR-057 has no server session yet — this is the request that makes one; the server's origin check is its defence (ADR-057 D4: routes with no session)",
};

/** An app's own sites (sync-excluded), merged in when the file exists. */
const APP_SITES_FILE = "__tests__/session-change-requests.app.json";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export interface SourceText {
  readonly file: string;
  readonly text: string;
}

export interface Finding {
  readonly file: string;
  readonly line: number;
  /** The address as written. */
  readonly address: string;
  /** The named functions it is made in, outermost first ("sessionChange.send"), or "". */
  readonly within: string;
  readonly method: string | null;
}

/** Whether a module runs in the browser for certain: "use client", or a screen directory. */
function browserModule(file: string, sf: ts.SourceFile): boolean {
  const first = sf.statements[0];
  const directive =
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use client";
  // A module that holds the page's session runs in the browser too.
  const session = sf.statements.some(
    (st) =>
      ts.isImportDeclaration(st) &&
      ts.isStringLiteral(st.moduleSpecifier) &&
      /(?:^\.\/|platform\/auth\/)context$/.test(st.moduleSpecifier.text)
  );
  return (
    directive ||
    session ||
    /^(?:components|hooks)\//.test(file) ||
    /^app\/(?!api\/)/.test(file)
  );
}

/** The const initializer `name` names in this file, if any. */
function constOf(sf: ts.SourceFile, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer &&
      ts.isVariableDeclarationList(n.parent) &&
      (n.parent.flags & ts.NodeFlags.Const) !== 0
    )
      found = n.initializer;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** The start of an address as written: "/…" (this origin), "https://…" (another), or unknown. */
function addressStart(sf: ts.SourceFile, e: ts.Expression, depth = 0): string | null {
  const x = ts.isParenthesizedExpression(e) || ts.isAsExpression(e) ? e.expression : e;
  if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return x.text;
  if (ts.isTemplateExpression(x)) return x.head.text === "" ? null : x.head.text;
  if (ts.isIdentifier(x) && depth < 4) {
    const init = constOf(sf, x.text);
    return init ? addressStart(sf, init, depth + 1) : null;
  }
  return null;
}

/** The method an init gives: its `method` read as a string, GET when it gives none, else null. */
function methodOf(sf: ts.SourceFile, init: ts.Expression | undefined): string | null {
  if (!init) return "GET";
  if (!ts.isObjectLiteralExpression(init)) return null;
  const prop = init.properties.find(
    (p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === "method"
  );
  if (!prop) return init.properties.some(ts.isSpreadAssignment) ? null : "GET";
  if (!ts.isPropertyAssignment(prop)) return null;
  const v = prop.initializer;
  if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v))
    return v.text.toUpperCase();
  if (ts.isIdentifier(v)) {
    const c = constOf(sf, v.text);
    if (c && (ts.isStringLiteral(c) || ts.isNoSubstitutionTemplateLiteral(c)))
      return c.text.toUpperCase();
  }
  return null;
}

/** The names of the functions a node is in, outermost first, joined by "." ("" at top level). */
function enclosingNames(n: ts.Node): string {
  const names: string[] = [];
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) names.unshift(p.name.text);
    else if (
      (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) &&
      ts.isVariableDeclaration(p.parent) &&
      ts.isIdentifier(p.parent.name)
    )
      names.unshift(p.parent.name.text);
    else if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name))
      names.unshift(p.name.text);
  }
  return names.join(".");
}

/** A site as SITES names it: `<file> <function>(): <address as written>`, or `<file>: <address>`. */
export function siteKey(f: Finding): string {
  return `${f.file}${f.within ? ` ${f.within}()` : ""}: ${f.address}`;
}

/** Each request in `sources` that may change state on this origin, outside the paths. */
export function changeRequests(sources: readonly SourceText[]): Finding[] {
  const out: Finding[] = [];
  for (const { file, text } of sources) {
    const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const browser = browserModule(file, sf);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.arguments.length > 0) {
        const callee = n.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee) &&
              ts.isIdentifier(callee.expression) &&
              ["window", "globalThis", "self", "navigator"].includes(
                callee.expression.text
              )
            ? callee.name.text
            : null;
        const beacon = name === "sendBeacon";
        if (name === "fetch" || name === "fetchWithTimeout" || beacon) {
          const method = beacon ? "POST" : methodOf(sf, n.arguments[1]);
          const start = addressStart(sf, n.arguments[0]);
          const thisOrigin =
            start !== null && start.startsWith("/") && !start.startsWith("//");
          const otherOrigin = start !== null && !thisOrigin;
          const changing = method === null || !SAFE.has(method);
          if (changing && !otherOrigin && (thisOrigin || browser))
            out.push({
              file,
              line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
              address: n.arguments[0].getText(sf),
              within: enclosingNames(n),
              method,
            });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** The findings no site allows, and the sites that allow nothing. */
export function sessionChangeProblems(
  sources: readonly SourceText[],
  sites: Readonly<Record<string, string>> = SITES
): string[] {
  const found = changeRequests(sources);
  const out: string[] = [];
  const used = new Set<string>();
  for (const f of found) {
    const key = siteKey(f);
    if (key in sites) {
      used.add(key);
      continue;
    }
    out.push(
      `${f.file}:${f.line}: ${f.method ?? "a method the scan cannot read"} ${f.address} — a request that changes state is sent with apiFetch (or the auth context's sessionChange), which waits for the session read and sends its token; or list it in SITES with why it has no session to send`
    );
  }
  for (const key of Object.keys(sites))
    if (!used.has(key)) out.push(`SITES "${key}": names no request — remove it`);
  return out;
}

function repoSources(): SourceText[] {
  return DIRS.flatMap((d) =>
    walkFiles(
      join(ROOT, d),
      (n) => /\.(?:ts|tsx|js|mjs)$/.test(n) && !/\.test\.tsx?$/.test(n)
    )
  )
    .map((p) => relative(ROOT, p).split(sep).join("/"))
    .filter((f) => !f.startsWith("app/api/") && !/(?:^|\/)__tests__\//.test(f))
    .map((file) => ({ file, text: readFileSync(join(ROOT, file), "utf8") }));
}

function repoSites(): Record<string, string> {
  let app: Record<string, string> = {};
  try {
    app = JSON.parse(readFileSync(join(ROOT, APP_SITES_FILE), "utf8")) as Record<
      string,
      string
    >;
  } catch {
    /* justified */
    // No app sites: platform-foundation itself.
  }
  return { ...SITES, ...app };
}

describe("every state-changing request to this origin waits for the session and sends its token (TASK-219)", () => {
  it("reads the browser modules' requests", () => {
    const found = changeRequests(repoSources());
    expect(found.map(siteKey)).toEqual(expect.arrayContaining(Object.keys(SITES)));
  });

  it("none outside apiFetch and sessionChange, but the listed sites", () => {
    expect(sessionChangeProblems(repoSources(), repoSites())).toEqual([]);
  });
});

describe("the session-change scan's self-tests (TASK-219)", () => {
  it("[self-test] the pre-TASK-219 sign-out — a raw POST with the token only if already read — is found; apiFetch is not", () => {
    const before: SourceText = {
      file: "platform/auth/context.tsx",
      text: [
        '"use client";',
        "async function post(path: string) {",
        '  await fetch(path, { method: "POST", credentials: "same-origin" });',
        "}",
        "async function everywhere() {",
        '  await fetch("/api/auth/sign-out-everywhere", { method: "POST" });',
        "}",
        'function ask(method: "GET" | "POST") { return fetch("/api/auth/session", { method }); }',
        'void apiFetch("/api/admin/users/search", { method: "POST" });',
        'void fetch("/api/features");',
        'void fetch("https://example.com/x", { method: "POST" });',
      ].join("\n"),
    };
    // A site is its function's: the old post() sent to `path` too, and sessionChange's entry does not
    // cover it.
    expect(changeRequests([before]).map(siteKey)).toEqual([
      "platform/auth/context.tsx post(): path",
      'platform/auth/context.tsx everywhere(): "/api/auth/sign-out-everywhere"',
      'platform/auth/context.tsx ask(): "/api/auth/session"',
    ]);
    expect(sessionChangeProblems([before], {})).toEqual([
      expect.stringMatching(/^platform\/auth\/context\.tsx:3: POST path — /),
      expect.stringMatching(
        /^platform\/auth\/context\.tsx:6: POST "\/api\/auth\/sign-out-everywhere" — /
      ),
      expect.stringMatching(
        /^platform\/auth\/context\.tsx:8: a method the scan cannot read "\/api\/auth\/session" — /
      ),
    ]);
  });

  it("[self-test] a beacon, a const path, a spread init and an unreadable address in a screen are found; a server module's unreadable address is not", () => {
    const screen: SourceText = {
      file: "components/X.tsx",
      text: [
        'const PATH = "/api/x";',
        'navigator.sendBeacon("/api/metrics", body);',
        "void fetch(PATH, { ...init });",
        'void window.fetch(url, { method: "DELETE" });',
        'void fetchWithTimeout(PATH, { method: "PUT" });',
      ].join("\n"),
    };
    const server: SourceText = {
      file: "platform/ai/provider.ts",
      text: 'void fetchWithTimeout(`${this.baseUrl}/v1/messages`, { method: "POST" });\nvoid fetch(endpoint, { method: "POST" });',
    };
    expect(
      changeRequests([screen, server]).map((f) => `${f.line} ${f.method} ${f.address}`)
    ).toEqual(['2 POST "/api/metrics"', "3 null PATH", "4 DELETE url", "5 PUT PATH"]);
  });

  it("[self-test] a listed site is allowed; a site that names nothing is a finding", () => {
    const src: SourceText = {
      file: "lib/guest.ts",
      text: 'void fetch("/api/auth/guest", { method: "POST" });',
    };
    expect(
      sessionChangeProblems([src], { 'lib/guest.ts: "/api/auth/guest"': "planted" })
    ).toEqual([]);
    expect(sessionChangeProblems([], { "lib/gone.ts: x": "planted" })).toEqual([
      'SITES "lib/gone.ts: x": names no request — remove it',
    ]);
  });
});
