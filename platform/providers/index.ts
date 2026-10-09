/**
 * platform/providers/index.ts — Public API
 */

export { initProviders, getActiveProviders, resetProviders } from "./registry";

export {
  ENVIRONMENT_CONTRACT,
  EnvironmentContractError,
  assertEnvironmentContract,
  checkEnvironmentContract,
  getAuthProviderSetting,
  getCognitoSettings,
  getGuestTokenSecret,
  getSupabaseUrl,
  resolveSetting,
} from "./environment-contract";
export type { CognitoSettings, SettingDeclaration } from "./environment-contract";

export type {
  AuthProviderType,
  CacheProviderType,
  AIProviderType,
  ErrorReporterType,
  ModerationStoreType,
  EmbeddingProviderType,
  ProviderSelections,
} from "./registry";
