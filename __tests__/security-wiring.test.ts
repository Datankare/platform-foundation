/**
 * __tests__/security-wiring.test.ts — every security control is called, or listed as not (audit 2026-10)
 *
 * The audit's most common failure was a control built, tested and never called: tests passed
 * because they called it; no production path did. This finds every exported security control in
 * the security modules — by name (check…, enforce…, require…, screen…, verify…, validate…,
 * record…, purge…, grant…, revoke…, register… for extension points…) — and requires a reference
 * from production code (app, platform, lib, hooks, components, root entry points; never tests,
 * mocks or scripts), or an entry in platform/assurance/unwired-security.ts with the reason.
 *
 * Limit, stated: "referenced" is not "reachable". A control called only by another unwired
 * function counts as referenced. The register and the independent review cover that gap.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { UNWIRED_SECURITY } from "@/platform/assurance/unwired-security";
import { productionSources, ROOT } from "./helpers/route-policy";

/** Modules whose exports are security controls. */
const SECURITY_MODULES = [
  "platform/auth/",
  "platform/moderation/",
  "platform/gdpr/",
  "platform/rate-limit/",
  "platform/agents/",
  "platform/admin/",
  "platform/ai/",
  "lib/safety.ts",
  "lib/sanitize.ts",
];

/** Names that make an export a control (an action that enforces, records or decides). */
const CONTROL_NAME =
  /^(?:check|enforce|require|screen|verify|validate|guard|evaluate|record|purge|hardPurge|softDelete|redact|sanitize|holds|classify|grant|revoke|consume|audited|adminGuard|writeGoverned|approveAndApply|is\w*(?:Allowed|Breached|Required|Controlled))/;

/** Extension points a production path must call for the control behind them to exist. */
const EXTENSION_POINTS = [
  "registerDeletionModule",
  "registerExportModule",
  "registerDevice",
  "registerWorkflow",
  "setModalityClassifiers",
];

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Source with comments, imports and re-exports removed: naming a function is not calling it. */
const stripNonCode = (src: string): string =>
  stripComments(src)
    .replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];?/gm, "")
    .replace(/^\s*export\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?/gm, "");

// The register itself names every unwired control; it is not a caller.
const SOURCES = productionSources().filter((f) => !f.startsWith("platform/assurance/"));
const CODE = new Map(
  SOURCES.map((f) => [f, stripNonCode(readFileSync(join(ROOT, f), "utf-8"))])
);

interface Control {
  readonly key: string;
  readonly file: string;
  readonly name: string;
}

function controls(): Control[] {
  const out: Control[] = [];
  for (const file of SOURCES) {
    if (file.endsWith("/index.ts")) continue;
    if (
      !SECURITY_MODULES.some((m) => (m.endsWith("/") ? file.startsWith(m) : file === m))
    )
      continue;
    const src = CODE.get(file) ?? "";
    for (const m of src.matchAll(
      /^export\s+(?:async\s+)?(?:function\*?|const)\s+(\w+)/gm
    )) {
      const name = m[1];
      if (CONTROL_NAME.test(name) || EXTENSION_POINTS.includes(name)) {
        out.push({ key: `${file}#${name}`, file, name });
      }
    }
  }
  return out;
}

/**
 * Used by production code other than its own definition: called (`name(`), constructed, or
 * passed as a value (`name,` / `name)`) — not merely imported, typed or mentioned in a string
 * (release review: an import alone counted as wired).
 */
function isWired(c: Control): boolean {
  const ref = new RegExp(
    `(?<!["'\`])\\b${c.name}\\b(?=\\s*(?:\\(|<[^>]*>\\s*\\(|[,)\\]}]))`,
    "g"
  );
  for (const [file, src] of CODE) {
    if (file.endsWith("/index.ts")) continue;
    const hits = src.match(ref)?.length ?? 0;
    if (file === c.file ? hits > 1 : hits > 0) return true;
  }
  return false;
}

const ALL = controls();

describe("security wiring (audit 2026-10: built, tested, never called)", () => {
  it("finds the security controls (self-test before any absence counts)", () => {
    expect(ALL.length).toBeGreaterThan(40);
    const keys = ALL.map((c) => c.key);
    expect(keys).toContain("platform/auth/admin-guard.ts#requireAdmin");
    expect(keys).toContain("lib/safety.ts#checkSafety");
    expect(keys).toContain("platform/rate-limit/daily-quota.ts#enforceDailyPaidQuota");
  });

  it("the wiring check sees a real caller, and ignores one inside a comment", () => {
    const requireAdmin = ALL.find((c) => c.name === "requireAdmin")!;
    expect(isWired(requireAdmin)).toBe(true);
    expect(stripComments("// requireAdmin(request)\n/* checkSafety(x) */")).not.toMatch(
      /requireAdmin|checkSafety/
    );
  });

  it("an import or a re-export is not a use", () => {
    const src = stripNonCode(
      'import { hardPurgeUser } from "x";\nexport { softDeleteUser } from "y";\nconst a = 1;'
    );
    expect(src).not.toMatch(/hardPurgeUser|softDeleteUser/);
  });

  it("every control has a production caller, or is registered as unwired with the reason", () => {
    const unlisted = ALL.filter((c) => !isWired(c) && !UNWIRED_SECURITY[c.key]).map(
      (c) => c.key
    );
    expect(unlisted).toEqual([]);
  });

  it("no registered control has gained a caller (remove it from the register)", () => {
    const stale = ALL.filter((c) => UNWIRED_SECURITY[c.key] && isWired(c)).map(
      (c) => c.key
    );
    expect(stale).toEqual([]);
  });

  it("every register entry names a real control and gives a reason", () => {
    const keys = new Set(ALL.map((c) => c.key));
    for (const [key, reason] of Object.entries(UNWIRED_SECURITY)) {
      expect({ key, exists: keys.has(key), reason: reason.trim().length > 20 }).toEqual({
        key,
        exists: true,
        reason: true,
      });
    }
  });
});
