/**
 * platform/providers/index.ts — Public API
 */

export { initProviders, getActiveProviders, resetProviders } from "./registry";

export type {
  AuthProviderType,
  CacheProviderType,
  AIProviderType,
  ErrorReporterType,
  ProviderSelections,
} from "./registry";
