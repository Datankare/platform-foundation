/**
 * __tests__/property-tests-configured.test.ts — every property test obeys the fuzz job's run count
 *
 * The scheduled fuzz job raises FC_NUM_RUNS to search far harder than a commit can afford. A
 * property test that does not take its parameters from helpers/fuzz.ts silently runs the default
 * count there too, so the job would claim a depth it did not reach.
 *
 * The seed likewise (TASK-198, D-16): in CI FC_SEED fixes it per commit (ci.yml), so a failure in
 * any pass replays with `FC_SEED=<seed>`. A property test that set its own seed, or a split
 * property whose parts shared one, would escape that or search the same cases four times.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import {
  currentTestFile,
  fuzzParams,
  fuzzParamsPart,
  fuzzSeed,
  seedOffsetFor,
} from "./helpers/fuzz";

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

  it("none sets its own seed (FC_SEED decides it, per commit in CI)", () => {
    const seeding = PROPERTY.filter((f) => /\bseed\s*:/.test(readFileSync(f, "utf-8")));
    expect(seeding).toEqual([]);
  });

  it("every part of a split property names its part (each part its own seed)", () => {
    const unnamed = PROPERTY.flatMap((f) =>
      [...readFileSync(f, "utf-8").matchAll(/fuzzParamsPart\(([^)]*)\)/g)]
        .filter((m) => m[1].split(",").length !== 2)
        .map((m) => `${f}: ${m[0]}`)
    );
    expect(unnamed).toEqual([]);
  });
});

describe("helpers/fuzz.ts seeds (TASK-198, D-16)", () => {
  const saved = process.env.FC_SEED;
  afterEach(() => {
    if (saved === undefined) delete process.env.FC_SEED;
    else process.env.FC_SEED = saved;
  });
  // This file's own offset: the seed every property test here draws is FC_SEED plus it.
  const own = seedOffsetFor("__tests__/property-tests-configured.test.ts");

  it("knows the running test file, and each file gets its own offset", () => {
    expect(currentTestFile()).toBe("__tests__/property-tests-configured.test.ts");
    expect(seedOffsetFor(undefined)).toBe(0);
    expect(seedOffsetFor("__tests__/a.test.ts")).not.toBe(
      seedOffsetFor("__tests__/b.test.ts")
    );
  });

  it("FC_SEED fixes the seed of every property test (plus the file's offset); unset, fast-check draws one", () => {
    process.env.FC_SEED = "123456789";
    expect(fuzzSeed()).toBe((123456789 + own) | 0);
    expect(fuzzParams()).toMatchObject({ seed: (123456789 + own) | 0 });
    delete process.env.FC_SEED;
    expect(fuzzSeed()).toBeUndefined();
    expect(fuzzParams()).not.toHaveProperty("seed");
  });

  it("a seed past 32 bits is folded into one; a value that is not an integer is an error", () => {
    process.env.FC_SEED = String(0xabcdef12);
    expect(fuzzSeed()).toBe(((0xabcdef12 | 0) + own) | 0);
    process.env.FC_SEED = "abc";
    expect(() => fuzzSeed()).toThrow(/FC_SEED must be an integer/);
  });

  it("the parts of one property each get their own seed under a fixed one", () => {
    process.env.FC_SEED = "1000";
    const base = (1000 + own) | 0;
    const seeds = [1, 2, 3, 4].map((part) => fuzzParamsPart(4, part).seed);
    expect(seeds).toEqual([base, base + 1, base + 2, base + 3].map((x) => x | 0));
    expect(() => fuzzParamsPart(4, 5)).toThrow(RangeError);
    delete process.env.FC_SEED;
    expect(fuzzParamsPart(4, 1)).not.toHaveProperty("seed");
  });
});
