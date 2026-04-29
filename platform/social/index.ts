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

// ---------------------------------------------------------------------------
// Store singleton
// ---------------------------------------------------------------------------

import type { SocialStore } from "./types";
import { InMemorySocialStore } from "./memory-social-store";

let currentStore: SocialStore = new InMemorySocialStore();

/** Get the current social store. */
export function getSocialStore(): SocialStore {
  return currentStore;
}

/** Set the social store (for provider init or testing). */
export function setSocialStore(store: SocialStore): SocialStore {
  const previous = currentStore;
  currentStore = store;
  return previous;
}

/** Reset to default InMemorySocialStore (testing only). */
export function resetSocialStore(): void {
  currentStore = new InMemorySocialStore();
}
