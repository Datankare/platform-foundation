/**
 * platform/modules — Optional product modules and their registration (ADR-054)
 *
 * Writing a module, listing an app's modules, and the boundary: ./README.md.
 *
 * Deliberately NOT exported here: the composition roots (./app-modules.ts, ./app-home.tsx), which
 * import modules — the core imports them only where it composes the app.
 *
 * @module platform/modules
 */

export { definePlatformModule, moduleContentType, ModuleDefinitionError } from "./define";
export {
  registerModules,
  getModules,
  getModule,
  hasRegisteredModules,
  isModuleEnabled,
  moduleFingerprint,
  resetModuleRegistry,
} from "./registry";
export {
  composeWithModules,
  composeValues,
  unionWithModules,
  CORE_OWNER,
} from "./compose";
export {
  assertModuleContributions,
  registerModuleContentTypes,
  createModuleHealthProbes,
} from "./contributions";
export type {
  ModuleId,
  PlatformModule,
  PlatformModuleInput,
  ModuleProviderSlot,
  ProviderSlotContext,
  DurableSlot,
  FeatureRequirement,
  FeatureStatus,
  ModerationContentTypeDefinition,
  ModuleHealthProbe,
  Contributed,
} from "./types";
