/**
 * platform/adaptive/memory.ts — within-session adaptive memory (ADR-036 D5).
 *
 * Per D6a, memory is a typed slice of the ActivityStateStore rather than a bespoke store: it
 * inherits the CAS/reduceCommit append path and the session lifecycle, and "within-session only"
 * holds by construction — the backing InMemoryActivityStateStore is keyed per (behavior, scope)
 * session and nothing outlives it. The window is bounded so memory cannot grow without limit.
 */
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";
import { InMemoryActivityStateStore } from "@/platform/app-framework/memory-state-store";
import type { ActivityStateStore } from "@/platform/kernel/state-store";
import type { AdaptiveScope } from "./loop";
import type { AdaptiveMemory, AdaptiveMemoryEntry } from "./types";

interface AdaptiveMemoryState {
  readonly recent: readonly AdaptiveMemoryEntry[];
}

const WINDOW = 10;
const STORE_KEY = "platform.adaptive.memory";

function store(): ActivityStateStore<AdaptiveMemoryState> {
  return getSingleton(
    STORE_KEY,
    () => new InMemoryActivityStateStore<AdaptiveMemoryState>()
  );
}

function sessionKey(behavior: string, scope: AdaptiveScope): string {
  return `adaptive:${behavior}:${scope.type}:${scope.id ?? "none"}`;
}

/** Read the bounded within-session memory for a (behavior, scope) session. */
export async function readAdaptiveMemory(
  behavior: string,
  scope: AdaptiveScope
): Promise<AdaptiveMemory> {
  const current = await store().load(sessionKey(behavior, scope));
  return { recent: current?.state.recent ?? [] };
}

/** Append an entry to within-session memory via the CAS reduceCommit path, bounded to WINDOW. */
export async function appendAdaptiveMemory(
  behavior: string,
  scope: AdaptiveScope,
  entry: AdaptiveMemoryEntry
): Promise<void> {
  const s = store();
  const key = sessionKey(behavior, scope);
  if ((await s.load(key)) === null) {
    await s.create(key, { recent: [] });
  }
  await s.reduceCommit(
    key,
    (current) => ({ recent: [...current.recent, entry].slice(-WINDOW) }),
    "adaptive-memory-append"
  );
}

/** Test support: drop all within-session adaptive memory. */
export function resetAdaptiveMemory(): void {
  setSingleton(STORE_KEY, new InMemoryActivityStateStore<AdaptiveMemoryState>());
}
