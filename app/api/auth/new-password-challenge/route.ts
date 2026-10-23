import { NextRequest } from "next/server";
import { readJsonObject, requireTextFields } from "@/platform/errors";
import { authResultResponse, callAuthProvider } from "@/platform/auth/auth-response";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";

export async function POST(request: NextRequest) {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_LOGIN);
  if (limited) return limited;
  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  // Typed as text: requireTextFields below refuses anything else before it is used.
  const body = read.body as { session: string; newPassword: string; username: string };
  const invalid = requireTextFields(
    body,
    ["session", "newPassword", "username"],
    request
  );
  if (invalid) return invalid;
  const called = await callAuthProvider(
    (auth) =>
      auth.respondToNewPasswordChallenge(body.session, body.newPassword, body.username),
    {
      request,
      context: "New-password challenge failed",
    }
  );
  if (!called.ok) return called.response;
  return authResultResponse(called.result, {
    request,
    context: "New-password challenge failed",
  });
}
