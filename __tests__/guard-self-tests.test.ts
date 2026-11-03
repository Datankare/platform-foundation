/**
 * __tests__/guard-self-tests.test.ts — every guard proves it can fail (TASK-200, rule 4)
 *
 * @guard a guard or scan test with no planted-violation self-test, or a scan left untagged
 *
 * A guard is a test that scans the repository — its source, tests, docs, workflows, migrations or
 * registries — for a class of defect and fails on any instance not allowed. One that can never
 * fail looks exactly like one that passes (TASK-194 shipped such guards; review found them). So:
 *
 *   - a guard says so: `@guard <the class it refuses>` in its header comment;
 *   - every guard has at least one test named `[self-test] …` that plants a violation — source
 *     text, a fixture file, a scratch repository — and asserts the scan reports it (a count
 *     "found a plausible number of files" is not one: it never plants anything);
 *   - that test runs: not `it.skip` / `xit` / `test.todo` / `.failing`, nor in a skipped describe;
 *   - and it runs the scan: its body calls, with at least one argument, a function the file
 *     defines outside that test or imports (not from node's built-ins, typescript, jest or
 *     fast-check), or something bound in the test from such a call (`const { repo } = started()`,
 *     then `repo.check(base)`) — so `expect(1).toBe(1)` is no self-test. The limit of this proxy:
 *     it proves the test feeds some input to the file's own code, not that the input is a
 *     violation or that the assertion is on the scan's finding; the reviewer reads that (REVIEW.md
 *     rule 15);
 *   - a test file that reads the repository's files, or uses the scan helpers, is a guard unless
 *     its header says `@not-guard: <why>` — so a new scan cannot skip the convention unnoticed.
 *
 * Runs over this repository's test files, an app's own included (the convention is shared).
 */
import { readFileSync } from "fs";
import { join, relative, sep } from "path";
import * as ts from "typescript";
import { testFiles } from "./helpers/repo-files";

const ROOT = join(__dirname, "..");
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");

