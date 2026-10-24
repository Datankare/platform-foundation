/**
 * platform/social/store.ts — The active social store (ADR-032 singleton)
 *
 * Installed by the social module's SOCIAL_STORE slot (./module.ts) at boot; read by the group
 * and invite services through getSocialStore().
 *
 * @module platform/social
 */

import type { SocialStore } from "./types";
import { InMemorySocialStore } from "./memory-social-store";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";

/** ADR-032: anchored on globalThis — a module-scope `let` is duplicated per bundle entry. */
export const SOCIAL_STORE_KEY = "platform.social.store";
function readCurrentStore(): SocialStore {
  return getSingleton<SocialStore>(SOCIAL_STORE_KEY, () => new InMemorySocialStore());
}
function writeCurrentStore(next: SocialStore): void {
  setSingleton<SocialStore>(SOCIAL_STORE_KEY, next);
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
