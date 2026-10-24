/**
 * platform/features — Optional-feature availability (ADR-050 D3)
 *
 * @module platform/features
 */

export {
  CORE_FEATURE_REQUIREMENTS,
  listFeatureRequirements,
  getFeatureRequirement,
  featureAvailability,
  isFeatureAvailable,
} from "./availability";
export type {
  CoreFeatureId,
  FeatureId,
  FeatureRequirement,
  FeatureStatus,
} from "./availability";
export { requireFeature } from "./guard";
