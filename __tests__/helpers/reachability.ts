/**
 * __tests__/helpers/reachability.ts — which repository files a set of entry points reaches
 * (TASK-210 N-117; TASK-211 N-118)
 *
 * Shared by __tests__/mounted-screens.test.ts (every component is on a page) and
 * __tests__/reachable-modules.test.ts (every module is reached from an entry point). A file is
 * reached when an entry imports it — `import`, `export … from`, `import()` (next/dynamic),
 * `require()` — resolved as the app resolves them (`@/` from the root, relative, the
 * .ts/.tsx/.js/index fallbacks), and every file such a file imports, transitively. Test files are
 * never a path: a module only a test loads is not reached.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, normalize, sep } from "path";
import { specifiersIn } from "./import-graph";

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "coverage"]);
/** A JavaScript or TypeScript source file. */
export const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export const toPosix = (p: string) => p.split(sep).join("/");

/** Every file under `dir` of `root` (root-relative), source files only unless `all`. */
export function filesUnder(root: string, dir: string, all = false): string[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = toPosix(dir === "" ? entry.name : join(dir, entry.name));
    if (entry.isDirectory()) out.push(...filesUnder(root, rel, all));
    else if (all || SOURCE.test(entry.name)) out.push(rel);
  }
  return out.sort();
}

/** Whether a file is a test (jest or Playwright, or their fixtures): never a path to the app. */
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

/** Every file the given entries reach (the entries included), never through a test file. */
export function reachedFrom(root: string, entries: Iterable<string>): Set<string> {
  const reached = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (reached.has(file) || isTest(file)) continue;
    reached.add(file);
    if (!SOURCE.test(file)) continue;
    const source = readFileSync(join(root, file), "utf8");
    for (const specifier of specifiersIn(file, source)) {
      const to = resolveIn(root, file, specifier);
      if (to !== null && !reached.has(to)) stack.push(to);
    }
  }
  return reached;
}
