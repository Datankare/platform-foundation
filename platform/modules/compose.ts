/**
 * platform/modules/compose.ts — A core list plus what the registered modules add to it
 *
 * Every extensible core registry (prompts, evals, features, goals, rate rules, the consent and
 * account-status lists, moderation content types, provider slots) is its own core entries
 * followed by the registered modules' entries, in registration order. Composition refuses a name
 * the core or an earlier module already has, naming both owners — a module never silently
 * replaces a core entry or another module's (ADR-054 D4).
 *
 * The result is cached per registered set (the frozen array getModules() returns), so a registry
 * read on every request composes once per process.
 *
 * @module platform/modules
 */

import { ModuleDefinitionError } from "./define";
import { getModules } from "./registry";
import type { Contributed, PlatformModule } from "./types";

/** The owner of a core entry in a composed list. */
export const CORE_OWNER = "core";

const cache = new WeakMap<readonly PlatformModule[], Map<string, unknown>>();

function memo<T>(modules: readonly PlatformModule[], kind: string, build: () => T): T {
  let byKind = cache.get(modules);
  if (!byKind) {
    byKind = new Map<string, unknown>();
    cache.set(modules, byKind);
  }
  if (!byKind.has(kind)) byKind.set(kind, build());
  return byKind.get(kind) as T;
}

/**
 * The core's entries then each registered module's, each with its owner. Throws
 * ModuleDefinitionError when a module's entry has a name the core or an earlier module has.
 *
 * `kind` names the list in errors and keys the cache, so each registry passes its own.
 */
export function composeWithModules<T>(
  kind: string,
  core: readonly T[],
  nameOf: (entry: T) => string,
  fromModule: (mod: PlatformModule) => readonly T[]
): readonly Contributed<T>[] {
  const modules = getModules();
  return memo(modules, kind, () => {
    const owners = new Map<string, string>();
    const out: Contributed<T>[] = [];
    for (const value of core) {
      owners.set(nameOf(value), CORE_OWNER);
      out.push({ moduleId: CORE_OWNER, value });
    }
    for (const mod of modules) {
      for (const value of fromModule(mod)) {
        const name = nameOf(value);
        const owner = owners.get(name);
        if (owner !== undefined) {
          const by = owner === CORE_OWNER ? "the core" : `module "${owner}"`;
          throw new ModuleDefinitionError(mod.id, `${kind} "${name}" is already ${by}'s`);
        }
        owners.set(name, mod.id);
        out.push({ moduleId: mod.id, value });
      }
    }
    return Object.freeze(out);
  });
}

/** composeWithModules without the owners. */
export function composeValues<T>(
  kind: string,
  core: readonly T[],
  nameOf: (entry: T) => string,
  fromModule: (mod: PlatformModule) => readonly T[]
): readonly T[] {
  const modules = getModules();
  return memo(modules, `${kind}#values`, () =>
    Object.freeze(composeWithModules(kind, core, nameOf, fromModule).map((c) => c.value))
  );
}

/**
 * A list where the same name may come from the core and from modules (a feature named in both
 * the core's and a module's consent list): the union, core first, each name once.
 */
export function unionWithModules(
  kind: string,
  core: readonly string[],
  fromModule: (mod: PlatformModule) => readonly string[]
): readonly string[] {
  const modules = getModules();
  return memo(modules, kind, () =>
    Object.freeze([...new Set([...core, ...modules.flatMap(fromModule)])])
  );
}
