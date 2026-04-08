/**
 * platform/auth/auth-init.ts — Auth initialization (backward compat)
 *
 * Delegates to the central provider registry.
 * Existing callers (auth API routes, AuthPageClient) import from here.
 * New code should import initProviders from @/platform/providers/registry.
 *
 * @module platform/auth
 */

import { initProviders } from "@/platform/providers/registry";

/**
 * Initialize auth (and all other providers).
 * Backward-compatible wrapper around initProviders().
 */
export function initAuth(): void {
  initProviders();
}
