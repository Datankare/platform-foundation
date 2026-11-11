/**
 * __tests__/db-suite-hygiene.test.ts — what a database suite may do to the shared database
 * (TASK-198: D-14, D-15, D-18)
 *
 * @guard a database suite that writes seeded rows, shortens timeouts or plans on sampled statistics
 *
 * Every suite under __tests__/db runs in parallel with the others against ONE replayed database
 * (CI's three Layer 1 passes, and locally). Statically, over each of them:
 *
 *   D-18  No suite writes a SEEDED platform_config key — one the migrations insert, which other
 *         suites read as the deployment's value — by SQL (`update|insert into|delete from
 *         platform_config` with that key as a literal, a parameter, or a constant holding it).
 *         A suite makes its own keys (`test.<random>`, `r13.<tenant id>`). A case that can only
 *         act on a seeded key (the kill switch's platform scope rewrites `agent.trusted_agents`)
 *         runs in the serial pass: __tests__/db-serial/*.serial.ts, which jest's testMatch leaves
 *         out of every parallel pass and `npm run test:db-serial` runs alone, after them (TASK-204,
 *         N-19 — the TASK-198 allowance list is gone). The other rules hold there too.
 *   D-14  No suite runs under a statement timeout shorter than the DB suites' own (10 s,
 *         helpers/db.ts): the data layer sets idle_in_transaction_session_timeout to the same
 *         value, so a worker stalled that long on the loaded database has its session killed.
 *         A shorter one is set inside one test and restored in a `finally`.
 *   D-15  A suite that reads query plans (auto_explain, EXPLAIN) plans on statistics that are the
 *         same every run: it sets default_statistics_target (a sample larger than the table —
 *         `analyze` otherwise samples at random) in the transaction it measures.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import * as ts from "typescript";

const ROOT = join(__dirname, "..");
const DB_SUITES = join(ROOT, "__tests__/db");
const SUITE_TIMEOUT_MS = 10_000;

/** The serial pass's suites (TASK-204, N-19): run alone, so a seeded write races nothing. */
const SERIAL_SUITES = join(ROOT, "__tests__/db-serial");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");

/** Every platform_config key the schema baseline and the migrations insert. */
export function seededConfigKeys(root = ROOT): Set<string> {
  const files = [
    join(root, "supabase/baseline/000_baseline.sql"),
    ...walk(join(root, "supabase/migrations")),
  ].filter((f) => f.endsWith(".sql") && existsSync(f));
  const keys = new Set<string>();
  for (const f of files) {
    const text = readFileSync(f, "utf8").replace(/--[^\n]*/g, "");
    for (const m of text.matchAll(
      /insert\s+into\s+(?:public\.)?platform_config\b([\s\S]*?);/gi
    )) {
      const at = m[1].search(/\bvalues\b/i);
      if (at < 0) continue;
      for (const k of m[1].slice(at).matchAll(/(?:values|,)\s*\(\s*'([a-z][\w.-]*)'/gi))
        keys.add(k[1]);
    }
  }
  return keys;
}

/** The platform's config writers a suite may call directly. */
const CONFIG_WRITERS = new Set(["setConfigWithHistory"]);
/** setConfigWithHistory's target argument (0-based): absent, it is PLATFORM_DEFAULT_TARGET. */
const TARGET_ARG = 6;

const WRITE =
  /\b(?:update|insert\s+into|delete\s+from)\s+(?:public\.)?platform_config\b/i;

/** The string a node stands for, when it is a literal or a constant initialised with one. */
function stringValue(node: ts.Node, consts: Map<string, string>): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isIdentifier(node)) return consts.get(node.text);
  return undefined;
}

export interface SuiteFinding {
  readonly line: number;
  readonly kind: "seeded-write" | "short-timeout" | "sampled-plan";
  readonly text: string;
}

