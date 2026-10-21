/**
 * __tests__/helpers/route-policy.ts — Shared logic for the route checks (ADR-052, TASK-133, TASK-136)
 *
 * Finds every API route, and resolves which function names count as verifying the caller or
 * applying a rate limit: the platform's own, plus the app's declared wrappers (platform/route-policy)
 * once each is shown to call a platform function, directly or through another accepted wrapper.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

export const ROOT = process.cwd();

function walk(dir: string, accept: (rel: string) => boolean): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, accept));
    else {
      const rel = relative(ROOT, p).split("\\").join("/");
      if (accept(rel)) out.push(rel);
    }
  }
  return out;
}

/** Every API route file, e.g. "app/api/process/route.ts". */
export function apiRoutes(): string[] {
  return walk(join(ROOT, "app", "api"), (rel) => rel.endsWith("/route.ts")).sort();
}

/**
 * A source file a declared wrapper may live in. Tests and Jest manual mocks (`__mocks__/`) are
 * not: a mock re-declares the wrapper's name without its behaviour, so counting it would make a
 * real wrapper look ambiguous ("defined in 2 files").
 */
export function isWrapperSource(rel: string): boolean {
  return (
    /\.tsx?$/.test(rel) &&
    !/\.test\.tsx?$/.test(rel) &&
    !rel.includes("__tests__/") &&
    !rel.includes("__mocks__/")
  );
}

function sourceFiles(): string[] {
  return ["lib", "platform", "app"].flatMap((d) => walk(join(ROOT, d), isWrapperSource));
}

export const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf-8");

/** A regular expression matching a call to `name(`. */
export const callOf = (name: string): RegExp => new RegExp(`\\b${name}\\s*\\(`);

/** Files that define a function or const called `name`. */
export function definitionsOf(name: string): string[] {
  const def = new RegExp(
    `(?:function\\s+${name}\\s*[(<]|(?:const|let)\\s+${name}\\s*(?::[^=]+)?=)`
  );
  return sourceFiles().filter((f) => def.test(read(f)));
}

export interface ResolvedNames {
  /** Names a route may call: the platform's plus every accepted declaration. */
  readonly accepted: readonly string[];
  /** Declarations that failed, with the reason. */
  readonly problems: readonly string[];
}

/**
 * Accept each declared name whose single definition calls a platform name or another accepted
 * declaration (resolved to a fixed point). `defs` is injectable for the self-tests.
 */
export function resolveDeclared(
  platform: readonly string[],
  declared: readonly string[],
  defs: (name: string) => { file: string; source: string }[] = (name) =>
    definitionsOf(name).map((file) => ({ file, source: read(file) }))
): ResolvedNames {
  const accepted = new Set(platform);
  const problems: string[] = [];
  const pending = new Map<string, string>();
  for (const name of declared) {
    const found = defs(name);
    if (found.length !== 1) {
      problems.push(
        `${name}: ${found.length === 0 ? "no definition found" : `defined in ${found.length} files`}`
      );
    } else {
      pending.set(name, found[0].source);
    }
  }
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [name, source] of pending) {
      if ([...accepted].some((a) => a !== name && callOf(a).test(source))) {
        accepted.add(name);
        pending.delete(name);
        progressed = true;
      }
    }
  }
  for (const name of pending.keys()) {
    problems.push(
      `${name}: its definition calls no platform function (or accepted wrapper)`
    );
  }
  return { accepted: [...accepted], problems };
}

/** Exported route handlers in a source file (GET, POST, …). */
export function handlerCount(src: string): number {
  return [
    ...src.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g),
  ].length;
}

/** Calls in `src` to any of `names`. */
export function callCount(src: string, names: readonly string[]): number {
  return names.reduce(
    (n, name) => n + (src.match(new RegExp(callOf(name), "g"))?.length ?? 0),
    0
  );
}
