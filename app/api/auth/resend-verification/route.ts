import { NextRequest } from "next/server";
import { initAuth } from "@/platform/auth/auth-init";
import { getAuthProvider } from "@/platform/auth/config";
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
  const body = read.body as { email?: string };
  if (!body.email) {
    return apiError("request.missing_fields", { params: { fields: ["email"] }, request });
  }
  const auth = getAuthProvider();
  return authResultResponse(await auth.resendEmailVerification(body.email), {
    request,
    context: "Resend verification failed",
  });
}
