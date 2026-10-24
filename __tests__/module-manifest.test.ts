/**
 * __tests__/module-manifest.test.ts — platform/modules/manifest.json is true (ADR-054 D6)
 *
 * The manifest says where each module's files are today; the lint boundary, the boundary test,
 * the conformance composition, the migration replay and (Sprint 7S) the consumer sync all read
 * it. So it is checked both ways:
 *
 *   - everything it lists exists, and no file is claimed twice;
 *   - every file in a module directory is listed by exactly one module (a directory listed as a
 *     module's, or a directory the modules share until 7S) — a new file there cannot go unowned;
 *   - it agrees with the modules the app registers: ids, dependencies, kits, definitions, prompts
 *     and evals, and the singleton keys the module slots declare;
 *   - the lint configuration is generated from it.
 */

import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { getModules, type PlatformModule } from "@/platform/modules";
import { isTestFile, sourceFiles } from "./helpers/import-graph";

const mm = require("../scripts/module-manifest.cjs");

interface ManifestModule {
  readonly definition: string;
  readonly entry: string;
  readonly dependsOn: readonly string[];
  readonly code: readonly string[];
  readonly prompts: readonly string[];
  readonly evals: readonly string[];
  readonly routes: readonly string[];
  readonly components: readonly string[];
  readonly tests: readonly string[];
  readonly kits: readonly string[];
  readonly kitManifest: string | null;
  readonly migrations: readonly string[];
}
interface Manifest {
  readonly compositionRoots: readonly string[];
  readonly seamTests: readonly string[];
  readonly sharedDirectories: readonly string[];
  readonly modules: Record<string, ManifestModule>;
}

const ROOT = process.cwd();
const MANIFEST: Manifest = mm.loadManifest();
const IDS: string[] = mm.moduleIds(MANIFEST);
const LIST_KEYS = [
  "dependsOn",
  "code",
  "prompts",
  "evals",
  "routes",
  "components",
  "tests",
  "kits",
  "migrations",
] as const;

const isDir = (rel: string) =>
  existsSync(join(ROOT, rel)) && statSync(join(ROOT, rel)).isDirectory();
const zoneFiles = (id: string): string[] =>
  mm.zonePaths(MANIFEST, id).flatMap((p: string) => mm.expandPath(p));
const ownedFiles = (id: string): string[] =>
  mm.ownedPaths(MANIFEST, id).flatMap((p: string) => mm.expandPath(p));

/** Every listed path of a module, with what it is listed as. */
function listedPaths(id: string): [string, string][] {
  const m = MANIFEST.modules[id];
  const lists = LIST_KEYS.filter((k) => k !== "dependsOn").flatMap((k) =>
    m[k].map((p): [string, string] => [k, p])
  );
  const singles: [string, string | null][] = [
    ["definition", m.definition],
    ["entry", m.entry],
    ["kitManifest", m.kitManifest],
  ];
  return [...lists, ...singles.filter((e): e is [string, string] => e[1] !== null)];
}