/** What makes a test file look like a repository scan. */
const SCAN_SHAPE =
  /\b(?:readFileSync|readdirSync|globSync)\(|ls-files|helpers\/(?:route-policy|import-graph|owner-scan|input-reads-scan|audited-external-scan|call-graph|route-methods|repo-files|fake-fetch-scan)["']/;

/** The header tags: `@guard <class>` or `@not-guard: <reason>` on a comment line. */
export function guardTag(text: string): { guard: boolean; notGuard: string | null } {
  // Each line with its comment lead (`/**`, `*`) taken off.
  const lines = text.split("\n").map((l) =>
    l
      .trim()
      .replace(/^\/?\*+/, "")
      .trim()
  );
  const guard = lines.some(
    (l) => l.startsWith("@guard ") && l.length > "@guard ".length + 3
  );
  const not = lines.find((l) => l.startsWith("@not-guard:"));
  return {
    guard,
    notGuard:
      not === undefined
        ? null
        : not.slice("@not-guard:".length).replace(/\*\/$/, "").trim(),
  };
}

/** Modules whose functions are not the guard's scan: node's built-ins, the parser, the runner. */
const NOT_THE_SCAN =
  /^(?:node:)?(?:fs|fs\/promises|path|os|child_process|util|crypto|url|assert)$|^typescript$|^@jest\/globals$|^fast-check$/;

/** A call's callee chain: `it.each(t)` → ["it", "each"]; `describe.skip` → ["describe", "skip"]. */
function calleeChain(e: ts.Expression): string[] {
  if (ts.isIdentifier(e)) return [e.text];
  if (ts.isPropertyAccessExpression(e))
    return [...calleeChain(e.expression), e.name.text];
  if (ts.isCallExpression(e)) return calleeChain(e.expression); // it.each(table)(…)
  if (ts.isTaggedTemplateExpression(e)) return calleeChain(e.tag); // it.each`table`(…)
  return [];
}
const TEST_ROOTS = new Set(["it", "test", "describe"]);
const NOT_RUN_ROOTS = new Set(["xit", "xtest", "xdescribe"]);
/** Members that keep a test from running, or make its failure a pass. */
const NOT_RUN_MEMBERS = new Set(["skip", "todo", "failing"]);

/** The leftmost name of a callee: `repo.check` → repo; `scan` → scan; `a.b().c` → a. */
function rootName(e: ts.Expression): string | undefined {
  let x: ts.Expression = e;
  for (;;) {
    if (ts.isIdentifier(x)) return x.text;
    if (
      ts.isPropertyAccessExpression(x) ||
      ts.isElementAccessExpression(x) ||
      ts.isCallExpression(x) ||
      ts.isNewExpression(x) ||
      ts.isParenthesizedExpression(x) ||
      ts.isNonNullExpression(x) ||
      ts.isAsExpression(x)
    )
      x = x.expression;
    else return undefined;
  }
}

/** The names a binding pattern binds. */
function boundNames(b: ts.BindingName): string[] {
  if (ts.isIdentifier(b)) return [b.text];
  return b.elements.flatMap((e) => (ts.isBindingElement(e) ? boundNames(e.name) : []));
}

/**
 * The file's own code a self-test may run: functions and classes it defines, consts bound to a
 * function, a pattern (`/…/`, `new RegExp(…)`) or a require(…)/import(…), and its imports — not node's built-ins, typescript, jest or
 * fast-check (NOT_THE_SCAN). `inside`: a test body whose own definitions do not count.
 */
function scanSymbols(sf: ts.SourceFile, inside?: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (n === inside) return;
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      if (!NOT_THE_SCAN.test(n.moduleSpecifier.text) && n.importClause) {
        const c = n.importClause;
        if (c.name) out.add(c.name.text);
        const b = c.namedBindings;
        if (b && ts.isNamespaceImport(b)) out.add(b.name.text);
        if (b && ts.isNamedImports(b)) b.elements.forEach((e) => out.add(e.name.text));
      }
      return;
    }
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name)
      out.add(n.name.text);
    if (ts.isVariableDeclaration(n) && n.initializer) {
      let init: ts.Expression = n.initializer;
      while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init))
        init = init.expression;
      const fn = ts.isArrowFunction(init) || ts.isFunctionExpression(init);
      const required =
        ts.isCallExpression(init) &&
        ((ts.isIdentifier(init.expression) && init.expression.text === "require") ||
          init.expression.kind === ts.SyntaxKind.ImportKeyword) &&
        init.arguments.length > 0 &&
        ts.isStringLiteral(init.arguments[0]) &&
        !NOT_THE_SCAN.test(init.arguments[0].text);
      // A scan that is a pattern: `const BARE_FETCH = /…/` or `new RegExp(…)`.
      const pattern =
        ts.isRegularExpressionLiteral(init) ||
        (ts.isNewExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.expression.text === "RegExp");
      if (fn || required || pattern) boundNames(n.name).forEach((x) => out.add(x));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Whether a self-test's body runs the file's scan with an input: a call (or `new`), with at least
 * one argument, of one of `symbols` — or of a name the body binds from such a call.
 */
