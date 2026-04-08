/**
 * platform/auth/auth-init.ts — Server-side auth initialization
 *
 * Registers the CognitoAuthProvider (or MockAuthProvider in test) at startup.
 * Import this file once in server-side code (e.g., layout.tsx or instrumentation.ts).
 *
 * @module platform/auth
 */

import { registerAuthProvider, hasAuthProvider } from "@/platform/auth/config";
import { createCognitoAuthProvider } from "@/platform/auth/cognito-provider";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";
import { logger } from "@/lib/logger";

/**
 * Initialize the auth provider based on environment.
 * Safe to call multiple times — skips if already registered.
 */
export function initAuth(): void {
  if (hasAuthProvider()) return;

  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_CLIENT_ID;

  if (userPoolId && clientId) {
    registerAuthProvider(createCognitoAuthProvider());
    logger.info("Auth initialized with CognitoAuthProvider", {
      region: process.env.COGNITO_REGION ?? "us-east-1",
      userPoolId: `${userPoolId.slice(0, 12)}...`,
    });
  } else {
    // Development/test fallback — mock provider
    registerAuthProvider(createMockAuthProvider());
    logger.warn(
      "Auth initialized with MockAuthProvider — set COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID for real auth"
    );
  }
}
