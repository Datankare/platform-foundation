/**
 * __tests__/no-stubbed-guards.test.ts — No test replaces the guard it relies on
 *
 * Adversarial Validation practice 5 (CONTRIBUTING.md): a test that asserts authorization never
 * stubs the guard it asserts. In October 2026 every admin route test mocked adminGuard to allow,
 * so a moderator reaching super_admin through the command bar passed every test (TASK-145,
 * learning 116). Authorization tests send real roles through the real guard instead
 * (helpers/test-identities.ts); this test keeps it that way.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

/** Modules that decide who may do what. Tests use them as they are. */
const GUARDS = ["@/platform/auth/admin-guard", "@/platform/auth/role-governance"];

const ROOT = process.cwd();

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...testFiles(p));
    else if (/\.test\.tsx?$/.test(name))
      out.push(relative(ROOT, p).split("\\").join("/"));
  }
  return out;
}

const FILES = ["__tests__", "platform", "app", "lib", "components"].flatMap((d) => {
  try {
    return testFiles(join(ROOT, d));
  } catch {
    return [];
  }
});

describe("no stubbed guards", () => {
  it("finds the test files (self-test)", () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES).toContain("__tests__/no-stubbed-guards.test.ts");
  });

  it.each(GUARDS)("no test mocks or spies on %s", (guard) => {
    // By its alias or by any relative path ending in the module's name, and with jest.spyOn on
    // the module object (release review: a relative path or a spy evaded the check).
    const moduleName = guard.split("/").pop() as string;
    const path = `(?:${guard.replace(/[/.-]/g, "\\$&")}|(?:\\.{1,2}/)+(?:[\\w.-]+/)*${moduleName})`;
    const mock = new RegExp(
      `jest\\.(?:mock|doMock|unstable_mockModule|requireMock)\\(\\s*["'\`]${path}["'\`]`
    );
    const spy = new RegExp(
      `import\\s+\\*\\s+as\\s+(\\w+)\\s+from\\s+["'\`]${path}["'\`]`
    );
    const offenders = FILES.filter((f) => {
      if (f === "__tests__/no-stubbed-guards.test.ts") return false;
      const src = readFileSync(join(ROOT, f), "utf-8");
      if (mock.test(src)) return true;
      const ns = spy.exec(src)?.[1];
      return ns !== undefined && new RegExp(`jest\\.spyOn\\(\\s*${ns}\\b`).test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("the check catches a relative-path mock and a spy", () => {
    const moduleName = "admin-guard";
    const path = `(?:@/platform/auth/admin-guard|(?:\\.{1,2}/)+(?:[\\w.-]+/)*${moduleName})`;
    const mock = new RegExp(`jest\\.(?:mock|doMock)\\(\\s*["'\`]${path}["'\`]`);
    expect(mock.test('jest.mock("../admin-guard", () => ({}))')).toBe(true);
    expect(mock.test('jest.mock("../../platform/auth/admin-guard")')).toBe(true);
    expect(mock.test('jest.mock("../admin-guard-helpers")')).toBe(false);
  });
});
