/**
 * __tests__/module-lint.test.ts — The lint rule draws the core/module boundary (ADR-054 D3)
 *
 * Lints fixture sources as if they were files in the tree — virtual files, nothing is written —
 * with the repository's own eslint.config.mjs, and asserts what import/no-restricted-paths
 * reports. Covers every import form the boundary must see (`@/` aliases, relative paths,
 * `export … from`, type-only imports, `require()`, dynamic `import()`) and every kind of file:
 * core code, a core test, the composition roots, a module, a module's declared dependency, the
 * file-pattern zones inside the shared platform/voice/ directory, and a module's own test.
 *
 * ESLint runs in a child process (helpers/eslint-fixtures.cjs): it loads its config with a
 * dynamic import(), which jest's module sandbox does not support.
 */

import { execFileSync } from "child_process";
import { join } from "path";

// The module ids and dependencies come from the merged manifest (TASK-157), never a copy.
const mm = require("../scripts/module-manifest.cjs");
const MANIFEST = mm.loadManifest();
const IDS: string[] = mm.moduleIds(MANIFEST);

const RULE = "import/no-restricted-paths";
const CORE = "platform/agents/__boundary_fixture__.ts";
// An existing voice file: in the shared directory, a file belongs to the module that lists it.
const VOICE = "platform/voice/pipeline.ts";
const SONG_ID = "platform/voice/song-id-module.ts";
const SOCIAL_TEST = "__tests__/social-store.test.ts";

interface Fixture {
  readonly name: string;
  readonly filePath: string;
  readonly code: string;
}

const importing = (specifier: string, name = "x"): string =>
  `import { ${name} } from "${specifier}";\nvoid ${name};`;

/** Core files importing a module, one per import form and kind of module file. */
const CORE_BREACHES: readonly Fixture[] = [
  ["an @/ alias", importing("@/platform/social", "getSocialStore")],
  ["a relative path", importing("../social/store", "getSocialStore")],
  [
    "a type-only import",
    'import type { SocialStore } from "@/platform/social/types";\nexport type S = SocialStore;',
  ],
  ["export … from", 'export { SOCIAL_MODULE } from "@/platform/social/module";'],
  ["require()", 'export const store = require("@/platform/social/store");'],
  ["dynamic import()", 'export const load = () => import("@/platform/voice/song-id");'],
  ["a module route", 'export { POST } from "@/app/api/process/route";'],
  ["a module component", 'export { default } from "@/components/SpikeApp";'],
  ["a module prompt", importing("@/prompts/social/curator-v1", "CURATOR_V1")],
  [
    "a module's kit",
    'export { runSocialStoreContract } from "@/__tests__/contract/social-store-contract";',
  ],
].map(([name, code]) => ({ name, filePath: CORE, code }));

/** Imports the boundary allows, and imports between modules it refuses. */
const OTHERS: readonly Fixture[] = [
  {
    name: "core test → module",
    filePath: "__tests__/__boundary_fixture__.test.ts",
    code: importing("@/platform/social/memory-social-store", "InMemorySocialStore"),
  },
  {
    name: "core → core",
    filePath: CORE,
    code: importing("@/platform/modules", "getModules"),
  },
  {
    name: "app-modules → module",
    filePath: "platform/modules/app-modules.ts",
    code: importing("@/platform/social/module", "SOCIAL_MODULE"),
  },
  {
    name: "app-home → module",
    filePath: "platform/modules/app-home.tsx",
    code: 'import SpikeApp from "@/components/SpikeApp";\nexport const Home = SpikeApp;',
  },
  {
    name: "voice → translation (declared)",
    filePath: VOICE,
    code: 'import type { TranslationProvider } from "@/platform/translation/types";\nexport type T = TranslationProvider;',
  },
  {
    name: "voice → social (undeclared)",
    filePath: VOICE,
    code: importing("@/platform/social/store", "getSocialStore"),
  },
  {
    name: "song-id → audio-convert (declared)",
    filePath: SONG_ID,
    code: importing("./audio-converter-readiness", "isAudioConverterReady"),
  },
  {
    name: "song-id → voice (undeclared)",
    filePath: SONG_ID,
    code: importing("./chunker", "chunkText"),
  },
  {
    name: "audio-convert → song-id (undeclared)",
    filePath: "platform/voice/ffmpeg-converter.ts",
    code: importing("./mock-identify", "MockSongIdentifier"),
  },
  {
    name: "social test → social",
    filePath: SOCIAL_TEST,
    code: importing("@/platform/social/memory-social-store", "InMemorySocialStore"),
  },
  {
    name: "social test → translation",
    filePath: SOCIAL_TEST,
    code: importing("@/platform/translation/mock-translate", "MockTranslateProvider"),
  },
];

