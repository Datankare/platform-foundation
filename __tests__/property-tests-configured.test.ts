/**
 * __tests__/property-tests-configured.test.ts — every property test obeys the fuzz job's run count
 *
 * The scheduled fuzz job raises FC_NUM_RUNS to search far harder than a commit can afford. A
 * property test that does not take its parameters from helpers/fuzz.ts silently runs the default
 * count there too, so the job would claim a depth it did not reach.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = process.cwd();

function tests(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tests(p));
    else if (/\.test\.tsx?$/.test(name)) out.push(relative(ROOT, p));
  }
  return out;
}

const ALL = ["__tests__", "platform", "lib", "app"].flatMap((d) => tests(join(ROOT, d)));
const PROPERTY = ALL.filter((f) =>
  /^import[\s\S]*?from\s*["']fast-check["']/m.test(readFileSync(f, "utf-8"))
);

describe("property tests", () => {
  it("finds the property tests (self-test)", () => {
    expect(PROPERTY.length).toBeGreaterThanOrEqual(2);
  });

  it("each takes its run count from helpers/fuzz.ts", () => {
    const unconfigured = PROPERTY.filter(
      (f) => !/fc\.configureGlobal\(fuzzParams\(\)\)/.test(readFileSync(f, "utf-8"))
    );
    expect(unconfigured).toEqual([]);
  });

  it("none overrides the run count per assertion (the deep job would not reach its depth)", () => {
    const overriding = PROPERTY.filter((f) =>
      /\bnumRuns\s*:/.test(readFileSync(f, "utf-8"))
    );
    expect(overriding).toEqual([]);
  });
});
