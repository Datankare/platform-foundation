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
import type { VerifiedAdmin } from "@/platform/auth/role-governance";
import { OPERATOR_PERMISSION } from "@/platform/admin/config-scope";
import type { Operator, OperatorFailure, OperatorResult } from "./admin";

export { OPERATOR_PERMISSION };

export function operatorOf(admin: VerifiedAdmin): Operator {
  return { userId: admin.userId };
}

/** The coded error for an operator failure. */
export function operatorError(
  code: OperatorFailure,
  message: string,
  request: NextRequest
): NextResponse {
  switch (code) {
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
      return apiError("tenant.invalid", { request });
    case "tenant.own_tenant":
      return apiError("tenant.own_tenant", { request });
    case "tenant.self_approval":
      return apiError("tenant.self_approval", { request });
    case "audit.unavailable":
      return apiError("service.unavailable", { params: { service: "audit" }, request });
  }
}

/** A result as a response: the value as JSON (status `okStatus`), or its coded error. */
export function operatorResponse<T>(
  result: OperatorResult<T>,
  request: NextRequest,
  okStatus = 200
): NextResponse {
  if (result.ok) return NextResponse.json({ result: result.value }, { status: okStatus });
  return operatorError(result.code, result.message, request);
}
