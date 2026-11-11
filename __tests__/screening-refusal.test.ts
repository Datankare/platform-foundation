/**
 * __tests__/screening-refusal.test.ts — only a block is `content.rejected` (TASK-211, N-119)
 *
 * @guard a route that answers screened input `content.rejected` itself, or screens input without
 * answering through lib/screening-refusal.ts
 *
 * Every screen links `content.rejected` to the account page, where the decision is appealed — but
 * the routes answered it for a block, a hold for a moderator and an outage alike, and for the
 * model's own output: only a block is a decision recorded against the account, so the link led
 * to nothing to appeal (found walking the assistant page with no model key). Now:
 *
 *   input     checkSafety carries the screening's decision; a route answers by
 *             screeningRefusal — block → content.rejected, escalate → content.held_for_review,
 *             unjudged → service.unavailable (moderation);
 *   output    withheld model output is content.withheld (no appeal);
 *   statically, no production source names "content.rejected" but the mapping and the
 *   registries that define and render it, and every source that calls checkSafety answers
 *   through screeningRefusal (or injects it into code that does, named below).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import ts from "typescript";
import { filesUnder, isTest } from "./helpers/reachability";
import { screeningRefusal } from "@/lib/screening-refusal";

const mockScreen = jest.fn();
jest.mock("@/platform/moderation", () => ({
  ...jest.requireActual("@/platform/moderation"),
  screenContent: (...a: unknown[]) => mockScreen(...a),
}));

import { checkSafety } from "@/lib/safety";

const ROOT = join(__dirname, "..");

/** The sources that may name "content.rejected": the mapping, and where the code is defined. */
export const MAY_NAME_REJECTED: Readonly<Record<string, string>> = {
  "lib/screening-refusal.ts":
    "the mapping: the one place a block becomes content.rejected",
  "platform/errors/registry.ts":
    "the code's definition (status, params, what a caller does)",
  "platform/errors/refusal.ts": "the code's handling kind for screens",
  "components/refusal/RefusalNotice.tsx":
    "the screen's appeal rule: a block offers its appeal",
};

/**
 * Sources that call checkSafety only to inject it into code that answers through the mapping
 * (the effects pattern): the source, and the module that answers. Checked only where present.
 */
export const INJECTS_SCREENING: Readonly<Record<string, string>> = {
  "app/api/translate/dispatch/route.ts": "lib/translate-session.ts",
};

const DIRS = ["app", "lib", "components", "hooks", "platform", "modules"];

