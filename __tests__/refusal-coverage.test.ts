/**
 * TASK-181 — refusal coverage: every refusal a route can return is handled by every screen that
 * calls it.
 *
 * @guard a refusal code a screen that calls the route does not handle
 *
 * Statically, for this repository (a consuming app runs the same file over its own routes and
 * screens — they live in the same directories):
 *
 *   routes   app/api/**\/route.ts — the codes each can return: its own `apiError("…")` /
 *            `apiErrorBody("…")` literals, `internal.error` when it calls internalError, and the
 *            codes of every guard it calls. Guards declare their codes where they are written:
 *            a module exporting `REFUSAL_GUARDS` (function name → codes) under platform/ or lib/
 *            (platform/auth/actor-guard.ts, middleware.ts, admin-guard.ts, account-status-guard,
 *            coppa-gate, guest-allowance, platform/rate-limit/enforce.ts, platform/tenancy/…).
 *            Codes a provider maps at run time (errorFromResult, authResultResponse, and the
 *            service.unavailable internalError answers for an external dependency's failure —
 *            TASK-197) are not seen; their messages are the server's own, and service.unavailable
 *            is a platform code the shared handler decides.
 *   callers  every "/api/…" literal in app/ (not app/api), components/, hooks/ and lib/, matched
 *            to its route ([param] segments match a `${…}` segment).
 *   covered  a (caller, code) pair is covered when the caller routes refusals through the shared
 *            handler (it calls handleRefusal or readRefusal — platform/errors/refusal.ts) and the
 *            code is a platform code (REFUSAL_HANDLERS decides every one), or when the caller
 *            lists the code in its own `HANDLED_CODES` array (an app code, or a code the screen
 *            treats itself), or when the caller makes its calls through apiFetch and the code is
 *            one apiFetch handles for every caller — platform/auth/api-fetch.ts's own
 *            `HANDLED_CODES` (ADR-057: `auth.csrf_failed`, answered by reading the session again
 *            and making the call once more with its current token; a screen sees it only when
 *            that fails too, as the server's message).
 *
 * The pairs not covered today are listed in refusal-coverage-baseline.json (repository root, per
 * repository — a consumer keeps its own; it is not synced). The list may only shrink: a new gap
 * fails, and a fixed one must be removed in the same commit
 * (`UPDATE_REFUSAL_COVERAGE_BASELINE=1 npx jest __tests__/refusal-coverage.test.ts` rewrites it,
 * but only ever to a subset of what it was). The ratchet style of screen-literals-ratchet.
 *
 * It also bans the pattern behind most gaps — `if (!res.ok) return { error: "<literal>" }` in a
 * screen or hook: a refusal's code and message thrown away for fixed text.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, relative, sep } from "path";
import * as ts from "typescript";
import { REFUSAL_HANDLERS } from "@/platform/errors/refusal";

const ROOT = join(__dirname, "..");
const BASELINE_FILE = join(ROOT, "refusal-coverage-baseline.json");

function walk(dir: string, accept: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      return name === "__tests__" || name === "node_modules" || name.startsWith(".")
        ? []
        : walk(p, accept);
    }
    return accept(name) ? [p] : [];
  });
}

const isSource = (name: string) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name);
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");
const read = (p: string) => readFileSync(p, "utf8");

/** `apiError("x")` / `apiErrorBody("x")` literals, and internal.error for internalError(…). */
export function literalCodes(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(
    /\bapiError(?:Body)?\(\s*["']([a-z_]+(?:\.[a-z0-9_]+)+)["']/g
  )) {
    out.add(m[1]);
  }
  if (/\binternalError\(/.test(text)) out.add("internal.error");
  return [...out];
}

// ── Guards ──────────────────────────────────────────────────────────────────────────────────

interface GuardModule {
  readonly file: string;
  readonly guards: Readonly<Record<string, readonly string[]>>;
}

function guardModules(): GuardModule[] {
  return ["platform", "lib"]
    .flatMap((d) => walk(join(ROOT, d), isSource))
    .filter((f) => /export const REFUSAL_GUARDS\b/.test(read(f)))
    .map((file) => {
      const mod = require(file) as { REFUSAL_GUARDS: Record<string, readonly string[]> };
      return { file: rel(file), guards: mod.REFUSAL_GUARDS };
    });
}

function guardTable(modules: GuardModule[]): Map<string, readonly string[]> {
  const table = new Map<string, readonly string[]>();
  for (const m of modules) {
    for (const [name, codes] of Object.entries(m.guards)) {
      const known = table.get(name);
      table.set(name, known ? [...new Set([...known, ...codes])] : codes);
    }
  }
  return table;
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────────

interface Route {
  readonly path: string; // "/api/admin/approvals/[id]"
  readonly segments: readonly string[];
  readonly codes: readonly string[];
}

function routes(guards: Map<string, readonly string[]>): Route[] {
  const apiDir = join(ROOT, "app", "api");
  return walk(apiDir, (n) => n === "route.ts").map((file) => {
    const text = read(file);
    const codes = new Set(literalCodes(text));
    for (const [name, guardCodes] of guards) {
      if (new RegExp(`\\b${name}\\(`).test(text)) guardCodes.forEach((c) => codes.add(c));
    }
    const path =
      "/" +
      rel(file)
        .replace(/^app\//, "")
        .replace(/\/route\.ts$/, "");
    return { path, segments: path.split("/").slice(1), codes: [...codes].sort() };
  });
}

// ── Callers ─────────────────────────────────────────────────────────────────────────────────

const HOLE = "\u0000";

/** Every "/api/…" literal in a source file, `${…}` parts as HOLE. */
export function apiLiterals(text: string, name = "probe.tsx"): string[] {
  const sf = ts.createSourceFile(
    name,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    let value: string | undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      value = node.text;
    } else if (ts.isTemplateExpression(node)) {
      value =
        node.head.text + node.templateSpans.map((s) => HOLE + s.literal.text).join("");
    }
    if (value !== undefined && value.startsWith("/api/")) out.push(value);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The route a caller's literal addresses, or undefined. */
export function matchRoute<R extends { segments: readonly string[] }>(
  literal: string,
  candidates: readonly R[]
): R | undefined {
  const path = literal.split("?")[0];
  const segs = path
    .split("/")
    .slice(1)
    .filter((s, i, all) => !(s === "" && i === all.length - 1))
    // A HOLE glued to text is a query string or suffix (`review${qs}`): the text is the segment.
    .map((s) => (s === HOLE ? HOLE : s.split(HOLE)[0]));
  const dynamic = (s: string) => /^\[.+\]$/.test(s);
  const exact = candidates.find(
    (r) =>
      r.segments.length === segs.length &&
      r.segments.every((rs, i) => rs === segs[i] || (dynamic(rs) && segs[i] !== ""))
  );
  return (
    exact ??
    candidates.find(
      (r) =>
        r.segments.some((s) => s.startsWith("[...")) &&
        r.segments.every(
          (rs, i) => rs.startsWith("[...") || rs === segs[i] || dynamic(rs)
        )
    )
  );
}

/** The codes a caller lists in its own `HANDLED_CODES` array. */
export function handledCodes(text: string): string[] {
  const m = /\bHANDLED_CODES\b[^=]*=\s*(?:Object\.freeze\()?\[([^\]]*)\]/.exec(text);
  return m ? [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]) : [];
}

/** Whether a caller routes its refusals through the shared handler. */
export function usesSharedHandler(text: string): boolean {
  return /\b(?:handleRefusal|readRefusal)\(/.test(text);
}

/** The transport every screen calls the API through, and the refusals it handles itself. */
const TRANSPORT_FILE = "platform/auth/api-fetch.ts";
export function transportCodes(): string[] {
  return handledCodes(read(join(ROOT, TRANSPORT_FILE)));
}

/** Whether a caller makes its API calls through the transport (and no other way). */
export function usesTransportOnly(text: string): boolean {
  return /\bapiFetch\(/.test(text) && !/(?<![\w.])fetch\(/.test(text);
}

function callerFiles(): string[] {
  return [
    ...walk(join(ROOT, "app"), isSource).filter((f) => !rel(f).startsWith("app/api/")),
    ...["components", "hooks", "lib"].flatMap((d) => walk(join(ROOT, d), isSource)),
  ];
}

/** The (caller, route, code) pairs one caller leaves unhandled. */
export function callerGaps(
  path: string,
  text: string,
  all: readonly Route[],
  transport: readonly string[] = []
): string[] {
  const out = new Set<string>();
  const literals = apiLiterals(text, path);
  if (literals.length === 0) return [];
  const shared = usesSharedHandler(text);
  const own = new Set([
    ...handledCodes(text),
    ...(usesTransportOnly(text) ? transport : []),
  ]);
  for (const literal of literals) {
    const route = matchRoute(literal, all);
    if (!route) continue;
    for (const code of route.codes) {
      const covered =
        own.has(code) ||
        (shared && Object.prototype.hasOwnProperty.call(REFUSAL_HANDLERS, code));
      if (!covered) out.add(`${path} -> ${route.path} : ${code}`);
    }
  }
  return [...out];
}

export function gaps(): string[] {
  const all = routes(guardTable(guardModules()));
  const transport = transportCodes();
  return [
    ...new Set(callerFiles().flatMap((f) => callerGaps(rel(f), read(f), all, transport))),
  ].sort();
}

// ── The banned pattern ──────────────────────────────────────────────────────────────────────

/** `if (!x.ok) { … return { …, error: "<literal>" } }` sites in a screen or hook. */
export function literalErrorReturns(text: string, name = "probe.tsx"): number[] {
  const sf = ts.createSourceFile(
    name,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const lines: number[] = [];
  const isNotOk = (e: ts.Expression) =>
    ts.isPrefixUnaryExpression(e) &&
    e.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isPropertyAccessExpression(e.operand) &&
    e.operand.name.text === "ok";
  const literalError = (r: ts.Statement) =>
    ts.isReturnStatement(r) &&
    !!r.expression &&
    ts.isObjectLiteralExpression(r.expression) &&
    r.expression.properties.some(
      (p) =>
        ts.isPropertyAssignment(p) &&
        p.name.getText(sf) === "error" &&
        (ts.isStringLiteral(p.initializer) ||
          ts.isNoSubstitutionTemplateLiteral(p.initializer))
    );
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && isNotOk(node.expression)) {
      const body = ts.isBlock(node.thenStatement)
        ? node.thenStatement.statements
        : [node.thenStatement];
      if (body.some(literalError)) {
        lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

// ── Tests ───────────────────────────────────────────────────────────────────────────────────

describe("refusal coverage (TASK-181)", () => {
  const current = gaps();

  it("every (caller, code) gap is in the baseline, and the baseline holds no fixed gap", () => {
    const baseline = JSON.parse(read(BASELINE_FILE)) as { gaps: string[] };
    if (process.env.UPDATE_REFUSAL_COVERAGE_BASELINE === "1") {
      const added = current.filter((g) => !baseline.gaps.includes(g));
      expect({ added }).toEqual({ added: [] }); // the baseline only ever shrinks
      writeFileSync(
        BASELINE_FILE,
        JSON.stringify({ ...baseline, count: current.length, gaps: current }, null, 2) +
          "\n"
      );
      return;
    }
    const added = current.filter((g) => !baseline.gaps.includes(g));
    const fixed = baseline.gaps.filter((g) => !current.includes(g));
    expect({ added, fixed }).toEqual({ added: [], fixed: [] });
  });

  it("each guard module lists every code it returns itself", () => {
    const modules = guardModules();
    expect(modules.length).toBeGreaterThanOrEqual(8);
    const unlisted = modules.flatMap((m) => {
      const listed = new Set(Object.values(m.guards).flat());
      return literalCodes(read(join(ROOT, m.file)))
        .filter((c) => c !== "internal.error" && !listed.has(c))
        .map((c) => `${m.file}: ${c}`);
    });
    expect(unlisted).toEqual([]);
  });

  it("finds the routes, the guards behind them and their callers (self-test)", () => {
    const all = routes(guardTable(guardModules()));
    expect(all.length).toBeGreaterThan(40);
    const session = all.find((r) => r.path === "/api/admin/session");
    expect(session?.codes).toEqual(
      expect.arrayContaining([
        "auth.permission_denied",
        "account.restricted",
        "rate.limited",
      ])
    );
    expect(matchRoute("/api/admin/approvals/\u0000", all)?.path).toBe(
      "/api/admin/approvals/[id]"
    );
    expect(matchRoute("/api/moderation/review\u0000", all)?.path).toBe(
      "/api/moderation/review"
    );
    expect(matchRoute("/api/no/such/route", all)).toBeUndefined();
    expect(
      apiLiterals('const a = apiFetch(`/api/x/${id}?q=1`); fetch("/api/y"); "/other";')
    ).toEqual(["/api/x/\u0000?q=1", "/api/y"]);
    expect(handledCodes('const HANDLED_CODES = ["a.b", "app.c.d"] as const;')).toEqual([
      "a.b",
      "app.c.d",
    ]);
    expect(usesSharedHandler("const r = await readRefusal(res);")).toBe(true);
  });

  it("no screen or hook throws a refusal away for fixed text", () => {
    const sites = ["app", "components", "hooks"]
      .flatMap((d) => walk(join(ROOT, d), isSource))
      .filter((f) => !rel(f).startsWith("app/api/"))
      .flatMap((f) => literalErrorReturns(read(f), f).map((line) => `${rel(f)}:${line}`));
    expect(sites).toEqual([]);
  });

  it("[self-test] reports a planted screen that does not handle a code its route returns", () => {
    const route: Route = {
      path: "/api/planted/[id]",
      segments: ["api", "planted", "[id]"],
      codes: ["auth.permission_denied", "app.planted.refused"],
    };
    const screen =
      "const r = await apiFetch(`/api/planted/${id}`); if (!r.ok) setError(true);";
    expect(callerGaps("components/Planted.tsx", screen, [route])).toEqual([
      "components/Planted.tsx -> /api/planted/[id] : auth.permission_denied",
      "components/Planted.tsx -> /api/planted/[id] : app.planted.refused",
    ]);
    // The shared handler decides every platform code; an app code needs HANDLED_CODES.
    const shared = `${screen} const x = readRefusal(r);`;
    expect(callerGaps("components/Planted.tsx", shared, [route])).toEqual([
      "components/Planted.tsx -> /api/planted/[id] : app.planted.refused",
    ]);
    const listed = `${shared} const HANDLED_CODES = ["app.planted.refused"];`;
    expect(callerGaps("components/Planted.tsx", listed, [route])).toEqual([]);
  });

  it("[self-test] a code the transport handles is covered only for a caller that calls through it, and only that code", () => {
    const route: Route = {
      path: "/api/planted",
      segments: ["api", "planted"],
      codes: ["auth.csrf_failed", "auth.permission_denied"],
    };
    expect(transportCodes()).toEqual(["auth.csrf_failed"]);
    const through = 'const r = await apiFetch("/api/planted", { method: "POST" });';
    expect(
      callerGaps("components/P.tsx", through, [route], ["auth.csrf_failed"])
    ).toEqual(["components/P.tsx -> /api/planted : auth.permission_denied"]);
    // A plain fetch sends no session token and is not retried: the code is the screen's to handle.
    const plain = 'const r = await fetch("/api/planted", { method: "POST" });';
    expect(callerGaps("components/P.tsx", plain, [route], ["auth.csrf_failed"])).toEqual([
      "components/P.tsx -> /api/planted : auth.csrf_failed",
      "components/P.tsx -> /api/planted : auth.permission_denied",
    ]);
    // …and so is a caller that mixes the two.
    expect(
      callerGaps("components/P.tsx", `${through} ${plain}`, [route], ["auth.csrf_failed"])
    ).toHaveLength(2);
  });

  it("[self-test] recognises the banned pattern", () => {
    expect(
      literalErrorReturns(
        'async function f(){ if (!res.ok) { return { items: [], error: "Nope" }; } if (!r.ok) return { error: msg }; }'
      )
    ).toEqual([1]);
  });
});
