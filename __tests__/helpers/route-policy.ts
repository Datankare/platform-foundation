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

/** Where else a Next.js app can put API routes: the checks do not scan them, so they refuse them. */
const UNSCANNED_ROUTE_DIRS = ["src/app/api", "pages/api", "src/pages/api"];

/**
 * Every API route file, e.g. "app/api/process/route.ts". Throws when routes exist anywhere the
 * route checks do not scan, so a consumer's routes cannot pass by being elsewhere (release
 * review, Sprint 7X).
 */
export function apiRoutes(): string[] {
  const elsewhere = UNSCANNED_ROUTE_DIRS.filter((d) => {
    try {
      return statSync(join(ROOT, d)).isDirectory();
    } catch {
      return false;
    }
  });
  if (elsewhere.length > 0) {
    throw new Error(
      `API routes in ${elsewhere.join(", ")} are not covered by the route checks; keep routes in app/api.`
    );
  }
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

/**
 * Every production source file: the app, platform, shared libraries, hooks, components and the
 * root entry points — no tests, mocks or scripts.
 */
export function productionSources(): string[] {
  apiRoutes(); // refuses routes outside app/api
  try {
    if (statSync(join(ROOT, "src")).isDirectory()) {
      throw new Error(
        "Source under src/ is not covered by the source checks; use the root layout."
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Source under src/")) throw e;
  }
  const roots = ["instrumentation.ts", "proxy.ts", "middleware.ts"].filter((f) => {
    try {
      return statSync(join(ROOT, f)).isFile();
    } catch {
      return false;
    }
  });
  return [
    ...["lib", "platform", "app", "hooks", "components", "shared"].flatMap((d) =>
      walk(join(ROOT, d), isWrapperSource)
    ),
    ...roots,
  ];
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

const withoutComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/**
 * The body of `name`'s definition in `src`, comments removed — what the wrapper itself does,
 * not whatever else its file contains (release review: a call anywhere in the file, even in a
 * comment, accepted the wrapper). Empty when the definition is not found.
 */
export function definitionBody(src: string, name: string): string {
  const code = withoutComments(src);
  const def = new RegExp(
    `(?:function\\s+${name}\\s*[(<]|(?:const|let)\\s+${name}\\s*(?::[^=]+)?=)`
  ).exec(code);
  if (!def) return "";
  // From the definition to the next top-level declaration (formatted code starts each at
  // column 0): the function's signature and body, and nothing else in the file.
  const start = def.index;
  const rest = code.slice(start + def[0].length);
  const next = /\n(?:export\s|async\s+function\s|function\s|const\s|let\s|class\s)/.exec(
    rest
  );
  return code.slice(start, start + def[0].length + (next ? next.index : rest.length));
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
      pending.set(name, definitionBody(found[0].source, name));
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
