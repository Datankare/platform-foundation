/**
 * @jest-environment node
 */
/**
 * __tests__/catalog-definitions-guard.test.ts — every setting and permission the database holds is
 * named by the catalog, in every locale it defines (TASK-209, N-113; ADR-051 D4)
 *
 * @guard A setting or a permission a screen would show without the catalog's words
 *
 * The check is scripts/catalog-definitions-check.mjs, run by scripts/migration-replay.sh on the
 * replayed database before any test writes to it — so it reads what the migrations define (the
 * platform's, every module's, the app's) and nothing another suite made. (Read from the shared
 * test database, it saw a setting another suite had just created: TASK-209's N-114 proof found
 * it.) Here: the replay runs it, and the script finds each kind of gap, in each locale.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "scripts/catalog-definitions-check.mjs");

/** Run the check over `lines` with the catalogs of `root`. */
function check(root: string, lines: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, "--root", root], {
    input: lines.join("\n"),
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("the catalog names every setting and permission the migrations define (N-113)", () => {
  it("the replay runs the check on its database, before any test writes to it", () => {
    const replay = readFileSync(join(ROOT, "scripts/migration-replay.sh"), "utf8");
    expect(replay).toMatch(
      /SELECT 'setting ' \|\| key FROM public\.platform_config UNION ALL SELECT 'permission ' \|\| code FROM public\.permissions"[\s\S]*?\| node "\$ROOT\/scripts\/catalog-definitions-check\.mjs" --root "\$ROOT"/
    );
  });

  it("[self-test] finds a missing setting, a missing part, a stale entry and a locale's gap; the app's entries count", () => {
    const dir = mkdtempSync(join(tmpdir(), "catalog-defs-"));
    try {
      mkdirSync(join(dir, "messages", "app"), { recursive: true });
      const write = (f: string, v: unknown) =>
        writeFileSync(join(dir, "messages", f), JSON.stringify(v));
      write("en.json", {
        screens: {
          settings: { a: { b: "B" }, gone: "Gone" },
          permissions: { p1: { name: "P1" }, old: { name: "O", description: "o" } },
        },
      });
      write("app/en.json", {
        screens: {
          app: {
            settings: { c: "C" },
            permissions: { p2: { name: "P2", description: "x" } },
          },
        },
      });
      // A second locale lacking one setting the first has.
      write("fr.json", {
        screens: {
          settings: { a: { b: "B" }, gone: "G" },
          permissions: {
            p1: { name: "P1", description: "d" },
            old: { name: "O", description: "o" },
          },
        },
      });
      write("app/fr.json", {
        screens: { app: { permissions: { p2: { name: "P2", description: "x" } } } },
      });
      const r = check(dir, [
        "setting a.b",
        "setting c",
        "setting d",
        "permission p1",
        "permission p2",
      ]);
      expect(r.code).toBe(1);
      const gaps = r.out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^(?:en|fr): /.test(l));
      expect(gaps).toEqual([
        "en: no such permission old",
        "en: no such setting gone",
        "en: permission p1.description",
        "en: setting d",
        "fr: no such permission old",
        "fr: no such setting gone",
        "fr: setting c",
        "fr: setting d",
      ]);
      // Nothing to read is a failure, not a pass.
      expect(check(dir, []).code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
