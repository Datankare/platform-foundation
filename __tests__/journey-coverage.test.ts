/**
 * __tests__/journey-coverage.test.ts — every screen and route has a journey, or says why not
 * (TASK-198, D-21)
 *
 * The AI command bar's retired model (TASK-186) reached users because no journey ran that path
 * with real providers, and nothing said so. Here, statically, for this repository (a consumer runs
 * the same file over its own app and journeys):
 *
 *   units     every page (app/**\/page.tsx → its path) and every API route (app/api/**\/route.ts);
 *   covered   a unit is covered when an e2e test (e2e/, mock providers) or a live journey
 *             (e2e-live/, real providers and users) names its path in a string — page.goto,
 *             request.get, waitForResponse — a `${…}` segment matching a [param];
 *   exempt    every other unit is listed in journey-exemptions.json (repository root, per
 *             repository — not synced) with the reason it has no journey.
 *
 * The exemptions are a ratchet: a new unit with no journey fails here (give it one, or add it
 * with its reason — a reviewer reads an added exemption as a gate loosened, REVIEW.md rule 8, and
 * the file is High in scripts/risk-tiers.json), and an exemption no longer needed (now covered, or
 * the unit gone) fails until it is removed:
 * `UPDATE_JOURNEY_EXEMPTIONS=1 npx jest __tests__/journey-coverage.test.ts` removes those, and
 * never adds one. Mechanically too (round 1, L6): CI writes the base branch's exemptions and app
 * files to $JOURNEY_BASE (ci.yml), and a unit that existed at the base with a journey may not be
 * exempted now — only a unit the change adds can be.
 *
 * "Names its path" is a static proxy: it proves a journey reaches the unit, not that it asserts
 * everything there. The journeys' own assertions are reviewed with them.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, relative, sep } from "path";
import * as ts from "typescript";

const ROOT = join(__dirname, "..");
const EXEMPTIONS_FILE = join(ROOT, "journey-exemptions.json");

interface ExemptionsFile {
  readonly _comment: string;
  readonly count: number;
  readonly exemptions: Record<string, string>;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");

/** The path a page or route file serves: route groups `(x)` dropped. */
export function unitPath(file: string): string {
  const parts = file
    .replace(/^app\//, "")
    .replace(/(^|\/)(page\.tsx|route\.ts)$/, "")
    .split("/")
    .filter((s) => s !== "" && !/^\(.*\)$/.test(s));
  return `/${parts.join("/")}`;
}

/** Every page and API route of the app, by path. */
export function units(root = ROOT): string[] {
  const files = walk(join(root, "app")).map((f) =>
    relative(root, f).split(sep).join("/")
  );
  return [
    ...new Set(
      files
        .filter((f) => /(?:^|\/)page\.tsx$/.test(f) || /^app\/api\/.*route\.ts$/.test(f))
        .map(unitPath)
    ),
  ].sort();
}

/**
 * The calls that make or await a request: navigation, a request, a response or request awaited, a
 * URL awaited — and `page.on("response" | "request", …)`, a listener that records what the journey
 * then asserts. A path counts only inside one of these (round 1, L7) — not in a comment, a prefix
 * check (`path.startsWith("/api/admin/")`) or prose.
 */
const REQUEST_CALLS = new Set([
  "goto",
  "waitForURL",
  "toHaveURL",
  "waitForResponse",
  "waitForRequest",
  "fetch",
  "apiFetch",
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
]);

const calleeName = (c: ts.CallExpression): string => {
  const e = c.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return "";
};

/** A literal's text as a path pattern (`${…}` as one segment of anything), or undefined. */
function literalPath(node: ts.Node, sf: ts.SourceFile): string | undefined {
  let text: string | undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    text = node.text;
  else if (ts.isTemplateExpression(node)) text = node.getText(sf).slice(1, -1);
  if (text === undefined || !text.startsWith("/")) return undefined;
  const path = text
    .replace(/\$\{[^}]*\}/g, "*")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
  return path === "" ? "/" : path;
}

/**
 * The paths a journey source requests: the path literals inside a request call's arguments, and
 * those a name used there stands for — a constant (`PLAN_PATH`), or the list a loop variable is
 * drawn from (`for (const [section, endpoint] of READ_SECTIONS)`), one file deep.
 */
