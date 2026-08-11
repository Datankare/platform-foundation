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
export * from "./actions";
export * from "./turn";
export {
  createSession,
  loadSession,
  updateSessionMeta,
  dispatch,
  isConflict,
  subscribeSessionEvents,
  resetSessionEventSubscribers,
  ActionRejectedError,
} from "./session";
export type {
  ConflictResult,
  DispatchOutcome,
  LoadSessionArgs,
  LoadedSession,
} from "./session";

import type { ActivityStateStore } from "./state-store";
import { InMemoryActivityStateStore } from "./memory-state-store";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";

// Type-erased singleton — the registry registers a concrete store; the session
// coordinator re-parameterizes at the call site (the ActivityDefinition knows TState).
/** ADR-032: anchored on globalThis — a module-scope `let` is duplicated per bundle entry. */
const STATESTORE_KEY = "platform.appFramework.stateStore";
function readActiveStore(): ActivityStateStore<unknown> {
  return getSingleton<ActivityStateStore<unknown>>(
    STATESTORE_KEY,
    () => new InMemoryActivityStateStore<unknown>()
  );
}
function writeActiveStore(next: ActivityStateStore<unknown>): void {
  setSingleton<ActivityStateStore<unknown>>(STATESTORE_KEY, next);
}

/** Set the active application state store (called by the provider registry, D2). */
export function setActivityStateStore(store: ActivityStateStore<unknown>): void {
  writeActiveStore(store);
}

/** Get the active application state store. */
export function getActivityStateStore<TState>(): ActivityStateStore<TState> {
  return readActiveStore() as ActivityStateStore<TState>;
}

/** Reset to a fresh in-memory store (testing only). */
export function resetActivityStateStore(): void {
  writeActiveStore(new InMemoryActivityStateStore<unknown>());
}
