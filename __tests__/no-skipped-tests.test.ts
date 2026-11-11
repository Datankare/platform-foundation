/**
 * @jest-environment node
 */
/**
 * __tests__/no-skipped-tests.test.ts — no Jest test is focused, skipped, left to do or expected to
 * fail (TASK-209)
 *
 * @guard a focused, skipped, to-do or failing-by-design Jest test
 *
 * A focused test (`it.only`, `fit`, `describe.only`) runs alone and silently drops every other in
 * its file; a skipped one (`it.skip`, `xit`, `describe.skip`, `(cond ? it : it.skip)(…)`), a
 * `todo` and a `.failing` look like coverage and check nothing. Jest reports such a file
 * "focused", not "passed", and the gates' totals hide it among the passes (55i found three
 * suites, thirteen tests, skipped by a condition on the repository they ran in). So a test that
 * applies to one repository only runs in both and says what holds in the other.
 *
 * The scan reads every file Jest loads as a test or helper — any file under a `__tests__`
 * directory, and the live eval runner — and refuses `it`, `test` or `describe` (and their
 * `.each` / `.concurrent` chains) with `.only`, `.skip`, `.todo` or `.failing`, and the aliases
 * `fit`, `fdescribe`, `ftest`, `xit`, `xtest`, `xdescribe`, wherever they appear as code (a string
 * that spells one — the process check's fixtures — is not code). Allowed, and only these: the
 * two availability gates, `dbDescribe` (helpers/db.ts) and `valkeyDescribe`
 * (helpers/valkey-server.ts), each a failure under REQUIRE_DB_TESTS / REQUIRE_VALKEY_TESTS (as CI
 * runs) — checked here too.
 */
import { readFileSync } from "fs";
import { join, relative, sep } from "path";
import * as ts from "typescript";
import { walkFiles } from "./helpers/repo-files";

const ROOT = join(__dirname, "..");
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");

const RUNNERS = new Set(["it", "test", "describe"]);
const MODIFIERS = new Set(["only", "skip", "todo", "failing"]);
const ALIASES = new Set(["fit", "fdescribe", "ftest", "xit", "xtest", "xdescribe"]);

/** The two availability gates, and the variable each must throw on under CI. */
export const ALLOWED: Readonly<Record<string, string>> = {
  "__tests__/helpers/db.ts": "REQUIRE_DB_TESTS",
  "__tests__/helpers/valkey-server.ts": "REQUIRE_VALKEY_TESTS",
};

/** The root identifier of a property chain (`it.concurrent.skip` → "it"), or undefined. */
function chainRoot(e: ts.Expression): string | undefined {
  let n: ts.Expression = e;
  while (ts.isPropertyAccessExpression(n) || ts.isCallExpression(n))
    n = ts.isPropertyAccessExpression(n) ? n.expression : n.expression;
  return ts.isIdentifier(n) ? n.text : undefined;
}

