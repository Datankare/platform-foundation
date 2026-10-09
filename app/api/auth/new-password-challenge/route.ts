import { NextRequest } from "next/server";
import { initAuth } from "@/platform/auth/auth-init";
import { getAuthProvider } from "@/platform/auth/config";
import { apiError } from "@/platform/errors";
import { authResultResponse } from "@/platform/auth/auth-response";

export async function POST(request: NextRequest) {
  initAuth();
  let body: { session?: string; newPassword?: string; username?: string };
  try {
    body = await request.json();
  } catch {
    return apiError("request.invalid_json", { request });
  }
  if (!body.session || !body.newPassword || !body.username) {
    return apiError("request.missing_fields", {
      params: { fields: ["session", "newPassword", "username"] },
      request,
    });
  }
  const auth = getAuthProvider();
  return authResultResponse(
    await auth.respondToNewPasswordChallenge(
      body.session,
      body.newPassword,
      body.username
    ),
    { request, context: "New-password challenge failed" }
  );
}