interface LintOutput {
  readonly results: {
    filePath: string;
    messages: { ruleId: string; message: string }[];
  }[];
  readonly configs: Record<string, [number, { zones: { message: string }[] }] | string>;
}

let output: LintOutput;
const messagesFor = new Map<string, string[]>();

beforeAll(() => {
  const fixtures = [...CORE_BREACHES, ...OTHERS];
  const stdout = execFileSync(
    process.execPath,
    [join(process.cwd(), "__tests__/helpers/eslint-fixtures.cjs")],
    {
      cwd: process.cwd(),
      input: JSON.stringify({
        files: fixtures.map(({ filePath, code }) => ({ filePath, code })),
        configFor: [CORE, "platform/modules/app-modules.ts", VOICE],
      }),
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  output = JSON.parse(stdout.toString("utf8"));
  fixtures.forEach((f, i) => {
    messagesFor.set(
      f.name,
      output.results[i].messages.filter((m) => m.ruleId === RULE).map((m) => m.message)
    );
  });
}, 120_000);

describe("import/no-restricted-paths (ADR-054 D3)", () => {
  it("is on for core files with one zone per module, drawn from the manifest", () => {
    const entry = output.configs[CORE];
    expect(Array.isArray(entry) && entry[0]).toBe(2);
    const zones = Array.isArray(entry) ? entry[1].zones : [];
    expect(zones.map((z) => /Module "([\w-]+)"/.exec(z.message)?.[1]).sort()).toEqual(
      [...IDS].sort()
    );
  });

  it("is off for a composition root", () => {
    // ESLint keeps the options of an earlier config object when a later one turns a rule off.
    const entry = output.configs["platform/modules/app-modules.ts"];
    expect(Array.isArray(entry) ? entry[0] : entry).toBe(0);
  });

  it("gives a module zones for exactly the modules it does not depend on", () => {
    const entry = output.configs[VOICE];
    const zones = Array.isArray(entry) ? entry[1].zones : [];
    expect(
      zones.map((z) => /Module "([\w-]+)" is outside/.exec(z.message)?.[1]).sort()
    ).toEqual(IDS.filter((id) => !mm.mayImport(MANIFEST, "voice", id)).sort());
  });

  it.each(CORE_BREACHES.map((f) => [f.name]))(
    "refuses a core file importing a module through %s",
    (name) => {
      const messages = messagesFor.get(name) ?? [];
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(/The core never imports a product module/);
    }
  );

  it.each([
    ["core test → module", /Module "social" is outside it/],
    [
      "voice → social (undeclared)",
      /Module "voice" may import .*Module "social" is outside/,
    ],
    ["song-id → voice (undeclared)", /Module "voice" is outside it/],
    ["audio-convert → song-id (undeclared)", /Module "song-id" is outside it/],
    ["social test → translation", /Module "translation" is outside it/],
  ])("refuses %s", (name, pattern) => {
    expect(messagesFor.get(name)).toEqual([expect.stringMatching(pattern)]);
  });

  it.each([
    ["core → core"],
    ["app-modules → module"],
    ["app-home → module"],
    ["voice → translation (declared)"],
    ["song-id → audio-convert (declared)"],
    ["social test → social"],
  ])("allows %s", (name) => {
    expect(messagesFor.get(name)).toEqual([]);
  });
});
