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
 * TASK-205 (R-75): the baseline is 0 in both repositories, so any literal fails, and the scan
 * also counts a string a JSX expression shows (`{busy ? "Saving..." : "Save"}`, `{x ?? "None"}`)
 * or a label attribute's expression gives (`aria-label={on ? "Stop" : "Start"}`, a template) —
 * text on the screen the earlier scan did not see. And every catalog key a screen names
 * (`renderMessage("screens.…")`, or a screen's `t("key")` over `renderMessage(\`screens.x.${key}\`)`)
 * must exist: a missing key renders as the key itself.
 *
 * @guard English text on a screen that is not from the message catalog
 *
 * The baseline file is per repository (a consumer keeps its own; it is not synced).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import * as ts from "typescript";
import { CATALOGS, DEFAULT_LOCALE, lookup } from "@/platform/errors/messages";

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

/**
 * The strings a JSX expression shows or a label attribute's expression gives (TASK-205): the
 * expression itself, a branch of a ternary, either side of `??` / `||`, the right of `&&`.
 */
function shownStrings(e: ts.Expression | undefined, out: ts.Node[] = []): ts.Node[] {
  if (!e) return out;
  if (ts.isParenthesizedExpression(e)) return shownStrings(e.expression, out);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    if (/[a-z]{2,}/i.test(e.text)) out.push(e);
    return out;
  }
  if (ts.isTemplateExpression(e)) {
    const text = e.head.text + e.templateSpans.map((s) => s.literal.text).join("");
    if (/[a-z]{2,}/i.test(text)) out.push(e);
    return out;
  }
  if (ts.isConditionalExpression(e)) {
    shownStrings(e.whenTrue, out);
    return shownStrings(e.whenFalse, out);
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      shownStrings(e.left, out);
      return shownStrings(e.right, out);
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return shownStrings(e.right, out);
  }
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
    // A string a JSX child expression shows, or a label attribute's expression gives (TASK-205).
    if (
      ts.isJsxExpression(node) &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    )
      for (const lit of shownStrings(node.expression)) sites.push(at(lit));
    if (
      ts.isJsxAttribute(node) &&
      LABEL_ATTRS.has(node.name.getText(sf)) &&
      node.initializer &&
      ts.isJsxExpression(node.initializer)
    )
      for (const lit of shownStrings(node.initializer.expression)) sites.push(at(lit));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

/**
 * Every catalog key a screen names by a literal: `renderMessage("a.b")`, and `t("c")` where the
 * file defines `const t = (key…) => renderMessage(\`a.b.${key}\`…)` (any helper name).
 */
export function catalogKeysUsed(sf: ts.SourceFile): { key: string; line: number }[] {
  const prefixes = new Map<string, string>();
  const out: { key: string; line: number }[] = [];
  const lineOf = (n: ts.Node) =>
    sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const findHelpers = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isArrowFunction(n.initializer)
    ) {
      const body = n.initializer.body;
      if (
        ts.isCallExpression(body) &&
        ts.isIdentifier(body.expression) &&
        body.expression.text === "renderMessage" &&
        body.arguments[0] &&
        ts.isTemplateExpression(body.arguments[0]) &&
        body.arguments[0].templateSpans.length === 1 &&
        body.arguments[0].templateSpans[0].literal.text === ""
      )
        prefixes.set(n.name.text, body.arguments[0].head.text);
    }
    ts.forEachChild(n, findHelpers);
  };
  findHelpers(sf);
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.arguments[0]) {
      const a = n.arguments[0];
      const name = n.expression.text;
      if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) {
        if (name === "renderMessage" && a.text.startsWith("screens."))
          out.push({ key: a.text, line: lineOf(a) });
        else if (prefixes.has(name))
          out.push({ key: prefixes.get(name)! + a.text, line: lineOf(a) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The screens' files: .tsx and .ts (a screen's own helpers) under app/, components/, platform/. */
function screenFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory())
      return name === "__tests__" || name === "node_modules" ? [] : screenFiles(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
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
  it("no literal is left: the baseline is 0, and any literal fails, by its place (TASK-205)", () => {
    const baselineFile = join(ROOT, "screen-literal-baseline.json");
    const baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as { count: number };
    expect(baseline.count).toBe(0);
    expect(allSites()).toEqual([]);
  });

  it("every catalog key a screen names exists in English (TASK-205)", () => {
    const missing = ["app", "components", "platform"]
      .flatMap((d) => screenFiles(join(ROOT, d)))
      .flatMap((file) => {
        const sf = ts.createSourceFile(
          file,
          readFileSync(file, "utf8"),
          ts.ScriptTarget.Latest,
          true,
          file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        );
        return catalogKeysUsed(sf)
          .filter(({ key }) => lookup(CATALOGS[DEFAULT_LOCALE], key) === undefined)
          .map(({ key, line }) => `${relative(ROOT, file)}:${line} ${key}`);
      });
    expect(missing).toEqual([]);
  });

  it("[self-test] finds a string a JSX expression shows (TASK-205)", () => {
    const sf = ts.createSourceFile(
      "probe.tsx",
      [
        'const a = <b>{busy ? "Saving..." : "Save"}</b>;',
        'const c = <b>{name ?? "No name"}</b>;',
        'const d = <b>{open && "Close it"}</b>;',
        "const e = <b>{`${n} items left`}</b>;",
        'const f = <i aria-label={on ? "Stop it" : "Start it"} />;',
        'const g = <b>{t("k")}{" "}{"—"}{x ? "" : null}</b>;',
        'const h = <i className={on ? "bg-red" : "bg-blue"} />;',
      ].join("\n"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    expect(literalSites(sf, "probe.tsx")).toEqual([
      "probe.tsx:1",
      "probe.tsx:1",
      "probe.tsx:2",
      "probe.tsx:3",
      "probe.tsx:4",
      "probe.tsx:5",
      "probe.tsx:5",
    ]);
  });

  it("[self-test] reads the keys a screen names, through its helper", () => {
    const sf = ts.createSourceFile(
      "probe.tsx",
      [
        "const t = (key: string, values?: MessageValues) => renderMessage(`screens.x.${key}`, values);",
        'const a = <b>{t("one")}{renderMessage("screens.y.two")}{t(`three`)}{t(dynamic)}</b>;',
        'renderMessage("errors.auth.required");',
      ].join("\n"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    expect(catalogKeysUsed(sf).map((k) => k.key)).toEqual([
      "screens.x.one",
      "screens.y.two",
      "screens.x.three",
    ]);
  });

  it("[self-test] finds text, labels and attributes; ignores expressions", () => {
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
