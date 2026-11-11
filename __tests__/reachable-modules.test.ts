/**
 * __tests__/reachable-modules.test.ts — every module is reached from an entry point (TASK-211,
 * N-118)
 *
 * @guard a module under app/, components/, hooks/, lib/, platform/ or modules/ that no entry point
 * reaches
 *
 * Batch 55j's guard (__tests__/mounted-screens.test.ts) covered components/ only, and found the
 * streaming hook, the realtime-channel hook, the stream parser and Playform's PKCE helper outside
 * it: tested, documented, and loaded by nothing that runs. Here, statically, for the whole of this
 * repository (a consumer runs the same file over its own tree):
 *
 *   entries   what runs or is loaded by what runs —
 *               pages and route handlers: Next's convention files under app/ (page, layout,
 *                 route, template, loading, error, not-found, …, and the metadata files);
 *               middleware and instrumentation: proxy.ts / middleware.ts, instrumentation.ts,
 *                 instrumentation-client.ts, and the configs the build and lint load
 *                 (next.config, eslint.config, postcss.config);
 *               scripts: every source file under scripts/ (and its shell and Python scripts);
 *               scripts and workflows naming a file: a string in a script, or a path on a line of
 *                 a workflow, a shell script or package.json's scripts, that names a source file;
 *               package exports: package.json's main, module, types, bin and exports, and the
 *                 platform's area entries, platform/<area>/index.ts — the import path each area's
 *                 README gives a consumer (`@/platform/auth`), the core's counterpart of a module's
 *                 registry entry (which is its index.ts, ADR-054);
 *               the module registry: platform/modules/manifest.json's and app-manifest.json's
 *                 composition roots and each module's definition and entry;
 *               what the other repository imports through the platform-paths sync: a file
 *                 platform-foundation ships that only its consumer loads, in CONSUMER_ENTRIES —
 *                 and the consumer's run of this file proves its own entries reach each one;
 *   reached   an entry, and every file it imports, transitively (__tests__/helpers/reachability:
 *             import, export … from, import(), require(), as the app resolves them). A test file
 *             is never a path: a module only a test loads is not reached;
 *   refused   a source file under the checked directories that is not reached, unless
 *             KNOWN_UNREACHED names it for this repository, with why — each such file must be read
 *             by a CI guard (a test marked @guard imports it), and is an entry for what it imports.
 *
 * Both lists are exact: a consumer entry that is reached anyway, or names no file, fails until it
 * is removed, as does a known entry that is reached or gone.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import ts from "typescript";
import { filesUnder, isTest, reachedFrom, SOURCE } from "./helpers/reachability";

const ROOT = join(__dirname, "..");

/** The directories whose every module must be reached. */
export const CHECKED_DIRS = [
  "app/",
  "components/",
  "hooks/",
  "lib/",
  "platform/",
  "modules/",
];

/** Next's convention files under app/: what the router loads (a page, a route handler, …). */
const APP_CONVENTION =
  /(?:^|\/)(?:page|layout|template|loading|error|global-error|not-found|forbidden|unauthorized|default|route|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.(?:ts|tsx|js|jsx)$/;

/** The root files the server, the build and the lint load: middleware, instrumentation, configs. */
const ROOT_ENTRY =
  /^(?:proxy|middleware|instrumentation|instrumentation-client|next\.config|eslint\.config|postcss\.config)\.(?:ts|js|mjs|cjs)$/;

/**
 * Files platform-foundation ships for its consumer (platform/modules/platform-paths.json and the
 * synced platform/ tree) that only the consumer loads, by package name, with the consumer's file
 * that does. In platform-foundation they are entries; in the consumer (Playform) each must be
 * reached from the consumer's own entries — the consumer's CI proves the claim.
 */
export const CONSUMER_ENTRIES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  "platform-foundation": {
    "components/AdaptiveInput/":
      "the platform's input component (platform/input, ROADMAP Sprint 1a): Playform's home " +
      "mounts it (components/SpikeApp.tsx); the platform's demo home has no conductor to drive it",
    "platform/auth/profile-screening.ts":
      "screens a profile update (audit D-11): the platform has no profile route; Playform's " +
      "app/api/profile/route.ts calls it",
  },
};

