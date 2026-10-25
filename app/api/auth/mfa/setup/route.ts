/**
 * app/api/auth/mfa/setup/route.ts — TOTP MFA setup for the signed-in user (audit A-9).
 * Rate limited, the caller verified, then platform/auth/mfa-routes.ts.
 */

import { NextRequest } from "next/server";
import { requireAuth } from "@/platform/auth/middleware";
import { mfaSetup } from "@/platform/auth/mfa-routes";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";

export const POST = tenantRoute(async function POST(request: NextRequest) {
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_SESSION);
  if (limited) return limited;
  // Changes how the account signs in: fails closed when Cognito cannot answer (M5).
  const auth = await requireAuth(request, { privileged: true });
  if (auth.error) return auth.error;
  return mfaSetup(request, auth);
});
