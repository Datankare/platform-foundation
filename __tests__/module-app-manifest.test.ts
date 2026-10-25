/**
 * __tests__/module-app-manifest.test.ts — The app's module manifest (TASK-157, ADR-054 D6)
 *
 * platform/modules/manifest.json is the platform's and is synced unchanged; an app's own files
 * that belong to a module, and the app's own modules, go in platform/modules/app-manifest.json (a
 * consumer seam). scripts/module-manifest.cjs merges the two, and every reader — the lint
 * boundary, the manifest and boundary tests, test:core, the migration replay — sees the merge.
 *
 * An app may add paths to a platform module and declare new modules, with dependencies and
 * migrations. The merge refuses, loudly and saying what to change: a path claimed by two modules,
 * an app redefining a platform module's dependencies (or definition, entry, kit manifest), an
 * unknown list, an unknown dependency, a cycle.
 */

import { existsSync } from "fs";

const mm = require("../scripts/module-manifest.cjs");

const PLATFORM = mm.loadPlatformManifest();
const merge = (app: unknown) => mm.mergeManifests(PLATFORM, app);
const NEW_MODULE = {
  definition: "features/quiz/module.ts",
  entry: "features/quiz/index.ts",
  dependsOn: ["social"],
  code: ["features/quiz"],
  routes: ["app/api/quiz"],
  tests: ["__tests__/quiz.test.ts"],
  migrations: ["supabase/migrations/052a_playform_quiz_scores.sql"],
};