export function namedPaths(source: string, name = "journey.ts"): string[] {
  const sf = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  // What each name stands for: a declaration's initializer, or a loop's iterable.
  const stands = new Map<string, ts.Node>();
  const bind = (binding: ts.BindingName, value: ts.Node) => {
    if (ts.isIdentifier(binding)) stands.set(binding.text, value);
    else
      for (const el of binding.elements)
        if (!ts.isOmittedExpression(el)) bind(el.name, value);
  };
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.initializer) bind(n.name, n.initializer);
    if (ts.isForOfStatement(n) && ts.isVariableDeclarationList(n.initializer)) {
      for (const d of n.initializer.declarations) bind(d.name, n.expression);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const out = new Set<string>();
  const seen = new Set<ts.Node>();
  const take = (n: ts.Node, depth: number) => {
    if (seen.has(n)) return;
    seen.add(n);
    const path = literalPath(n, sf);
    if (path !== undefined) out.add(path);
    if (ts.isIdentifier(n) && depth < 3) {
      const target = stands.get(n.text);
      if (target) take(target, depth + 1);
    }
    ts.forEachChild(n, (c) => take(c, depth));
  };
  const visit = (n: ts.Node) => {
    // page.on("response" | "request", …): the journey observes the requests it judges.
    const observes =
      ts.isCallExpression(n) &&
      calleeName(n) === "on" &&
      n.arguments[0] !== undefined &&
      ts.isStringLiteral(n.arguments[0]) &&
      /^(?:response|request)$/.test(n.arguments[0].text);
    if (ts.isCallExpression(n) && (REQUEST_CALLS.has(calleeName(n)) || observes)) {
      for (const arg of n.arguments) take(arg, 0);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...out];
}

/** Whether a named path reaches a unit's path ([p] matches one segment, [...p] one or more). */
export function reaches(named: string, unit: string): boolean {
  const n = named.split("/").filter(Boolean);
  const u = unit.split("/").filter(Boolean);
  const match = (i: number, j: number): boolean => {
    if (j === u.length) return i === n.length;
    const seg = u[j];
    if (/^\[\.\.\..+\]$/.test(seg) || /^\[\[\.\.\..+\]\]$/.test(seg)) {
      for (let k = i + 1; k <= n.length; k++) if (match(k, j + 1)) return true;
      return /^\[\[/.test(seg) && match(i, j + 1);
    }
    if (i === n.length) return false;
    if (/^\[.+\]$/.test(seg)) return match(i + 1, j + 1);
    return (n[i] === seg || n[i] === "*") && match(i + 1, j + 1);
  };
  return match(0, 0);
}

/** The units some e2e test or live journey reaches. */
export function coveredUnits(all: readonly string[]): Set<string> {
  const sources = ["e2e", "e2e-live"]
    .flatMap((d) => walk(join(ROOT, d)))
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => [f, readFileSync(f, "utf8")] as const);
  const named = sources.flatMap(([f, text]) => namedPaths(text, f));
  return new Set(all.filter((u) => named.some((p) => reaches(p, u))));
}

function readExemptions(): ExemptionsFile {
  return JSON.parse(readFileSync(EXEMPTIONS_FILE, "utf8")) as ExemptionsFile;
}

describe("journey coverage (TASK-198, D-21)", () => {
  it("self-test: paths, params and what a journey names", () => {
    // A template path with a placeholder, built so that this file holds no escaped placeholder.
    const TEMPLATE_PATH = "`/api/admin/approvals/" + "$" + "{id}?x=1`";
    expect(unitPath("app/page.tsx")).toBe("/");
    expect(unitPath("app/(shop)/agent/console/page.tsx")).toBe("/agent/console");
    expect(unitPath("app/api/admin/approvals/[id]/route.ts")).toBe(
      "/api/admin/approvals/[id]"
    );
    expect(
      namedPaths(`
        // page.goto("/api/in/a/comment")
        const PLAN = "/api/plan";
        const LIST = [["a", "/api/listed"]] as const;
        const isRead = (p: string) => p.startsWith("/api/prefix/");
        await page.goto("/admin");
        fetch(${TEMPLATE_PATH});
        page.waitForResponse((r) => new URL(r.url()).pathname === PLAN);
        for (const [, endpoint] of LIST) await page.waitForResponse((r) => r.url() === endpoint);
        page.on("response", (r) => { if (path === "/api/observed") calls.push(r); });
        page.on("console", (m) => m.text() === "/api/not/a/request");
        const prose = "/api/only/named";
      `).sort()
    ).toEqual([
      "/admin",
      "/api/admin/approvals/*",
      "/api/listed",
      "/api/observed",
      "/api/plan",
    ]);
    expect(reaches("/api/admin/approvals/*", "/api/admin/approvals/[id]")).toBe(true);
    expect(reaches("/api/admin/approvals/abc", "/api/admin/approvals/[id]")).toBe(true);
    expect(reaches("/api/admin/approvals", "/api/admin/approvals/[id]")).toBe(false);
    expect(reaches("/api/admin", "/api/admin/users")).toBe(false);
    expect(reaches("/", "/")).toBe(true);
    expect(reaches("/api/auth/sso/google", "/api/auth/sso/[provider]")).toBe(true);
    expect(reaches("/a/b/c", "/a/[...rest]")).toBe(true);
  });

  const all = units();
  it("finds the pages and the API routes", () => {
    expect(all).toContain("/");
    expect(all).toContain("/admin");
    expect(all.filter((u) => u.startsWith("/api/")).length).toBeGreaterThan(30);
  });

  it("every page and API route has a journey, or an exemption with its reason", () => {
    const file = readExemptions();
    const covered = coveredUnits(all);
    const exempt = file.exemptions;
    const missing = all.filter((u) => !covered.has(u) && !exempt[u]);
    expect(
      missing.map(
        (u) =>
          `${u}: no e2e test or live journey names it — add one (e2e/ or e2e-live/), or list it in journey-exemptions.json with why it has none`
      )
    ).toEqual([]);

    // The ratchet: an exemption that is no longer needed goes.
    const stale = Object.keys(exempt).filter((u) => covered.has(u) || !all.includes(u));
    if (stale.length > 0 && process.env.UPDATE_JOURNEY_EXEMPTIONS === "1") {
      const kept = Object.fromEntries(
        Object.entries(exempt).filter(([u]) => !stale.includes(u))
      );
      writeFileSync(
        EXEMPTIONS_FILE,
        `${JSON.stringify({ ...file, count: Object.keys(kept).length, exemptions: kept }, null, 2)}\n`
      );
      return;
    }
    expect(
      stale.map(
        (u) =>
          `${u}: exempt in journey-exemptions.json but ${covered.has(u) ? "now covered by a journey" : "no longer a page or route"} — remove it (UPDATE_JOURNEY_EXEMPTIONS=1 npx jest __tests__/journey-coverage.test.ts)`
      )
    ).toEqual([]);
  });

  it("against the base branch (CI): no unit that had a journey there is exempted now", () => {
    const base = process.env.JOURNEY_BASE;
    // In CI (or with JOURNEY_BASE_REQUIRED=1) the base must be there (round 2): a workflow that
    // stopped writing it would otherwise turn this check into a pass. Locally the checks above stand.
    if (!base) {
      const required =
        Boolean(process.env.CI) || process.env.JOURNEY_BASE_REQUIRED === "1";
      expect(required ? "JOURNEY_BASE is not set in CI (ci.yml's base step)" : "").toBe(
        ""
      );
      return;
    }
    const baseExemptions = join(base, "exemptions.json");
    // The change that introduces the file has no base list to compare with.
    if (!existsSync(baseExemptions)) return;
    const before = (JSON.parse(readFileSync(baseExemptions, "utf8")) as ExemptionsFile)
      .exemptions;
    const baseUnits = new Set(
      readFileSync(join(base, "app-files.txt"), "utf8")
        .split("\n")
        .filter((f) => /(?:^|\/)page\.tsx$/.test(f) || /^app\/api\/.*route\.ts$/.test(f))
        .map(unitPath)
    );
    expect(baseUnits.size).toBeGreaterThan(0);
    const lost = Object.keys(readExemptions().exemptions).filter(
      (u) => baseUnits.has(u) && !before[u]
    );
    expect(
      lost.map(
        (u) =>
          `${u}: had a journey on the base branch and is exempted now — the list only shrinks`
      )
    ).toEqual([]);
  });

  it("each exemption gives a reason, and the count is the list's", () => {
    const file = readExemptions();
    const entries = Object.entries(file.exemptions);
    expect(file.count).toBe(entries.length);
    expect(entries.filter(([, reason]) => reason.trim().length < 20)).toEqual([]);
    expect(rel(EXEMPTIONS_FILE)).toBe("journey-exemptions.json");
  });
});
