/**
 * platform/features — Optional-feature availability (ADR-050 D3)
 *
 * @module platform/features
 */

export {
  FEATURE_REQUIREMENTS,
  featureAvailability,
  isFeatureAvailable,
} from "./availability";
export type { FeatureId, FeatureStatus } from "./availability";
export { requireFeature } from "./guard";
