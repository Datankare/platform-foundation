/**
 * __tests__/browser-audio-imports.test.ts — the browser audio modules stay browser-only, and the
 * browser encoder stays theirs (TASK-234; DESIGN-56f1 §7.1, test T20)
 *
 * @guard a server module or any other file importing the browser encoder or the browser modules'
 * dependencies, or browser audio code outside "@/platform/voice/browser-audio" and
 * "@/platform/voice/browser-recorder"
 *
 * Rules, each read from the TypeScript AST (identifiers and import declarations — never comments
 * or strings):
 *   R1  "@/platform/voice/browser-audio" and "@/platform/voice/browser-recorder" import only
 *       "@/platform/voice/canonical-wav" (and DOM globals) — no server module, no package.
 *   R2  `encodeCanonicalPcm`, the browser's way to mint a CanonicalWav, is imported only by
 *       browser-audio.ts (tests aside).
 *   R4  neither browser module reads the browser's name or version (`navigator.userAgent`,
 *       `navigator.vendor`, `appVersion`, `userAgentData`): support is decided by capability.
 *   R3  `decodeAudioData`, `OfflineAudioContext`, `MediaRecorder` and `getUserMedia` appear in
 *       no source file under the checked directories (app, components, hooks, lib, platform,
 *       modules) except the two browser modules and this repository's own exceptions below.
 * An exception that matches nothing fails, and so does a rule that finds nothing where it must
 * (a scan that reads nothing proves nothing). These modules are not reached by the app yet
 * (KNOWN_UNREACHED in reachable-modules.test.ts); this test is the guard that reads them.
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, posix } from "path";
import ts from "typescript";
import { filesUnder, isTest } from "./helpers/reachability";

const ROOT = join(__dirname, "..");
/** The reachability check's directories (reachable-modules.test.ts CHECKED_DIRS; a test below keeps them equal). */
const CHECKED_DIRS = ["app/", "components/", "hooks/", "lib/", "platform/", "modules/"];
const BROWSER_AUDIO = "platform/voice/browser-audio.ts";
const BROWSER_RECORDER = "platform/voice/browser-recorder.ts";
const BROWSER_MODULES = [BROWSER_AUDIO, BROWSER_RECORDER];
const CANONICAL = "@/platform/voice/canonical-wav";
const ENCODER = "encodeCanonicalPcm";
const BROWSER_API = [
  "webkitOfflineAudioContext",
  "webkitAudioContext",
  "decodeAudioData",
  "OfflineAudioContext",
  "MediaRecorder",
  "getUserMedia",
];

/**
 * Files outside the two modules that may still use the browser audio API, by package name, each
 * with why. Each must match a file that uses one (else it fails, so it cannot linger).
 */
export const BROWSER_API_EXCEPTIONS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  "platform-foundation": {},
  playform: {
    "hooks/useAudioRecorder.ts":
      "the recorder hook until 56f-2 moves it onto platform/voice/browser-recorder.ts; this entry then fails until removed",
  },
};

export interface ImportFact {
  readonly specifier: string;
  readonly names: readonly string[];
  readonly typeOnly: boolean;
}

/** The import declarations (and re-exports) of a source text. */
export function importsOf(file: string, text: string): ImportFact[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: ImportFact[] = [];
  const visit = (n: ts.Node) => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      const names: string[] = [];
      let typeOnly = false;
      if (ts.isImportDeclaration(n)) {
        const clause = n.importClause;
        typeOnly = !!clause?.isTypeOnly;
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements)
            names.push((el.propertyName ?? el.name).text);
        } else if (bindings && ts.isNamespaceImport(bindings)) names.push("*");
        if (clause?.name) names.push("default");
      } else {
        typeOnly = n.isTypeOnly;
        const clause = n.exportClause;
        if (clause && ts.isNamedExports(clause)) {
          for (const el of clause.elements) names.push((el.propertyName ?? el.name).text);
        } else names.push("*");
      }
      out.push({ specifier: n.moduleSpecifier.text, names, typeOnly });
    }
    if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === "require")) &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0])
    ) {
      out.push({ specifier: n.arguments[0].text, names: ["*"], typeOnly: false });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The property a `Reflect.get(o, "x")` or `Object.getOwnPropertyDescriptor(o, "x")` names. */
function reflectedName(n: ts.Node): string | undefined {
  if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression))
    return undefined;
  const target = n.expression.expression;
  const method = n.expression.name.text;
  const ok =
    ts.isIdentifier(target) &&
    ((target.text === "Reflect" && (method === "get" || method === "has")) ||
      (target.text === "Object" && method === "getOwnPropertyDescriptor"));
  const arg = n.arguments[1];
  return ok && arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
}

