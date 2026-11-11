/**
 * __tests__/mounted-screens.test.ts — every screen component is on a page (TASK-210, N-117)
 *
 * @guard a component under components/ that no page reaches
 *
 * Batch 55i found the moderator's review dashboard and the user's appeal form mounted on no page
 * of either repository: tested, catalogued, and unreachable — a moderator could not review the
 * queue and a user could not appeal, and nothing said so. Here, statically, for this repository (a
 * consumer runs the same file over its own app):
 *
 *   entries   every file under app/ that is not a test — its pages, layouts and routes, and the
 *             files they keep beside them (app/HomeClient.tsx);
 *   reached   a file an entry imports — `import`, `export … from`, `import()` (next/dynamic) or
 *             `require()`, resolved as the app resolves them (`@/` from the root, relative, the
 *             .ts/.tsx/index fallbacks) — and every file such a file imports, transitively. Test
 *             files (__tests__/, e2e/, *.test.*, *.spec.*) are never a path: a component only a
 *             test renders is not on a page;
 *   refused   a source file under components/ that is not reached, unless KNOWN_UNMOUNTED names
 *             it (or its folder) for this repository, with why.
 *
 * "Imported by another component" is not enough on its own: a component that only an unmounted
 * component imports is as unreachable as that one (Playform's Teams panel and the group cards it
 * held). The known list must name only what is unreached: an entry that is reached, or names no
 * file, fails until it is removed.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, normalize, sep } from "path";
import { specifiersIn } from "./helpers/import-graph";

const ROOT = join(__dirname, "..");

/**
 * The components this repository ships unmounted, by its package name, each with why. Kept
 * minimal: a component no page needs is removed, and one a page needs is mounted.
 */
export const KNOWN_UNMOUNTED: Readonly<Record<string, Readonly<Record<string, string>>>> =
  {
    "platform-foundation": {
      "components/AdaptiveInput/":
        "the platform's input component (platform/input, ROADMAP Sprint 1a), shipped for a consumer's " +
        "own screen: Playform's home mounts it (its components/SpikeApp.tsx). The platform's demo " +
        "home is its own translation form and has no conductor to drive it.",
    },
    playform: {},
  };

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "coverage"]);
const SOURCE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

const toPosix = (p: string) => p.split(sep).join("/");

/** Every source file under `dir` of `root`, root-relative. */
function filesUnder(root: string, dir: string): string[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = toPosix(join(dir, entry.name));
    if (entry.isDirectory()) out.push(...filesUnder(root, rel));
    else if (SOURCE.test(entry.name)) out.push(rel);
  }
  return out.sort();
}

/** Whether a file is a test (jest or Playwright): never a path to a page. */
export function isTest(rel: string): boolean {
  return /(?:^|\/)(?:__tests__|__mocks__|e2e|e2e-live)\/|\.test\.|\.spec\./.test(rel);
}

/** The repository file a specifier names from `from`, or null (a package, or no such file). */
export function resolveIn(root: string, from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = specifier.slice(2);
  else if (specifier.startsWith("."))
    base = toPosix(normalize(join(dirname(from), specifier)));
  else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    const abs = join(root, candidate);
    if (existsSync(abs) && statSync(abs).isFile()) return candidate;
  }
  return null;
}

/** Every file reached from the app's non-test files under app/. */
export function reachedFromPages(root: string): Set<string> {
  const reached = new Set<string>();
  const stack = filesUnder(root, "app").filter((f) => !isTest(f));
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (reached.has(file) || isTest(file)) continue;
    reached.add(file);
    const source = readFileSync(join(root, file), "utf8");
    for (const specifier of specifiersIn(file, source)) {
      const to = resolveIn(root, file, specifier);
      if (to !== null && !reached.has(to)) stack.push(to);
    }
  }
  return reached;
}

/** Whether a known-list entry (a file, or a folder ending in "/") names `file`. */
const names = (entry: string, file: string) =>
  entry.endsWith("/") ? file.startsWith(entry) : file === entry;

export interface MountReport {
  /** Components no page reaches and the known list does not name. */
  readonly unmounted: string[];
  /** Known-list entries that name nothing unreached (reached now, or gone): to be removed. */
  readonly stale: string[];
}

