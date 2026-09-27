/**
 * app/api/auth/forgot-password/route.ts — Password recovery
 */

import { NextRequest } from "next/server";
import { initAuth } from "@/platform/auth/auth-init";
import { getAuthProvider } from "@/platform/auth/config";
import { apiError } from "@/platform/errors";
import { authResultResponse } from "@/platform/auth/auth-response";

export async function POST(request: NextRequest) {
  initAuth();
  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return apiError("request.invalid_json", { request });
  }
  if (!body.email) {
    return apiError("request.missing_fields", { params: { fields: ["email"] }, request });
  }
  const auth = getAuthProvider();
  const result = await auth.forgotPassword(body.email);
  return authResultResponse(result, { request, context: "Forgot password failed" });
}
