/**
 * ADR-051 D5 (b), ratchet phase (7A A4a → A4b): counts error responses that are still free text —
 * a NextResponse.json / Response.json body with an `error` field and no `code` — across app/api,
 * platform and lib. The count must equal the checked-in baseline: converting a response means
 * lowering the baseline in the same commit, so it can only go down. A4b takes it to zero and
 * replaces this ratchet with a hard rule (every error through apiError).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import * as ts from "typescript";
import baseline from "@/platform/errors/free-text-baseline.json";

const ROOT = join(__dirname, "..");
const DIRS = ["app/api", "platform", "lib"];

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      return name === "__tests__" || name === "node_modules" ? [] : files(p);
    }
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

function freeTextErrorSites(): string[] {
  const sites: string[] = [];
  for (const file of DIRS.flatMap((d) => files(join(ROOT, d)))) {
    const text = readFileSync(file, "utf8");
    if (!/Response\.json/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        /(?:^|\.)(?:NextResponse|Response)\.json$/.test(node.expression.getText(sf)) &&
        node.arguments.length > 0 &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        const keys = node.arguments[0].properties
          .map((p) => (p.name ? p.name.getText(sf) : ""))
          .filter(Boolean);
        if (keys.includes("error") && !keys.includes("code")) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          sites.push(`${relative(ROOT, file)}:${line}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites.sort();
}

describe("API errors — free-text ratchet (ADR-051, TASK-109)", () => {
  it("the free-text error count equals the baseline (lower the baseline as you convert)", () => {
    const sites = freeTextErrorSites();
    expect({ count: sites.length }).toEqual({ count: baseline.count });
  });
});