/** The browser audio API a source text uses: identifiers, string element access, Reflect (AST). */
export function browserApiIn(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const visit = (n: ts.Node) => {
    if (
      (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) &&
      BROWSER_API.includes(n.text)
    ) {
      found.add(n.text);
    }
    // window["MediaRecorder"], ctx["decodeAudioData"], Reflect.get(window, "MediaRecorder")
    if (
      ts.isElementAccessExpression(n) &&
      ts.isStringLiteralLike(n.argumentExpression) &&
      BROWSER_API.includes(n.argumentExpression.text)
    ) {
      found.add(n.argumentExpression.text);
    }
    const reflected = reflectedName(n);
    if (reflected !== undefined && BROWSER_API.includes(reflected)) found.add(reflected);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...found].sort();
}

/**
 * A specifier as a repository path without its extension: "@/x" and relative paths resolved from
 * the importing file; a .ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts ending and a trailing "/index"
 * removed — so every spelling of one module compares equal. A package name is returned as is.
 */
export function specifierPath(from: string, spec: string): string {
  let p = spec;
  if (p.startsWith("@/")) p = p.slice(2);
  else if (p.startsWith(".")) p = posix.normalize(posix.join(posix.dirname(from), p));
  return p.replace(/\.[cm]?[jt]sx?$/, "").replace(/\/index$/, "");
}

const CANONICAL_PATH = "platform/voice/canonical-wav";
const isCanonicalFrom = (from: string, s: string) =>
  specifierPath(from, s) === CANONICAL_PATH;

const NAME_READS = ["userAgent", "vendor", "appVersion", "userAgentData", "platform"];

/** R4: property reads of the browser's name or version in a source text (AST). */
export function r4Problems(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n) && NAME_READS.includes(n.name.text)) {
      found.push(
        `${file}: reads ${n.name.text} — decide by capability, never by the browser's name`
      );
    }
    if (
      ts.isElementAccessExpression(n) &&
      ts.isStringLiteralLike(n.argumentExpression) &&
      NAME_READS.includes(n.argumentExpression.text)
    ) {
      found.push(
        `${file}: reads ${n.argumentExpression.text} — decide by capability, never by the browser's name`
      );
    }
    // const { userAgent } = navigator; const { userAgent: ua } = navigator
    if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
      const key = n.propertyName ?? n.name;
      if (ts.isIdentifier(key) && NAME_READS.includes(key.text)) {
        found.push(
          `${file}: reads ${key.text} — decide by capability, never by the browser's name`
        );
      }
    }
    const reflected = reflectedName(n);
    if (reflected !== undefined && NAME_READS.includes(reflected)) {
      found.push(
        `${file}: reads ${reflected} — decide by capability, never by the browser's name`
      );
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** R1: what a browser module imports besides canonical-wav. */
export function r1Problems(file: string, text: string): string[] {
  return importsOf(file, text)
    .filter((i) => !isCanonicalFrom(file, i.specifier))
    .map(
      (i) =>
        `${file}: imports "${i.specifier}" — a browser module imports only ${CANONICAL}`
    );
}

/** R2: a file other than browser-audio.ts importing the encoder. */
export function r2Problems(file: string, text: string): string[] {
  if (file === BROWSER_AUDIO) return [];
  return importsOf(file, text)
    .filter((i) => isCanonicalFrom(file, i.specifier))
    .filter((i) => i.names.includes(ENCODER) || i.names.includes("*"))
    .map(
      (i) =>
        `${file}: imports ${ENCODER} (or the whole module) from "${i.specifier}" — only ${BROWSER_AUDIO} may`
    );
}

/** R3: browser audio API used outside the two modules and the allowed exceptions. */
export function r3Problems(
  file: string,
  text: string,
  exceptions: Readonly<Record<string, string>>
): string[] {
  if (BROWSER_MODULES.includes(file) || file in exceptions) return [];
  return browserApiIn(file, text).map(
    (id) =>
      `${file}: uses ${id} — browser audio lives in ${BROWSER_MODULES.join(" and ")}`
  );
}

function packageName(): string {
  return (
    JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { name: string }
  ).name;
}

/**
 * Every tracked source file (git ls-files), tests excluded — R2's scope: a server file anywhere
 * (proxy.ts, instrumentation.ts, next.config.ts, prompts/, scripts/, …) could mint with the encoder.
 */
const trackedSources = () =>
  execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 64 << 20 })
    .toString("utf8")
    .split("\0")
    .filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !isTest(f) && existsSync(join(ROOT, f)));

const sources = () =>
  CHECKED_DIRS.flatMap((d) => filesUnder(ROOT, d.replace(/\/$/, ""))).filter(
    (f) => !isTest(f)
  );
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