/** The string literals of a source (comments are not strings). */
export function stringLiterals(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteralLike(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Whether a source calls checkSafety( (not a property or a declaration of it). */
export function callsCheckSafety(fileName: string, source: string): boolean {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "checkSafety"
    )
      found = true;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** The production sources that break the rule, each with why. */
export function screeningViolations(root: string): string[] {
  const sources = DIRS.flatMap((d) => filesUnder(root, d)).filter((f) => !isTest(f));
  const out: string[] = [];
  for (const f of sources) {
    const text = readFileSync(join(root, f), "utf8");
    if (!MAY_NAME_REJECTED[f] && stringLiterals(f, text).includes("content.rejected"))
      out.push(
        `${f}: names content.rejected (answer screened input with screeningRefusal)`
      );
    if (f === "lib/safety.ts" || !callsCheckSafety(f, text)) continue;
    const answers = (rel: string) =>
      existsSync(join(root, rel)) &&
      readFileSync(join(root, rel), "utf8").includes("screeningRefusal(");
    const injectedInto = INJECTS_SCREENING[f];
    if (!(text.includes("screeningRefusal(") || (injectedInto && answers(injectedInto))))
      out.push(`${f}: calls checkSafety without answering through screeningRefusal`);
  }
  return out;
}

describe("screeningRefusal: each decision its own answer (N-119)", () => {
  it.each([
    ["block", "content.rejected", {}],
    ["escalate", "content.held_for_review", {}],
    ["unjudged", "service.unavailable", { service: "moderation" }],
    [undefined, "content.held_for_review", {}],
  ] as const)("%s → %s", (decision, code, params) => {
    expect(screeningRefusal({ decision })).toEqual({ code, params });
  });
});

describe("checkSafety carries the screening's decision (N-119)", () => {
  const result = (over: Record<string, unknown>) => ({
    action: "allow",
    blocklistMatches: [],
    reasoning: [],
    ...over,
  });
  beforeEach(() => mockScreen.mockReset());

  it.each([
    ["a blocklist block", { action: "block", blocklistMatches: ["x"] }, "block"],
    [
      "a classifier block",
      {
        action: "block",
        classifierOutput: { safe: false, categories: [], confidence: 1 },
      },
      "block",
    ],
    [
      "an escalation (queued for a moderator)",
      {
        action: "escalate",
        classifierOutput: { safe: true, categories: [], confidence: 0.5 },
      },
      "escalate",
    ],
    [
      "nothing judged (an outage: withheld, never queued)",
      { action: "escalate", screeningUnavailable: true, unjudgedReason: "unavailable" },
      "unjudged",
    ],
  ])("%s → not safe, decision %s", async (_name, over, decision) => {
    mockScreen.mockResolvedValue(result(over));
    const r = await checkSafety("text", { requestId: "req-1", userId: "u-1" });
    expect(r.safe).toBe(false);
    expect(r.decision).toBe(decision);
  });

  it.each([["allow"], ["warn"]])("%s → safe, no decision", async (action) => {
    mockScreen.mockResolvedValue(result({ action }));
    const r = await checkSafety("text", { requestId: "req-1" });
    expect(r).toEqual({ safe: true });
  });
});

describe("no route answers screened input content.rejected itself (N-119)", () => {
  it("every production source answers through screeningRefusal", () => {
    expect(screeningViolations(ROOT)).toEqual([]);
  });

  it("each allowed source exists, and names the code (the lists are exact)", () => {
    for (const f of Object.keys(MAY_NAME_REJECTED)) {
      const text = readFileSync(join(ROOT, f), "utf8");
      expect([f, stringLiterals(f, text).includes("content.rejected")]).toEqual([
        f,
        true,
      ]);
    }
    for (const [f, into] of Object.entries(INJECTS_SCREENING)) {
      if (!existsSync(join(ROOT, f))) continue; // a consumer's route: absent here
      expect([f, callsCheckSafety(f, readFileSync(join(ROOT, f), "utf8"))]).toEqual([
        f,
        true,
      ]);
      expect([into, existsSync(join(ROOT, into))]).toEqual([into, true]);
    }
  });

  it("[self-test] a literal is found, a comment is not; a checkSafety call is told apart", () => {
    expect(
      stringLiterals("a.ts", '// "content.rejected"\nconst c = "content.rejected";')
    ).toEqual(["content.rejected"]);
    expect(stringLiterals("a.ts", '/* "content.rejected" */ const c = 1;')).toEqual([]);
    expect(callsCheckSafety("a.ts", "await checkSafety(text, {});")).toBe(true);
    expect(callsCheckSafety("a.ts", "effects.checkSafety(text);")).toBe(false);
    expect(callsCheckSafety("a.ts", "export async function checkSafety() {}")).toBe(
      false
    );
  });

  it("[self-test] on a scratch tree: a route naming the code, or screening without the mapping, is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "screening-refusal-"));
    const put = (rel: string, text: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    try {
      put(
        "app/api/ok/route.ts",
        "const s = await checkSafety(t);\nconst r = screeningRefusal(s);\n"
      );
      put("app/api/output/route.ts", 'return apiError("content.withheld", {});\n');
      expect(screeningViolations(root)).toEqual([]);
      put(
        "app/api/old/route.ts",
        'if (!s.safe) return apiError("content.rejected", {});\n'
      );
      put("lib/screen.ts", "export const go = (t: string) => checkSafety(t);\n");
      put("__tests__/x.test.ts", 'expect(code).toBe("content.rejected");\n');
      expect(screeningViolations(root)).toEqual([
        "app/api/old/route.ts: names content.rejected (answer screened input with screeningRefusal)",
        "lib/screen.ts: calls checkSafety without answering through screeningRefusal",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
