/**
 * app/api/auth/sign-up/route.ts — Sign up endpoint
 *
 * Refused when the tenant does not accept new accounts (signups_enabled). In a shared
 * deployment the new account is assigned the tenant of the address it signed up at (ADR-053
 * D2); if that assignment fails, the account is assigned at its first sign-in instead.
 *
 * Age (COPPA, audit X-16): `dateOfBirth` (YYYY-MM-DD) is required and checked here, before the
 * account exists. The account's platform row is created at once with that age recorded, so a
 * child's account starts under the consent gate. If the record cannot be written the account
 * still exists, unverified — and an unverified account is refused every consent-gated feature
 * until its age is recorded (POST /api/account/age), so the failure is never an adult's access.
 */

import { NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { apiError, readJsonObject, requireTextFields } from "@/platform/errors";
import {
  authResultResponse,
  callAuthProvider,
  concealAccount,
  passwordPolicyRefusal,
} from "@/platform/auth/auth-response";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";
import {
  assignCurrentTenant,
  sessionTenantRefusal,
  signupsOpen,
} from "@/platform/tenancy/identity";
import { parseDeclaredBirthDate, recordAgeVerification } from "@/platform/auth/coppa";
import { isUnder13Unavailable } from "@/platform/auth/age";
import { ensureUserProvisioned } from "@/platform/auth/user-provisioning";

export const POST = tenantRoute(async function POST(request: NextRequest) {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.AUTH_ACCOUNT);
  if (limited) return limited;

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  // Typed as text: requireTextFields below refuses anything else before it is used.
  const body = read.body as { email: string; password: string; dateOfBirth: string };

  const invalid = requireTextFields(body, ["email", "password", "dateOfBirth"], request);
  if (invalid) return invalid;
  const declared = parseDeclaredBirthDate(body.dateOfBirth);
  if (!declared) {
    return apiError("request.invalid_value", {
      params: { field: "dateOfBirth", allowed: ["a past date of birth, YYYY-MM-DD"] },
      request,
    });
  }
  // TASK-181: no under-13 account until parental consent ships (Batch 4) — nothing is created.
  if (isUnder13Unavailable(declared)) {
    return apiError("account.child_accounts_unavailable", { request });
  }

  if (!(await signupsOpen())) return apiError("auth.signups_closed", { request });

  // The tenant's policy, set by its administrators (Sprint 7X; it was hard-coded here).
  const weak = await passwordPolicyRefusal(body.password, request);
  if (weak) return weak;

  const called = await callAuthProvider(
    (auth) => auth.signUp(body.email, body.password),
    {
      request,
      context: "Sign up failed",
    }
  );
  if (!called.ok) return called.response;
  const result = called.result;

  if (result.success) {
    // No email in the log: logs are not a store of personal data (ring 6).
    logger.info("User registered", { route: "api/auth/sign-up" });
    if (result.userId) {
      await assignCurrentTenant(result.userId);
      await recordSignUpAge(result.userId, body.email, body.dateOfBirth);
    }
  }
  // A provider that signs the new account straight in returns a session: checked like sign-in's.
  const refused = await sessionTenantRefusal(result, request);
  if (refused) return refused;

  // An address that already has an account is answered as a new one (audit A-15).
  return authResultResponse(concealAccount(result, "create"), {
    request,
    context: "Sign up failed",
  });
});

/** Create the account's row with its declared age; a failure leaves it unverified (gated). */
async function recordSignUpAge(
  userId: string,
  email: string,
  dateOfBirth: string
): Promise<void> {
  const provisioned = await ensureUserProvisioned(userId, { email });
  if (provisioned !== "created" && provisioned !== "existing") {
    if (provisioned !== "skipped") {
      logger.warn("Sign-up: the account's age could not be recorded yet", {
        outcome: provisioned,
        route: "api/auth/sign-up",
      });
    }
    return;
  }
  const recorded = await recordAgeVerification(userId, dateOfBirth);
  if (!recorded.success) {
    logger.warn("Sign-up: the account's age could not be recorded; it stays unverified", {
      route: "api/auth/sign-up",
    });
  }
}
