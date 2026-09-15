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
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { listPrompts } from "@/prompts";
import { EVAL_SUITES, PENDING_EVAL, TOOL_USE_EXEMPT } from "@/prompts/evals";
import { runDeterministic } from "@/prompts/evals/runner";

const ROOT = process.cwd();

/** Members of `export type Name = "a" | "b" | ...;` (single- or multi-line). */
function unionMembers(source: string, typeName: string): string[] {
  const m = source.match(new RegExp(`export type ${typeName}\\s*=\\s*([^;]+);`, "m"));
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** Locate the prompt source file whose config declares `name: "<name>"`. */
function promptFileFor(name: string): string | null {
  const dirs = [join(ROOT, "prompts")];
  while (dirs.length) {
    const dir = dirs.pop() as string;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "__tests__" && entry !== "evals") dirs.push(full);
      } else if (/-v\d+\.ts$/.test(entry)) {
        if (new RegExp(`name:\\s*"${name}"`).test(readFileSync(full, "utf-8")))
          return full;
      }
    }
  }
  return null;
}

describe("prompt eval harness conformance (ADR-038)", () => {
  const covered = new Set(EVAL_SUITES.map((s) => s.prompt));
  const registered = listPrompts();

  it("every registered prompt is covered by a suite or TOOL_USE_EXEMPT (nothing lingers)", () => {
    const unaccounted = registered.filter(
      (p) => !covered.has(p) && !TOOL_USE_EXEMPT.includes(p) && !PENDING_EVAL.includes(p)
    );
    expect(unaccounted).toEqual([]);
  });

  it("PENDING_EVAL is drained", () => {
    expect([...PENDING_EVAL]).toEqual([]);
  });

  it("TOOL_USE_EXEMPT holds only registered, genuinely parserless prompts", () => {
    for (const name of TOOL_USE_EXEMPT) {
      expect(registered).toContain(name);
      const file = promptFileFor(name);
      expect(file).not.toBeNull();
      expect(readFileSync(file as string, "utf-8")).not.toMatch(
        /export function parse\w+Response/
      );
    }
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