function runsTheScan(body: ts.Node, symbols: ReadonlySet<string>): boolean {
  const derived = new Set(symbols);
  derived.delete("expect");
  const reaches = (e: ts.Node): boolean => {
    let found = false;
    const look = (n: ts.Node): void => {
      if (found) return;
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const root = rootName(n.expression);
        if (root !== undefined && derived.has(root)) found = true;
      }
      ts.forEachChild(n, look);
    };
    look(e);
    return found;
  };
  // Names the body binds from a call of the scan (`const { repo } = started()`), until none is new.
  for (let changed = true; changed;) {
    changed = false;
    const bind = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        n.initializer &&
        (reaches(n.initializer) || derived.has(rootName(n.initializer) ?? ""))
      )
        for (const name of boundNames(n.name))
          if (!derived.has(name)) {
            derived.add(name);
            changed = true;
          }
      ts.forEachChild(n, bind);
    };
    bind(body);
  }
  let runs = false;
  const visit = (n: ts.Node): void => {
    if (runs) return;
    if (
      (ts.isCallExpression(n) || ts.isNewExpression(n)) &&
      (n.arguments?.length ?? 0) > 0
    ) {
      const root = rootName(n.expression);
      if (root !== undefined && root !== "expect" && derived.has(root)) runs = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return runs;
}

/**
 * Names of the tests named `[self-test] …` that run (not skipped, not todo), assert, and run the
 * file's own scan with an input (runsTheScan).
 */
export function selfTests(text: string, name = "probe.test.ts"): string[] {
  const sf = ts.createSourceFile(
    name,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const out: string[] = [];
  const visit = (node: ts.Node, skipped: boolean): void => {
    let inner = skipped;
    if (ts.isCallExpression(node)) {
      const chain = calleeChain(node.expression);
      const root = chain[0];
      if (root !== undefined && (TEST_ROOTS.has(root) || NOT_RUN_ROOTS.has(root))) {
        const notRun =
          skipped || NOT_RUN_ROOTS.has(root) || chain.some((m) => NOT_RUN_MEMBERS.has(m));
        if (notRun) inner = true;
        if (root !== "describe" && root !== "xdescribe" && node.arguments.length >= 2) {
          const [title, body] = node.arguments;
          const label =
            ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title)
              ? title.text
              : ts.isTemplateExpression(title)
                ? title.head.text
                : "";
          if (
            !notRun &&
            label.includes("[self-test]") &&
            /\bexpect\(/.test(body.getText(sf)) &&
            runsTheScan(body, scanSymbols(sf, body))
          )
            out.push(label);
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  visit(sf, false);
  return out;
}

/** The findings for one test file's text. */
export function guardFindings(path: string, text: string): string[] {
  const { guard, notGuard } = guardTag(text);
  if (guard && notGuard !== null) return [`${path}: tagged both @guard and @not-guard`];
  if (guard) {
    return selfTests(text, path).length > 0
      ? []
      : [
          `${path}: a guard with no [self-test] that plants a violation and asserts it is reported`,
        ];
  }
  if (notGuard !== null) {
    return notGuard.split(/\s+/).length >= 4
      ? []
      : [`${path}: @not-guard needs a reason of four words or more`];
  }
  return SCAN_SHAPE.test(text)
    ? [
        `${path}: reads the repository's files — tag it @guard <class> (with a [self-test]) or @not-guard: <why>`,
      ]
    : [];
}

describe("every guard proves it can fail (TASK-200, rule 4)", () => {
  const files = testFiles(ROOT);

  it("finds the test files and the guards among them", () => {
    expect(files.length).toBeGreaterThan(300);
    const guards = files.filter((f) => guardTag(readFileSync(f, "utf8")).guard);
    expect(guards.length).toBeGreaterThan(60);
  });

  it("every guard has a planted-violation [self-test]; every scan is tagged", () => {
    const findings = files.flatMap((f) => guardFindings(rel(f), readFileSync(f, "utf8")));
    expect(findings).toEqual([]);
  });

  it("[self-test] reports a guard without a self-test, an untagged scan and a bare @not-guard", () => {
    const untested = `/**\n * @guard routes that skip the tenant\n */\nit("finds the routes (self-test)", () => { expect(1).toBe(1); });`;
    expect(guardFindings("a.test.ts", untested)).toEqual([
      "a.test.ts: a guard with no [self-test] that plants a violation and asserts it is reported",
    ]);
    // A self-test that runs the scan (imported) but asserts nothing.
    const noAssert = `/** @guard x y z w */\nimport { scan } from "./helpers/scan";\nit("[self-test] plants", () => { scan("bad"); });`;
    expect(guardFindings("b.test.ts", noAssert)).toEqual([
      "b.test.ts: a guard with no [self-test] that plants a violation and asserts it is reported",
    ]);
    // Planted: the same self-test asserting on the scan passes — the assertion was what was missing.
    expect(
      guardFindings(
        "b.test.ts",
        noAssert.replace('scan("bad");', 'expect(scan("bad")).toEqual(["x"]);')
      )
    ).toEqual([]);
    // Tagged both ways.
    expect(
      guardFindings(
        "g.test.ts",
        `/**\n * @guard routes that skip the tenant\n * @not-guard: a reason of four words\n */`
      )
    ).toEqual(["g.test.ts: tagged both @guard and @not-guard"]);
    const untagged = `const t = readFileSync("app/x.ts", "utf8");\nit("x", () => expect(t).toBe(""));`;
    expect(guardFindings("c.test.ts", untagged)).toEqual([
      "c.test.ts: reads the repository's files — tag it @guard <class> (with a [self-test]) or @not-guard: <why>",
    ]);
    expect(
      guardFindings("d.test.ts", `/** @not-guard: fixture */\nreadFileSync("x")`)
    ).toEqual(["d.test.ts: @not-guard needs a reason of four words or more"]);
    const good = `/**\n * @guard routes that skip the tenant\n */\nfunction scan(n: number) { return [String(n)]; }\nit.each([1])("[self-test] reports %s", (n) => { expect(scan(n)).toEqual(["x"]); });`;
    expect(guardFindings("e.test.ts", good)).toEqual([]);
    // The fake-fetch scan helper is a scan.
    expect(
      guardFindings(
        "f.test.ts",
        'import { handWrittenBodies } from "./helpers/fake-fetch-scan";'
      )
    ).toHaveLength(1);
  });

  it("[self-test] refuses a self-test that does not run, or does not run the scan", () => {
    const head = `/**\n * @guard routes that skip the tenant\n */\nimport { scan } from "./helpers/route-policy";\nimport { readFileSync } from "fs";\n`;
    const finding = [
      "z.test.ts: a guard with no [self-test] that plants a violation and asserts it is reported",
    ];
    const planted = (test: string) => guardFindings("z.test.ts", head + test);
    // Not run: skipped, todo, x-prefixed, failing, in a skipped describe.
    for (const notRun of [
      `it.skip("[self-test] p", () => { expect(scan("bad")).toEqual(["bad"]); });`,
      `xit("[self-test] p", () => { expect(scan("bad")).toEqual(["bad"]); });`,
      `test.skip("[self-test] p", () => { expect(scan("bad")).toEqual(["bad"]); });`,
      `it.todo("[self-test] p");`,
      `it.failing("[self-test] p", () => { expect(scan("bad")).toEqual(["bad"]); });`,
      `describe.skip("d", () => { it("[self-test] p", () => { expect(scan("bad")).toEqual(["bad"]); }); });`,
      `xdescribe("d", () => { it("[self-test] p", () => { expect(scan("bad")).toEqual(["bad"]); }); });`,
    ])
      expect([notRun, planted(notRun)]).toEqual([notRun, finding]);
    // Runs, but not the scan: a trivial assertion, a built-in, a function of its own, no input.
    for (const noScan of [
      `it("[self-test] p", () => { expect(1).toBe(1); });`,
      `it("[self-test] p", () => { expect(readFileSync("x", "utf8")).toBe(""); });`,
      `it("[self-test] p", () => { const f = (x: string) => [x]; expect(f("bad")).toEqual(["bad"]); });`,
      `it("[self-test] p", () => { expect(scan()).toEqual([]); });`,
    ])
      expect([noScan, planted(noScan)]).toEqual([noScan, finding]);
    // Runs the scan: directly, a bound result, a namespace, a class of the file.
    for (const ok of [
      `it("[self-test] p", () => { expect(scan("bad")).toEqual(["bad"]); });`,
      `function started() { return { repo: { check: (b: string) => [b] } }; }\nit("[self-test] p", () => { const { repo } = started(); expect(repo.check("x")).toEqual(["x"]); });`,
      `const mm = require("../scripts/module-manifest.cjs");\nit("[self-test] p", () => { expect(mm.merge({ x: 1 })).toBeNull(); });`,
      `class Repo { check(x: string) { return [x]; } }\nit("[self-test] p", () => { expect(new Repo().check("x")).toEqual(["x"]); });`,
      `const BARE = /\\bfetch\\(/;\nit("[self-test] p", () => { const re = BARE; expect(re.test("fetch(x)")).toBe(true); });`,
    ])
      expect([ok, planted(ok)]).toEqual([ok, []]);
  });
});
