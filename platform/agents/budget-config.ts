/**
 * platform/agents/budget-config.ts — governed agent budget caps (ADR-048 D1).
 *
 * Resolves the daily cost cap and per-trajectory step cap from the permission-tiered governed
 * config store (getConfig, 60s cache), applied as a platform ceiling that can only TIGHTEN the
 * per-agent default (min-wins): governance over an unbounded-spend control may lower it, never
 * silently raise an agent above its own default. Unset or looser governed value leaves the
 * per-agent default standing (no regression). A config-store failure fails safe to the per-agent
 * default — a lookup hiccup never disables budget enforcement.
 *
 * getConfig is imported lazily so that pulling this module into the agent graph at boot does not
 * eagerly load the config/Supabase layer (which would bind real clients before test mocks apply).
 *
 * @module platform/agents
 */

export const BUDGET_COST_CAP_KEY = "agent.budget.max_cost_per_day";
export const BUDGET_STEP_CAP_KEY = "agent.budget.max_steps_per_trajectory";

async function resolveCap(key: string, perAgentDefault: number): Promise<number> {
  try {
    const { getConfig } = await import("@/platform/auth/platform-config");
    const governed = Number(await getConfig<number>(key, perAgentDefault));
    // A non-finite or non-positive ceiling is not a valid cap (and is below the migration's
    // min_value): treat it as unset and fall back to the per-agent default rather than
    // silently disabling the agent.
    return Number.isFinite(governed) && governed > 0
      ? Math.min(governed, perAgentDefault)
      : perAgentDefault;
  } catch {
    return perAgentDefault;
  }
}

/** Effective daily cost cap = min(governed platform ceiling, per-agent default). */
export function resolveDailyCostCap(perAgentDefault: number): Promise<number> {
  return resolveCap(BUDGET_COST_CAP_KEY, perAgentDefault);
}

/** Effective per-trajectory step cap = min(governed platform ceiling, per-agent default). */
export function resolveStepCap(perAgentDefault: number): Promise<number> {
  return resolveCap(BUDGET_STEP_CAP_KEY, perAgentDefault);
}
