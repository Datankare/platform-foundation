/**
 * platform/modules/registry.ts — The modules this app runs with (ADR-054 D4)
 *
 * An app registers its modules once, at boot, before the providers initialize:
 *
 *   registerModules(APP_MODULES);   // platform/modules/app-modules.ts — the app's list
 *   initProviders();
 *
 * Registration checks the set as a whole: every id once, every declared dependency present and
 * no cycle among them, and no two modules contributing the same provider slot, selector setting,
 * singleton key, agent, prompt, content type, feature, goal, rate rule, moderation content type
 * or health probe. A collision with the core's own vocabulary is refused by the core registry
 * that composes it, which initProviders() runs at boot (./contributions.ts).
 *
 * Idempotent: registering the same modules again (the same ids in the same order, with the same
 * declarations) is a no-op, so a second boot path or a bundle-duplicated copy of the list does
 * not throw (ADR-032). Registering a different set once one is registered is refused — the set a
 * process runs with does not change after boot.
 *
 * The registered set lives in the globalThis singleton carrier (ADR-032): instrumentation.ts and
 * the route bundles are separate module copies, and every copy must see the set boot registered.
 *
 * This file imports nothing but the singleton carrier and types, so every core registry can read
 * it without an import cycle.
 *
 * @module platform/modules
 */

import { getSingleton, setSingleton } from "@/platform/kernel/singleton";
import { ModuleDefinitionError } from "./define";
import type { ModuleId, PlatformModule } from "./types";

const REGISTRY_KEY = "platform.modules.registered";

/** One empty set, so readers that cache per registered set (./compose.ts) cache it once. */
const NO_MODULES: readonly PlatformModule[] = Object.freeze([]);

interface RegisteredModules {
  readonly modules: readonly PlatformModule[];
  /** The declaration fingerprint of each module, in order — what idempotence compares. */
  readonly fingerprints: readonly string[];
}

function current(): RegisteredModules | null {
  return getSingleton<RegisteredModules | null>(REGISTRY_KEY, () => null);
}

/**
 * Everything a module declares, as one string: names, settings and values, never functions.
 * Two copies of one module (a bundle duplicate, a re-imported definition) have the same one.
 */
export function moduleFingerprint(mod: PlatformModule): string {
  return JSON.stringify({
    id: mod.id,
    dependsOn: mod.dependsOn,
    providers: mod.providers.map((s) => [
      s.slot,
      s.envVar,
      s.values,
      s.defaultValue,
      s.durable ?? null,
      s.singletonKeys,
    ]),
    agents: mod.agents,
    prompts: mod.prompts,
    evals: mod.evals.map((e) => [e.prompt, e.source, e.cases.map((c) => c.id)]),
    contentTypes: mod.contentTypes.map((c) => [c.name, c.agentId]),
    features: mod.features.map((f) => [f.id, f.needs]),
    goals: mod.goals,
    rateRules: mod.rateRules,
    consentFeatures: mod.consentFeatures,
    accountStatusFeatures: mod.accountStatusFeatures,
    moderationContentTypes: mod.moderationContentTypes,
    healthProbes: mod.healthProbes.map((h) => h.name),
    kits: mod.kits,
  });
}

/** The names one kind of contribution may not share between modules. */
const CONTRIBUTION_KINDS: readonly [string, (m: PlatformModule) => readonly string[]][] =
  [
    ["provider slot", (m) => m.providers.map((s) => s.slot)],
    ["selector setting", (m) => m.providers.map((s) => s.envVar)],
    ["singleton key", (m) => m.providers.flatMap((s) => s.singletonKeys)],
    ["agent", (m) => m.agents.map((a) => a.id)],
    ["prompt", (m) => m.prompts.map((p) => p.name)],
    ["content type", (m) => m.contentTypes.map((c) => c.name)],
    ["feature", (m) => m.features.map((f) => f.id)],
    ["goal", (m) => m.goals],
    ["rate rule", (m) => m.rateRules.map((r) => r.id)],
    ["moderation content type", (m) => m.moderationContentTypes.map((t) => t.name)],
    ["health probe", (m) => m.healthProbes.map((h) => h.name)],
  ];

