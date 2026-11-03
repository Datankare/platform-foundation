/**
 * ADR-051 D5 (e), TASK-110 — screen-literal ratchet. Counts user-visible English literals in the
 * screens: JSX text with letters, string values of user-visible attributes (placeholder,
 * aria-label, title, alt, label), and — TASK-194 round 13, nit 6 — a sentence given to a React
 * state setter (`setError("…")`, `` setNotice(`…`) ``, `setError(x ?? "…")`): the screen shows it
 * as surely as JSX text, and the scan did not see one, so new English messages passed. The count
 * must equal the baseline in screen-literal-baseline.json at the repo root: new UI adds no
 * literals, and moving strings into the catalog means lowering the baseline in the same commit.
 * Sprint 7B takes it to zero.
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

/** A user-visible sentence: two words or more. */
const SENTENCE = /[a-z]{2,}\s+[a-z]/i;

/** The catalog's own calls: what they render is not a literal on the screen. */
const CATALOG_CALLS = new Set(["t", "renderMessage"]);

/**
 * Every literal sentence anywhere in a setter's argument (round 14, item 7) — direct, a fallback
 * (`x ?? "…"`), a branch of a ternary, the body of an updater (`(prev) => …`), a field of an object
 * — but not inside a call to the catalog (`t("key")`, `renderMessage(…)`).
 */
function setterLiterals(arg: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  const walk = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      CATALOG_CALLS.has(n.expression.text)
    )
      return;
    // A property's own name is no text on the screen.
    if (ts.isPropertyAssignment(n)) {
      walk(n.initializer);
      return;
    }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (SENTENCE.test(n.text)) out.push(n);
      return;
    }
    if (ts.isTemplateExpression(n)) {
      const text = n.head.text + n.templateSpans.map((s) => s.literal.text).join("");
      if (SENTENCE.test(text)) out.push(n);
      n.templateSpans.forEach((s) => walk(s.expression));
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(arg);
  return out;
}

function literalSites(sf: ts.SourceFile, name: string): string[] {
  const sites: string[] = [];
  const counted = new Set<ts.Node>();
  const at = (n: ts.Node): string =>
    `${name}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && /[a-z]/i.test(node.text)) sites.push(at(node));
    // A sentence (two words or more) a state setter shows (round 13, nit 6), anywhere in its
    // argument (round 14, item 7) — each literal once, however setters nest.
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      /^set[A-Z]/.test(node.expression.text)
    ) {
      for (const arg of node.arguments)
        for (const lit of setterLiterals(arg))
          if (!counted.has(lit)) {
            counted.add(lit);
            sites.push(at(lit));
          }
    }
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

  it("finds a sentence a state setter shows (round 13, nit 6)", () => {
    const sf = ts.createSourceFile(
      "probe.tsx",
      [
        'setError("The change could not be applied.");',
        "setNotice(`Change held for approval${ref}.`);",
        'setError(res.error ?? "Something went wrong.");',
        'setMode("edit");',
        'setError(t("not_applied"));',
        // Round 14, item 7: a ternary, an updater, an object, a nested setter; t() skipped.
        'setError(ok ? "All went well here." : "It did not go well.");',
        'setRows((prev) => prev.map((r) => ({ ...r, note: "Saved just now" })));',
        'setState({ title: "Your settings", label: t("k") });',
        'setOuter(() => { setInner("Done and dusted"); return 1; });',
        'setLabel(t("key", { fallback: "Not a literal on screen" }));',
      ].join("\n"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    expect(literalSites(sf, "probe.tsx")).toEqual([
      "probe.tsx:1",
      "probe.tsx:2",
      "probe.tsx:3",
      "probe.tsx:6",
      "probe.tsx:6",
      "probe.tsx:7",
      "probe.tsx:8",
      "probe.tsx:9",
    ]);
  });
});
