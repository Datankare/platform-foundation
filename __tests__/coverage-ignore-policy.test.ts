/**
 * __tests__/coverage-ignore-policy.test.ts — security code is never hidden from coverage
 *
 * @guard a security module hidden from coverage
 *
 * Twelve security modules (permissions, audit, entitlements, consent, GDPR deletion, the admin
 * guard…) were listed in coveragePathIgnorePatterns, so coverage could not show that their
 * refusals were untested (audit 2026-10). This keeps every security module measured: the only
 * entries allowed under a security directory are barrels (index.ts), which hold no logic.
 */

import { readFileSync } from "fs";
import { join } from "path";

const SECURITY = [
  "platform/auth/",
  "platform/admin/",
  "platform/moderation/",
  "platform/gdpr/",
  "platform/rate-limit/",
  "platform/agents/",
  "platform/route-policy/",
  "platform/assurance/",
  "app/api/",
  "lib/safety",
  "lib/sanitize",
  "lib/logger",
  "proxy.ts",
];

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
const IGNORED: string[] = pkg.jest.coveragePathIgnorePatterns;

/** Ignore patterns that hide a security module (an index barrel aside). */
function hiddenSecurity(ignored: readonly string[]): string[] {
  return ignored.filter(
    (p) => SECURITY.some((s) => p.includes(s)) && !p.endsWith("/index.ts")
  );
}

describe("coverage ignore policy", () => {
  it("reads the ignore list (self-test)", () => {
    expect(IGNORED).toContain("/node_modules/");
  });

  it("hides no security module from coverage", () => {
    expect(hiddenSecurity(IGNORED)).toEqual([]);
  });

  it("[self-test] reports a planted pattern that hides a security module", () => {
    expect(
      hiddenSecurity([
        "/node_modules/",
        "platform/auth/session.ts",
        "platform/auth/index.ts",
      ])
    ).toEqual(["platform/auth/session.ts"]);
  });
});
