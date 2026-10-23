/**
 * app/api/auth/sign-up/route.ts — Sign up endpoint
 */

import { NextRequest } from "next/server";
import {
  getGlobalPasswordPolicy,
  passwordRuleViolations,
} from "@/platform/auth/password-policy";
import { logger } from "@/lib/logger";
import { apiError, readJsonObject, requireTextFields } from "@/platform/errors";
import { authResultResponse, callAuthProvider } from "@/platform/auth/auth-response";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";

export async function POST(request: NextRequest) {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_ACCOUNT);
  if (limited) return limited;

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  // Typed as text: requireTextFields below refuses anything else before it is used.
  const body = read.body as { email: string; password: string };

  const invalid = requireTextFields(body, ["email", "password"], request);
  if (invalid) return invalid;

  // The global policy the admins set (Sprint 7X; it was hard-coded here and never read).
  const failedRules = passwordRuleViolations(
    body.password,
    await getGlobalPasswordPolicy()
  );

  if (failedRules.length > 0) {
    return apiError("auth.password_policy", { params: { rules: failedRules }, request });
  }

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
  }

  return authResultResponse(result, { request, context: "Sign up failed" });
}
