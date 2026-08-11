/**
 * Social Module — barrel exports and singleton.
 *
 * Usage:
 *   import { getSocialStore } from "@/platform/social";
 *   const store = getSocialStore();
 *
 * Environment variables:
 *   SOCIAL_STORE = "supabase" | "memory" (default: "memory")
 *
 * @module platform/social
 */

export type {
  Group,
  GroupStatus,
  Membership,
  MemberRole,
  GroupInvite,
  InviteStatus,
  GroupResult,
  InviteResult,
  MembershipResult,
  CreateGroupInput,
  CreateInviteInput,
  SocialStore,
} from "./types";

export { InMemorySocialStore } from "./memory-social-store";
export { SupabaseSocialStore } from "./supabase-social-store";
export { GroupService, GROUP_LIMITS } from "./group-service";
export type { ScreenContentFn } from "./group-service";
export { InviteService } from "./invite-service";
export { createGuardianScreenFn } from "./guardian-adapter";

// Social agents (Sprint 4b)
export {
  createMatchmakerWorkflow,
  createGatekeeperWorkflow,
  createConciergeWorkflow,
  createAnalystWorkflow,
  createCuratorWorkflow,
} from "./agents";
export type {
  MatchmakerResult,
  GatekeeperResult,
  ConciergeResult,
  AnalystResult,
  CuratorResult,
} from "./agents";

// ---------------------------------------------------------------------------
// Store singleton
// ---------------------------------------------------------------------------

import type { SocialStore } from "./types";
import { InMemorySocialStore } from "./memory-social-store";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";

/** ADR-032: anchored on globalThis — a module-scope `let` is duplicated per bundle entry. */
const STORE_KEY = "platform.social.store";
function readCurrentStore(): SocialStore {
  return getSingleton<SocialStore>(STORE_KEY, () => new InMemorySocialStore());
}
function writeCurrentStore(next: SocialStore): void {
  setSingleton<SocialStore>(STORE_KEY, next);
}

/** Get the current social store. */
export function getSocialStore(): SocialStore {
  return readCurrentStore();
}

/** Set the social store (for provider init or testing). */
export function setSocialStore(store: SocialStore): SocialStore {
  const previous = readCurrentStore();
  writeCurrentStore(store);
  return previous;
}

/** Reset to default InMemorySocialStore (testing only). */
export function resetSocialStore(): void {
  writeCurrentStore(new InMemorySocialStore());
}
