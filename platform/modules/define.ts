/**
 * platform/modules/define.ts — definePlatformModule: validate and freeze a module (ADR-054 D4)
 *
 * A module is checked once, where it is written, so a malformed declaration fails the import that
 * defines it rather than a request that happens to read it: ids, slot names and selector settings
 * are well-formed; nothing is declared twice inside the module; a slot's default is one of its
 * selections; a durable slot names a durable selection that is not its default; an eval suite is
 * for one of the module's own prompts. Collisions between modules are refused by registration
 * (./registry.ts) and collisions with the core by the core registries when they compose.
 *
 * The result is frozen, lists included, so nothing can add to a module after it is defined.
 *
 * @module platform/modules
 */

import type { AnyContentType, ContentType } from "@/platform/content/types";
import type { ModuleProviderSlot, PlatformModule, PlatformModuleInput } from "./types";

/** Thrown for a malformed module declaration or registration; the message names the module. */
export class ModuleDefinitionError extends Error {
  constructor(moduleId: string, problem: string) {
    super(`Platform module "${moduleId}": ${problem} (ADR-054)`);
    this.name = "ModuleDefinitionError";
  }
}

export const MODULE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SLOT_NAME = /^[a-z][A-Za-z0-9]*$/;
const ENV_VAR = /^[A-Z][A-Z0-9_]*$/;
const SELECTION = /^[a-z][a-z0-9-]*$/;
const SINGLETON_KEY = /^platform\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+$/;
const AGENT_ID = /^[a-z][a-z0-9-]*$/;
const PROMPT_NAME = /^[a-z][a-z0-9-]*$/;
const FEATURE_ID = /^[a-z][a-z0-9_]*$/;
const GOAL = /^[a-z][a-z0-9-]*$/;
const RULE_ID = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;
const MODERATION_TYPE = /^[a-z][a-z0-9-]*$/;
/** A path under __tests__/ to a .ts/.tsx file, with no "." or ".." segment. */
const KIT_PATH = /^__tests__\/(?:(?!\.\.?\/)[\w.-]+\/)*[\w-][\w.-]*\.tsx?$/;

/** Every element of `names` matches `shape` and appears once. */
function requireDistinct(
  moduleId: string,
  kind: string,
  names: readonly string[],
  shape: RegExp
): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string" || !shape.test(name)) {
      throw new ModuleDefinitionError(moduleId, `${kind} "${String(name)}" is malformed`);
    }
    if (seen.has(name)) {
      throw new ModuleDefinitionError(moduleId, `${kind} "${name}" is declared twice`);
    }
    seen.add(name);
  }
}

function validateSlot(moduleId: string, slot: ModuleProviderSlot): void {
  const at = `provider slot "${slot.slot}"`;
  if (typeof slot.init !== "function") {
    throw new ModuleDefinitionError(moduleId, `${at} has no init`);
  }
  if (slot.values.length === 0) {
    throw new ModuleDefinitionError(moduleId, `${at} declares no selections`);
  }
  requireDistinct(moduleId, `${at} selection`, slot.values, SELECTION);
  if (!slot.values.includes(slot.defaultValue)) {
    throw new ModuleDefinitionError(
      moduleId,
      `${at} defaults to "${slot.defaultValue}", which is not one of its selections`
    );
  }
  requireDistinct(moduleId, `${at} singleton key`, slot.singletonKeys, SINGLETON_KEY);
  const durable = slot.durable;
  if (!durable) return;
  if (durable.selections.length === 0 || durable.noun === "" || durable.fallback === "") {
    throw new ModuleDefinitionError(
      moduleId,
      `${at} is durable but does not say which selections are durable and what is lost without them`
    );
  }
  for (const selection of durable.selections) {
    if (!slot.values.includes(selection)) {
      throw new ModuleDefinitionError(
        moduleId,
        `${at} names durable selection "${selection}", which is not one of its selections`
      );
    }
  }
  if (durable.selections.includes(slot.defaultValue)) {
    throw new ModuleDefinitionError(
      moduleId,
      `${at} defaults to a durable selection; the default must work without a database`
    );
  }
}

function validateProviders(moduleId: string, slots: readonly ModuleProviderSlot[]): void {
  requireDistinct(
    moduleId,
    "provider slot",
    slots.map((s) => s.slot),
    SLOT_NAME
  );
  requireDistinct(
    moduleId,
    "selector setting",
    slots.map((s) => s.envVar),
    ENV_VAR
  );
  requireDistinct(
    moduleId,
    "singleton key",
    slots.flatMap((s) => s.singletonKeys),
    SINGLETON_KEY
  );
  for (const slot of slots) validateSlot(moduleId, slot);
}

