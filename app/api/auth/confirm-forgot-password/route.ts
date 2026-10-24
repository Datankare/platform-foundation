import { NextRequest } from "next/server";
import { readJsonObject, requireTextFields } from "@/platform/errors";
import {
  authResultResponse,
  callAuthProvider,
  passwordPolicyRefusal,
} from "@/platform/auth/auth-response";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";

export const POST = tenantRoute(async function POST(request: NextRequest) {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_ACCOUNT);
  if (limited) return limited;
  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  // Typed as text: requireTextFields below refuses anything else before it is used.
  const body = read.body as { email: string; code: string; newPassword: string };
  const invalid = requireTextFields(body, ["email", "code", "newPassword"], request);
  if (invalid) return invalid;
  const weak = await passwordPolicyRefusal(body.newPassword, request);
  if (weak) return weak;
  const called = await callAuthProvider(
    (auth) => auth.confirmForgotPassword(body.email, body.code, body.newPassword),
    {
      request,
      context: "Password reset failed",
    }
  );
  if (!called.ok) return called.response;
  return authResultResponse(called.result, { request, context: "Password reset failed" });
});
