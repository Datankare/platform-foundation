/**
 * @jest-environment node
 */
/**
 * __tests__/a11y-helper-guard.test.ts — axe runs in a browser only through the shared helper,
 * which waits for the page to come to rest (TASK-226)
 *
 * @guard an e2e test, walk or journey that runs axe itself, bypassing e2e/helpers/a11y.ts and
 * its wait for running CSS transitions and animations
 *
 * CI on 56e-1 (PF c4ee517, Layer 3) failed "the reset steps" at 1280 and 390 px: axe reported
 * colour contrast on the reset form's submit button with blended colours (#757982 on #122c77),
 * because it measured while the button's opacity transition from disabled to enabled was in
 * flight. It passed on retry; a flaky test fails the run. checkA11y now waits until no
 * transition or animation runs (document.getAnimations()), failing with the running ones named
 * after a bounded time, and measures again if one starts while axe measures. That only helps
 * if every audit goes through it, so every source file of the repository is read and refused
 * when it:
 *
 *   own-axe-builder   loads @axe-core/playwright          → checkA11y from e2e/helpers/a11y.ts
 *                     (anywhere but the helper)
 *   axe-in-a-browser  injects axe-core's source into a page (its source property or its minified file)
 *   axe-out-of-jsdom  loads axe-core in a file that is not a jsdom Jest test (jsdom paints
 *                     nothing and runs no transition, so the race cannot happen there)
 *
 * And the helper itself must still wait: it calls waitForStillPage before analyze() and reads
 * document.getAnimations(). These are patterns in the source, a proxy; the behaviour is proved
 * in a browser by e2e/a11y-helper.spec.ts (a transition in flight at audit time, and an endless
 * animation that fails the audit with its name).
 */

import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { walkFiles } from "./helpers/repo-files";

const ROOT = join(__dirname, "..");
const HELPER = "e2e/helpers/a11y.ts";
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");

// Built from parts so this file's own text never matches what it looks for.
const PW = "@axe-core" + "/playwright";
const CORE = "axe" + "-core";
const loads = (mod: string) =>
  new RegExp(
    String.raw`(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|^\s*import\s+)["']` +
      mod.replace(/[/.-]/g, (c) => "\\" + c) +
      `["']`,
    "m"
  );

export type Finding = { file: string; rule: string };

/** What one file breaks, given its path from the root and its text. */
export function scanFile(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  if (file !== HELPER && loads(PW).test(text))
    out.push({ file, rule: "own-axe-builder" });
  if (
    new RegExp(String.raw`\baxe\.source\b|` + CORE + String.raw`/axe(?:\.min)?\.js`).test(
      text
    )
  )
    out.push({ file, rule: "axe-in-a-browser" });
  if (loads(CORE).test(text)) {
    const jsdomTest =
      /^__tests__\/.*\.test\.tsx?$/.test(file) &&
      /@jest-environment\s+jsdom\b/.test(text);
    if (!jsdomTest) out.push({ file, rule: "axe-out-of-jsdom" });
  }
  return out;
}

/** The helper still waits for rest before it measures. */
export function helperWaits(text: string): string[] {
  const problems: string[] = [];
  if (!/document\s*\.\s*getAnimations\s*\(/.test(text))
    problems.push("the helper no longer reads document.getAnimations()");
  const wait = text.search(/await\s+waitForStillPage\s*\(/);
  const analyze = text.search(/\.analyze\s*\(\s*\)/);
  if (wait < 0) problems.push("checkA11y no longer awaits waitForStillPage");
  if (analyze < 0) problems.push("the helper no longer calls analyze()");
  if (wait >= 0 && analyze >= 0 && wait > analyze)
    problems.push("checkA11y measures before it waits for rest");
  return problems;
}

function repoFindings(): Finding[] {
  return walkFiles(ROOT, (n) => /\.[cm]?[jt]sx?$/.test(n)).flatMap((p) =>
    scanFile(rel(p), readFileSync(p, "utf8"))
  );
}

describe("axe runs only through the shared helper, which waits for rest", () => {
  it("no file runs axe in a browser except e2e/helpers/a11y.ts", () => {
    expect(repoFindings()).toEqual([]);
  });

  it("the helper waits for running transitions and animations before it measures", () => {
    expect(helperWaits(readFileSync(join(ROOT, HELPER), "utf8"))).toEqual([]);
  });

  it("[self-test] a spec that builds its own AxeBuilder is refused", () => {
    const spec = `import AxeBuilder from "${PW}";\nawait new AxeBuilder({ page }).analyze();`;
    expect(scanFile("e2e/own.spec.ts", spec)).toEqual([
      { file: "e2e/own.spec.ts", rule: "own-axe-builder" },
    ]);
    expect(scanFile("e2e-live/j.live.spec.ts", `const A = require('${PW}');`)).toEqual([
      { file: "e2e-live/j.live.spec.ts", rule: "own-axe-builder" },
    ]);
    expect(scanFile(HELPER, `import AxeBuilder from "${PW}";`)).toEqual([]);
  });

  it("[self-test] axe's source injected into a page is refused", () => {
    expect(
      scanFile(
        "e2e/inject.spec.ts",
        `await page.addScriptTag({ content: axe${".source"} });`
      )
    ).toEqual([{ file: "e2e/inject.spec.ts", rule: "axe-in-a-browser" }]);
    expect(
      scanFile(
        "scripts/walk.mjs",
        `await page.addScriptTag({ path: "node_modules/${CORE}/axe.min.js" });`
      )
    ).toEqual([{ file: "scripts/walk.mjs", rule: "axe-in-a-browser" }]);
  });

  it("[self-test] axe-core outside a jsdom Jest test is refused; inside one it is allowed", () => {
    const req = `const axe = require("${CORE}");`;
    expect(scanFile("e2e/raw.spec.ts", req)).toEqual([
      { file: "e2e/raw.spec.ts", rule: "axe-out-of-jsdom" },
    ]);
    expect(
      scanFile("__tests__/x.test.tsx", `/**\n * @jest-environment node\n */\n${req}`)
    ).toEqual([{ file: "__tests__/x.test.tsx", rule: "axe-out-of-jsdom" }]);
    expect(
      scanFile("__tests__/x.test.tsx", `/**\n * @jest-environment jsdom\n */\n${req}`)
    ).toEqual([]);
  });

  it("[self-test] a helper that measures before it waits, or never waits, is refused", () => {
    expect(helperWaits("await builder.analyze();")).toEqual([
      "the helper no longer reads document.getAnimations()",
      "checkA11y no longer awaits waitForStillPage",
    ]);
    expect(
      helperWaits(
        "document.getAnimations(); const r = await b.analyze(); await waitForStillPage(page);"
      )
    ).toEqual(["checkA11y measures before it waits for rest"]);
  });
});