/** The consumer that proves CONSUMER_ENTRIES: its package name, and the platform it consumes. */
const CONSUMERS: Readonly<Record<string, string>> = { playform: "platform-foundation" };

/**
 * Modules no entry reaches that this repository keeps, by package name, each with why. Kept
 * minimal: each is a consumer-owned register a CI guard reads (a test marked @guard imports it),
 * at the path the sync template excludes (docs/templates/sync-config.json) so the consumer owns
 * it — moving it would break every consumer's sync. Code no entry reaches is wired or removed.
 */
export const KNOWN_UNREACHED: Readonly<Record<string, Readonly<Record<string, string>>>> =
  {
    "platform-foundation": {
      "platform/route-policy/app-route-policy.ts":
        "the app's route guards (TASK-136), consumer-owned: read by the route checks " +
        "(__tests__/api-route-auth.test.ts and its siblings), never by the app at run time",
      "platform/assurance/unwired-security.ts":
        "the register of security controls with no production caller, consumer-owned: read by " +
        "__tests__/security-wiring.test.ts, never by the app at run time",
    },
    playform: {
      "platform/route-policy/app-route-policy.ts":
        "Playform's route guards (TASK-136), consumer-owned: read by the route checks " +
        "(__tests__/api-route-auth.test.ts and its siblings), never by the app at run time",
      "platform/assurance/unwired-security.ts":
        "Playform's register of security controls with no production caller, consumer-owned: " +
        "read by __tests__/security-wiring.test.ts, never by the app at run time",
    },
  };

/** A source path named in text: one of the checked directories or scripts/, with its extension. */
const NAMED_PATH =
  /(?:^|[^\w@/.-])(?:\.\/)?((?:app|components|hooks|lib|platform|modules|scripts)\/[\w./()[\]@-]*\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs))(?![\w-]|\.\w)/g;

/** A script that is not JavaScript or TypeScript: read as lines. */
const SCRIPT_TEXT = /\.(?:sh|bash|py)$/;

/** The source paths a line-oriented text names, skipping `#` comment lines. */
export function pathsInText(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    for (const m of line.matchAll(NAMED_PATH)) out.push(m[1]);
  }
  return out;
}

/** The repository paths a script's string literals name (comments are not strings). */
export function pathsInScript(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteralLike(n)) out.push(...pathsInText(n.text));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const readJson = (root: string, rel: string): unknown =>
  JSON.parse(readFileSync(join(root, rel), "utf8"));

/** Every string inside a JSON value (package.json's exports may nest). */
const stringsIn = (v: unknown): string[] =>
  typeof v === "string"
    ? [v]
    : Array.isArray(v)
      ? v.flatMap(stringsIn)
      : v && typeof v === "object"
        ? Object.values(v).flatMap(stringsIn)
        : [];

interface ModuleManifest {
  readonly compositionRoots?: readonly string[];
  readonly modules?: Readonly<Record<string, { definition?: string; entry?: string }>>;
}

/** The registry's entries: composition roots, and each module's definition and entry. */
function registryEntries(root: string): string[] {
  const out: string[] = [];
  for (const rel of [
    "platform/modules/manifest.json",
    "platform/modules/app-manifest.json",
  ]) {
    try {
      const m = readJson(root, rel) as ModuleManifest;
      out.push(...(m.compositionRoots ?? []));
      for (const mod of Object.values(m.modules ?? {})) {
        if (mod.definition) out.push(mod.definition);
        if (mod.entry) out.push(mod.entry);
      }
    } catch {
      // An absent manifest declares nothing.
    }
  }
  return out;
}

/** Whether a list entry (a file, or a folder ending in "/") names `file`. */
const names = (entry: string, file: string) =>
  entry.endsWith("/") ? file.startsWith(entry) : file === entry;

