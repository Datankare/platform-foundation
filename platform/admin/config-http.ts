/**
 * platform/admin/config-http.ts — one config change as an HTTP answer (audit X-7, ADR-053 D5)
 *
 * The governed write (writeGovernedConfig) and reset (resetGovernedConfig) behind
 * PUT/DELETE /api/admin/config, shared by the operators' per-tenant settings
 * (/api/operator/tenants/[id]/config, which runs them in that tenant). Each outcome — not found,
 * refused by tier or scope, invalid, held or awaiting approval, applied, failed — has one answer.
 *
 * @module platform/admin
 */

import { NextRequest, NextResponse } from "next/server";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";
import {
  describeFailure,
  resetGovernedConfig,
  writeGovernedConfig,
  type GovernedConfigOutcome,
} from "@/platform/admin/governed-config";
import type { ConfigScope } from "@/platform/admin/types";
import { logger, generateRequestId } from "@/lib/logger";
import { apiError, internalError, readJsonObject } from "@/platform/errors";

export interface ConfigPutOptions {
  /** Force the change's scope (the operators' per-tenant settings: always "tenant"). */
  readonly scope?: ConfigScope;
}

/** PUT { key, value, changeComment?, scope? } as `admin`, in the current tenant. */
export async function configPutResponse(
  request: NextRequest,
  admin: VerifiedAdmin,
  options: ConfigPutOptions = {}
): Promise<Response> {
  const requestId = generateRequestId();
  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const body = read.body as {
    key?: unknown;
    value?: unknown;
    changeComment?: unknown;
    scope?: unknown;
  };
  if (typeof body?.key !== "string" || body.key === "" || body.value === undefined) {
    return apiError("request.missing_fields", {
      params: { fields: ["key", "value"] },
      request,
    });
  }
  // ADR-053 D5: optional — "platform" (an operator changing the default) or "tenant".
  if (body.scope !== undefined && body.scope !== "platform" && body.scope !== "tenant") {
    return apiError("request.invalid_body", { request });
  }
  if (
    options.scope !== undefined &&
    body.scope !== undefined &&
    body.scope !== options.scope
  ) {
    return apiError("request.invalid_body", { request });
  }
  const scope = options.scope ?? (body.scope as ConfigScope | undefined);

  try {
    const outcome = await writeGovernedConfig(admin, {
      key: body.key,
      value: body.value,
      changeComment:
        typeof body.changeComment === "string" && body.changeComment.trim() !== ""
          ? body.changeComment
          : "Changed on the config page",
      ...(scope ? { scope } : {}),
    });

    return governedOutcomeResponse(outcome, body.key, body.value, request);
  } catch (error) {
    logger.error("Config update failed", {
      requestId,
      route: "/api/admin/config",
      error: error instanceof Error ? error.message : "Unknown",
    });
    return apiError("internal.error", { request });
  }
}

/**
 * One governed change's outcome as the answer: 200 applied, 202 held or awaiting a second
 * approver, else its coded refusal. Shared by the config page and the Jobs console's schedules.
 */
export function governedOutcomeResponse(
  outcome: GovernedConfigOutcome,
  key: string,
  value: unknown,
  request: NextRequest
): Response {
  switch (outcome.kind) {
    case "not_found":
      return apiError("admin.target_not_found", {
        params: { target: "config" },
        request,
      });
    case "refused":
      return apiError("auth.permission_denied", {
        params: { permission: outcome.permission },
        request,
      });
    case "refused_scope":
      return apiError("admin.config_scope_refused", {
        params: { key },
        request,
      });
    case "invalid":
      // The structured reason, worded by the message (round 14, item 2).
      return apiError("admin.config_invalid_value", {
        params: { ...outcome.params, key },
        request,
      });
    case "pending":
      return NextResponse.json(
        {
          // Held, not done: never reported as success (review 9 H1).
          success: false,
          held: true,
          pending: true,
          key,
          approval: outcome.result.approval ?? outcome.result.data ?? null,
        },
        { status: 202 }
      );
    case "applied":
      return NextResponse.json({ success: true, key, value });
    case "failed":
      return failedResponse(outcome, request, "Admin config write failed");
  }
}

/**
 * A governed change that did not go through, as its answer (round 14, item 1): its code when it
 * has one — a change already waiting 409, the audit log unavailable 503, a stale or lost commit
 * — else internal.error, its text logged. (The code was dropped: every one answered 500.)
 */
function failedResponse(
  outcome: Extract<GovernedConfigOutcome, { kind: "failed" }>,
  request: NextRequest,
  context: string
): Response {
  if (
    outcome.code &&
    outcome.code !== "admin.action_failed" &&
    outcome.code !== "internal.error"
  ) {
    return apiError(outcome.code, { params: { ...(outcome.params ?? {}) }, request });
  }
  return internalError(describeFailure(outcome.result), { request, context });
}

/** DELETE ?key=… as `admin`: the current tenant's own value removed, governed. */
export async function configResetResponse(
  request: NextRequest,
  admin: VerifiedAdmin
): Promise<Response> {
  const key = request.nextUrl.searchParams.get("key");
  if (!key)
    return apiError("request.missing_fields", { params: { fields: ["key"] }, request });
  try {
    const outcome = await resetGovernedConfig(admin, {
      key,
      changeComment: "Use the platform default",
    });
    switch (outcome.kind) {
      case "not_found":
        return apiError("admin.target_not_found", {
          params: { target: "config" },
          request,
        });
      case "refused":
        return apiError("auth.permission_denied", {
          params: { permission: outcome.permission },
          request,
        });
      case "refused_scope":
        return apiError("admin.config_scope_refused", { params: { key }, request });
      case "pending":
        return NextResponse.json(
          {
            success: false,
            held: true,
            pending: true,
            key,
            approval: outcome.result.approval ?? outcome.result.data ?? null,
          },
          { status: 202 }
        );
      case "applied": {
        const unchanged = (outcome.result.data as { unchanged?: boolean } | null)
          ?.unchanged;
        return NextResponse.json({
          success: true,
          key,
          ...(unchanged ? { unchanged } : {}),
        });
      }
      case "invalid":
        // A reset sets no value; were one refused, its reason is the entry's (round 14).
        return apiError("admin.config_invalid_value", {
          params: { ...outcome.params, key },
          request,
        });
      case "failed":
        return failedResponse(outcome, request, "Admin config reset failed");
    }
  } catch (error) {
    return internalError(error, { request, context: "Admin config reset failed" });
  }
}
