/**
 * app/api/auth/sign-up/route.ts — Sign up endpoint
 */

import { NextRequest } from "next/server";
import { initAuth } from "@/platform/auth/auth-init";
import { getAuthProvider } from "@/platform/auth/config";
import {
  getGlobalPasswordPolicy,
  passwordRuleViolations,
} from "@/platform/auth/password-policy";
import { logger } from "@/lib/logger";
import { apiError, readJsonObject } from "@/platform/errors";
import { authResultResponse } from "@/platform/auth/auth-response";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";

export async function POST(request: NextRequest) {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_ACCOUNT);
  if (limited) return limited;
  initAuth();

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const body = read.body as { email?: string; password?: string };

  if (!body.email || !body.password) {
    return apiError("request.missing_fields", {
      params: { fields: ["email", "password"] },
      request,
    });
  }

  // The global policy the admins set (Sprint 7X; it was hard-coded here and never read).
  const failedRules = passwordRuleViolations(
    body.password,
    await getGlobalPasswordPolicy()
  );

  if (failedRules.length > 0) {
    return apiError("auth.password_policy", { params: { rules: failedRules }, request });
  }

  const auth = getAuthProvider();
  const result = await auth.signUp(body.email, body.password);

  if (result.success) {
    // No email in the log: logs are not a store of personal data (ring 6).
    logger.info("User registered", { route: "api/auth/sign-up" });
  }

  return authResultResponse(result, { request, context: "Sign up failed" });
}
