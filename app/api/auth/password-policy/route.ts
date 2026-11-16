/**
 * GET /api/auth/password-policy — the rules a new password must meet here (TASK-222, E-112)
 *
 * Public: the sign-up, password-reset and new-password screens read it before anyone is signed
 * in, and show it item by item (components/auth/ui/PasswordRules.tsx) — the policy the routes
 * that set a password refuse one by (platform/auth/auth-response.ts passwordPolicyRefusal: the
 * tenant-wide policy, read in the request's tenant). Only what a person choosing a password
 * needs: the length and the kinds of character. Never who the policy is for, never the history
 * or rotation settings. An unreadable store answers the strict built-in policy, as the routes
 * then enforce it.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getGlobalPasswordPolicy } from "@/platform/auth/password-policy";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";
import type { ResponseSchema } from "@/platform/errors/response-schema";

const GET_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    policy: {
      type: "object",
      properties: {
        minLength: { type: "number" },
        requireUppercase: { type: "boolean" },
        requireLowercase: { type: "boolean" },
        requireNumber: { type: "boolean" },
        requireSpecial: { type: "boolean" },
      },
    },
  },
};

export const GET = tenantRoute(async function GET(
  request: NextRequest
): Promise<NextResponse> {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.API_GLOBAL);
  if (limited) return limited;
  const p = await getGlobalPasswordPolicy();
  return NextResponse.json(
    {
      policy: {
        minLength: p.minLength,
        requireUppercase: p.requireUppercase,
        requireLowercase: p.requireLowercase,
        requireNumber: p.requireNumber,
        requireSpecial: p.requireSpecial,
      },
    },
    // Read on each screen that sets a password: an administrator's change shows at once.
    { headers: { "Cache-Control": "no-store" } }
  );
}, GET_RESPONSE);