/** Every entry point of the repository at `root` (consumer entries and the known list aside). */
export function entryPoints(root: string): string[] {
  const all = filesUnder(root, "", true).filter((f) => !isTest(f));
  const exists = new Set(all);
  const entries = new Set<string>();
  const add = (p: string) => {
    const rel = p.replace(/^\.\//, "");
    if (exists.has(rel) && SOURCE.test(rel)) entries.add(rel);
  };
  for (const f of all) {
    if (f.startsWith("app/") && APP_CONVENTION.test(f)) add(f);
    if (!f.includes("/") && ROOT_ENTRY.test(f)) add(f);
    if (/^platform\/[^/]+\/index\.tsx?$/.test(f)) add(f);
    if (f.startsWith("scripts/") && (SOURCE.test(f) || SCRIPT_TEXT.test(f))) {
      add(f);
      const text = readFileSync(join(root, f), "utf8");
      (SOURCE.test(f) ? pathsInScript(f, text) : pathsInText(text)).forEach(add);
    }
    if (f.startsWith(".github/workflows/") && /\.ya?ml$/.test(f))
      pathsInText(readFileSync(join(root, f), "utf8")).forEach(add);
  }
  const pkg = readJson(root, "package.json") as Record<string, unknown>;
  for (const key of ["main", "module", "types", "bin", "exports"])
    stringsIn(pkg[key]).forEach(add);
  for (const cmd of stringsIn(pkg.scripts)) pathsInText(cmd).forEach(add);
  registryEntries(root).forEach(add);
  return [...entries].sort();
}

export interface ReachReport {
  /** Modules no entry reaches and the known list does not name. */
  readonly unreached: string[];
  /** Known or consumer entries that name nothing unreached (reached anyway, or gone). */
  readonly stale: string[];
}

/** The modules of `root`'s checked directories no entry reaches, against the two lists. */
export function unreachedModules(
  root: string,
  known: Readonly<Record<string, string>>,
  consumerEntries: Readonly<Record<string, string>> = {}
): ReachReport {
  const checked = (f: string) => CHECKED_DIRS.some((d) => f.startsWith(d)) && !isTest(f);
  const sources = filesUnder(root, "").filter(checked);
  const base = entryPoints(root);
  const reachedBase = reachedFrom(root, base);
  // A list entry is an entry point for what it imports; it may only name what is not reached.
  const listed = (entries: Readonly<Record<string, string>>) =>
    sources.filter((f) => Object.keys(entries).some((k) => names(k, f)));
  const reached = reachedFrom(root, [
    ...base,
    ...listed(consumerEntries),
    ...listed(known),
  ]);
  const notReachedBase = sources.filter((f) => !reachedBase.has(f));
  const stale = [...Object.keys(consumerEntries), ...Object.keys(known)].filter(
    (k) => !notReachedBase.some((f) => names(k, f))
  );
  return {
    unreached: sources.filter((f) => !reached.has(f)),
    stale,
  };
}

/** The test files marked @guard that import `file` (by its @/ path). */
function guardsReading(root: string, file: string): string[] {
  const spec = `@/${file.replace(/\.(?:ts|tsx)$/, "")}`;
  return filesUnder(root, "__tests__")
    .filter((f) => /\.test\.tsx?$/.test(f))
    .filter((f) => {
      const text = readFileSync(join(root, f), "utf8");
      return text.includes("@guard") && text.includes(`"${spec}"`);
    });
}

/** This repository's package name (the lists' key). */
function packageName(root: string): string {
  return (readJson(root, "package.json") as { name: string }).name;
}

describe("every module is reached from an entry point (N-118)", () => {
  const name = packageName(ROOT);

  it("no module under the checked directories is unreached, and both lists are exact", () => {
    expect(Object.keys(KNOWN_UNREACHED)).toContain(name);
    const report = unreachedModules(
      ROOT,
      KNOWN_UNREACHED[name],
      CONSUMER_ENTRIES[name] ?? {}
    );
    // Wire it into what it exists for, or remove it with its tests; never list it to pass.
    expect(report.unreached).toEqual([]);
    expect(report.stale).toEqual([]);
  });

  it("every file a consumer entry names is reached from the consumer's own entries", () => {
    const platform = CONSUMERS[name];
    if (platform === undefined) return; // not a consumer: platform-foundation itself
    const reached = reachedFrom(ROOT, entryPoints(ROOT));
    const sources = filesUnder(ROOT, "").filter((f) => !isTest(f));
    for (const entry of Object.keys(CONSUMER_ENTRIES[platform] ?? {})) {
      const files = sources.filter((f) => names(entry, f));
      expect([entry, files.length > 0]).toEqual([entry, true]);
      expect([entry, files.some((f) => reached.has(f))]).toEqual([entry, true]);
    }
  });

  it("every list entry says why, and every known entry is read by a CI guard", () => {
    for (const lists of [KNOWN_UNREACHED, CONSUMER_ENTRIES]) {
      for (const [repo, entries] of Object.entries(lists)) {
        for (const [entry, why] of Object.entries(entries)) {
          expect([repo, entry, CHECKED_DIRS.some((d) => entry.startsWith(d))]).toEqual([
            repo,
            entry,
            true,
          ]);
          expect(why.split(/\s+/).length).toBeGreaterThanOrEqual(8);
        }
      }
    }
    for (const entry of Object.keys(KNOWN_UNREACHED[name])) {
      expect([entry, guardsReading(ROOT, entry).length > 0]).toEqual([entry, true]);
    }
  });

  it("finds this repository's entry points (self-test)", () => {
    const entries = entryPoints(ROOT);
    expect(entries).toEqual(expect.arrayContaining(["app/page.tsx", "proxy.ts"]));
    expect(entries.filter((f) => f.startsWith("scripts/")).length).toBeGreaterThan(5);
    expect(entries).toContain("platform/modules/app-modules.ts");
  });

  describe("on a scratch repository", () => {
    let root: string;
    const put = (rel: string, text: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "reachable-modules-"));
      put("package.json", JSON.stringify({ name: "x", scripts: {} }));
      put("app/page.tsx", 'import { a } from "@/lib/a";\nexport default a;\n');
      put("lib/a.ts", 'export { b as a } from "../platform/b";\n');
      put("platform/b.ts", "export const b = 1;\n");
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    const report = (known = {}, consumer = {}) => unreachedModules(root, known, consumer);

    it("[self-test] a module nothing imports is refused; one a page reaches passes", () => {
      expect(report()).toEqual({ unreached: [], stale: [] });
      put("hooks/useStream.ts", "export const useStream = () => null;\n");
      expect(report().unreached).toEqual(["hooks/useStream.ts"]);
    });

    it("[self-test] a module only a test or an unreached module imports is refused", () => {
      put("lib/pkce.ts", "export const v = 1;\n");
      put("__tests__/pkce.test.ts", 'import { v } from "@/lib/pkce";\n');
      put("hooks/useChannel.ts", 'import { s } from "./events";\n');
      put("hooks/events.ts", "export const s = 1;\n");
      expect(report().unreached).toEqual([
        "hooks/events.ts",
        "hooks/useChannel.ts",
        "lib/pkce.ts",
      ]);
    });

    it("[self-test] a colocated app file counts only when a convention file imports it", () => {
      put("app/account/AccountClient.tsx", "export default () => null;\n");
      expect(report().unreached).toEqual(["app/account/AccountClient.tsx"]);
      put(
        "app/account/page.tsx",
        'import C from "./AccountClient";\nexport default C;\n'
      );
      expect(report().unreached).toEqual([]);
    });

    it("[self-test] middleware, instrumentation and route handlers are entry points", () => {
      put("proxy.ts", 'import "@/platform/edge";\n');
      put("platform/edge.ts", "export {};\n");
      put(
        "instrumentation.ts",
        'export async function register() { await import("./lib/boot"); }\n'
      );
      put("lib/boot.ts", "export {};\n");
      put("app/api/x/route.ts", 'import { r } from "@/lib/r";\nexport const GET = r;\n');
      put("lib/r.ts", "export const r = 1;\n");
      expect(report().unreached).toEqual([]);
    });

    it("[self-test] scripts, the files they name, workflows and package scripts are entry points", () => {
      put(
        "scripts/relink.mjs",
        'const load = (p) => import(p);\nawait load("platform/auth/relink-command.ts");\n// lib/commented.ts\n'
      );
      put("platform/auth/relink-command.ts", "export {};\n");
      put("lib/commented.ts", "export {};\n");
      put(".github/workflows/ci.yml", "run: npx tsx lib/ci-step.ts\n# run: lib/off.ts\n");
      put("lib/ci-step.ts", "export {};\n");
      put("lib/off.ts", "export {};\n");
      put(
        "package.json",
        JSON.stringify({
          name: "x",
          scripts: { w: "node lib/worker.mjs" },
          main: "lib/main.js",
        })
      );
      put("lib/worker.mjs", "export {};\n");
      put("lib/main.js", "module.exports = {};\n");
      put("scripts/risk-tiers.json", JSON.stringify({ high: ["lib/data-only.ts"] }));
      put("lib/data-only.ts", "export {};\n");
      // A path in a script's data file (risk tiers) is not a script naming it.
      expect(report().unreached).toEqual([
        "lib/commented.ts",
        "lib/data-only.ts",
        "lib/off.ts",
      ]);
    });

    it("[self-test] the module registry's definitions, entries and composition roots are entry points", () => {
      put(
        "platform/modules/manifest.json",
        JSON.stringify({
          compositionRoots: ["platform/modules/app-modules.ts"],
          modules: {
            m: { definition: "platform/m/module.ts", entry: "platform/m/index.ts" },
          },
        })
      );
      put("platform/modules/app-modules.ts", "export {};\n");
      put("platform/m/module.ts", "export {};\n");
      put("platform/m/index.ts", 'export * from "./impl";\n');
      put("platform/m/impl.ts", "export {};\n");
      put("platform/m/orphan.ts", "export {};\n");
      // A core area's entry (its index.ts, the consumer's import path) is a package export.
      put("platform/jobs/index.ts", 'export { enqueue } from "./queue";\n');
      put("platform/jobs/queue.ts", "export const enqueue = 1;\n");
      put("platform/jobs/deep/index.ts", "export {};\n");
      expect(report().unreached).toEqual([
        "platform/jobs/deep/index.ts",
        "platform/m/orphan.ts",
      ]);
    });

    it("[self-test] a consumer entry or a known entry passes what it names and what that imports; a stale one fails", () => {
      put("components/Input/index.ts", 'export * from "./Input";\n');
      put("components/Input/Input.tsx", "export const Input = 1;\n");
      put(
        "platform/route-policy/policy.ts",
        'import type { S } from "./spec";\nexport const p: S = {};\n'
      );
      put("platform/route-policy/spec.ts", "export type S = object;\n");
      expect(
        report(
          { "platform/route-policy/policy.ts": "why", "lib/a.ts": "reached anyway" },
          { "components/Input/": "a consumer mounts it", "lib/gone.ts": "no file" }
        )
      ).toEqual({ unreached: [], stale: ["lib/gone.ts", "lib/a.ts"] });
    });

    it("[self-test] named paths: strings and non-comment lines only, with their extension", () => {
      expect(
        pathsInText('run: node scripts/x.mjs && tsx "./lib/y.ts"\n# lib/z.ts')
      ).toEqual(["scripts/x.mjs", "lib/y.ts"]);
      expect(pathsInText("see platform/a/README.md and lib/b.ts.bak")).toEqual([]);
      expect(pathsInScript("s.mjs", '// lib/c.ts\nconst f = "lib/d.ts";\n')).toEqual([
        "lib/d.ts",
      ]);
    });
  });
});
