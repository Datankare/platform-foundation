/**
 * __tests__/migration-naming.test.ts — Platform and app migrations never collide (TASK-158)
 *
 * The platform's migrations are NNN_<name>.sql, each listed in supabase/platform-migrations.json.
 * An app's are NNN<letter>_<app>_<name>.sql (052a_playform_…): they sort after the platform's NNN
 * and before NNN+1, so the platform can keep numbering without colliding with any app. "app" (the
 * prefix) is set in the app's platform/modules/app-manifest.json; null in platform-foundation.
 *
 * Refused: an app migration with a bare number (unless the app applied it before the convention
 * and lists it in migrationsBeforeTheConvention — renaming an applied migration re-runs it), an
 * app migration without the app's prefix, and the letter form in platform-foundation. The replay
 * (scripts/module-manifest.cjs --replay-order) runs the same check before it applies anything.
 *
 * Consumer-correct (PF v6.0.x — found adopting PF in Playform): an app inherits this file
 * unchanged. Every check of this repository's own migrations reads the merged manifest
 * (scripts/module-manifest.cjs: the platform's with the app's, its migrationsBeforeTheConvention
 * included) and sorts the files three ways — the platform's (supabase/platform-migrations.json),
 * the app's grandfathered ones (checked only for existence and replay order), and the app's
 * own (the convention and the 001-to-latest range). The constructed cases put the platform's
 * list, never this repository's files, beside a hand-made app manifest: an app's grandfathered
 * migrations (Playform's 007_playform_…, 031–036) are not in that manifest's list. A fixture app
 * repository with grandfathered migrations proves the checks pass there as they do here.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

const mm = require("../scripts/module-manifest.cjs");

const MANIFEST = mm.loadManifest();
const FILES: string[] = mm.migrationFiles();
const PLATFORM: string[] = mm.loadPlatformMigrations();
const problems = (files: string[], manifest: object, platform = PLATFORM): string[] =>
  mm.migrationNameProblems(files, manifest, platform);
const PF = { app: null, migrationsBeforeTheConvention: [] };
const APP = { app: "playform", migrationsBeforeTheConvention: [] };
/** The app this repository is (its manifest's "app"), or "playform" in platform-foundation. */
const THIS_APP: string = MANIFEST.app ?? "playform";
/** APP with this repository's grandfathered migrations, so its own files may sit beside a case. */
const THIS_REPO_AS_APP = {
  app: THIS_APP,
  migrationsBeforeTheConvention: [...MANIFEST.migrationsBeforeTheConvention],
};
const LATEST = (platform: string[]) =>
  Math.max(...platform.map((f) => Number(/^(\d{3})_/.exec(f)?.[1] ?? 0)));
const PLATFORM_FORM = /^\d{3}_[a-z0-9_-]+\.sql$/;
const APP_FORM = /^(\d{3})[a-z]_([a-z0-9_-]+)\.sql$/;

/**
 * What is wrong with a repository's migrations, read as a consumer reads them: the merged
 * manifest, the directory, the platform's list. Empty in platform-foundation and in an app.
 */
