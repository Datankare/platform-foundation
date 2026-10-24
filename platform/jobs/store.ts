/**
 * platform/jobs/store.ts — the active job store (a provider slot, ADR-032 singleton)
 *
 * Installed at boot by the JOB_STORE slot (platform/providers/registry.ts): the Postgres store
 * for postgres or supabase, the in-memory one otherwise — which production refuses unless a
 * local or CI harness opts out (E2E_IN_MEMORY_STORES), like every durable store (ADR-048 D3).
 *
 * @module platform/jobs
 */

import { getSingleton, setSingleton } from "@/platform/kernel/singleton";
import { InMemoryJobStore } from "./memory-store";
import type { JobStore } from "./types";

export const JOB_STORE_KEY = "platform.jobs.store";

export function getJobStore(): JobStore {
  return getSingleton<JobStore>(JOB_STORE_KEY, () => new InMemoryJobStore());
}

/** Replace the store (provider init, tests). Returns the previous one. */
export function setJobStore(store: JobStore): JobStore {
  const previous = getJobStore();
  setSingleton<JobStore>(JOB_STORE_KEY, store);
  return previous;
}

/** Back to a fresh in-memory store (tests only). */
export function resetJobStore(): void {
  setSingleton<JobStore>(JOB_STORE_KEY, new InMemoryJobStore());
}
