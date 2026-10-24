/**
 * app/api/auth/sign-up/route.ts — Sign up endpoint
 *
 * Refused when the tenant does not accept new accounts (signups_enabled). In a shared
 * deployment the new account is assigned the tenant of the address it signed up at (ADR-053
 * D2); if that assignment fails, the account is assigned at its first sign-in instead.
 */

import { NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { apiError, readJsonObject, requireTextFields } from "@/platform/errors";
import {
  authResultResponse,
  callAuthProvider,
  passwordPolicyRefusal,
} from "@/platform/auth/auth-response";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";
import {
  assignCurrentTenant,
  sessionTenantRefusal,
  signupsOpen,
} from "@/platform/tenancy/identity";

export const POST = tenantRoute(async function POST(request: NextRequest) {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_ACCOUNT);
  if (limited) return limited;

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  // Typed as text: requireTextFields below refuses anything else before it is used.
  const body = read.body as { email: string; password: string };

  const invalid = requireTextFields(body, ["email", "password"], request);
  if (invalid) return invalid;

  if (!(await signupsOpen())) return apiError("auth.signups_closed", { request });

  // The tenant's policy, set by its administrators (Sprint 7X; it was hard-coded here).
  const weak = await passwordPolicyRefusal(body.password, request);
  if (weak) return weak;

  const called = await callAuthProvider(
    (auth) => auth.signUp(body.email, body.password),
    {
      request,
      context: "Sign up failed",
    }
  );
  if (!called.ok) return called.response;
  const result = called.result;

  if (result.success) {
    // No email in the log: logs are not a store of personal data (ring 6).
    logger.info("User registered", { route: "api/auth/sign-up" });
    if (result.userId) await assignCurrentTenant(result.userId);
  }
  // A provider that signs the new account straight in returns a session: checked like sign-in's.
  const refused = await sessionTenantRefusal(result, request);
  if (refused) return refused;

  return authResultResponse(result, { request, context: "Sign up failed" });
});
