/**
 * platform/rag/memory-user-context-store.ts — In-memory user context store
 *
 * Default implementation for tests and development.
 *
 * P7:  Provider-aware — mock/fallback.
 * P11: Always available.
 * P16: Cognitive memory — episodic + semantic + procedural.
 *
 * @module platform/rag
 */

import type { UserContextStore, UserAIContext, InteractionRecord } from "./types";

const MAX_INTERACTIONS = 100;

export class InMemoryUserContextStore implements UserContextStore {
  private contexts: Map<string, UserAIContext> = new Map();

  async getContext(userId: string): Promise<UserAIContext | undefined> {
    return this.contexts.get(userId);
  }

  async saveContext(context: UserAIContext): Promise<void> {
    this.contexts.set(context.userId, context);
  }

  async addInteraction(userId: string, interaction: InteractionRecord): Promise<void> {
    const existing = this.contexts.get(userId);
    const now = new Date().toISOString();

    if (!existing) {
      this.contexts.set(userId, {
        userId,
        interactions: [interaction],
        preferences: {},
        patterns: [],
        updatedAt: now,
      });
      return;
    }

    const interactions = [...existing.interactions, interaction];
    const trimmed =
      interactions.length > MAX_INTERACTIONS
        ? interactions.slice(-MAX_INTERACTIONS)
        : interactions;

    this.contexts.set(userId, {
      ...existing,
      interactions: trimmed,
      updatedAt: now,
    });
  }

  async updatePreferences(
    userId: string,
    preferences: Record<string, unknown>
  ): Promise<void> {
    const existing = this.contexts.get(userId);
    const now = new Date().toISOString();

    if (!existing) {
      this.contexts.set(userId, {
        userId,
        interactions: [],
        preferences,
        patterns: [],
        updatedAt: now,
      });
      return;
    }

    this.contexts.set(userId, {
      ...existing,
      preferences: { ...existing.preferences, ...preferences },
      updatedAt: now,
    });
  }

  async deleteContext(userId: string): Promise<void> {
    this.contexts.delete(userId);
  }
}
