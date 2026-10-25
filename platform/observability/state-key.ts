/**
 * platform/observability/state-key.ts — Where the observability state is kept (ADR-032)
 *
 * The singleton key of the state initObservability() sets, in a module of its own so a light
 * reader (platform/observability/alert.ts) finds the state without loading the whole layer.
 *
 * @module platform/observability
 */

export const OBSERVABILITY_STATE_KEY = "platform.observability.state";
