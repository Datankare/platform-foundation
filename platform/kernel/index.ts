/**
 * platform/kernel/index.ts — Platform vocabulary barrel
 *
 * Imports nothing from the platform. See ./types for the layering rationale.
 *
 * @module platform/kernel
 */

export * from "./types";
export * from "./state-store";

// Bundle-safe singletons (ADR-032). A module-scope `let` is not one value per
// process: the bundler duplicates modules across entries, and each copy gets its own.
export {
  getSingleton,
  setSingleton,
  hasSingleton,
  resetSingleton,
  resetAllSingletons,
  singletonKeys,
} from "./singleton";
