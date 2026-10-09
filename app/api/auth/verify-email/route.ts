import { NextRequest } from "next/server";
import { initAuth } from "@/platform/auth/auth-init";
import { getAuthProvider } from "@/platform/auth/config";
import { apiError } from "@/platform/errors";
import { authResultResponse } from "@/platform/auth/auth-response";

export async function POST(request: NextRequest) {
  initAuth();
  let body: { email?: string; code?: string };
  try {
    body = await request.json();
  } catch {
    return apiError("request.invalid_json", { request });
  }
  if (!body.email || !body.code) {
    return apiError("request.missing_fields", {
      params: { fields: ["email", "code"] },
      request,
    });
  }
  const auth = getAuthProvider();
  return authResultResponse(await auth.confirmEmailVerification(body.email, body.code), {
    request,
    context: "Email verification failed",
  });
}
