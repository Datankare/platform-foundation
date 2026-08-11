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
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";

/** ADR-032: anchored on globalThis — a module-scope `let` is duplicated per bundle entry. */
const PROVIDER_KEY = "platform.auth.provider";
function readRegisteredProvider(): AuthProvider | null {
  return getSingleton<AuthProvider | null>(PROVIDER_KEY, () => null);
}
function writeRegisteredProvider(next: AuthProvider | null): void {
  setSingleton<AuthProvider | null>(PROVIDER_KEY, next);
}

/**
 * Register the auth provider implementation.
 * Call this once at app startup with your chosen provider.
 *
 * Example:
 *   registerAuthProvider(createCognitoAuthProvider({ ... }));
 *   registerAuthProvider(createAuth0Provider({ ... }));
 */
export function registerAuthProvider(provider: AuthProvider): void {
  writeRegisteredProvider(provider);
}

/**
 * Forget the registered provider.
 *
 * Test affordance, and its absence was a real gap: with no supported way to say "nothing is
 * registered", tests reached for jest.resetModules() and depended on a module-scope binding
 * vanishing. That stopped being true when the value moved to the globalThis registry
 * (ADR-032), and it was never a property worth depending on.
 */
export function resetAuthProvider(): void {
  writeRegisteredProvider(null);
}

/**
 * Get the registered auth provider.
 * Throws if no provider has been registered — fail-fast on misconfiguration.
 */
export function getAuthProvider(): AuthProvider {
  const provider = readRegisteredProvider();
  if (!provider) {
    // No recovery path here, deliberately. This function used to re-require
    // @/platform/providers and call initProviders() again, because instrumentation.ts and a
    // route handler saw different module instances (the comment cited "Gotcha 43").
    //
    // ADR-032 fixed that cause: singletons live on a globalThis registry keyed by
    // Symbol.for, so the provider registered at startup IS the one a route reads. Retrying
    // initialisation from inside a request would now re-read every env var and re-register
    // every slot mid-flight, and would hide a genuine misconfiguration behind a silent
    // repair — the opposite of the fail-fast this function documents.
    throw new Error(
      "No auth provider registered. Call registerAuthProvider() at app startup. " +
        "See platform/auth/AUTH_INTEGRATION_GUIDE.md for setup instructions."
    );
  }
  return provider;
}

/**
 * Check if an auth provider has been registered.
 * Useful for conditional logic during startup.
 */
export function hasAuthProvider(): boolean {
  return readRegisteredProvider() !== null;
}