function refuseSharedContributions(modules: readonly PlatformModule[]): void {
  for (const [kind, namesOf] of CONTRIBUTION_KINDS) {
    const owner = new Map<string, ModuleId>();
    for (const mod of modules) {
      for (const name of namesOf(mod)) {
        const first = owner.get(name);
        if (first !== undefined) {
          throw new ModuleDefinitionError(
            mod.id,
            `${kind} "${name}" is already contributed by module "${first}"`
          );
        }
        owner.set(name, mod.id);
      }
    }
  }
}

function refuseMissingOrCyclicDependencies(modules: readonly PlatformModule[]): void {
  const byId = new Map(modules.map((m) => [m.id, m]));
  for (const mod of modules) {
    for (const dep of mod.dependsOn) {
      if (!byId.has(dep)) {
        throw new ModuleDefinitionError(
          mod.id,
          `depends on module "${dep}", which is not registered — list it in the app's modules`
        );
      }
    }
  }
  // Depth-first walk; a module met again while still on the path closes a cycle. Every
  // dependency is present (checked above), so each lookup finds its module.
  const done = new Set<ModuleId>();
  const visit = (mod: PlatformModule, path: readonly ModuleId[]): void => {
    if (done.has(mod.id)) return;
    if (path.includes(mod.id)) {
      throw new ModuleDefinitionError(
        mod.id,
        `dependency cycle: ${[...path, mod.id].join(" → ")}`
      );
    }
    for (const dep of mod.dependsOn) {
      visit(byId.get(dep) as PlatformModule, [...path, mod.id]);
    }
    done.add(mod.id);
  };
  for (const mod of modules) visit(mod, []);
}

function refuseDuplicateIds(modules: readonly PlatformModule[]): void {
  const seen = new Set<ModuleId>();
  for (const mod of modules) {
    if (seen.has(mod.id)) {
      throw new ModuleDefinitionError(mod.id, "is listed twice");
    }
    seen.add(mod.id);
  }
}

/** Same ids, same order, same declarations. */
function sameRegistration(
  registered: RegisteredModules,
  fingerprints: string[]
): boolean {
  return (
    registered.fingerprints.length === fingerprints.length &&
    registered.fingerprints.every((f, i) => f === fingerprints[i])
  );
}

/**
 * Register the app's modules. Call once at boot, before initProviders(). Throws
 * ModuleDefinitionError for an invalid set (see the file header); a repeat of the registered set
 * is a no-op; a different set is refused.
 */
export function registerModules(modules: readonly PlatformModule[]): void {
  refuseDuplicateIds(modules);
  refuseMissingOrCyclicDependencies(modules);
  refuseSharedContributions(modules);
  const fingerprints = modules.map(moduleFingerprint);
  const registered = current();
  if (registered) {
    if (sameRegistration(registered, fingerprints)) return;
    throw new Error(
      "Platform modules are already registered (" +
        (registered.modules.map((m) => m.id).join(", ") || "none") +
        "); the set an app runs with is registered once, at boot (ADR-054)"
    );
  }
  setSingleton<RegisteredModules | null>(REGISTRY_KEY, {
    modules: modules.length === 0 ? NO_MODULES : Object.freeze([...modules]),
    fingerprints,
  });
}

/** The registered modules, in registration order; empty before registration. */
export function getModules(): readonly PlatformModule[] {
  return current()?.modules ?? NO_MODULES;
}

/** Whether registration has happened (an app with no modules has registered an empty set). */
export function hasRegisteredModules(): boolean {
  return current() !== null;
}

/** Whether a module with this id is registered. */
export function isModuleEnabled(id: ModuleId): boolean {
  return getModules().some((m) => m.id === id);
}

/** A registered module by id, or undefined. */
export function getModule(id: ModuleId): PlatformModule | undefined {
  return getModules().find((m) => m.id === id);
}

/** Forget the registered set (testing only — a process registers once, at boot). */
export function resetModuleRegistry(): void {
  setSingleton<RegisteredModules | null>(REGISTRY_KEY, null);
}