describe("the app's module manifest (TASK-157)", () => {
  it("platform-foundation ships it empty: the merge is the platform's manifest", () => {
    expect(existsSync(mm.APP_MANIFEST)).toBe(true);
    const app = mm.loadAppManifest();
    if (app.app === null) {
      expect(app).toMatchObject({ modules: {}, migrationsBeforeTheConvention: [] });
      expect(mm.moduleIds(mm.loadManifest())).toEqual(Object.keys(PLATFORM.modules));
    }
    // In any app, the merged manifest is the one every reader loads.
    expect(mm.loadManifest()).toEqual(merge(app));
  });

  it("adds an app's paths to a platform module, once, after the platform's", () => {
    const app = {
      app: "playform",
      modules: {
        translation: { routes: ["app/api/translate", "app/api/translate"] },
        "song-id": {
          routes: ["app/api/identify"],
          tests: ["__tests__/identify-api.test.ts"],
        },
      },
    };
    const merged = merge(app);
    expect(merged.modules.translation.routes).toEqual([
      ...PLATFORM.modules.translation.routes,
      "app/api/translate",
    ]);
    expect(merged.modules["song-id"].tests).toEqual([
      ...PLATFORM.modules["song-id"].tests,
      "__tests__/identify-api.test.ts",
    ]);
    expect(mm.zoneOf(merged, "app/api/identify/route.ts")).toBe("song-id");
    expect(mm.ownerOf(merged, "__tests__/identify-api.test.ts")).toBe("song-id");
    expect(merged.appModules).toEqual([]);
    expect(PLATFORM.modules.translation.routes).not.toContain("app/api/translate");
  });

  it("declares an app's own module, with its dependencies and migrations", () => {
    const merged = merge({ app: "playform", modules: { quiz: NEW_MODULE } });
    expect(mm.moduleIds(merged)).toEqual([...Object.keys(PLATFORM.modules), "quiz"]);
    expect(merged.appModules).toEqual(["quiz"]);
    expect(merged.modules.quiz).toMatchObject({
      dependsOn: ["social"],
      kitManifest: null,
    });
    expect(mm.dependencyOrder(merged, ["social", "quiz"])).toEqual(["social", "quiz"]);
    expect(mm.mayImport(merged, "quiz", "social")).toBe(true);
    expect(mm.mayImport(merged, "social", "quiz")).toBe(false);
    // Its migration replays after the core's and after the module it depends on.
    const files = [...mm.migrationFiles(), "052a_playform_quiz_scores.sql"].sort();
    const order: string[] = mm.replayOrder(merged, files);
    expect(order.at(-1)).toBe("052a_playform_quiz_scores.sql");
    expect(order.indexOf("015_social_data_model.sql")).toBeLessThan(order.length - 1);
    // The lint boundary gets a zone for it, and the core may not import it.
    const blocks = mm.lintBoundaryConfigs(merged);
    const coreZones = blocks[0].rules["import/no-restricted-paths"][1].zones;
    expect(
      coreZones.some((z: { message: string }) => z.message.includes('Module "quiz"'))
    ).toBe(true);
  });

  it.each([
    [
      "a path claimed by a platform module and an app module",
      { modules: { quiz: { ...NEW_MODULE, code: ["platform/social/store.ts"] } } },
      /path claimed by two modules: "platform\/social" \(social\.code\) and "platform\/social\/store\.ts" \(quiz\.code\)/,
    ],
    [
      "an app adding another module's path to a platform module",
      { modules: { social: { code: ["platform/voice/chunker.ts"] } } },
      /path claimed by two modules: "platform\/voice\/chunker\.ts" \(voice\.code\) and "platform\/voice\/chunker\.ts" \(social\.code\)/,
    ],
    [
      "a module claiming a composition root",
      { modules: { social: { code: ["platform/modules/app-home.tsx"] } } },
      /claims "platform\/modules\/app-home\.tsx", a composition root/,
    ],
    [
      "an app redefining a platform module's dependencies",
      { modules: { translation: { dependsOn: ["social"] } } },
      /modules\.translation\.dependsOn: "translation" is a platform module — its dependsOn is the platform's to declare\. Remove "dependsOn"/,
    ],
    [
      "an app redefining a platform module's definition",
      { modules: { games: { definition: "x.ts" } } },
      /modules\.games\.definition: "games" is a platform module/,
    ],
    [
      "an unknown list",
      { modules: { games: { sources: ["x"] } } },
      /modules\.games\.sources: not a manifest key — use code, prompts/,
    ],
    [
      "an unknown dependency",
      { modules: { quiz: { ...NEW_MODULE, dependsOn: ["leaderboard"] } } },
      /module "quiz" \(platform\/modules\/app-manifest\.json\) depends on "leaderboard", which no manifest declares/,
    ],
    [
      "a dependency cycle",
      {
        modules: {
          quiz: { ...NEW_MODULE, dependsOn: ["board"] },
          board: {
            definition: "b/module.ts",
            entry: "b/index.ts",
            dependsOn: ["quiz"],
            code: ["b"],
          },
        },
      },
      /dependency cycle: quiz → board → quiz/,
    ],
    [
      "a new module without a definition",
      { modules: { quiz: { entry: "features/quiz/index.ts" } } },
      /modules\.quiz: a new module declares "definition"/,
    ],
    [
      "a malformed module id",
      { modules: { Quiz_Board: { definition: "q.ts", entry: "q.ts" } } },
      /modules\.Quiz_Board: a module id is lower-case words joined by hyphens/,
    ],
    [
      "a malformed app prefix",
      { app: "Play-Form", modules: {} },
      /"app" must be your app's migration prefix/,
    ],
    ["an unknown top-level key", { overlay: {}, modules: {} }, /unknown key "overlay"/],
  ])("refuses %s", (_name, app, message) => {
    expect(() => merge(app)).toThrow(message);
  });

  it("reports every problem at once", () => {
    let message = "";
    try {
      merge({
        modules: { translation: { dependsOn: [] }, games: { entry: "games/x.ts" } },
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.split("\n")).toHaveLength(2);
  });
});

/**
 * Review 7 H2: an app manifest could take what is the platform's. A platform migration claimed
 * into a module left the core's replay order (and REPLAY_MODULES could leave it out altogether);
 * a core path claimed into a module's code or tests left the core's import boundary. The merge
 * now refuses each — these are the reviewer's four manifests, and their variants.
 */
describe("the app's manifest cannot take the platform's migrations or paths (review 7 H2)", () => {
  const replayed = (app: unknown, selected?: string[]) =>
    mm.replayOrder(merge(app), mm.migrationFiles(), selected);

  it.each([
    [
      "a platform migration claimed into a platform module",
      {
        app: "playform",
        modules: { social: { migrations: ["supabase/migrations/049_tenancy.sql"] } },
      },
      /modules\.social\.migrations "supabase\/migrations\/049_tenancy\.sql": 049_tenancy\.sql is a platform migration/,
    ],
    [
      "a platform migration claimed into an app module (REPLAY_MODULES would drop it)",
      {
        app: "playform",
        modules: {
          quiz: { ...NEW_MODULE, migrations: ["supabase/migrations/049_tenancy.sql"] },
        },
      },
      /modules\.quiz\.migrations "supabase\/migrations\/049_tenancy\.sql": 049_tenancy\.sql is a platform migration/,
    ],
    [
      "core paths claimed into a module's code",
      {
        app: "playform",
        modules: {
          translation: {
            code: ["platform/auth/user-data.ts", "platform/gdpr", "app/api/account"],
          },
        },
      },
      /modules\.translation\.code "platform\/auth\/user-data\.ts": everything under platform\/ is the platform's/,
    ],
    [
      "a core path claimed into a module's tests",
      {
        app: "playform",
        modules: { quiz: { ...NEW_MODULE, tests: ["platform/data/tx.ts"] } },
      },
      /modules\.quiz\.tests "platform\/data\/tx\.ts": everything under platform\/ is the platform's/,
    ],
  ])("refuses the reviewer's manifest: %s", (_name, app, message) => {
    expect(() => merge(app)).toThrow(message);
  });

  it("names every core path of a manifest that claims several", () => {
    let message = "";
    try {
      merge({
        app: "playform",
        modules: {
          translation: {
            code: ["platform/auth/user-data.ts", "platform/gdpr", "app/api/account"],
          },
        },
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/"platform\/gdpr": everything under platform\//);
    expect(message).toMatch(
      /"app\/api\/account": holds the platform's app\/api\/account\/[^ ]+ \(platform\/modules\/platform-paths\.json\)/
    );
  });

  it.each([
    [
      "a platform file outside platform/",
      { routes: ["app/api/account/delete/route.ts"] },
      /a platform file/,
    ],
    [
      "a directory holding platform files",
      { tests: ["__tests__/db"] },
      /holds the platform's __tests__\/db\//,
    ],
    ["a parent of everything", { code: ["app"] }, /holds the platform's app\//],
    ["platform/ itself", { code: ["platform"] }, /everything under platform\//],
    [
      "a path climbing out with ..",
      { code: ["features/../platform/auth"] },
      /without "\.", "\.\."/,
    ],
    ["a path through .", { code: ["./platform/auth"] }, /without "\.", "\.\."/],
    ["an absolute path", { code: ["/platform/auth"] }, /without "\.", "\.\."/],
    [
      "the migrations directory",
      { migrations: ["supabase/migrations"] },
      /one file, supabase\/migrations\/<name>\.sql/,
    ],
    [
      "a platform migration by another directory",
      { migrations: ["db/049_tenancy.sql"] },
      /one file/,
    ],
    [
      "a definition that is a platform file",
      { definition: "lib/logger.ts" },
      /modules\.quiz\.definition "lib\/logger\.ts": a platform file/,
    ],
  ])("refuses %s", (_name, extra, message) => {
    expect(() =>
      merge({ app: "playform", modules: { quiz: { ...NEW_MODULE, ...extra } } })
    ).toThrow(message);
  });

  // Review 8 H-D: an entry is a path, matched as written. A glob put files the app never named —
  // the platform's own — in a module's lint zone; a case or normalisation variant of a platform
  // path slipped past the platform-paths check (it is the same file on macOS and Windows).
  it.each([
    ["a recursive glob", { routes: ["app/api/**"] }],
    ["a star", { code: ["app/api/acc*"] }],
    ["a glob of tests", { tests: ["__tests__/db/*.ts"] }],
    ["a question mark", { code: ["lib/logge?.ts"] }],
    ["a character class", { code: ["lib/[l]ogger.ts"] }],
    ["a closing bracket", { code: ["lib/logger].ts"] }],
    ["braces", { code: ["lib/{logger,sanitize}.ts"] }],
    ["a closing brace", { code: ["lib/logger}.ts"] }],
    ["a negation", { code: ["!lib/quiz.ts"] }],
    ["an extglob @(", { code: ["lib/@(logger).ts"] }],
    ["an extglob +(", { code: ["lib/+(logger).ts"] }],
    ["a comment", { code: ["#lib/quiz.ts"] }],
    ["a backslash", { code: ["lib\\logger.ts"] }],
    ["a control character", { code: ["lib/quiz\u0000.ts"] }],
  ])("refuses glob and control characters: %s", (_name, extra) => {
    expect(() =>
      merge({ app: "playform", modules: { quiz: { ...NEW_MODULE, ...extra } } })
    ).toThrow(/glob characters \(\* \? \[ \] \{ \} ! @\( \+\( #\) or control characters/);
  });

  it.each([
    ["Platform/auth", { code: ["Platform/auth"] }, /everything under platform\//],
    [
      "PLATFORM/data/tx.ts",
      { tests: ["PLATFORM/data/tx.ts"] },
      /everything under platform\//,
    ],
    [
      "app/api/Account",
      { routes: ["app/api/Account"] },
      /holds the platform's app\/api\/account\//,
    ],
    ["Lib/Logger.ts", { code: ["Lib/Logger.ts"] }, /a platform file/],
    [
      "a platform migration in another case",
      { migrations: ["supabase/migrations/049_TENANCY.sql"] },
      /is a platform migration/,
    ],
    [
      "the migrations directory in another case",
      { migrations: ["supabase/Migrations/049_tenancy.sql"] },
      /one file/,
    ],
  ])(
    "refuses a case or Unicode variant of a platform path: %s",
    (_name, extra, message) => {
      expect(() =>
        merge({ app: "playform", modules: { quiz: { ...NEW_MODULE, ...extra } } })
      ).toThrow(message);
    }
  );

  /** A second app module, claiming `code`. */
  const BOARD = (code: string[]) => ({
    definition: "features/board/module.ts",
    entry: "features/board/index.ts",
    dependsOn: [],
    code,
  });

  it("compares in NFC: a composed and a decomposed é are one path", () => {
    const composed = "app/caf\u00e9.ts";
    const decomposed = "app/cafe\u0301.ts";
    expect(() =>
      merge({
        app: "playform",
        modules: {
          quiz: { ...NEW_MODULE, code: [composed] },
          board: BOARD([decomposed]),
        },
      })
    ).toThrow(/path claimed by two modules/);
  });

  it("two modules claiming one path in different cases is a double claim", () => {
    expect(() =>
      merge({
        app: "playform",
        modules: {
          quiz: { ...NEW_MODULE, code: ["features/quiz"] },
          board: BOARD(["Features/Quiz/x.ts"]),
        },
      })
    ).toThrow(/path claimed by two modules/);
  });

  // Review 9 L10: lookalikes of a platform path that the segment checks let through — each the
  // platform's own path to a matcher or a file system that drops, decodes or ignores the extra.
  it.each([
    ["a trailing dot (Windows drops it)", "platform./auth"],
    ["a trailing dot inside app/", "app/api/account./delete"],
    ["a trailing space", "platform /auth"],
    ["a zero-width space (\\p{Cf})", "plat\u200bform/auth"],
    ["a soft hyphen (\\p{Cf})", "plat\u00adform/auth"],
    ["a byte-order mark (\\p{Cf})", "\ufeffplatform/auth"],
    ["a fullwidth solidus", "platform\uff0fauth"],
    ["a division slash", "platform\u2215auth"],
    ["an encoded slash", "app/api/account%2Fdelete"],
    ["a percent sign anywhere", "features/100%"],
    ["a route group with a trailing dot", "app/(quiz.)/play"],
    ["an empty route group", "app/()/play"],
    ["a non-ASCII letter", "features/qu\u00efz"],
  ])("refuses %s: %j", (_name, p) => {
    expect(() =>
      merge({
        app: "playform",
        modules: { quiz: { ...NEW_MODULE, code: ["features/quiz", p] } },
      })
    ).toThrow(/plain segments/);
  });

  it("still accepts plain segments: letters, digits, . _ -, a dotfile, a route group", () => {
    expect(() =>
      merge({
        app: "playform",
        modules: {
          quiz: {
            ...NEW_MODULE,
            code: ["features/quiz", "features/quiz-2/x_y.test.ts", ".storybook/quiz.ts"],
            routes: ["app/(quiz)/play"],
          },
        },
      })
    ).not.toThrow();
  });

  it("a Next.js route group's parentheses are plain, and accepted", () => {
    expect(() =>
      merge({
        app: "playform",
        modules: { quiz: { ...NEW_MODULE, routes: ["app/(quiz)/play"] } },
      })
    ).not.toThrow();
  });

  it("without the app's claim, 049 replays with the core whatever modules are selected", () => {
    const order = replayed({ app: "playform", modules: { quiz: NEW_MODULE } }, []);
    expect(order).toContain("049_tenancy.sql");
    expect(order.indexOf("049_tenancy.sql")).toBe(
      order.indexOf("048_ai_metrics.sql") + 1
    );
  });

  it("still takes an app's own files — Playform's manifest as it stands", () => {
    const playform = {
      app: "playform",
      modules: {
        translation: {
          code: ["lib/transcribe.ts", "lib/extract.ts", "hooks/useAudioRecorder.ts"],
          routes: [
            "app/api/translate",
            "app/api/tts",
            "app/api/transcribe",
            "app/api/extract",
          ],
          components: ["components/LanguagePicker.tsx", "components/TranslationCard.tsx"],
          tests: ["__tests__/extract-api.test.ts", "__tests__/tts.test.ts"],
        },
        "song-id": {
          routes: ["app/api/identify"],
          tests: ["__tests__/identify-api.test.ts"],
        },
      },
    };
    expect(() => merge(playform)).not.toThrow();
  });

  it("platform-paths.json lists every file the platform ships outside platform/ (not the seams)", () => {
    const listed: string[] = mm.loadPlatformPaths();
    expect(listed).toContain("app/api/account/delete/route.ts");
    expect(listed).toContain("supabase/migrations/049_tenancy.sql");
    expect(listed.some((f) => f.startsWith("platform/"))).toBe(false);
    for (const seam of mm.CONSUMER_SEAMS)
      expect(listed.some((f: string) => mm.within(f, seam))).toBe(false);
    // In platform-foundation, --check proves the list is the tree (an app never regenerates it).
    if (mm.loadAppManifest().app === null) {
      const tracked = mm.trackedPlatformPaths();
      if (tracked !== null) expect(listed).toEqual(tracked);
    }
  });
});