describe("the browser audio modules' imports (T20)", () => {
  const exceptions = BROWSER_API_EXCEPTIONS[packageName()];

  it("this repository has an exception list", () => {
    expect(exceptions).toBeDefined();
  });

  it("R1: browser-audio.ts and browser-recorder.ts import only canonical-wav — and do import it", () => {
    for (const f of BROWSER_MODULES) {
      expect(r1Problems(f, read(f))).toEqual([]);
      expect([
        f,
        importsOf(f, read(f)).some((i) => isCanonicalFrom(f, i.specifier)),
      ]).toEqual([f, true]);
    }
  });

  it("R4: no browser-side module (the two, and canonical-wav.ts with the support lists) reads the browser's name or version", () => {
    for (const f of [...BROWSER_MODULES, "platform/voice/canonical-wav.ts"])
      expect(r4Problems(f, read(f))).toEqual([]);
  });

  it("R2: only browser-audio.ts imports encodeCanonicalPcm — and it does (every tracked source file read)", () => {
    const files = trackedSources();
    expect(files).toEqual(expect.arrayContaining(["proxy.ts", "next.config.ts"]));
    expect(files.some((f) => f.startsWith("scripts/"))).toBe(true);
    expect(files.flatMap((f) => r2Problems(f, read(f)))).toEqual([]);
    expect(
      importsOf(BROWSER_AUDIO, read(BROWSER_AUDIO)).some((i) => i.names.includes(ENCODER))
    ).toBe(true);
  });

  it("R3: the browser audio API appears only in the two modules and the listed exceptions", () => {
    expect(sources().flatMap((f) => r3Problems(f, read(f), exceptions ?? {}))).toEqual(
      []
    );
  });

  it("R3 finds the API where it must: the two modules use it", () => {
    expect(browserApiIn(BROWSER_AUDIO, read(BROWSER_AUDIO))).toEqual(
      expect.arrayContaining(["OfflineAudioContext", "decodeAudioData"])
    );
    expect(browserApiIn(BROWSER_RECORDER, read(BROWSER_RECORDER))).toEqual(
      expect.arrayContaining(["MediaRecorder", "getUserMedia"])
    );
  });

  it("every exception names a file that uses the API (else remove it)", () => {
    for (const [file, why] of Object.entries(exceptions ?? {})) {
      expect(why.split(/\s+/).length).toBeGreaterThanOrEqual(8);
      let text = "";
      try {
        text = read(file);
      } catch {
        text = "";
      }
      expect([file, browserApiIn(file, text).length > 0]).toEqual([file, true]);
    }
  });

  it("scans the reachability check's directories (CHECKED_DIRS of reachable-modules.test.ts)", () => {
    const text = read("__tests__/reachable-modules.test.ts");
    const m = /export const CHECKED_DIRS = \[([^\]]*)\]/.exec(text);
    expect(m).not.toBeNull();
    const theirs = [...(m?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(theirs).toEqual(CHECKED_DIRS);
  });

  it("names the three modules by their import paths (read by reachable-modules)", () => {
    const self = read("__tests__/browser-audio-imports.test.ts");
    for (const m of ["canonical-wav", "browser-audio", "browser-recorder"]) {
      expect(self).toContain(`"@/platform/voice/${m}"`);
    }
  });
});

describe("planted violations (self-tests)", () => {
  it("[self-test] R2 (RA-5/RB-6): every spelling of the module, from a file outside the checked folders", () => {
    for (const spec of [
      "@/platform/voice/canonical-wav",
      "@/platform/voice/canonical-wav.js",
      "@/platform/voice/canonical-wav.ts",
      "./platform/voice/canonical-wav.mjs",
    ]) {
      expect([
        spec,
        r2Problems("proxy.ts", `import { ${ENCODER} } from "${spec}";`).length,
      ]).toEqual([spec, 1]);
    }
    expect(
      r2Problems(
        "platform/voice/x.ts",
        `import { ${ENCODER} } from "./canonical-wav.ts";`
      )
    ).toHaveLength(1);
    expect(
      r2Problems(
        "platform/voice/x.ts",
        `import { ${ENCODER} } from "../voice/canonical-wav/index";`
      )
    ).toHaveLength(1);
    expect(
      r2Problems(
        "proxy.ts",
        `import { ${ENCODER} } from "@/platform/voice/canonical-wavy";`
      )
    ).toEqual([]);
  });

  it("[self-test] R3 (RB-7): string element access, Reflect.get and the webkit-prefixed constructors", () => {
    const text = [
      'const R = (window as any)["MediaRecorder"];',
      "const C = new webkitOfflineAudioContext(1, 1, 16000);",
      'new webkitAudioContext()["decodeAudioData"](b);',
      'const g = Reflect.get(navigator.mediaDevices, "getUserMedia");',
    ].join("\n");
    expect(browserApiIn("hooks/x.ts", text)).toEqual(
      [
        "MediaRecorder",
        "decodeAudioData",
        "getUserMedia",
        "webkitAudioContext",
        "webkitOfflineAudioContext",
      ].sort()
    );
  });

  it("[self-test] R4 (RA-10/RB-7): destructuring, Reflect.get, getOwnPropertyDescriptor, navigator.platform", () => {
    const text = [
      "const { userAgent } = navigator;",
      "const { vendor: v } = navigator;",
      'const a = Reflect.get(navigator, "appVersion");',
      'const d = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgentData");',
      "const p = navigator.platform;",
    ].join("\n");
    expect(r4Problems(BROWSER_AUDIO, text).map((x) => x.split(" — ")[0])).toEqual([
      `${BROWSER_AUDIO}: reads userAgent`,
      `${BROWSER_AUDIO}: reads vendor`,
      `${BROWSER_AUDIO}: reads appVersion`,
      `${BROWSER_AUDIO}: reads userAgentData`,
      `${BROWSER_AUDIO}: reads platform`,
    ]);
  });

  it("[self-test] R4: navigator.userAgent, navigator['vendor'], userAgentData are reported", () => {
    const text = [
      "const ua = navigator.userAgent;",
      'const v = navigator["vendor"];',
      "const d = navigator.userAgentData;",
      "// navigator.appVersion in a comment",
    ].join("\n");
    expect(r4Problems(BROWSER_AUDIO, text)).toEqual([
      `${BROWSER_AUDIO}: reads userAgent — decide by capability, never by the browser's name`,
      `${BROWSER_AUDIO}: reads vendor — decide by capability, never by the browser's name`,
      `${BROWSER_AUDIO}: reads userAgentData — decide by capability, never by the browser's name`,
    ]);
  });

  it("[self-test] R1: a browser module importing a server module, a package, or by require", () => {
    const planted = [
      'import { CANONICAL } from "@/platform/voice/canonical-wav";',
      'import { getDb } from "@/lib/db";',
      'import fs from "fs";',
      'const x = require("@/platform/voice/google-stt");',
      'export { y } from "@/lib/z";',
    ].join("\n");
    expect(r1Problems(BROWSER_RECORDER, planted)).toEqual([
      `${BROWSER_RECORDER}: imports "@/lib/db" — a browser module imports only ${CANONICAL}`,
      `${BROWSER_RECORDER}: imports "fs" — a browser module imports only ${CANONICAL}`,
      `${BROWSER_RECORDER}: imports "@/platform/voice/google-stt" — a browser module imports only ${CANONICAL}`,
      `${BROWSER_RECORDER}: imports "@/lib/z" — a browser module imports only ${CANONICAL}`,
    ]);
  });

  it("[self-test] R2: a route importing the encoder, renamed, by namespace, or re-exported", () => {
    const route = "app/api/x/route.ts";
    expect(
      r2Problems(route, `import { ${ENCODER} as enc } from "${CANONICAL}";`)
    ).toHaveLength(1);
    expect(r2Problems(route, `import * as W from "${CANONICAL}";`)).toHaveLength(1);
    expect(r2Problems(route, `export { ${ENCODER} } from "${CANONICAL}";`)).toHaveLength(
      1
    );
    expect(
      r2Problems("platform/voice/x.ts", `import { ${ENCODER} } from "./canonical-wav";`)
    ).toHaveLength(1);
    expect(
      r2Problems(route, `import { checkCanonicalWav } from "${CANONICAL}";`)
    ).toEqual([]);
    expect(
      r2Problems(BROWSER_AUDIO, `import { ${ENCODER} } from "${CANONICAL}";`)
    ).toEqual([]);
  });

  it("[self-test] R3: an identifier counts; a comment or a string does not; an exception is honoured", () => {
    const text = [
      "// MediaRecorder in a comment",
      'const s = "getUserMedia in a string";',
      "const r = new MediaRecorder(stream);",
      "ctx.decodeAudioData(buf);",
    ].join("\n");
    expect(r3Problems("hooks/useX.ts", text, {})).toEqual([
      `hooks/useX.ts: uses MediaRecorder — browser audio lives in ${BROWSER_MODULES.join(" and ")}`,
      `hooks/useX.ts: uses decodeAudioData — browser audio lives in ${BROWSER_MODULES.join(" and ")}`,
    ]);
    expect(r3Problems("hooks/useX.ts", text, { "hooks/useX.ts": "why" })).toEqual([]);
    expect(
      browserApiIn("a.ts", "// OfflineAudioContext\nconst t = 'getUserMedia';")
    ).toEqual([]);
  });

  it("[self-test] an exception whose file uses no browser audio API would fail its check", () => {
    expect(browserApiIn("hooks/useAudioRecorder.ts", "export const x = 1;")).toEqual([]);
  });
});
