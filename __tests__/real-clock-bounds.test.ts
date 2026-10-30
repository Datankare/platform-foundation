/**
 * __tests__/real-clock-bounds.test.ts — no per-commit test's verdict depends on how the runner
 * schedules the CPU (TASK-198, D-13)
 *
 * TASK-191: the "Core without modules" pass failed once and passed on the rerun. One cause,
 * reproduced 1 in 8 runs under two CPU burners: R13-M2's "opens after 5 failures" ran on a real
 * clock, and a heartbeat more than 100 ms late (a GC pause, another worker) made a cache failure
 * read as event-loop lag — the breaker stayed closed. Every such test now runs on jest's fake clock;
 * the real-clock proofs run in the soak job (__tests__/soak/, .github/workflows/fuzz.yml).
 *
 * Over every per-commit test file (the jest testMatch: *.test.ts / *.test.tsx under __tests__),
 * statically:
 *
 *   1. No upper bound on real elapsed time: `expect(Date.now() - t).toBeLessThan(…)` (or
 *      performance.now(), or a variable assigned such a difference) — a loaded runner exceeds any
 *      bound — unless the test runs on the fake clock (jest.useFakeTimers in the test, or in a
 *      beforeEach / beforeAll of a describe around it).
 *   2. No synchronous busy loop (`while (Date.now() < end)`), whose verdict can depend on what
 *      else gets CPU — unless the file is listed below with the reason its verdicts cannot.
 *
 * Each allowance names its file and why the clock cannot decide it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import * as ts from "typescript";

const ROOT = join(__dirname, "..");

/** Real-elapsed upper bounds that cannot fail by the clock, by file: the reason. */
const ELAPSED_ALLOWED: Readonly<Record<string, string>> = {
  "__tests__/db/r13.db.test.ts":
    "a 10 s ceiling on withdrawing 250 holds (measured well under 1 s): it catches one round trip per hold, not a slow runner — the DB suites' own bound is 30 s",
};

/** Busy loops whose verdicts cannot depend on scheduling, by file: the reason. */
const BUSY_LOOP_ALLOWED: Readonly<Record<string, string>> = {
  "__tests__/r14-hostile.test.ts":
    "each busy loop is longer than the stamp read's bound, so it guarantees the lag a verdict needs (a heartbeat cannot fire during it) and an answer queued behind the bound's timer is read in the same turn; the cases a loaded runner could change run on the fake clock",
};

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const rel = (p: string) => relative(ROOT, p).split(sep).join("/");

/** The per-commit test files (package.json jest.testMatch). */
function testFiles(): string[] {
  return ["__tests__", "platform", "lib", "app", "components", "hooks"]
    .flatMap((d) => walk(join(ROOT, d)))
    .map(rel)
    .filter((f) => /(?:^|\/)__tests__\/.*\.test\.tsx?$/.test(f));
}

const CLOCK = /\b(?:Date|performance)\.now\(\)\s*-/;
const UPPER = new Set(["toBeLessThan", "toBeLessThanOrEqual"]);

export interface ClockFinding {
  readonly line: number;
  readonly kind: "elapsed-bound" | "busy-loop";
  readonly text: string;
}

/** The calls `it(…)`/`test(…)`/`describe(…)`/`beforeEach(…)` … whose callback holds `node`. */
function enclosingCalls(node: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n)) out.push(n);
  }
  return out;
}

const calleeName = (c: ts.CallExpression) => {
  const e = c.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) {
    const head = e.expression;
    return ts.isIdentifier(head) ? head.text : "";
  }
  return "";
};