/** What one DB suite's source does that the rules above refuse. */
export function suiteFindings(
  source: string,
  seeded: ReadonlySet<string>,
  name = "x.db.test.ts"
): SuiteFinding[] {
  const sf = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const out: SuiteFinding[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const consts = new Map<string, string>();
  // TASK-204 (N-19, TASK-198 round 3's residuals): a target held in a constant, a writer under
  // another name (an import alias, a constant holding it, a namespace's property).
  const initializers = new Map<string, ts.Expression>();
  const writers = new Set(CONFIG_WRITERS);
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const v = stringValue(n.initializer, new Map());
      if (v !== undefined) consts.set(n.name.text, v);
      initializers.set(n.name.text, n.initializer);
      if (ts.isIdentifier(n.initializer) && writers.has(n.initializer.text))
        writers.add(n.name.text);
    }
    if (ts.isImportSpecifier(n) && CONFIG_WRITERS.has((n.propertyName ?? n.name).text))
      writers.add(n.name.text);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  /** The writer a call calls, by any name: `f(…)` or `ns.f(…)`. */
  const callsWriter = (call: ts.CallExpression) =>
    (ts.isIdentifier(call.expression) && writers.has(call.expression.text)) ||
    (ts.isPropertyAccessExpression(call.expression) &&
      CONFIG_WRITERS.has(call.expression.name.text));
  /**
   * The scope a writer's target names: "platform" (left out, `undefined`,
   * PLATFORM_DEFAULT_TARGET, an object without `scope`), "tenant", or "unknown" (a spread that may
   * carry a scope, any other expression) — read from the AST, through constants; unknown counts
   * as platform (fail closed).
   */
  const scopeOf = (target: ts.Expression | undefined, depth = 0): string => {
    if (target === undefined) return "platform";
    if (ts.isParenthesizedExpression(target) || ts.isAsExpression(target))
      return scopeOf(target.expression, depth);
    if (ts.isIdentifier(target)) {
      if (target.text === "undefined" || target.text === "PLATFORM_DEFAULT_TARGET")
        return "platform";
      const init = initializers.get(target.text);
      return init && depth < 5 ? scopeOf(init, depth + 1) : "unknown";
    }
    if (ts.isObjectLiteralExpression(target)) {
      let spread = false;
      let scope: string | undefined;
      for (const p of target.properties) {
        if (ts.isSpreadAssignment(p)) spread = true;
        else if (
          ts.isPropertyAssignment(p) &&
          (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
          p.name.text === "scope"
        )
          scope =
            stringValue(
              ts.isAsExpression(p.initializer) ? p.initializer.expression : p.initializer,
              consts
            ) ?? "unknown";
      }
      return scope ?? (spread ? "unknown" : "platform");
    }
    return "unknown";
  };

  const inTest = (n: ts.Node): ts.CallExpression | undefined => {
    for (let p = n.parent; p; p = p.parent) {
      if (
        ts.isCallExpression(p) &&
        ts.isIdentifier(p.expression) &&
        (p.expression.text === "it" || p.expression.text === "test")
      )
        return p;
    }
    return undefined;
  };

  const visit = (n: ts.Node) => {
    // D-18: a call whose first argument is SQL writing platform_config.
    if (ts.isCallExpression(n) && n.arguments.length > 0) {
      const sql = n.arguments[0];
      const text = ts.isStringLiteralLike(sql)
        ? sql.text
        : ts.isTemplateExpression(sql)
          ? sql.getText(sf)
          : undefined;
      if (text && WRITE.test(text)) {
        const keys: string[] = [];
        for (const k of text.matchAll(/'([a-z][\w.-]*)'/gi)) keys.push(k[1]);
        const values = n.arguments[1];
        if (values && ts.isArrayLiteralExpression(values)) {
          for (const e of values.elements) {
            const v = stringValue(e, consts);
            if (v !== undefined) keys.push(v);
          }
        }
        for (const k of keys.filter((k) => seeded.has(k)))
          out.push({ line: line(n), kind: "seeded-write", text: k });
      }
    }
    // D-18 (round 1, L5): the platform's own writer (platform/auth/platform-config.ts
    // setConfigWithHistory) at the platform scope, on a seeded key, a literal or a constant
    // holding one. Platform scope (round 2): the target `{ scope: "platform", … }`, the target left
    // out or `undefined` (its default), or PLATFORM_DEFAULT_TARGET.
    if (ts.isCallExpression(n) && callsWriter(n) && n.arguments.length > 0) {
      const spreadAt = n.arguments.findIndex((a) => ts.isSpreadElement(a));
      const key = spreadAt === 0 ? undefined : stringValue(n.arguments[0], consts);
      // A spread before the target leaves it at an unknown position: unknown scope.
      const scope =
        spreadAt >= 0 && spreadAt <= TARGET_ARG
          ? "unknown"
          : scopeOf(n.arguments[TARGET_ARG]);
      if (spreadAt === 0)
        out.push({
          line: line(n),
          kind: "seeded-write",
          text: "<a key the guard cannot read>",
        });
      else if (key !== undefined && seeded.has(key) && scope !== "tenant")
        out.push({ line: line(n), kind: "seeded-write", text: key });
    }
    // D-14: DATABASE_STATEMENT_TIMEOUT_MS set below the suites' bound outside one test's finally.
    const timeoutValue = (() => {
      if (
        ts.isPropertyAssignment(n) &&
        (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) &&
        n.name.text === "DATABASE_STATEMENT_TIMEOUT_MS"
      )
        return stringValue(n.initializer, consts);
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        /\bDATABASE_STATEMENT_TIMEOUT_MS$/.test(n.left.getText(sf))
      )
        return stringValue(n.right, consts);
      return undefined;
    })();
    if (timeoutValue !== undefined && Number(timeoutValue) < SUITE_TIMEOUT_MS) {
      const test = inTest(n);
      const restored =
        test !== undefined &&
        (() => {
          let found = false;
          const look = (m: ts.Node) => {
            if (
              ts.isTryStatement(m) &&
              m.finallyBlock &&
              /DATABASE_STATEMENT_TIMEOUT_MS/.test(m.finallyBlock.getText(sf))
            )
              found = true;
            ts.forEachChild(m, look);
          };
          look(test);
          return found;
        })();
      if (!restored)
        out.push({
          line: line(n),
          kind: "short-timeout",
          text: `DATABASE_STATEMENT_TIMEOUT_MS ${timeoutValue}`,
        });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  // D-15: plans read on sampled statistics.
  // Plans measured (auto_explain, EXPLAIN ANALYZE, a plan's node fields) — not EXPLAIN used only
  // to parse and type-check SQL (sql-schema-parity).
  const readsPlans =
    /auto_explain|\bexplain\s*\(\s*analy[sz]e|"Actual Rows"|"Index Name"/i.test(source);
  if (readsPlans && !/default_statistics_target/.test(source)) {
    out.push({ line: 1, kind: "sampled-plan", text: "reads plans" });
  }
  return out;
}

describe("database suites on the shared database (TASK-198)", () => {
  const seeded = seededConfigKeys();

  it("self-test: the seeded keys are found", () => {
    expect(seeded.size).toBeGreaterThan(60);
    for (const k of [
      "agent.trusted_agents",
      "signups_enabled",
      "ai.prompt_cache_enabled",
    ])
      expect(seeded).toContain(k);
  });

  it("[self-test] finds seeded writes, short suite-wide timeouts and plans on sampled statistics", () => {
    const found = suiteFindings(
      `
      const KEY = "signups_enabled";
      const MINE = "test." + id;
      beforeAll(() => { process.env = { ...saved, DATABASE_STATEMENT_TIMEOUT_MS: "500" }; });
      it("a", async () => {
        await owner("update platform_config set value = $2 where key = $1", [KEY, "1"]);
        await owner("update platform_config set value = '1' where key = 'maintenance_mode'");
        await owner("update platform_config set value = $2 where key = $1", [MINE, "1"]);
        await owner("update platform_config_history set x = 1 where config_key = $1", [KEY]);
        await setConfigWithHistory(KEY, 1, a, "c", "admin_ui", undefined, { scope: "platform" });
        await setConfigWithHistory(KEY, 1, a, "c", "admin_ui", undefined, { scope: "tenant" });
        await setConfigWithHistory(KEY, 1, a, "c");
        await setConfigWithHistory(KEY, 1, a, "c", "admin_ui", undefined, PLATFORM_DEFAULT_TARGET);
        await client.query("load 'auto_explain'");
      });
      it("b", async () => {
        process.env.DATABASE_STATEMENT_TIMEOUT_MS = "300";
        try { await x(); } finally { process.env.DATABASE_STATEMENT_TIMEOUT_MS = saved; }
      });
      it("c", async () => { process.env.DATABASE_STATEMENT_TIMEOUT_MS = "300"; await x(); });
    `,
      seeded
    );
    expect(found.map((f) => [f.line, f.kind, f.text])).toEqual([
      [4, "short-timeout", "DATABASE_STATEMENT_TIMEOUT_MS 500"],
      [6, "seeded-write", "signups_enabled"],
      [7, "seeded-write", "maintenance_mode"],
      [10, "seeded-write", "signups_enabled"],
      [12, "seeded-write", "signups_enabled"],
      [13, "seeded-write", "signups_enabled"],
      [20, "short-timeout", "DATABASE_STATEMENT_TIMEOUT_MS 300"],
      [1, "sampled-plan", "reads plans"],
    ]);
    // TASK-204 (N-19): a target in a constant, a spread, an aliased or namespaced writer.
    expect(
      suiteFindings(
        `
        import { setConfigWithHistory as write } from "@/platform/auth/platform-config";
        import * as pc from "@/platform/auth/platform-config";
        const KEY = "signups_enabled";
        const TENANT = { scope: "tenant" };
        const PLATFORM = { scope: "platform", operator: true };
        const set2 = write;
        it("x", async () => {
          await write(KEY, 1, a, "c", "admin_ui", undefined, PLATFORM);
          await write(KEY, 1, a, "c", "admin_ui", undefined, TENANT);
          await pc.setConfigWithHistory(KEY, 1, a, "c");
          await set2(KEY, 1, a, "c", "admin_ui", undefined, { ...TENANT, scope: "platform" });
          await write(KEY, 1, a, "c", "admin_ui", undefined, { ...TENANT });
          await write(KEY, ...rest);
          await write(...all);
          await write(KEY, 1, a, "c", "admin_ui", undefined, { ...PLATFORM, scope: "tenant" });
        });
      `,
        seeded
      ).map((f) => [f.line, f.text])
    ).toEqual([
      [9, "signups_enabled"],
      [11, "signups_enabled"],
      [12, "signups_enabled"],
      [13, "signups_enabled"],
      [14, "signups_enabled"],
      [15, "<a key the guard cannot read>"],
    ]);
    // EXPLAIN only to type-check SQL is not reading a plan.
    expect(
      suiteFindings("await client.query(`explain (generic_plan) ${sql}`);", seeded)
    ).toEqual([]);
  });

  const suites = walk(DB_SUITES).filter((f) => /\.tsx?$/.test(f));
  const serial = walk(SERIAL_SUITES).filter((f) => /\.serial\.ts$/.test(f));
  it("finds the DB suites and the serial pass's", () => {
    expect(suites.length).toBeGreaterThan(20);
    expect(serial.length).toBeGreaterThan(0);
  });

  it("the serial pass's suites are left out of the parallel passes and run alone (N-19)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      jest: { testMatch: string[] };
    };
    // testMatch takes only *.test.ts(x): a *.serial.ts is never in a parallel pass.
    expect(pkg.jest.testMatch.length).toBeGreaterThan(0);
    expect(
      pkg.jest.testMatch.every(
        (m) => /\.test\.tsx?"?$/.test(m) || /\.test\.tsx?$/.test(m)
      )
    ).toBe(true);
    expect(pkg.scripts["test:db-serial"]).toMatch(
      /^jest --testMatch "<rootDir>\/__tests__\/db-serial\/\*\*\/\*\.serial\.ts" --runInBand$/
    );
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/npm run test:db-serial\b/);
  });

  it("no DB suite writes a seeded config key, shortens the suites' timeout, or reads plans on sampled statistics", () => {
    const problems: string[] = [];
    const used = new Set<string>();
    for (const file of [...suites, ...serial].map(rel)) {
      for (const f of suiteFindings(
        readFileSync(join(ROOT, file), "utf8"),
        seeded,
        file
      )) {
        // The serial pass runs alone: its seeded writes race no other suite.
        if (f.kind === "seeded-write" && file.startsWith("__tests__/db-serial/")) {
          used.add(file);
          continue;
        }
        problems.push(
          {
            "seeded-write": `${file}:${f.line} writes the seeded platform_config key "${f.text}", which other suites read in parallel — insert a key of the suite's own (test.<random>) instead (D-18)`,
            "short-timeout": `${file}:${f.line} sets ${f.text} for more than one test — the data layer kills a session idle that long on the shared database; keep the suites' ${SUITE_TIMEOUT_MS} ms and set a short one inside one test, restored in a finally (D-14)`,
            "sampled-plan": `${file} reads query plans without fixing the statistics they are planned on — set default_statistics_target above the table's size and analyze in the measuring transaction (D-15)`,
          }[f.kind]
        );
      }
    }
    expect(problems).toEqual([]);
    // A serial suite that no longer writes a seeded key belongs back in the parallel passes.
    expect(serial.map(rel).filter((f) => !used.has(f))).toEqual([]);
  });
});
