/**
 * __tests__/helpers/repo-files.ts — the repository's files, for the guards that scan them
 * (TASK-200). Skips what is not the repository's own: dependencies, build output, coverage, git.
 */
import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

const SKIP = new Set([
  "node_modules",
  ".next",
  "coverage",
  ".git",
  "test-results",
  "playwright-report",
]);

/** Every file under `dir` (recursively) whose name `accept` takes. */
export function walkFiles(dir: string, accept: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walkFiles(p, accept);
    return accept(name) ? [p] : [];
  });
}

/** Every Jest test file of the repository (`__tests__/**` `*.test.ts`, `*.test.tsx`: testMatch). */
export function testFiles(root: string): string[] {
  return walkFiles(root, (n) => /\.test\.tsx?$/.test(n))
    .filter((p) => /[\\/]__tests__[\\/]/.test(p))
    .sort();
}
