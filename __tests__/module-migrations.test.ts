/**
 * __tests__/module-migrations.test.ts — Each module owns its migrations (ADR-054 D5)
 *
 * A module's migrations are named NNN_<module>_<name>.sql (the module id as written, e.g.
 * 050_song-id_lyrics.sql) and listed in its manifest entry; a migration whose name names a module
 * must be that module's. A fresh replay (scripts/migration-replay.sh) applies the core's
 * migrations, then the selected modules' in dependency order — the order replayOrder computes.
 *
 * The two module migrations that predate the convention keep their names (renaming an applied
 * migration would re-run it on every database that recorded the old name); they are listed in
 * their modules' entries like any other.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const mm = require("../scripts/module-manifest.cjs");
const MANIFEST = mm.loadManifest();
const IDS: string[] = mm.moduleIds(MANIFEST);
const DIR = join(process.cwd(), "supabase/migrations");
const FILES = readdirSync(DIR)
  .filter((f) => mm.MIGRATION_FILE.test(f))
  .sort();

/** Module migrations named before ADR-054 (kept: renaming an applied migration re-runs it). */
const BEFORE_THE_CONVENTION: Record<string, string> = {
  "013_song_id_config.sql": "song-id",
  "015_social_data_model.sql": "social",
};

const listedBy = (file: string): string | undefined =>
  IDS.find((id) =>
    MANIFEST.modules[id].migrations.some((p: string) => p.endsWith(`/${file}`))
  );

/** The module a migration's name names: the id as written, or with underscores for hyphens. */
function namedModule(file: string): string | undefined {
  const words = `_${file.replace(/\.sql$/, "")}_`;
  return IDS.find(
    (id) => words.includes(`_${id}_`) || words.includes(`_${id.replace(/-/g, "_")}_`)
  );
}

describe("module migrations (ADR-054 D5)", () => {
  it("self-test: sees the migrations and recognises a module name", () => {
    expect(FILES.length).toBeGreaterThan(45);
    expect(namedModule("050_song-id_lyrics.sql")).toBe("song-id");
    expect(namedModule("051_social_reactions.sql")).toBe("social");
    expect(namedModule("052_audio_convert_presets.sql")).toBe("audio-convert");
    expect(namedModule("037_guest_translate_allowance.sql")).toBeUndefined();
    expect(namedModule("049_tenancy.sql")).toBeUndefined();
  });

  it("a migration whose name names a module is listed by that module", () => {
    const wrong = FILES.filter((f) => namedModule(f) && listedBy(f) !== namedModule(f));
    expect(wrong).toEqual([]);
  });

  it("a module's migrations follow NNN_<module>_<name>.sql, an app's NNN<letter>_<app>_<module>_<name>.sql (those before the convention excepted)", () => {
    const misnamed: string[] = [];
    for (const id of IDS) {
      for (const path of MANIFEST.modules[id].migrations as string[]) {
        const file = path.split("/").pop() as string;
        if (BEFORE_THE_CONVENTION[file] === id) continue;
        const platformForm = new RegExp(`^\\d{3}_${id}_[a-z0-9_]+\\.sql$`);
        const appForm = new RegExp(
          `^\\d{3}[a-z]_${MANIFEST.app}_${id}_[a-z0-9_]+\\.sql$`
        );
        if (!platformForm.test(file) && !(MANIFEST.app && appForm.test(file)))
          misnamed.push(`${id}: ${file}`);
      }
    }
    expect(misnamed).toEqual([]);
  });

  it("the exceptions are exactly the module migrations that predate the convention", () => {
    for (const [file, id] of Object.entries(BEFORE_THE_CONVENTION)) {
      expect([file, listedBy(file)]).toEqual([file, id]);
      expect(Number(file.slice(0, 3))).toBeLessThan(50);
    }
  });

  it("a fresh replay applies the core's migrations, then the modules' in dependency order", () => {
    const order: string[] = mm.replayOrder(MANIFEST, FILES);
    expect([...order].sort()).toEqual(FILES);
    const firstModule = order.findIndex((f) => listedBy(f) !== undefined);
    expect(order.slice(firstModule).every((f) => listedBy(f) !== undefined)).toBe(true);
    expect(order.slice(0, firstModule)).toEqual(
      FILES.filter((f) => listedBy(f) === undefined)
    );
    const owners = order.slice(firstModule).map((f) => listedBy(f) as string);
    const ranks = owners.map((id) => mm.dependencyOrder(MANIFEST).indexOf(id));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("a replay of selected modules applies only theirs, and refuses an unmet dependency", () => {
    const social: string[] = mm.replayOrder(MANIFEST, FILES, ["social"]);
    expect(social).toContain("015_social_data_model.sql");
    expect(social).not.toContain("013_song_id_config.sql");
    const core: string[] = mm.replayOrder(MANIFEST, FILES, []);
    expect(core.every((f) => listedBy(f) === undefined)).toBe(true);
    expect(() => mm.replayOrder(MANIFEST, FILES, ["voice"])).toThrow(
      /module "voice" depends on "translation", which is not selected/
    );
    expect(() => mm.replayOrder(MANIFEST, FILES, ["nope"])).toThrow(
      /unknown module\(s\): nope/
    );
  });

  it("refuses a module migration that is listed but missing", () => {
    const broken = JSON.parse(JSON.stringify(MANIFEST));
    broken.modules.games.migrations = ["supabase/migrations/099_games_missing.sql"];
    expect(() => mm.replayOrder(broken, FILES)).toThrow(
      /module migrations listed but not present: 099_games_missing.sql/
    );
  });

  it("the replay script takes its order from the manifest reader", () => {
    const script = readFileSync(
      join(process.cwd(), "scripts/migration-replay.sh"),
      "utf8"
    );
    expect(script).toMatch(
      /node "\$ROOT\/scripts\/module-manifest\.cjs" --replay-order "\$\{REPLAY_MODULES:-\}"/
    );
    expect(script).toMatch(/for f in \$order; do/);
    expect(script).not.toMatch(/ls "\$ROOT\/supabase\/migrations"/);
  });
});
