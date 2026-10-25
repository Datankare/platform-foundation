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
 * eagerly load the config and data layers (which would bind real pools before test mocks apply).
 *
 * @module platform/agents
 */

export const BUDGET_COST_CAP_KEY = "agent.budget.max_cost_per_day";
export const BUDGET_STEP_CAP_KEY = "agent.budget.max_steps_per_trajectory";
/** ADR-053 D6: each tenant's daily cap on all its agents' spend together (operator-set). */
export const TENANT_COST_CAP_KEY = "agent.budget.tenant_max_cost_per_day";
/** Used when the setting cannot be read: the seeded default, so a lookup hiccup never lifts it. */
export const DEFAULT_TENANT_DAILY_COST_CAP = 100;

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

/**
 * The current tenant's daily cap across all its agents (its own value, else the platform default;
 * operators set it). Unreadable or invalid: the seeded default, never unlimited.
 */
export async function resolveTenantDailyCostCap(): Promise<number> {
  try {
    const { getConfig } = await import("@/platform/auth/platform-config");
    const v = Number(
      await getConfig<number>(TENANT_COST_CAP_KEY, DEFAULT_TENANT_DAILY_COST_CAP)
    );
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_TENANT_DAILY_COST_CAP;
  } catch {
    return DEFAULT_TENANT_DAILY_COST_CAP;
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

/**
 * The most segments one trajectory chain — a session's or a rolled-over run's — may have (review
 * 12 M2): with every segment at most 1 000 steps and 16 MiB, a chain is bounded at this many
 * times that. Governed (safety tier, operator-set; migration 052).
 */
export const TRAJECTORY_SEGMENTS_KEY = "agent.trajectory_max_segments";
/** The seeded default, used too when the setting cannot be read: never unbounded. */
export const DEFAULT_TRAJECTORY_MAX_SEGMENTS = 20;
/** The bounds the migration declares for the setting. */
export const TRAJECTORY_MAX_SEGMENTS_LIMIT = 1_000;

/** The current tenant's cap on segments per trajectory chain; unreadable or invalid: the default. */
export async function resolveTrajectoryMaxSegments(): Promise<number> {
  try {
    const { getConfig } = await import("@/platform/auth/platform-config");
    const v = Number(
      await getConfig<number>(TRAJECTORY_SEGMENTS_KEY, DEFAULT_TRAJECTORY_MAX_SEGMENTS)
    );
    return Number.isInteger(v) && v >= 1 && v <= TRAJECTORY_MAX_SEGMENTS_LIMIT
      ? v
      : DEFAULT_TRAJECTORY_MAX_SEGMENTS;
  } catch {
    return DEFAULT_TRAJECTORY_MAX_SEGMENTS;
  }
}