describe("module manifest (ADR-054 D6)", () => {
  it("self-test: lists the six modules and finds their files", () => {
    expect([...IDS].sort()).toEqual(
      ["audio-convert", "games", "social", "song-id", "translation", "voice"].sort()
    );
    expect(zoneFiles("social")).toContain("platform/social/module.ts");
    expect(zoneFiles("song-id")).toContain("platform/voice/acrcloud-identify.ts");
    expect(mm.zoneOf(MANIFEST, "platform/voice/chunker.ts")).toBe("voice");
    expect(mm.zoneOf(MANIFEST, "platform/agents/registry.ts")).toBeNull();
  });

  it.each(IDS)("%s declares every list", (id) => {
    for (const key of LIST_KEYS)
      expect([key, Array.isArray(MANIFEST.modules[id][key])]).toEqual([key, true]);
  });

  it.each(IDS)("everything %s lists exists", (id) => {
    const missing = listedPaths(id).filter(([, p]) => !existsSync(join(ROOT, p)));
    expect(missing).toEqual([]);
  });

  it("the composition roots, their tests and the shared directories exist; roots are outside every zone", () => {
    for (const p of [
      ...MANIFEST.compositionRoots,
      ...MANIFEST.seamTests,
      ...MANIFEST.sharedDirectories,
    ]) {
      expect([p, existsSync(join(ROOT, p))]).toEqual([p, true]);
    }
    for (const root of MANIFEST.compositionRoots) {
      expect([root, mm.ownerOf(MANIFEST, root)]).toEqual([root, null]);
    }
  });

  it("no file is in two modules' zones", () => {
    const owner = new Map<string, string>();
    const twice: string[] = [];
    for (const id of IDS) {
      for (const file of zoneFiles(id)) {
        const first = owner.get(file);
        if (first) twice.push(`${file}: ${first} and ${id}`);
        owner.set(file, id);
      }
    }
    expect(twice).toEqual([]);
  });

  it("every file in a module directory is listed by exactly one module (bijection)", () => {
    const moduleDirs = [
      ...IDS.flatMap((id) => mm.zonePaths(MANIFEST, id).filter(isDir)),
      ...MANIFEST.sharedDirectories,
    ];
    const files = moduleDirs.flatMap((d: string) => mm.expandPath(d));
    expect(files.length).toBeGreaterThan(60);
    const unlisted = files.filter((f: string) => mm.zoneOf(MANIFEST, f) === null);
    expect(unlisted).toEqual([]);
  });

  it("a module's tests and kits sit outside every zone and belong to one module", () => {
    const owner = new Map<string, string>();
    const problems: string[] = [];
    for (const id of IDS) {
      for (const file of ownedFiles(id)) {
        if (mm.zoneOf(MANIFEST, file) !== null) problems.push(`${file} is in a zone`);
        if (!file.startsWith("__tests__/"))
          problems.push(`${file} is not under __tests__/`);
        const first = owner.get(file);
        if (first) problems.push(`${file}: ${first} and ${id}`);
        owner.set(file, id);
      }
    }
    expect(problems).toEqual([]);
  });

  it("listed tests are test files jest runs or helpers they use", () => {
    for (const id of IDS) {
      for (const file of MANIFEST.modules[id].tests) {
        expect([file, isTestFile(file)]).toEqual([file, true]);
      }
    }
  });

  it.each(IDS)("%s: its definition and entry are in its zone", (id) => {
    const m = MANIFEST.modules[id];
    expect(mm.zoneOf(MANIFEST, m.definition)).toBe(id);
    expect(mm.zoneOf(MANIFEST, m.entry)).toBe(id);
  });

  it("migrations are listed by one module at most, under supabase/migrations", () => {
    const all = IDS.flatMap((id) => MANIFEST.modules[id].migrations);
    expect(new Set(all).size).toBe(all.length);
    for (const p of all) expect(p).toMatch(/^supabase\/migrations\/\d{3}_[\w-]+\.sql$/);
  });

  it("dependencies name listed modules and form no cycle", () => {
    for (const id of IDS) {
      for (const dep of MANIFEST.modules[id].dependsOn) expect(IDS).toContain(dep);
    }
    expect(mm.dependencyOrder(MANIFEST)).toHaveLength(IDS.length);
  });
});

describe("module manifest agrees with the module definitions (ADR-054 D4)", () => {
  /** The module each definition file exports (loaded here, whatever the app registers). */
  const definitions = new Map<string, PlatformModule>(
    IDS.map((id) => {
      const exported: Record<string, unknown> = require(
        join(ROOT, MANIFEST.modules[id].definition)
      );
      const found = Object.values(exported).filter(
        (v): v is PlatformModule =>
          typeof v === "object" && v !== null && "id" in v && "providers" in v
      );
      return [
        id,
        found.length === 1 && found[0].id === id ? found[0] : (undefined as never),
      ];
    })
  );

  it.each(IDS)("%s: its definition file exports exactly that module", (id) => {
    expect(definitions.get(id)?.id).toBe(id);
  });

  it("every module the app registers is a manifest module", () => {
    for (const mod of getModules()) expect(IDS).toContain(mod.id);
  });

  it.each(IDS)("%s: dependencies and kits match its definition", (id) => {
    const mod = definitions.get(id) as PlatformModule;
    expect([...mod.dependsOn].sort()).toEqual([...MANIFEST.modules[id].dependsOn].sort());
    expect([...mod.kits].sort()).toEqual([...MANIFEST.modules[id].kits].sort());
  });

  it.each(IDS)(
    "%s: the singletons in its zone are exactly those its slots declare",
    (id) => {
      const declaredInZone = new Set<string>();
      for (const f of zoneFiles(id).filter((f) => /\.tsx?$/.test(f))) {
        const src = readFileSync(join(ROOT, f), "utf8");
        for (const m of src.matchAll(/const\s+\w*KEY\s*=\s*"(platform\.[\w.]+)"/g)) {
          declaredInZone.add(m[1]);
        }
      }
      const slots = (definitions.get(id) as PlatformModule).providers.flatMap(
        (s) => s.singletonKeys
      );
      expect([...declaredInZone].sort()).toEqual([...slots].sort());
    }
  );

  it.each(IDS)("%s: its prompts and evals live in its zone", (id) => {
    const mod = definitions.get(id) as PlatformModule;
    const promptFiles = sourceFiles(join(ROOT, "prompts")).filter((f) =>
      /-v\d+\.ts$/.test(f)
    );
    for (const prompt of mod.prompts) {
      const file = promptFiles.find((f) =>
        new RegExp(`name:\\s*"${prompt.name}"`).test(readFileSync(join(ROOT, f), "utf8"))
      );
      expect([prompt.name, file && mm.zoneOf(MANIFEST, file)]).toEqual([prompt.name, id]);
    }
    for (const suite of mod.evals) {
      expect([suite.prompt, mm.zoneOf(MANIFEST, suite.source)]).toEqual([
        suite.prompt,
        id,
      ]);
    }
  });

  it.each(IDS)(
    "%s: every prompt file in its zone is declared by its definition",
    (id) => {
      const names = new Set(
        (definitions.get(id) as PlatformModule).prompts.map((p) => p.name)
      );
      for (const f of zoneFiles(id).filter((f) => /-v\d+\.ts$/.test(f))) {
        const m = readFileSync(join(ROOT, f), "utf8").match(/name:\s*"([a-z0-9-]+)"/);
        expect([f, m && names.has(m[1])]).toEqual([f, true]);
      }
    }
  );

  it("the core's prompts and evals name no module prompt", () => {
    const moduleFiles = new Set(IDS.flatMap(zoneFiles));
    const corePrompts = sourceFiles(join(ROOT, "prompts")).filter(
      (f) => !moduleFiles.has(f)
    );
    expect(corePrompts.length).toBeGreaterThan(5);
    for (const f of corePrompts) {
      const src = readFileSync(join(ROOT, f), "utf8");
      for (const id of IDS)
        expect([f, src.includes(`prompts/${id}/`)]).toEqual([f, false]);
    }
  });
});

