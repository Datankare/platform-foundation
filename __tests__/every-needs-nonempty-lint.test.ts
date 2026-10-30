/**
 * __tests__/every-needs-nonempty-lint.test.ts — the lint rule behind TASK-198 D-19
 * (eslint-rules/every-needs-nonempty.cjs): `expect(xs.every(…)).toBe(true)` must come with an
 * assertion that xs is not empty, in the same test.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { RuleTester } from "eslint";
import * as tsParser from "@typescript-eslint/parser";

const rule = require("../eslint-rules/every-needs-nonempty.cjs");

const tester = new RuleTester({
  languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: "module" },
});

const inTest = (body: string) => `it("x", async () => {\n${body}\n});`;

describe("pf-tests/every-needs-nonempty", () => {
  // RuleTester declares its own describe/it blocks.
  {
    tester.run("every-needs-nonempty", rule, {
      valid: [
        inTest("expect(xs).toHaveLength(3);\nexpect(xs.every((x) => x.ok)).toBe(true);"),
        inTest("expect(xs.length).toBeGreaterThan(0);\nexpect(xs.every(f)).toBe(true);"),
        inTest(
          "expect(xs.map((x) => x.id)).toEqual([1, 2]);\nexpect(xs.every(f)).toBe(true);"
        ),
        inTest("expect(xs).toContain(a);\nexpect(xs.every(f)).toBeTruthy();"),
        // After the every() fails an empty list just as well.
        inTest("expect(xs.every(f)).toBe(true);\nexpect(xs).toHaveLength(80);"),
        inTest(
          "expect(fn).toHaveBeenCalledTimes(2);\nexpect(fn.mock.calls.every(f)).toBe(true);"
        ),
        // Fails on an empty list by itself: every() expected false.
        inTest("expect(xs.every(f)).toBe(false);"),
        inTest("expect(xs.some(f)).toBe(true);"),
      ],
      invalid: [
        {
          code: inTest("expect(xs.every((x) => x.ok)).toBe(true);"),
          errors: [{ messageId: "empty" }],
        },
        {
          code: inTest("expect(xs).toHaveLength(0);\nexpect(xs.every(f)).toBe(true);"),
          errors: [{ messageId: "empty" }],
        },
        {
          code: inTest(
            "expect(xs.length).toBeGreaterThanOrEqual(0);\nexpect(xs.every(f)).toEqual(true);"
          ),
          errors: [{ messageId: "empty" }],
        },
        {
          // Greater than -1 holds for an empty list (round 1).
          code: inTest(
            "expect(xs.length).toBeGreaterThan(-1);\nexpect(xs.every(f)).toBe(true);"
          ),
          errors: [{ messageId: "empty" }],
        },
        {
          code: inTest(
            "expect(xs.length).toBeGreaterThan(n);\nexpect(xs.every(f)).toBe(true);"
          ),
          errors: [{ messageId: "empty" }],
        },
        {
          code: inTest("expect(fn.mock.calls.every((c) => c[0] === 1)).toBe(true);"),
          errors: [{ messageId: "empty" }],
        },
        {
          code: inTest("expect(ys).toHaveLength(2);\nexpect(xs.every(f)).toBeTruthy();"),
          errors: [{ messageId: "empty" }],
        },
        {
          // Another test's assertion does not count.
          code: `${inTest("expect(xs).toHaveLength(2);")}\n${inTest("expect(xs.every(f)).toBe(true);")}`,
          errors: [{ messageId: "empty" }],
        },
      ],
    });
  }

  it("is on, as an error, for the test files in the lint configuration", () => {
    // Read as text: loading eslint.config.mjs needs ESM support jest is not run with.
    const config = readFileSync(join(__dirname, "../eslint.config.mjs"), "utf8");
    expect(config).toMatch(/"pf-tests\/every-needs-nonempty": "error"/);
    expect(config).toMatch(
      /createRequire\(import\.meta\.url\)\(\s*"\.\/eslint-rules\/every-needs-nonempty\.cjs"/
    );
    for (const glob of [
      '"**/__tests__/**/*.ts"',
      '"**/*.test.ts"',
      '"e2e/**/*.ts"',
      '"e2e-live/**/*.ts"',
    ])
      expect(config).toContain(glob);
  });
});