function repositoryProblems(root?: string): string[] {
  const manifest = mm.loadManifest(root);
  const files: string[] = mm.migrationFiles(root);
  const platform: string[] = mm.loadPlatformMigrations(root);
  const app: string | null = manifest.app;
  const before = new Set<string>(manifest.migrationsBeforeTheConvention);
  const listed = new Set(platform);
  const latest = LATEST(platform);
  const out: string[] = [...mm.migrationNameProblems(files, manifest, platform)];
  // The platform's: every listed migration ships, named NNN_<name>.sql.
  for (const f of platform) {
    if (!files.includes(f))
      out.push(`${f}: listed by the platform, not in the directory`);
    if (!PLATFORM_FORM.test(f)) out.push(`${f}: a platform migration not NNN_<name>.sql`);
  }
  for (const f of files) {
    if (listed.has(f)) continue;
    // Grandfathered (the app applied it under this name): existence and order only, below.
    if (app !== null && before.has(f)) continue;
    if (app === null) {
      out.push(`${f}: in platform-foundation, not in the platform's list`);
      continue;
    }
    // The app's own: the convention, and the range 001 to the platform's latest.
    const m = APP_FORM.exec(f);
    if (!m) out.push(`${f}: an app migration not NNN<letter>_${app}_<name>.sql`);
    else if (!m[2].startsWith(`${app}_`)) out.push(`${f}: without the "${app}_" prefix`);
    else if (Number(m[1]) < 1 || Number(m[1]) > latest)
      out.push(`${f}: numbered outside 001 to ${latest}`);
  }
  // Grandfathered: present, applied exactly once by the replay, and — one of the core's — after
  // no core migration that sorts after it (where it was applied before the convention).
  const order: string[] = mm.replayOrder(manifest, files);
  const inModule = new Set<string>(mm.moduleMigrations(manifest, mm.moduleIds(manifest)));
  for (const f of before) {
    if (listed.has(f)) out.push(`${f}: grandfathered, but the platform's`);
    if (!files.includes(f)) out.push(`${f}: grandfathered, not in the directory`);
    const at = order.indexOf(f);
    if (at < 0 || order.lastIndexOf(f) !== at)
      out.push(`${f}: grandfathered, not applied exactly once by the replay`);
    else if (
      !inModule.has(f) &&
      order.slice(0, at).some((g) => g > f && !inModule.has(g))
    )
      out.push(`${f}: grandfathered, replayed after a later core migration`);
  }
  return out;
}

/**
 * A fixture app repository: the platform's manifests and migrations (empty files), and an app
 * manifest carrying grandfathered migrations, as Playform's does. Removed by the caller.
 */
function fixtureApp(
  app: object,
  extra: string[]
): {
  root: string;
  files: string[];
  manifest: { migrationsBeforeTheConvention: string[] };
} {
  const root = mkdtempSync(join(tmpdir(), "pf-migration-naming-"));
  const copy = (rel: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), readFileSync(rel));
  };
  copy(mm.MANIFEST);
  copy(mm.PLATFORM_MIGRATIONS);
  copy(mm.PLATFORM_PATHS);
  writeFileSync(join(root, mm.APP_MANIFEST), JSON.stringify(app));
  mkdirSync(join(root, "supabase/migrations"), { recursive: true });
  for (const f of [...PLATFORM, ...extra])
    writeFileSync(join(root, "supabase/migrations", f), "select 1;\n");
  return {
    root,
    files: mm.migrationFiles(root),
    manifest: mm.loadManifest(root),
  };
}

const FIXTURE_APP = {
  app: "fixture",
  modules: {},
  migrationsBeforeTheConvention: [
    "007_fixture_subscription_tiers.sql",
    "031_known_features.sql",
    "036_known_features_agent_delegate.sql",
  ],
};
const FIXTURE_EXTRA = [
  ...FIXTURE_APP.migrationsBeforeTheConvention,
  "036a_fixture_after_grandfathered.sql",
  "052a_fixture_latest.sql",
];

