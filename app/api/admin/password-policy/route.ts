/**
 * app/api/admin/password-policy/route.ts — Admin password policy
 *
 * GET: the global password policy (what sign-up enforces)
 * PUT: change it — only the fields sent change, each within PASSWORD_POLICY_LIMITS; the change
 *      is recorded under the verified admin (TASK-138)
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard, requireAdmin } from "@/platform/auth/admin-guard";
import { auditedResponse } from "@/platform/auth/audit";
import {
  applyPasswordPolicyChange,
  getGlobalPasswordPolicy,
  saveGlobalPasswordPolicy,
} from "@/platform/auth/password-policy";
import { apiError, internalError, readJsonObject } from "@/platform/errors";

export async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_manage_config");
  if (denied) return denied;
  return NextResponse.json({ policy: await getGlobalPasswordPolicy() });
}

export async function PUT(request: NextRequest) {
  const verified = await requireAdmin(request, "admin_manage_config");
  if (verified.error) return verified.error;
  const { admin } = verified;

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const body = read.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return apiError("request.invalid_body", { request });
  }

  const current = await getGlobalPasswordPolicy();
  const change = applyPasswordPolicyChange(current, body as Record<string, unknown>);
  if ("field" in change) {
    return apiError("request.invalid_value", {
      params: { field: change.field, allowed: [change.allowed] },
      request,
    });
  }

  return auditedResponse(
    {
      action: "admin_action",
      actorId: admin.userId,
      details: {
        type: "password_policy_updated",
        previous: current,
        policy: change.policy,
      },
    },
    async () => {
      const saved = await saveGlobalPasswordPolicy(change.policy);
      if (!saved.success) {
        return {
          success: false,
          error: saved.error,
          response: internalError(saved.error, {
            request,
            context: "Admin password-policy update failed",
          }),
        };
      }
      return {
        success: true,
        response: NextResponse.json({ success: true, policy: change.policy }),
      };
    },
    () => apiError("service.unavailable", { params: { service: "audit" }, request })
  );
}
