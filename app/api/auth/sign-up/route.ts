/**
 * app/api/auth/sign-up/route.ts — Sign up endpoint
 */

import { NextRequest, NextResponse } from "next/server";
import { initAuth } from "@/platform/auth/auth-init";
import { getAuthProvider } from "@/platform/auth/config";
import { validatePassword } from "@/platform/auth/password-policy";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  initAuth();

  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid request body" },
      { status: 400 }
    );
  }

  if (!body.email || !body.password) {
    return NextResponse.json(
      { success: false, error: "Email and password are required" },
      { status: 400 }
    );
  }

  // Validate password against policy (Sprint 4 enhanced)
  const policyViolations = validatePassword(body.password, {
    rotationDays: 90,
    minLength: 12,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSpecial: true,
    passwordHistoryCount: 5,
  });

  if (policyViolations.length > 0) {
    return NextResponse.json(
      { success: false, error: policyViolations[0], violations: policyViolations },
      { status: 400 }
    );
  }

  const auth = getAuthProvider();
  const result = await auth.signUp(body.email, body.password);

  if (result.success) {
    logger.info("User registered", { email: body.email });
  }

  return NextResponse.json(result);
}