describe("the lint boundary is generated from the manifest (ADR-054 D3)", () => {
  type Block = { files: string[]; rules: Record<string, unknown> };
  const blocks: Block[] = mm.lintBoundaryConfigs(MANIFEST);
  const zonesOf = (block: Block): string[] => {
    const rule = block.rules["import/no-restricted-paths"];
    if (!Array.isArray(rule)) return [];
    return rule[1].zones.map(
      (z: { message: string }) => /Module "([\w-]+)" is outside/.exec(z.message)?.[1]
    );
  };

  it("eslint.config.mjs draws its zones from the manifest reader, not a copy", () => {
    const config = readFileSync(join(ROOT, "eslint.config.mjs"), "utf8");
    expect(config).toMatch(
      /createRequire\(import\.meta\.url\)\(\s*"\.\/scripts\/module-manifest\.cjs"\s*\)/
    );
    expect(config).toMatch(/\.\.\.lintBoundaryConfigs\(\)/);
    expect(config).not.toMatch(/platform\/social|platform\/voice|platform\/translation/);
  });

  it("the first block forbids every module to every file", () => {
    expect(blocks[0].files).toEqual(["**/*.{js,jsx,mjs,cjs,ts,tsx}"]);
    expect(zonesOf(blocks[0]).sort()).toEqual([...IDS].sort());
  });

  it("each module's block covers its files and forbids exactly the modules it does not depend on", () => {
    // One block per module, in manifest order, between the core block and the roots' block.
    const moduleBlocks = blocks.slice(1, -1);
    expect(moduleBlocks).toHaveLength(IDS.length);
    IDS.forEach((id, i) => {
      const block = moduleBlocks[i];
      const expected = IDS.filter((other) => !mm.mayImport(MANIFEST, id, other)).sort();
      expect([id, zonesOf(block).sort()]).toEqual([id, expected]);
      const definition = MANIFEST.modules[id].definition;
      const covered = block.files.some(
        (g) => g === definition || definition.startsWith(g.replace(/\/\*\*\/.*$/, "/"))
      );
      expect([id, covered]).toEqual([id, true]);
    });
  });

  it("each zone forbids the module's code, tests and kits, and the roots are exempt", () => {
    const zone = (
      blocks[0].rules["import/no-restricted-paths"] as [
        number,
        { zones: { from: string[]; message: string }[] },
      ]
    )[1].zones;
    for (const id of IDS) {
      const entry = zone.find((z) => z.message.includes(`Module "${id}" is outside`));
      expect(entry?.from).toEqual([
        ...mm.zonePaths(MANIFEST, id),
        ...mm.ownedPaths(MANIFEST, id),
      ]);
    }
    const last = blocks[blocks.length - 1];
    expect(last.files).toEqual([...MANIFEST.compositionRoots]);
    expect(last.rules["import/no-restricted-paths"]).toBe("off");
  });
});
