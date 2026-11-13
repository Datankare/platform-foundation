/**
 * __tests__/user-route-credentials.test.ts — a user route accepts only the cookie session
 * (ADR-057 D8, TASK-214)
 *
 * @guard production code that reads a request's Authorization header outside the registered machine-credential readers
 *
 * Before ADR-057 every route took the user's access token as `Authorization: Bearer`, which is
 * why the token had to be where page script could read it (SEC-016). A user is now authenticated
 * by the server-side session its HttpOnly cookie names, and by nothing else: the guards
 * (platform/auth/middleware.ts) do not read the header. A bearer credential is a machine's — the
 * jobs tick's secret, an agent's own credential — and each file that reads one is registered in
 * client-credential-register.json (`bearerReaders`: the file, the credential, why a machine
 * presents it). This guard fails when:
 *
 *   - any other production source reads the header: `headers.get("authorization")` (any case),
 *     `headers["authorization"]`, a destructured `authorization`, or parses "Bearer …" out of a
 *     value (`startsWith("Bearer ")`, a /^Bearer / pattern, `.replace("Bearer ", …)`);
 *   - a registered reader's entry is missing, stale (the file no longer reads it), or describes a
 *     user's credential (a session, an access token, a user's token);
 *   - the user guards themselves read it.
 *
 * Sending a bearer to another service (the cache's REST API, a signed AWS call) is not reading
 * one: an Authorization property written in an object literal or assigned to is ignored.
 * Parsed with TypeScript's parser — a mention in a comment is not a read. The register is per
 * repository; the scan is shared.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { productionSources, read, ROOT } from "./helpers/route-policy";

interface BearerReader {
  readonly file: string;
  readonly credential: string;
  readonly reason: string;
}

const REGISTER = "client-credential-register.json";
export function bearerReaders(): BearerReader[] {
  const register = JSON.parse(readFileSync(join(ROOT, REGISTER), "utf8")) as {
    bearerReaders?: BearerReader[];
  };
  return register.bearerReaders ?? [];
}

/** The guards every user route authenticates through: they never read a bearer. */
export const USER_GUARDS = ["platform/auth/middleware.ts", "platform/auth/session.ts"];