function validateRules(moduleId: string, mod: PlatformModule): void {
  requireDistinct(
    moduleId,
    "rate rule",
    mod.rateRules.map((r) => r.id),
    RULE_ID
  );
  for (const rule of mod.rateRules) {
    const valid =
      Number.isInteger(rule.maxRequests) &&
      rule.maxRequests > 0 &&
      Number.isInteger(rule.windowSeconds) &&
      rule.windowSeconds > 0;
    if (!valid) {
      throw new ModuleDefinitionError(
        moduleId,
        `rate rule "${rule.id}" needs a positive whole maxRequests and windowSeconds`
      );
    }
  }
}

function validateEvals(moduleId: string, mod: PlatformModule): void {
  const prompts = new Set(mod.prompts.map((p) => p.name));
  requireDistinct(
    moduleId,
    "eval suite",
    mod.evals.map((e) => e.prompt),
    PROMPT_NAME
  );
  for (const suite of mod.evals) {
    if (!prompts.has(suite.prompt)) {
      throw new ModuleDefinitionError(
        moduleId,
        `eval suite "${suite.prompt}" is not for one of this module's prompts`
      );
    }
  }
}

function validateNamedLists(moduleId: string, mod: PlatformModule): void {
  const lists: readonly [string, readonly string[], RegExp][] = [
    ["dependency", mod.dependsOn, MODULE_ID],
    ["agent", mod.agents.map((a) => a.id), AGENT_ID],
    ["prompt", mod.prompts.map((p) => p.name), PROMPT_NAME],
    ["content type", mod.contentTypes.map((c) => c.name), PROMPT_NAME],
    ["feature", mod.features.map((f) => f.id), FEATURE_ID],
    ["goal", mod.goals, GOAL],
    ["consent feature", mod.consentFeatures, FEATURE_ID],
    ["account-status feature", mod.accountStatusFeatures, FEATURE_ID],
    [
      "moderation content type",
      mod.moderationContentTypes.map((m) => m.name),
      MODERATION_TYPE,
    ],
    ["health probe", mod.healthProbes.map((h) => h.name), AGENT_ID],
    ["kit", mod.kits, KIT_PATH],
  ];
  for (const [kind, names, shape] of lists) requireDistinct(moduleId, kind, names, shape);
  if (mod.dependsOn.includes(moduleId)) {
    throw new ModuleDefinitionError(moduleId, "depends on itself");
  }
  for (const feature of mod.features) {
    if (typeof feature.check !== "function" || feature.needs.trim() === "") {
      throw new ModuleDefinitionError(
        moduleId,
        `feature "${feature.id}" needs a check and a description of what it needs`
      );
    }
  }
  for (const probe of mod.healthProbes) {
    if (typeof probe.create !== "function") {
      throw new ModuleDefinitionError(
        moduleId,
        `health probe "${probe.name}" has no create`
      );
    }
  }
}

/** Freeze a module and every list and declaration in it (functions stay as given). */
function freezeModule(mod: PlatformModule): PlatformModule {
  for (const value of Object.values(mod)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (item !== null && typeof item === "object") Object.freeze(item);
    }
    Object.freeze(value);
  }
  for (const slot of mod.providers) {
    Object.freeze(slot.values);
    Object.freeze(slot.singletonKeys);
    if (slot.durable) {
      Object.freeze(slot.durable.selections);
      Object.freeze(slot.durable);
    }
  }
  return Object.freeze(mod);
}

/**
 * Declare a module. Validates the declaration (see the file header), fills in empty lists and
 * freezes the result. Throws ModuleDefinitionError naming the module and the problem.
 */
export function definePlatformModule(input: PlatformModuleInput): PlatformModule {
  const id = input.id;
  if (typeof id !== "string" || !MODULE_ID.test(id)) {
    throw new ModuleDefinitionError(
      String(id),
      "the id must be lower-case words joined by hyphens"
    );
  }
  const mod: PlatformModule = {
    id,
    dependsOn: [...(input.dependsOn ?? [])],
    providers: [...(input.providers ?? [])],
    agents: [...(input.agents ?? [])],
    prompts: [...(input.prompts ?? [])],
    evals: [...(input.evals ?? [])],
    contentTypes: [...(input.contentTypes ?? [])],
    features: [...(input.features ?? [])],
    goals: [...(input.goals ?? [])],
    rateRules: [...(input.rateRules ?? [])],
    consentFeatures: [...(input.consentFeatures ?? [])],
    accountStatusFeatures: [...(input.accountStatusFeatures ?? [])],
    moderationContentTypes: [...(input.moderationContentTypes ?? [])],
    healthProbes: [...(input.healthProbes ?? [])],
    kits: [...(input.kits ?? [])],
  };
  validateNamedLists(id, mod);
  validateProviders(id, mod.providers);
  validateRules(id, mod);
  validateEvals(id, mod);
  return freezeModule(mod);
}

/**
 * Erase a content type's input and output types for the module's heterogeneous list. Safe for
 * the same reason the content registry's own erasure is: registration and generation use the
 * type's build, parse and render together, never across types.
 */
export function moduleContentType<TInput, TContent>(
  contentType: ContentType<TInput, TContent>
): AnyContentType {
  return contentType as unknown as AnyContentType;
}
