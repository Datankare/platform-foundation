/**
 * AI Data Purge Handlers — GDPR deletion of AI-related user data.
 *
 * GenAI Principles satisfied:
 *   P2 — AI instrumentation data is user-deletable
 *   P5 — AI cost tracking data is user-deletable
 *   P9 — Purge operations are traced via observability
 *
 * Registers purge handlers for:
 * 1. ai_metrics table (per-user AI call history, token usage, costs)
 * 2. Cached AI responses (via AICache.purgeUserData())
 *
 * Consumers register additional handlers for app-specific AI data
 * (e.g., conversation history, AI context store in Phase 4).
 *
 * @module platform/gdpr
 * @see GENAI_ROADMAP.md — GDPR applies to all AI-generated user data
 */

import type { PurgeHandler } from "./types";

/**
 * Purge handler: Delete user's AI call metrics from ai_metrics table.
 *
 * Priority 50 — runs after primary identity deletion (10-20)
 * but before infrastructure cleanup (80-100).
 */
export class AIMetricsPurgeHandler implements PurgeHandler {
  readonly name = "ai:metrics";
  readonly priority = 50;

  private deleteFn: (userId: string) => Promise<number>;

  /**
   * @param deleteFn — Function that deletes ai_metrics rows for a user.
   *   Typically: async (userId) => supabase.from('ai_metrics').delete().eq('user_id', userId)
   *   Injected to avoid direct Supabase dependency in the handler.
   */
  constructor(deleteFn: (userId: string) => Promise<number>) {
    this.deleteFn = deleteFn;
  }

  async execute(userId: string, dryRun: boolean): Promise<number> {
    if (dryRun) {
      // In dry-run, we can't count without the actual query
      // Consumers should provide a count query in their deleteFn for dry-run
      return 0;
    }
    return this.deleteFn(userId);
  }
}

/**
 * Purge handler: Clear user's cached AI responses.
 *
 * Priority 85 — runs after data deletion, before generic cache cleanup.
 *
 * NOTE: Phase 2 uses hash-based cache keys without user association.
 * Full per-user cache purge requires Phase 4 (user context store).
 * For now, this is a placeholder that documents the requirement.
 */
export class AICachePurgeHandler implements PurgeHandler {
  readonly name = "ai:cached-responses";
  readonly priority = 85;

  private purgeFn: (userId: string) => Promise<number>;

  /**
   * @param purgeFn — Function that clears cached AI responses for a user.
   *   Phase 2: May clear entire AI cache namespace (conservative).
   *   Phase 4: Per-user cache keying enables targeted purge.
   */
  constructor(purgeFn: (userId: string) => Promise<number>) {
    this.purgeFn = purgeFn;
  }

  async execute(userId: string, dryRun: boolean): Promise<number> {
    if (dryRun) return 0;
    return this.purgeFn(userId);
  }
}
