/**
 * platform/auth/auth-init.ts — Server-side auth initialization
 *
 * Registers the CognitoAuthProvider (or MockAuthProvider in test) at startup.
 * Import this file once in server-side code.
 *
 * NOTE: Playform uses cognito-config.ts instead (excluded from sync).
 *
 * @module platform/auth
 */

import { registerAuthProvider, hasAuthProvider } from "@/platform/auth/config";
import { createCognitoAuthProvider } from "@/platform/auth/cognito-provider";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";
import { logger } from "@/lib/logger";

export function initAuth(): void {
  if (hasAuthProvider()) return;

  const userPoolId = process.env.COGNITO_USER_POOL_ID ?? "";
  const clientId = process.env.COGNITO_CLIENT_ID ?? "";
  const region = process.env.COGNITO_REGION ?? process.env.AWS_REGION ?? "us-east-1";

  if (userPoolId && clientId) {
    registerAuthProvider(createCognitoAuthProvider({ region, userPoolId, clientId }));
    logger.info("Auth initialized with CognitoAuthProvider", {
      region,
      userPoolId: `${userPoolId.slice(0, 12)}...`,
    });
  } else {
    registerAuthProvider(createMockAuthProvider({}));
    logger.warn(
      "Auth initialized with MockAuthProvider — set COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID for real auth"
    );
  }
}
