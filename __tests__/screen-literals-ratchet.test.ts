/**
 * ADR-051 D5 (e), TASK-110 — screen-literal ratchet. Counts user-visible English literals in the
 * screens: JSX text with letters, and string values of user-visible attributes (placeholder,
 * aria-label, title, alt, label). The count must equal the baseline in
 * screen-literal-baseline.json at the repo root: new UI adds no literals, and moving strings
 * into the catalog means lowering the baseline in the same commit. Sprint 7B takes it to zero.
 *
 * The baseline file is per repository (a consumer keeps its own; it is not synced).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import * as ts from "typescript";

const ROOT = join(__dirname, "..");
const DIRS = ["app", "components", "platform"];
const LABEL_ATTRS = new Set(["placeholder", "aria-label", "title", "alt", "label"]);

function tsxFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      return name === "__tests__" || name === "node_modules" ? [] : tsxFiles(p);
    }
    return name.endsWith(".tsx") && !name.endsWith(".test.tsx") ? [p] : [];
  });
}

function literalSites(sf: ts.SourceFile, name: string): string[] {
  const sites: string[] = [];
  const at = (n: ts.Node): string =>
    `${name}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && /[a-z]/i.test(node.text)) sites.push(at(node));
    if (
      ts.isJsxAttribute(node) &&
      LABEL_ATTRS.has(node.name.getText(sf)) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      /[a-z]/i.test(node.initializer.text)
    ) {
      sites.push(at(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

function allSites(): string[] {
  return DIRS.flatMap((d) => tsxFiles(join(ROOT, d))).flatMap((file) =>
    literalSites(
      ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      ),
      relative(ROOT, file)
    )
  );
}

describe("screen literals — ratchet (ADR-051, TASK-110)", () => {
  it("the literal count equals the baseline (lower it as strings move to the catalog)", () => {
    const baselineFile = join(ROOT, "screen-literal-baseline.json");
    const baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as { count: number };
    expect({ count: allSites().length }).toEqual({ count: baseline.count });
  });

  it("finds text, labels and attributes; ignores expressions (self-test)", () => {
    const sf = ts.createSourceFile(
      "probe.tsx",
      'const a = <div title="Hello" data-x="y">Save {name} <input placeholder="Email" alt={t("k")} /></div>;',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    expect(literalSites(sf, "probe.tsx")).toHaveLength(3);
  });
});
