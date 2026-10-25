import { NextRequest } from "next/server";
import { readJsonObject, requireTextFields } from "@/platform/errors";
import { callAuthProvider, sessionResponse } from "@/platform/auth/auth-response";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";
import { sessionTenantRefusal } from "@/platform/tenancy/identity";

export const POST = tenantRoute(async function POST(request: NextRequest) {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_LOGIN);
  if (limited) return limited;
  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  // Typed as text: requireTextFields below refuses anything else before it is used.
  // The username the challenge was issued to (the email signed in with): Cognito answers it
  // only for that user (audit A-9).
  const body = read.body as { session: string; code: string; username: string };
  const invalid = requireTextFields(body, ["session", "code", "username"], request);
  if (invalid) return invalid;
  const called = await callAuthProvider(
    (auth) => auth.respondToMfaChallenge(body.session, body.code, body.username),
    {
      request,
      context: "MFA challenge failed",
    }
  );
  if (!called.ok) return called.response;
  // ADR-053 D2: the session it ends in is this tenant's identity's, or is not returned.
  const refused = await sessionTenantRefusal(called.result, request);
  if (refused) return refused;
  return sessionResponse(called.result, {
    request,
    context: "MFA challenge failed",
    method: "mfa",
  });
});
