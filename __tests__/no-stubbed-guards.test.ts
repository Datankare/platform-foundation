/**
 * __tests__/no-stubbed-guards.test.ts — No test replaces the guard it relies on
 *
 * Adversarial Validation practice 5 (CONTRIBUTING.md): a test that asserts authorization never
 * stubs the guard it asserts. In October 2026 every admin route test mocked adminGuard to allow,
 * so a moderator reaching super_admin through the command bar passed every test (TASK-145,
 * learning 116). Authorization tests send real roles through the real guard instead
 * (helpers/test-identities.ts); this test keeps it that way.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, relative } from "path";
import { APP_ROUTE_POLICY } from "@/platform/route-policy/app-route-policy";
import { definitionsOf } from "./helpers/route-policy";

/** Modules that decide who may do what. Tests use them as they are. */
/** Escape every regular-expression metacharacter (CodeQL js/incomplete-sanitization). */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

const ROOT = process.cwd();

/**
 * The platform's guards, and every module that defines a verifier the app declares
 * (app-route-policy.ts `verifiers`, e.g. a consumer's lib/route-guard.ts): a consumer's guard
 * mocked to allow everything hid its route tests' authorization the same way (audit A-18).
 */
const APP_GUARDS = APP_ROUTE_POLICY.verifiers.flatMap((name) =>
  definitionsOf(name).map((file) => `@/${file.replace(/\.tsx?$/, "")}`)
);
const GUARDS = [
  ...new Set([
    "@/platform/auth/admin-guard",
    "@/platform/auth/role-governance",
    "@/platform/auth/actor-guard",
    ...APP_GUARDS,
  ]),
];

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
    const moduleName = escapeRegExp(guard.split("/").pop() as string);
    const path = `(?:${escapeRegExp(guard)}|(?:\\.{1,2}/)+(?:[\\w.-]+/)*${moduleName})`;
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

  it.each(GUARDS)("no manual mock (__mocks__) replaces %s", (guard) => {
    // A __mocks__ file next to a guard replaces it in every test that calls jest.mock on it —
    // and in Playform's case answered "allowed" for every caller (audit A-18).
    const file = guard.replace(/^@\//, "");
    const manual = ["ts", "tsx", "js"].map((ext) =>
      join(ROOT, dirname(file), "__mocks__", `${file.split("/").pop()}.${ext}`)
    );
    expect(manual.filter((m) => existsSync(m)).map((m) => relative(ROOT, m))).toEqual([]);
  });

  it("covers the platform's actor guard and each declared app verifier's module", () => {
    expect(GUARDS).toContain("@/platform/auth/actor-guard");
    expect(GUARDS).toEqual(expect.arrayContaining(APP_GUARDS));
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
