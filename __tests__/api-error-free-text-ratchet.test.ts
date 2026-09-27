/**
 * ADR-051 D5 (b) — hard rule (7A A4b-3; was a ratchet 102 → 0 across A4a–A4b): no API error is
 * free text. A NextResponse.json / Response.json body with an `error` field and no `code`,
 * anywhere in app/api, platform or lib, fails CI. Errors go through apiError(),
 * internalError(), errorFromResult() or authResultResponse() (platform/errors, platform/auth).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import * as ts from "typescript";

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

function sitesIn(sf: ts.SourceFile, name: string): string[] {
  const sites: string[] = [];
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
        sites.push(`${name}:${line}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

function freeTextErrorSites(): string[] {
  const sites: string[] = [];
  for (const file of DIRS.flatMap((d) => files(join(ROOT, d)))) {
    const text = readFileSync(file, "utf8");
    if (!/Response\.json/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    sites.push(...sitesIn(sf, relative(ROOT, file)));
  }
  return sites.sort();
}

describe("API errors — no free text (ADR-051, TASK-109)", () => {
  it("every error response carries a registered code", () => {
    expect(freeTextErrorSites()).toEqual([]);
  });

  it("the scan finds a free-text error when one exists (self-test)", () => {
    const sf = ts.createSourceFile(
      "probe.ts",
      'NextResponse.json({ error: "x" }, { status: 400 });',
      ts.ScriptTarget.Latest,
      true
    );
    expect(sitesIn(sf, "probe.ts")).toEqual(["probe.ts:1"]);
  });
});