/** Every focus or skip in `source` (a file's text), as "<file>:<line> <what>". */
export function skippedTests(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const at = (n: ts.Node, what: string) =>
    out.push(
      `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${what}`
    );
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && MODIFIERS.has(n.name.text)) {
      const root = chainRoot(n.expression);
      if (root && RUNNERS.has(root)) at(n, n.getText(sf).replace(/\s+/g, ""));
    } else if (
      ts.isIdentifier(n) &&
      ALIASES.has(n.text) &&
      !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) &&
      !(ts.isPropertyAssignment(n.parent) && n.parent.name === n) &&
      !(ts.isVariableDeclaration(n.parent) && n.parent.name === n) &&
      !(ts.isParameter(n.parent) && n.parent.name === n)
    ) {
      at(n, n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The files Jest loads as tests or their helpers. */
function jestFiles(): string[] {
  return [
    ...walkFiles(ROOT, (n) => /\.(?:[cm]?[jt]s|tsx)$/.test(n)).filter((p) =>
      /[\\/]__tests__[\\/]/.test(p)
    ),
    join(ROOT, "prompts/evals/live.run.ts"),
  ]
    .filter((p) => {
      try {
        readFileSync(p);
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

/** What the repository's Jest files focus or skip, less the two availability gates. */
export function repositorySkips(
  files: readonly string[],
  read: (f: string) => string
): string[] {
  return files.flatMap((f) => {
    const r = rel(f);
    const found = skippedTests(r, read(f));
    if (!(r in ALLOWED)) return found;
    // A gate: its one `describe.skip`, and only where its variable makes a missing service fail.
    const text = read(f);
    const gate = new RegExp(
      `process\\.env\\.${ALLOWED[r]} === "1"[\\s\\S]*?throw new Error`
    );
    return found.length === 1 && found[0]!.endsWith(" describe.skip") && gate.test(text)
      ? []
      : found;
  });
}

describe("no Jest test is focused or skipped (TASK-209)", () => {
  it("in every test file and helper, the two availability gates aside", () => {
    const files = jestFiles();
    expect(files.length).toBeGreaterThan(300);
    expect(files.map(rel)).toEqual(expect.arrayContaining(Object.keys(ALLOWED)));
    expect(repositorySkips(files, (f) => readFileSync(f, "utf8"))).toEqual([]);
  });

  it("[self-test] finds every way to focus or skip; strings, other objects and declarations are not", () => {
    const planted = [
      'it.only("a", () => {});',
      'test.skip("b", () => {});',
      'describe.only("c", () => {});',
      'it.todo("d");',
      'it.failing("e", () => {});',
      'test.skip.each([1])("f", () => {});',
      'it.concurrent.only("g", async () => {});',
      'fit("h", () => {});',
      'xdescribe("i", () => {});',
      "const maybe = cond ? it : it.skip;",
      "(cond ? it : xit)('j', () => {});",
      "it . only ('k', () => {});",
    ].join("\n");
    expect(skippedTests("planted.test.ts", planted)).toEqual([
      "planted.test.ts:1 it.only",
      "planted.test.ts:2 test.skip",
      "planted.test.ts:3 describe.only",
      "planted.test.ts:4 it.todo",
      "planted.test.ts:5 it.failing",
      "planted.test.ts:6 test.skip",
      "planted.test.ts:7 it.concurrent.only",
      "planted.test.ts:8 fit",
      "planted.test.ts:9 xdescribe",
      "planted.test.ts:10 it.skip",
      "planted.test.ts:11 xit",
      "planted.test.ts:12 it.only",
    ]);
    const fine = [
      '\'it.skip("a")\'; `xit("b")`;',
      "const r = parser.skip(2); list.only(); jest.fn().mockName('x');",
      "it.each([1])('c', () => {});",
      "describe('d', () => { it('e', () => {}); });",
      "const o = { fit: 1 }; o.fit;",
    ].join("\n");
    expect(skippedTests("fine.test.ts", fine)).toEqual([]);
  });

  it("[self-test] an availability gate is allowed only as one describe.skip that fails under CI", () => {
    const gate =
      'if (process.env.REQUIRE_DB_TESTS === "1" && !ok) {\n  throw new Error("x");\n}\n' +
      "export const dbDescribe = ok ? describe : describe.skip;\n";
    const files = ["__tests__/helpers/db.ts", "__tests__/helpers/valkey-server.ts"].map(
      (f) => join(ROOT, f)
    );
    const texts: Record<string, string> = {
      "__tests__/helpers/db.ts": gate,
      // No throw under its variable: the skip would pass CI silently.
      "__tests__/helpers/valkey-server.ts":
        "export const valkeyDescribe = ok ? describe : describe.skip;\n",
    };
    expect(repositorySkips(files, (f) => texts[rel(f)]!)).toEqual([
      "__tests__/helpers/valkey-server.ts:1 describe.skip",
    ]);
    // A second skip beside the gate is refused too.
    texts["__tests__/helpers/db.ts"] = gate + "it.skip('x', () => {});\n";
    texts["__tests__/helpers/valkey-server.ts"] = gate.replace(
      "REQUIRE_DB_TESTS",
      "REQUIRE_VALKEY_TESTS"
    );
    expect(repositorySkips(files, (f) => texts[rel(f)]!)).toEqual([
      "__tests__/helpers/db.ts:4 describe.skip",
      "__tests__/helpers/db.ts:5 it.skip",
    ]);
  });
});
