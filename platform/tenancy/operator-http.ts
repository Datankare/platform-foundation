/**
 * platform/tenancy/operator-http.ts — the operator routes' shared answers (ADR-053 D7)
 *
 * Operator routes (app/api/operator/*) verify the caller with requireAdmin(…, platform_operate)
 * and answer an OperatorResult with one coded error each (ADR-051).
 *
 * @module platform/tenancy
 */

import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/platform/errors";
import type { RoleRefusal, VerifiedAdmin } from "@/platform/auth/role-governance";
import { OPERATOR_PERMISSION } from "@/platform/admin/config-scope";
import type { Operator, OperatorFailure, OperatorResult } from "./admin";

export { OPERATOR_PERMISSION };

export function operatorOf(admin: VerifiedAdmin): Operator {
  // The verified operator travels with the action: the role rules apply to them (audit C-5).
  return { userId: admin.userId, admin };
}

/** The coded error for an operator failure. */
export function operatorError(
  code: OperatorFailure,
  message: string,
  request: NextRequest,
  /** For tenant.role_refused: the role rule that refused (its own code, ADR-051). */
  refusal?: RoleRefusal,
  /** For approvals.no_eligible_approver: the action and what its approver must hold (N-24). */
  needs?: { readonly action: string; readonly permissions: readonly string[] }
): NextResponse {
  switch (code) {
    case "tenant.role_refused":
      return refusal
        ? apiError(refusal.code, { params: refusal.params, request })
        : apiError("auth.role_database_only", { params: { role: "unknown" }, request });
    case "tenant.not_found":
    case "tenant.request_not_found":
    case "tenant.user_not_found":
      return apiError("tenant.not_found", { request });
    case "tenant.exists":
    case "tenant.slug_taken":
    case "tenant.domain_taken":
    case "tenant.state_conflict":
      return apiError("tenant.conflict", { params: { reason: message }, request });
    case "tenant.invalid":
      // With what was wrong (S2 round 2): a reason outside the list, a note too long, a slug.
      return apiError("tenant.invalid", { params: { reason: message }, request });
    case "tenant.own_tenant":
      return apiError("tenant.own_tenant", { request });
    case "tenant.self_approval":
      return apiError("tenant.self_approval", { request });
    case "audit.unavailable":
      return apiError("service.unavailable", { params: { service: "audit" }, request });
    case "roles.unavailable":
      return apiError("service.unavailable", { params: { service: "roles" }, request });
    case "approvals.no_eligible_approver":
      return apiError("approvals.no_eligible_approver", {
        params: {
          action: needs?.action ?? "this action",
          permissions: [...(needs?.permissions ?? [OPERATOR_PERMISSION])],
        },
        request,
      });
  }
}

/** A result as a response: the value as JSON (status `okStatus`), or its coded error. */
export function operatorResponse<T>(
  result: OperatorResult<T>,
  request: NextRequest,
  okStatus = 200
): NextResponse {
  if (result.ok) return NextResponse.json({ result: result.value }, { status: okStatus });
  return operatorError(
    result.code,
    result.message,
    request,
    result.refusal,
    result.needs
  );
}
