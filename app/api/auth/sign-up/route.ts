/**
 * app/api/auth/sign-up/route.ts — Sign up endpoint
 */

import { NextRequest } from "next/server";
import { initAuth } from "@/platform/auth/auth-init";
import { getAuthProvider } from "@/platform/auth/config";
import { passwordRuleViolations } from "@/platform/auth/password-policy";
import { logger } from "@/lib/logger";
import { apiError } from "@/platform/errors";
import { authResultResponse } from "@/platform/auth/auth-response";

export async function POST(request: NextRequest) {
  initAuth();

  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return apiError("request.invalid_json", { request });
  }

  if (!body.email || !body.password) {
    return apiError("request.missing_fields", {
      params: { fields: ["email", "password"] },
      request,
    });
  }

  // Validate password against policy (Sprint 4 enhanced)
  const failedRules = passwordRuleViolations(body.password, {
    rotationDays: 90,
    minLength: 12,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSpecial: true,
    passwordHistoryCount: 5,
  });

  if (failedRules.length > 0) {
    return apiError("auth.password_policy", { params: { rules: failedRules }, request });
  }

  const auth = getAuthProvider();
  const result = await auth.signUp(body.email, body.password);

  if (result.success) {
    logger.info("User registered", { email: body.email });
  }

  return authResultResponse(result, { request, context: "Sign up failed" });
}
