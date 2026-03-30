/**
 * platform/auth/config.ts — Auth provider configuration
 *
 * Registers and provides access to the active AuthProvider implementation.
 * Routes and middleware import getAuthProvider() from here — never a
 * specific provider directly.
 *
 * Usage:
 *   import { getAuthProvider } from "@/platform/auth/config";
 *   const auth = getAuthProvider();
 *   const result = await auth.signIn(email, password);
 *
 * To register your own provider, call registerAuthProvider() at app startup
 * (e.g., in a server-side initialization file or middleware).
 *
 * ADR-012: Cloud-agnostic auth via provider interface.
 */

import type { AuthProvider } from "@/platform/auth/provider";

let registeredProvider: AuthProvider | null = null;

/**
 * Register the auth provider implementation.
 * Call this once at app startup with your chosen provider.
 *
 * Example:
 *   registerAuthProvider(createCognitoAuthProvider({ ... }));
 *   registerAuthProvider(createAuth0Provider({ ... }));
 */
export function registerAuthProvider(provider: AuthProvider): void {
  registeredProvider = provider;
}

/**
 * Get the registered auth provider.
 * Throws if no provider has been registered — fail-fast on misconfiguration.
 */
export function getAuthProvider(): AuthProvider {
  if (!registeredProvider) {
    throw new Error(
      "No auth provider registered. Call registerAuthProvider() at app startup. " +
        "See platform/auth/AUTH_INTEGRATION_GUIDE.md for setup instructions."
    );
  }
  return registeredProvider;
}

/**
 * Check if an auth provider has been registered.
 * Useful for conditional logic during startup.
 */
export function hasAuthProvider(): boolean {
  return registeredProvider !== null;
}
