/**
 * __tests__/db-suite-hygiene.test.ts — what a database suite may do to the shared database
 * (TASK-198: D-14, D-15, D-18)
 *
 * Every suite under __tests__/db runs in parallel with the others against ONE replayed database
 * (CI's three Layer 1 passes, and locally). Statically, over each of them:
 *
 *   D-18  No suite writes a SEEDED platform_config key — one the migrations insert, which other
 *         suites read as the deployment's value — by SQL (`update|insert into|delete from
 *         platform_config` with that key as a literal, a parameter, or a constant holding it).
 *         A suite makes its own keys (`test.<random>`, `r13.<tenant id>`). r13.db's kill-switch case
 *         rewrote `agent.trusted_agents` for the length of a test.
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

/**
 * Writes of a seeded key that cannot be made on a key of the suite's own, by file and key: the
 * reason (round 1, L5: one allowance never covers another key in the same file). May only shrink.
 */
const SEEDED_WRITES_ALLOWED: Readonly<Record<string, Readonly<Record<string, string>>>> =
  {
    "__tests__/db/r13.db.test.ts": {
      "agent.trusted_agents":
        "the kill switch's platform scope (a single-tenant deployment) acts only on agent.trusted_agents — the key is fixed in agent-kill-switch.ts and power-reduction.ts, so no random key can stand in; the row is restored in a finally, and no other suite reads its platform value (rv11 writes only a tenant override). To leave this list it needs a serial DB pass (TASK-198 follow-up)",
    },
  };

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
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const v = stringValue(n.initializer, new Map());
      if (v !== undefined) consts.set(n.name.text, v);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);

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
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      CONFIG_WRITERS.has(n.expression.text) &&
      n.arguments.length > 0
    ) {
      const key = stringValue(n.arguments[0], consts);
      const target = n.arguments[TARGET_ARG];
      const platformScope =
        target === undefined ||
        (ts.isIdentifier(target) &&
          (target.text === "undefined" || target.text === "PLATFORM_DEFAULT_TARGET")) ||
        /\bscope:\s*["']platform["']/.test(target.getText(sf));
      if (key !== undefined && seeded.has(key) && platformScope)
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

  it("self-test: finds seeded writes, short suite-wide timeouts and plans on sampled statistics", () => {
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
    // EXPLAIN only to type-check SQL is not reading a plan.
    expect(
      suiteFindings("await client.query(`explain (generic_plan) ${sql}`);", seeded)
    ).toEqual([]);
  });

  const suites = walk(DB_SUITES).filter((f) => /\.tsx?$/.test(f));
  it("finds the DB suites", () => {
    expect(suites.length).toBeGreaterThan(20);
  });

  it("no DB suite writes a seeded config key, shortens the suites' timeout, or reads plans on sampled statistics", () => {
    const problems: string[] = [];
    const used = new Set<string>();
    for (const file of suites.map(rel)) {
      for (const f of suiteFindings(
        readFileSync(join(ROOT, file), "utf8"),
        seeded,
        file
      )) {
        if (f.kind === "seeded-write" && SEEDED_WRITES_ALLOWED[file]?.[f.text]) {
          used.add(`${file} ${f.text}`);
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
    const allowed = Object.entries(SEEDED_WRITES_ALLOWED).flatMap(([file, keys]) =>
      Object.keys(keys).map((k) => `${file} ${k}`)
    );
    expect(allowed.filter((a) => !used.has(a))).toEqual([]);
  });
});