/** The components under `root`'s components/ that no page reaches, against `known`. */
export function unmountedScreens(
  root: string,
  known: Readonly<Record<string, string>>
): MountReport {
  const reached = reachedFromPages(root);
  const notReached = filesUnder(root, "components").filter(
    (f) => !isTest(f) && !reached.has(f)
  );
  return {
    unmounted: notReached.filter((f) => !Object.keys(known).some((k) => names(k, f))),
    stale: Object.keys(known).filter((k) => !notReached.some((f) => names(k, f))),
  };
}

/** This repository's package name (the known list's key). */
function packageName(root: string): string {
  return (
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string }
  ).name;
}

describe("every screen component is on a page (N-117)", () => {
  it("no component under components/ is unreached, and the known list is exact", () => {
    const name = packageName(ROOT);
    expect(Object.keys(KNOWN_UNMOUNTED)).toContain(name);
    const report = unmountedScreens(ROOT, KNOWN_UNMOUNTED[name]);
    // Mount it on the page that needs it, or remove it with its tests; never list it to pass.
    expect(report.unmounted).toEqual([]);
    expect(report.stale).toEqual([]);
  });

  it("every known entry says why, and names a component folder or file", () => {
    for (const [repo, entries] of Object.entries(KNOWN_UNMOUNTED)) {
      for (const [entry, why] of Object.entries(entries)) {
        expect([repo, entry, entry.startsWith("components/")]).toEqual([
          repo,
          entry,
          true,
        ]);
        expect(why.split(/\s+/).length).toBeGreaterThanOrEqual(8);
      }
    }
  });

  describe("on a scratch app", () => {
    let root: string;
    const put = (rel: string, text: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "mounted-screens-"));
      put(
        "app/page.tsx",
        'import Home from "@/components/Home";\nexport default Home;\n'
      );
      put(
        "app/admin/page.tsx",
        'const P = dynamic(() => import("../../components/Panel"));\n'
      );
      put(
        "components/Home.tsx",
        'import { Card } from "./cards";\nexport default Card;\n'
      );
      put("components/cards/index.ts", 'export { Card } from "./Card";\n');
      put("components/cards/Card.tsx", "export const Card = () => null;\n");
      put("components/Panel.tsx", "export default () => null;\n");
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("[self-test] a component no page reaches is refused; one a page reaches passes", () => {
      expect(unmountedScreens(root, {})).toEqual({ unmounted: [], stale: [] });
      put("components/Dashboard/Dashboard.tsx", "export default () => null;\n");
      expect(unmountedScreens(root, {}).unmounted).toEqual([
        "components/Dashboard/Dashboard.tsx",
      ]);
    });

    it("[self-test] a component only an unmounted one imports is refused too", () => {
      put("components/Teams.tsx", 'import Badge from "@/components/Badge";\n');
      put("components/Badge.tsx", "export default () => null;\n");
      expect(unmountedScreens(root, {}).unmounted).toEqual([
        "components/Badge.tsx",
        "components/Teams.tsx",
      ]);
    });

    it("[self-test] a component only a test renders is refused, as is an app test's import", () => {
      put("components/Form.tsx", "export default () => null;\n");
      put("__tests__/form.test.tsx", 'import Form from "@/components/Form";\n');
      put("app/__tests__/page.test.tsx", 'import Form from "@/components/Form";\n');
      expect(unmountedScreens(root, {}).unmounted).toEqual(["components/Form.tsx"]);
    });

    it("[self-test] a known entry covers its folder; an entry naming nothing unreached is stale", () => {
      put("components/Input/Input.tsx", "export default () => null;\n");
      put("components/Input/index.ts", 'export { default } from "./Input";\n');
      expect(
        unmountedScreens(root, {
          "components/Input/": "a reason",
          "components/Home.tsx": "x",
        })
      ).toEqual({ unmounted: [], stale: ["components/Home.tsx"] });
    });

    it("[self-test] imports resolve as the app's: @/, relative, index and extension fallbacks", () => {
      expect(resolveIn(root, "app/page.tsx", "@/components/Home")).toBe(
        "components/Home.tsx"
      );
      expect(resolveIn(root, "components/Home.tsx", "./cards")).toBe(
        "components/cards/index.ts"
      );
      expect(resolveIn(root, "app/page.tsx", "react")).toBeNull();
      expect(resolveIn(root, "app/page.tsx", "@/components/Missing")).toBeNull();
    });
  });
});
