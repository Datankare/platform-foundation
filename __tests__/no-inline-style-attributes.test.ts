/**
 * __tests__/no-inline-style-attributes.test.ts — no component renders a `style` attribute
 * (SEC-017, TASK-203)
 *
 * @guard a JSX `style` attribute, or a `style` attribute set from script, in production source
 *
 * The Content Security Policy allows inline styles only with the response's nonce
 * (platform/security/csp.ts: `style-src 'self' 'nonce-…'`, no 'unsafe-inline'), and an attribute
 * cannot carry a nonce: a `style={…}` rendered on the server, or `setAttribute("style", …)`,
 * is refused by the browser, and the element is shown unstyled. A value computed at run time is set
 * on the element's style object (`element.style.width = …`), which the policy allows. Scans every
 * production source (lib, platform, app, hooks, components, shared, the root entry points — and
 * an app's games/), parsed, so a `style` in a comment or a string is not one.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";
import { productionSources } from "./helpers/route-policy";

const ROOT = join(__dirname, "..");

/** `<file>:<line>` of each `style` attribute and `setAttribute("style", …)` in `text`. */
export function inlineStyles(file: string, text: string): string[] {
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const out: string[] = [];
  const at = (n: ts.Node) =>
    `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const visit = (n: ts.Node): void => {
    if (ts.isJsxAttribute(n) && n.name.getText(sf) === "style") out.push(at(n));
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "setAttribute" &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0]) &&
      n.arguments[0].text.toLowerCase() === "style"
    )
      out.push(at(n));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function gamesSources(): string[] {
  const dir = join(ROOT, "games");
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        if (name !== "__tests__" && name !== "node_modules") walk(p);
      } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        out.push(relative(ROOT, p));
      }
    }
  };
  walk(dir);
  return out;
}

describe("no inline style attributes (SEC-017)", () => {
  it("finds the sources, components among them (self-test)", () => {
    const files = productionSources();
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.startsWith("components/"))).toBe(true);
  });

  it("no production source renders or sets a style attribute", () => {
    const found = [...productionSources(), ...gamesSources()].flatMap((f) =>
      inlineStyles(f, readFileSync(join(ROOT, f), "utf8"))
    );
    expect(found).toEqual([]);
  });

  it("[self-test] finds a planted JSX style and a setAttribute; not a comment, a string or the style object", () => {
    const planted = [
      "const a = <div style={{ width: 1 }} />;",
      "const b = <div className='x' style={s} />;",
      'el.setAttribute("style", "color: red");',
      "// <div style={{}} />",
      "const s = 'style={{}}';",
      'el.style.width = "10%";',
      'el.setAttribute("class", "x");',
    ].join("\n");
    expect(inlineStyles("planted.tsx", planted)).toEqual([
      "planted.tsx:1",
      "planted.tsx:2",
      "planted.tsx:3",
    ]);
  });
});