/** Whether the test holding `node` runs on jest's fake clock. */
function onFakeClock(node: ts.Node, sf: ts.SourceFile): boolean {
  for (const call of enclosingCalls(node)) {
    const name = calleeName(call);
    if (name === "it" || name === "test") {
      if (/jest\.useFakeTimers\(/.test(call.getText(sf))) return true;
    }
    if (name === "describe") {
      // A beforeEach / beforeAll directly in this describe's callback that fakes the clock.
      const body = call.arguments[call.arguments.length - 1];
      if (body && (ts.isArrowFunction(body) || ts.isFunctionExpression(body))) {
        const hooks = (
          ts.isBlock(body.body) ? body.body.statements : ts.factory.createNodeArray()
        ).filter(
          (s) =>
            ts.isExpressionStatement(s) &&
            ts.isCallExpression(s.expression) &&
            /^before(?:Each|All)$/.test(calleeName(s.expression)) &&
            /jest\.useFakeTimers\(/.test(s.getText(sf))
        );
        if (hooks.length > 0) return true;
      }
    }
  }
  // A file-level beforeEach / beforeAll.
  return sf.statements.some(
    (s) =>
      ts.isExpressionStatement(s) &&
      ts.isCallExpression(s.expression) &&
      /^before(?:Each|All)$/.test(calleeName(s.expression)) &&
      /jest\.useFakeTimers\(/.test(s.getText(sf))
  );
}

/** Real-clock upper bounds and busy loops in one test file's source. */
export function clockFindings(source: string, name = "x.test.ts"): ClockFinding[] {
  const sf = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const elapsedVars = new Set<string>();
  const out: ClockFinding[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const collect = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      CLOCK.test(n.initializer.getText(sf))
    ) {
      elapsedVars.add(n.name.text);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const visit = (n: ts.Node) => {
    // expect(<elapsed>).toBeLessThan(…)
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      UPPER.has(n.expression.name.text)
    ) {
      let target: ts.Expression = n.expression.expression;
      if (ts.isPropertyAccessExpression(target) && target.name.text === "not")
        target = target.expression;
      if (
        ts.isCallExpression(target) &&
        ts.isIdentifier(target.expression) &&
        target.expression.text === "expect" &&
        target.arguments[0]
      ) {
        const arg = target.arguments[0];
        const text = arg.getText(sf);
        const elapsed =
          CLOCK.test(text) || (ts.isIdentifier(arg) && elapsedVars.has(arg.text));
        if (elapsed && !onFakeClock(n, sf)) {
          out.push({ line: line(n), kind: "elapsed-bound", text: n.getText(sf) });
        }
      }
    }
    // while (Date.now() < end) { … }
    if (
      (ts.isWhileStatement(n) || ts.isDoStatement(n) || ts.isForStatement(n)) &&
      /\b(?:Date|performance)\.now\(\)\s*</.test(
        (ts.isForStatement(n) ? n.condition : n.expression)?.getText(sf) ?? ""
      )
    ) {
      out.push({
        line: line(n),
        kind: "busy-loop",
        text: n.getText(sf).split("\n")[0],
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("real-clock bounds in per-commit tests (TASK-198, D-13)", () => {
  it("self-test: finds elapsed upper bounds and busy loops, and spares the fake clock", () => {
    const found = clockFindings(`
      it("a", async () => {
        const started = Date.now();
        await work();
        expect(Date.now() - started).toBeLessThan(450);
        const took = performance.now() - started;
        expect(took).not.toBeLessThanOrEqual(9);
        expect(took).toBeGreaterThanOrEqual(10);
        const end = Date.now() + 250;
        while (Date.now() < end) {}
      });
      it("b", async () => {
        jest.useFakeTimers();
        const t = Date.now();
        expect(Date.now() - t).toBeLessThan(5);
      });
      describe("c", () => {
        beforeEach(() => jest.useFakeTimers({ doNotFake: ["nextTick"] }));
        it("d", () => {
          const t = Date.now();
          expect(Date.now() - t).toBeLessThan(5);
        });
      });
    `);
    expect(found.map((f) => [f.line, f.kind])).toEqual([
      [5, "elapsed-bound"],
      [7, "elapsed-bound"],
      [10, "busy-loop"],
    ]);
  });

  const files = testFiles();
  it("finds the per-commit test files", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("__tests__/r13-hostile.test.ts");
  });

  it("no per-commit test bounds real elapsed time from above, or busy-loops, unless allowed with a reason", () => {
    const problems: string[] = [];
    const used = new Set<string>();
    for (const file of files) {
      for (const f of clockFindings(readFileSync(join(ROOT, file), "utf8"), file)) {
        const allowed =
          f.kind === "elapsed-bound" ? ELAPSED_ALLOWED[file] : BUSY_LOOP_ALLOWED[file];
        if (allowed) {
          used.add(`${f.kind}:${file}`);
          continue;
        }
        problems.push(
          f.kind === "elapsed-bound"
            ? `${file}:${f.line} bounds real elapsed time (${f.text}) — a loaded runner exceeds any bound: run the test on jest's fake clock (jest.useFakeTimers) and assert the time it measures, or move the real-clock proof to __tests__/soak/`
            : `${file}:${f.line} busy-loops on the real clock (${f.text}) — its verdict can depend on what else gets CPU: use the fake clock, or move it to __tests__/soak/, or list the file in BUSY_LOOP_ALLOWED with why it cannot`
        );
      }
    }
    expect(problems).toEqual([]);
    // Every allowance is still needed, and each says why.
    const stale = [
      ...Object.keys(ELAPSED_ALLOWED).map((f) => `elapsed-bound:${f}`),
      ...Object.keys(BUSY_LOOP_ALLOWED).map((f) => `busy-loop:${f}`),
    ].filter((k) => !used.has(k));
    expect(stale).toEqual([]);
    for (const reason of [
      ...Object.values(ELAPSED_ALLOWED),
      ...Object.values(BUSY_LOOP_ALLOWED),
    ]) {
      expect(reason.length).toBeGreaterThan(40);
    }
  });
});