describe("migration naming (TASK-158)", () => {
  it("self-test: sees the migrations and the platform's list", () => {
    expect(FILES.length).toBeGreaterThan(45);
    expect(PLATFORM).toContain("052_audit_wave2.sql");
  });

  it("this repository's migrations are named by the convention", () => {
    expect(problems(FILES, MANIFEST)).toEqual([]);
  });

  it("this repository's migrations, read as a consumer reads them: platform's, grandfathered, app's", () => {
    expect(repositoryProblems()).toEqual([]);
  });

  it("self-test: a fixture app with grandfathered migrations passes every check unchanged", () => {
    const fx = fixtureApp(FIXTURE_APP, FIXTURE_EXTRA);
    try {
      expect(fx.manifest.migrationsBeforeTheConvention).toEqual(
        FIXTURE_APP.migrationsBeforeTheConvention
      );
      expect(repositoryProblems(fx.root)).toEqual([]);
      expect(problems(fx.files, fx.manifest)).toEqual([]);
      // The range cases below, with the fixture's files beside them and its grandfather list.
      const own = { ...APP, app: "fixture", ...fx.manifest };
      const latest = LATEST(PLATFORM);
      const at = (n: number) => `${String(n).padStart(3, "0")}a_fixture_x.sql`;
      for (const f of [at(0), at(latest + 1)])
        expect(problems([...fx.files, f], own)).toHaveLength(1);
      expect(problems([...fx.files, at(1)], own)).toEqual([]);
      // The defect: the grandfathered names checked against a manifest without them.
      expect(
        problems([...fx.files, at(1)], { ...own, migrationsBeforeTheConvention: [] })
      ).toHaveLength(FIXTURE_APP.migrationsBeforeTheConvention.length);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("self-test: the consumer checks catch a fixture app's misnamed, out-of-range or missing migrations", () => {
    const cases: [object, string[], RegExp][] = [
      [FIXTURE_APP, ["052_fixture_bare.sql"], /052_fixture_bare\.sql/],
      [FIXTURE_APP, ["053a_fixture_beyond.sql"], /053a_fixture_beyond\.sql: .*001 to/],
      [FIXTURE_APP, ["040a_other_prefix.sql"], /040a_other_prefix\.sql/],
      [
        {
          ...FIXTURE_APP,
          migrationsBeforeTheConvention: [
            ...FIXTURE_APP.migrationsBeforeTheConvention,
            "033_gone.sql",
          ],
        },
        [],
        /033_gone\.sql/,
      ],
    ];
    for (const [app, extra, want] of cases) {
      const fx = fixtureApp(app, [
        ...FIXTURE_APP.migrationsBeforeTheConvention,
        ...extra,
      ]);
      try {
        const found = repositoryProblems(fx.root);
        expect(found.length).toBeGreaterThan(0);
        expect(found.join("\n")).toMatch(want);
      } finally {
        rmSync(fx.root, { recursive: true, force: true });
      }
    }
  });

  it("in platform-foundation, the list is exactly the migration files", () => {
    if (MANIFEST.app !== null) return;
    expect([...PLATFORM].sort()).toEqual(FILES);
    expect(FILES.every((f) => /^\d{3}_/.test(f))).toBe(true);
  });

  it("an app's migration sorts after the platform's NNN and before NNN+1", () => {
    const files = [
      "053_next.sql",
      "052b_playform_y.sql",
      "052_audit_wave2.sql",
      "052a_playform_x.sql",
    ].sort();
    expect(files).toEqual([
      "052_audit_wave2.sql",
      "052a_playform_x.sql",
      "052b_playform_y.sql",
      "053_next.sql",
    ]);
    expect(mm.MIGRATION_FILE.test("052a_playform_x.sql")).toBe(true);
  });

  it("accepts an app's letter-form migrations and its migrations from before the convention", () => {
    const files = [
      ...PLATFORM,
      "007_playform_tiers.sql",
      "052a_playform_tiers_record.sql",
    ];
    expect(
      problems(files, {
        ...APP,
        migrationsBeforeTheConvention: ["007_playform_tiers.sql"],
      })
    ).toEqual([]);
  });

  it("refuses an app migration that takes a bare platform number, and says what to rename it to", () => {
    expect(problems([...PLATFORM, "052_playform_tiers_record.sql"], APP)).toEqual([
      expect.stringMatching(
        /^052_playform_tiers_record\.sql: an app migration with a bare platform number .* Rename it to 052a_playform_tiers_record\.sql/
      ),
    ]);
    // The next free letter is suggested.
    expect(
      problems([...PLATFORM, "052a_playform_a.sql", "052_playform_b.sql"], APP)[0]
    ).toMatch(/Rename it to 052b_playform_b\.sql/);
  });

  it("refuses an app migration numbered outside 001 to the platform's latest (review 7 L1)", () => {
    const latest = LATEST(PLATFORM);
    // A probe at NNN with a letter none of `base` uses (an app's own NNN<letter>s are taken).
    const at = (app: string, n: number, base: string[]) => {
      const nnn = String(n).padStart(3, "0");
      const letter = [..."abcdefghijklmnopqrstuvwxyz"].find(
        (l) => !base.some((f) => f.startsWith(`${nnn}${l}_`))
      );
      return `${nnn}${letter}_${app}_x.sql`;
    };
    // Against the platform's list with APP, and against this repository's own files with its
    // own manifest (in an app, its grandfathered migrations included — never APP's empty list).
    const sets: [string[], typeof APP | typeof THIS_REPO_AS_APP][] = [
      [PLATFORM, APP],
      [FILES, THIS_REPO_AS_APP],
    ];
    for (const [base, manifest] of sets) {
      for (const n of [0, latest + 1, 999]) {
        const f = at(manifest.app, n, base);
        expect(problems([...base, f], manifest)).toEqual([
          expect.stringMatching(
            new RegExp(
              `^${f}: an app migration's NNN is the number of the platform migration it follows — 001 to ${String(latest).padStart(3, "0")}`
            )
          ),
        ]);
      }
      for (const n of [1, latest])
        expect(problems([...base, at(manifest.app, n, base)], manifest)).toEqual([]);
    }
  });

  it("refuses a letter-form migration without the app's prefix, or sharing a letter", () => {
    expect(problems([...PLATFORM, "052a_tiers.sql"], APP)).toEqual([
      expect.stringMatching(/rename it to 052a_playform_tiers\.sql/),
    ]);
    expect(
      problems([...PLATFORM, "052a_playform_a.sql", "052a_playform_b.sql"], APP)
    ).toEqual([expect.stringMatching(/052a is already 052a_playform_a\.sql/)]);
  });

  it("refuses the letter form in platform-foundation, and an unlisted platform migration", () => {
    expect(problems([...PLATFORM, "052a_audit_more.sql"], PF)).toEqual([
      expect.stringMatching(/platform-foundation never uses the letter form/),
    ]);
    expect(problems([...PLATFORM, "053_new.sql"], PF)).toEqual([
      expect.stringMatching(
        /053_new\.sql: a platform migration not listed in supabase\/platform-migrations\.json/
      ),
    ]);
    expect(problems(PLATFORM.slice(1), PF)).toEqual([
      expect.stringMatching(/lists .*, which is not in supabase\/migrations/),
    ]);
  });

  it("refuses a migrationsBeforeTheConvention entry that is the platform's, missing or letter-form", () => {
    const before = ["052_audit_wave2.sql", "060_gone.sql"];
    expect(problems(PLATFORM, { ...APP, migrationsBeforeTheConvention: before })).toEqual(
      [
        expect.stringMatching(/lists 052_audit_wave2\.sql, a platform migration/),
        expect.stringMatching(
          /lists 060_gone\.sql, which is not in supabase\/migrations/
        ),
      ]
    );
  });

  it("refuses a file that is not a migration name", () => {
    expect(problems([...PLATFORM, "52-x.sql"], APP)).toEqual([
      expect.stringMatching(/^52-x\.sql: not a migration name/),
    ]);
  });

  it("the replay checks the names before it orders anything", () => {
    const src = readFileSync("scripts/module-manifest.cjs", "utf8");
    const cli = src.slice(src.indexOf("if (require.main === module)"));
    expect(cli.indexOf("migrationNameProblems")).toBeGreaterThan(-1);
    expect(cli.indexOf("migrationNameProblems")).toBeLessThan(
      cli.indexOf("replayOrder(")
    );
  });
});