/** What an entry may never describe: a user's credential. */
const USER_CREDENTIAL =
  /\b(?:user'?s?|session|access[\s-]?token|id[\s-]?token|refresh[\s-]?token|cognito token)\b/i;

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

const isAuthorization = (s: string) => s.toLowerCase() === "authorization";
const BEARER_PREFIX = /^bearer\s/i;

/** The lines on which `text` reads an Authorization header or parses a bearer value. */
export function bearerReads(
  file: string,
  text: string
): { line: number; what: string }[] {
  const sf = parse(file, text);
  const out: { line: number; what: string }[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      const first = n.arguments[0];
      if (
        (method === "get" || method === "has") &&
        first &&
        ts.isStringLiteralLike(first) &&
        isAuthorization(first.text)
      ) {
        out.push({ line: at(n), what: `headers.${method}("${first.text}")` });
      }
      if (
        [
          "startsWith",
          "replace",
          "split",
          "slice",
          "match",
          "indexOf",
          "includes",
        ].includes(method) &&
        first &&
        ts.isStringLiteralLike(first) &&
        BEARER_PREFIX.test(first.text)
      ) {
        out.push({
          line: at(n),
          what: `parses a bearer value (.${method}("${first.text}"))`,
        });
      }
    }
    if (ts.isRegularExpressionLiteral(n) && /^\/\^?\\?b?bearer\b/i.test(n.text)) {
      out.push({ line: at(n), what: `parses a bearer value (${n.text})` });
    }
    if (
      ts.isElementAccessExpression(n) &&
      ts.isStringLiteralLike(n.argumentExpression) &&
      isAuthorization(n.argumentExpression.text)
    ) {
      const p = n.parent;
      const written =
        ts.isBinaryExpression(p) &&
        p.left === n &&
        p.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      if (!written) out.push({ line: at(n), what: 'reads ["authorization"]' });
    }
    if (
      ts.isPropertyAccessExpression(n) &&
      isAuthorization(n.name.text) &&
      /headers?$/i.test(n.expression.getText(sf))
    ) {
      const p = n.parent;
      const written =
        ts.isBinaryExpression(p) &&
        p.left === n &&
        p.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      if (!written) out.push({ line: at(n), what: "reads headers.authorization" });
    }
    if (ts.isBindingElement(n)) {
      const name = n.propertyName ?? n.name;
      if (
        (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
        isAuthorization(name.text) &&
        ts.isObjectBindingPattern(n.parent)
      ) {
        out.push({ line: at(n), what: "destructures authorization" });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** What is wrong with the register's entries, given which files read a bearer. */
export function registerProblems(
  entries: readonly BearerReader[],
  readers: ReadonlySet<string>,
  exists: (file: string) => boolean
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.file)) problems.push(`${e.file}: listed twice`);
    seen.add(e.file);
    if (!exists(e.file)) problems.push(`${e.file}: no such file`);
    else if (!readers.has(e.file))
      problems.push(`${e.file}: reads no bearer — remove the entry`);
    if (!e.credential?.trim() || !e.reason?.trim() || e.reason.trim().length < 40) {
      problems.push(
        `${e.file}: needs the credential it takes and why a machine presents it`
      );
    }
    if (USER_CREDENTIAL.test(e.credential ?? "")) {
      problems.push(`${e.file}: a user's credential is never a bearer (ADR-057 D8)`);
    }
    if (USER_GUARDS.includes(e.file)) {
      problems.push(`${e.file}: the user guards never read a bearer`);
    }
  }
  return problems;
}

describe("a user route accepts only the cookie session (ADR-057 D8)", () => {
  const sources = productionSources().filter((f) => /\.(?:tsx?|mjs|js)$/.test(f));
  const reads = new Map<string, { line: number; what: string }[]>();
  for (const f of sources) {
    const found = bearerReads(f, read(f));
    if (found.length > 0) reads.set(f, found);
  }
  const registered = bearerReaders();

  it("scans the production sources, the guards and every API route among them", () => {
    expect(sources.length).toBeGreaterThan(100);
    for (const f of USER_GUARDS) expect(sources).toContain(f);
    expect(
      sources.filter((f) => /^app\/api\/.*\/route\.ts$/.test(f)).length
    ).toBeGreaterThan(20);
  });

  it("only a registered machine-credential reader reads an Authorization header", () => {
    const allowed = new Set(registered.map((e) => e.file));
    const unregistered = [...reads]
      .filter(([f]) => !allowed.has(f))
      .flatMap(([f, found]) => found.map((r) => `${f}:${r.line} ${r.what}`));
    expect(unregistered).toEqual([]);
  });

  it("the user guards do not read one", () => {
    for (const f of USER_GUARDS)
      expect({ file: f, reads: reads.get(f) ?? [] }).toEqual({ file: f, reads: [] });
  });

  it("every registered reader exists, still reads one, and names a machine's credential", () => {
    expect(
      registerProblems(registered, new Set(reads.keys()), (f) =>
        existsSync(join(ROOT, f))
      )
    ).toEqual([]);
  });

  it("the jobs tick and the page proxy are the platform's own readers", () => {
    const files = registered.map((e) => e.file);
    expect(files).toEqual(
      expect.arrayContaining(["platform/jobs/tick-auth.ts", "proxy.ts"])
    );
  });

  describe("the scan itself", () => {
    const whats = (text: string) =>
      bearerReads("app/api/x/route.ts", text).map((r) => r.what);

    it("[self-test] sees every way a route could read the header", () => {
      expect(whats('const h = request.headers.get("Authorization");')).toHaveLength(1);
      expect(whats('const h = request.headers.get("authorization");')).toHaveLength(1);
      expect(whats('if (request.headers.has("AUTHORIZATION")) {}')).toHaveLength(1);
      expect(whats('const h = headers["authorization"];')).toHaveLength(1);
      expect(whats("const h = req.headers.authorization;")).toHaveLength(1);
      expect(whats("const { authorization } = headers;")).toHaveLength(1);
      expect(whats("const { Authorization: a } = headers;")).toHaveLength(1);
      expect(
        whats('const t = value.startsWith("Bearer ") ? value.slice(7) : null;')
      ).toHaveLength(1);
      expect(whats("const m = /^Bearer (\\S+)$/.exec(value);")).toHaveLength(1);
      expect(whats('const t = value.replace("Bearer ", "");')).toHaveLength(1);
    });

    it("[self-test] does not take sending a bearer, or a mention, for reading one", () => {
      expect(
        whats("fetch(url, { headers: { Authorization: `Bearer ${token}` } });")
      ).toEqual([]);
      expect(whats('out["authorization"] = signature;')).toEqual([]);
      expect(whats("headers.authorization = `Bearer ${key}`;")).toEqual([]);
      expect(
        whats('// reads request.headers.get("authorization")\nconst a = 1;')
      ).toEqual([]);
      expect(whats('const note = "send Authorization: Bearer <secret>";')).toEqual([]);
      expect(whats('const c = request.headers.get("cookie");')).toEqual([]);
    });

    it("[self-test] refuses a register entry that is stale, missing, thin, or a user's credential", () => {
      const ok: BearerReader = {
        file: "platform/jobs/tick-auth.ts",
        credential: "CRON_SECRET",
        reason: "The scheduler is a machine with no browser and no cookie at all.",
      };
      const readers = new Set([ok.file]);
      const exists = (f: string) => f !== "gone.ts";
      expect(registerProblems([ok], readers, exists)).toEqual([]);
      expect(registerProblems([ok, ok], readers, exists)).toEqual([
        "platform/jobs/tick-auth.ts: listed twice",
      ]);
      expect(registerProblems([{ ...ok, file: "gone.ts" }], readers, exists)[0]).toMatch(
        /no such file/
      );
      expect(
        registerProblems([{ ...ok, file: "lib/quiet.ts" }], readers, exists)[0]
      ).toMatch(/reads no bearer/);
      expect(
        registerProblems([{ ...ok, reason: "machines" }], readers, exists)[0]
      ).toMatch(/needs the credential/);
      expect(
        registerProblems(
          [{ ...ok, credential: "the user's access token" }],
          readers,
          exists
        )[0]
      ).toMatch(/never a bearer/);
      expect(
        registerProblems(
          [{ ...ok, file: "platform/auth/middleware.ts" }],
          new Set(["platform/auth/middleware.ts"]),
          exists
        )
      ).toContain("platform/auth/middleware.ts: the user guards never read a bearer");
    });
  });
});
