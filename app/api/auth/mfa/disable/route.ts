/**
 * app/api/auth/mfa/disable/route.ts — TOTP MFA disable for the signed-in user (audit A-9).
 * Rate limited, the caller verified, then platform/auth/mfa-routes.ts.
 */

import { NextRequest } from "next/server";
import { requireAuth } from "@/platform/auth/middleware";
import { mfaDisable } from "@/platform/auth/mfa-routes";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";
import type { ResponseSchema } from "@/platform/errors/response-schema";

const POST_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    // The session's new forgery token: a changed factor moves the session to a new id (ADR-057).
    csrfToken: {
      type: "string",
    },
    mfaEnabled: {
      type: "boolean",
    },
    success: {
      type: "boolean",
    },
  },
};

export const POST = tenantRoute(async function POST(request: NextRequest) {
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_SESSION);
  if (limited) return limited;
  // Changes how the account signs in: fails closed when Cognito cannot answer (M5).
  const auth = await requireAuth(request, { privileged: true });
  if (auth.error) return auth.error;
  return mfaDisable(request, auth);
}, POST_RESPONSE);
