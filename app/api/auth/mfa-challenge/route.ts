import { NextRequest } from "next/server";
import { initAuth } from "@/platform/auth/auth-init";
import { getAuthProvider } from "@/platform/auth/config";
import { apiError } from "@/platform/errors";
import { authResultResponse } from "@/platform/auth/auth-response";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";

export async function POST(request: NextRequest) {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_LOGIN);
  if (limited) return limited;
  initAuth();
  let body: { session?: string; code?: string };
  try {
    body = await request.json();
  } catch {
    return apiError("request.invalid_json", { request });
  }
  if (!body.session || !body.code) {
    return apiError("request.missing_fields", {
      params: { fields: ["session", "code"] },
      request,
    });
  }
  const auth = getAuthProvider();
  return authResultResponse(await auth.respondToMfaChallenge(body.session, body.code), {
    request,
    context: "MFA challenge failed",
  });
}
