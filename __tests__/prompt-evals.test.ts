/**
 * prompt-evals.test.ts — ADR-038 conformance meta-test (D4 gate + D5 taxonomy + D7 completeness).
 *
 * The gating deterministic lane plus the comprehensiveness rules, mechanically enforced:
 *   - every registered prompt has a suite or is explicitly PENDING_EVAL (which must shrink to []);
 *   - each suite's deterministic cases all pass (parse each recorded fixture through the prompt's
 *     own parser and assert);
 *   - each suite's declared enum coverage EQUALS the union in the prompt source (so coverage can
 *     never fall behind the contract — adding an enum member without a case is a red build);
 *   - every enum member has a tagged case, and fail-closed / boundary / adversarial classes are
 *     each present.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { listPrompts } from "@/prompts";
import { EVAL_SUITES, PENDING_EVAL } from "@/prompts/evals";
import { runDeterministic } from "@/prompts/evals/runner";

const ROOT = process.cwd();

/** Members of `export type Name = "a" | "b" | ...;` (single- or multi-line). */
function unionMembers(source: string, typeName: string): string[] {
  const m = source.match(new RegExp(`export type ${typeName}\\s*=\\s*([^;]+);`, "m"));
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

describe("prompt eval harness conformance (ADR-038)", () => {
  const covered = new Set(EVAL_SUITES.map((s) => s.prompt));
  const registered = listPrompts();

  it("every registered prompt has a suite or is explicitly PENDING_EVAL", () => {
    const uncovered = registered.filter(
      (p) => !covered.has(p) && !PENDING_EVAL.includes(p)
    );
    expect(uncovered).toEqual([]);
  });

  it("PENDING_EVAL has no stale entries (registered + not yet covered)", () => {
    const stale = PENDING_EVAL.filter((p) => covered.has(p) || !registered.includes(p));
    expect(stale).toEqual([]);
  });

  for (const suite of EVAL_SUITES) {
    describe(`suite: ${suite.prompt}`, () => {
      const src = readFileSync(join(ROOT, suite.source), "utf-8");

      it("is a registered prompt", () => {
        expect(registered).toContain(suite.prompt);
      });

      it("all deterministic cases pass", () => {
        const failed = runDeterministic(suite).filter((r) => !r.passed);
        expect(failed).toEqual([]);
      });

      it("declared enum coverage equals the prompt source union", () => {
        for (const [typeName, declared] of Object.entries(suite.coverage.enums)) {
          expect([...declared].sort()).toEqual(unionMembers(src, typeName).sort());
        }
      });

      it("every enum member has a tagged case", () => {
        const tags = new Set(suite.cases.flatMap((c) => c.tags));
        const missing: string[] = [];
        for (const [typeName, members] of Object.entries(suite.coverage.enums)) {
          for (const m of members) {
            if (!tags.has(`enum:${typeName}:${m}`)) missing.push(`enum:${typeName}:${m}`);
          }
        }
        expect(missing).toEqual([]);
      });

      it("has fail-closed, boundary, and adversarial cases", () => {
        const prefixes = new Set(
          suite.cases.flatMap((c) => c.tags.map((t) => t.split(":")[0]))
        );
        expect(prefixes.has("failclosed")).toBe(true);
        expect(prefixes.has("boundary")).toBe(true);
        expect(prefixes.has("adversarial")).toBe(true);
      });
    });
  }
});
