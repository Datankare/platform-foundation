/**
 * platform/app-framework/index.ts — Application framework barrel + store singleton
 *
 * Public surface of the application framework (ADR-028). The state-store singleton
 * follows the platform pattern (cf. moderation/social): the registry sets the
 * implementation synchronously at startup; consumers read it via getActivityStateStore().
 * Defaults to the in-memory store so tests and un-configured environments work.
 *
 * @module platform/app-framework
 */

export * from "./types";
export * from "./state-store";
export { InMemoryActivityStateStore } from "./memory-state-store";
export { SupabaseActivityStateStore } from "./supabase-state-store";

import type { ActivityStateStore } from "./state-store";
import { InMemoryActivityStateStore } from "./memory-state-store";

// Type-erased singleton — the registry registers a concrete store; the session
// coordinator re-parameterizes at the call site (the ActivityDefinition knows TState).
let activeStore: ActivityStateStore<unknown> = new InMemoryActivityStateStore<unknown>();

/** Set the active application state store (called by the provider registry, D2). */
export function setActivityStateStore(store: ActivityStateStore<unknown>): void {
  activeStore = store;
}

/** Get the active application state store. */
export function getActivityStateStore<TState>(): ActivityStateStore<TState> {
  return activeStore as ActivityStateStore<TState>;
}

/** Reset to a fresh in-memory store (testing only). */
export function resetActivityStateStore(): void {
  activeStore = new InMemoryActivityStateStore<unknown>();
}
