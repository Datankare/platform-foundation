/**
 * POST /api/admin/config-ai/execute — Direct config tool execution
 *
 * Executes a specific config agent tool by ID. Used by the admin UI
 * for direct tool invocations (search, get, update, history, impact,
 * approval workflow).
 *
 * Permission routing:
 *   - Read tools (search, get, history, compare, impact, bulk_review):
 *     config_view (all admins)
 *   - Write tools (update, request_approval): the target key's tier permission —
 *     config_manage_standard, or config_manage_safety for a safety-tier or unknown key
 *   - Approval tools (approve, reject):
 *     config_manage_safety (super_admin only)
 *
 * Phase 4, Sprint 3a
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { holds } from "@/platform/auth/role-governance";
import { tierPermission } from "@/platform/admin/governed-config";
import { logger, generateRequestId } from "@/lib/logger";
import {
  CONFIG_VALUE_SCHEMA,
  inputKeyRefusal,
  mergeInputSchemas,
  withOpenAs,
  type InputSchemaNode,
} from "@/platform/admin/input-keys";
import {
  CONFIG_SERVER_SET_INPUTS,
  CONFIG_TOOLS,
  configFailure,
  dispatchConfigTool,
} from "@/platform/admin/config-handlers";
import { getPermissionTier } from "@/platform/auth/platform-config";
import type { ToolExecutionContext } from "@/platform/admin/types";
import { generateId } from "@/platform/agents/utils";
import { apiError, apiErrorBody, readJsonBody } from "@/platform/errors";
import { ERROR_CODES } from "@/platform/errors/registry";
import { getApproval } from "@/platform/admin/config-approval";
import { requiredPermissionForKey } from "@/platform/admin/pending-approvals";
import { tenantRoute } from "@/platform/tenancy/route";
import { isOperator } from "@/platform/admin/config-scope";
import { configToolTargetKey } from "@/platform/admin/hold-keys";

// ---------------------------------------------------------------------------
// Permission routing
// ---------------------------------------------------------------------------

/** Tools that only require read access */
const READ_TOOLS = new Set([
  "search_config",
  "get_config",
  "get_history",
  "compare_to_defaults",
  "impact_report",
  "bulk_review",
]);

/** Tools that require write access (standard or safety tier) */
const WRITE_TOOLS = new Set(["update_config", "reset_config", "request_approval"]);

/** Tools that require safety-tier access (super_admin) */
const APPROVAL_TOOLS = new Set(["approve_change", "reject_change"]);

/**
 * Determine the required permission for a tool + config key combination.
 */
function getRequiredPermission(toolId: string, _configKey?: string): string {
  if (READ_TOOLS.has(toolId)) {
    return "config_view";
  }
  if (APPROVAL_TOOLS.has(toolId)) {
    // Entry only: the approval's own key decides the permission (its tier), checked below with
    // the record in hand — as the approvals route does (release review, Sprint 7X).
    return "config_view";
  }
  if (WRITE_TOOLS.has(toolId)) {
    // Entry only: the key's own tier permission (config_manage_standard or
    // config_manage_safety) is checked once the key is known, below. A safety approver holds
    // config_manage_safety without config_manage_standard, and may edit safety-tier keys.
    return "config_view";
  }
  // Unknown tool — require highest permission
  return "config_manage_safety";
}

// ---------------------------------------------------------------------------
// Request type
// ---------------------------------------------------------------------------

interface ExecuteRequest {
  /** Tool ID to execute */
  toolId: string;
  /** Tool input parameters */
  input: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/** Each config tool's input schema, by its id. */
const CONFIG_TOOL_SCHEMAS = new Map(CONFIG_TOOLS.map((t) => [t.id, t.inputSchema]));

/**
 * The body this route reads (TASK-203, N-31): a tool and its input — the input naming only keys
 * some config tool's schema names, a setting's value read as a configuration value
 * (CONFIG_VALUE_SCHEMA); a key no tool names is refused here, before anything else. The named
 * tool's own keys are checked exactly below, after the permission checks (a caller who may not
 * act is told so first — C-1), and the keys the server sets for it are refused here (below).
 */
const EXECUTE_BODY_SCHEMA: InputSchemaNode = {
  type: "object",
  properties: {
    toolId: { type: "string" },
    input: mergeInputSchemas(
      CONFIG_TOOLS.map((t) =>
        withOpenAs(t.inputSchema as InputSchemaNode, CONFIG_VALUE_SCHEMA)
      )
    ),
  },
};

/**
 * The keys of the tool's input the server sets (CONFIG_SERVER_SET_INPUTS: the operator flags,
 * heldPrevious, expectPrevious), never a caller: refused `request.field_not_accepted` (round 12).
 */
function serverSetPaths(body: Readonly<Record<string, unknown>>): string[] {
  return typeof body.toolId === "string" &&
    Object.prototype.hasOwnProperty.call(CONFIG_SERVER_SET_INPUTS, body.toolId)
    ? Object.keys(CONFIG_SERVER_SET_INPUTS[body.toolId] ?? {}).map((k) => `input.${k}`)
    : [];
}

export const POST = tenantRoute(async function POST(request: NextRequest) {
  const requestId = generateRequestId();

  // Verified (and rate limited) before the body is read: every config tool needs at least
  // config_view, and nothing about the request is looked at for an unverified caller (audit I-2).
  const guard = await requireAdmin(request, "config_view");
  if (guard.error) return guard.error;
  const { admin } = guard;
  const actorId = admin.userId;

  const read = await readJsonBody(request, EXECUTE_BODY_SCHEMA, {
    notAccepted: serverSetPaths,
  });
  if (!read.ok) return read.response;
  const raw = read.body;
  if (typeof raw.toolId !== "string" || !raw.toolId) {
    return apiError("request.missing_fields", {
      params: { fields: ["toolId"] },
      request,
    });
  }
  if (
    raw.input !== undefined &&
    (typeof raw.input !== "object" || raw.input === null || Array.isArray(raw.input))
  ) {
    return apiError("request.invalid_body", { request });
  }
  const body: ExecuteRequest = {
    toolId: raw.toolId,
    input: (raw.input as Record<string, unknown> | undefined) ?? {},
  };

  // The tool's own permission, beyond config_view.
  const basePermission = getRequiredPermission(body.toolId);
  if (!holds(admin, basePermission)) {
    return apiError("auth.permission_denied", {
      params: { permission: basePermission },
      request,
    });
  }

  try {
    // A write needs the tier permission of the key it acts on — read from the field that tool
    // acts on (configToolTargetKey: update_config and reset_config `key`, request_approval
    // `configKey`), the same function the handlers and holds use (TASK-194, audit C-1: this read
    // `key` first, so a request_approval naming a standard `key` and a safety `configKey` was
    // checked against the standard key and filed for the safety one). A write naming no key is
    // held to the safety tier (fail closed).
    if (WRITE_TOOLS.has(body.toolId)) {
      const key = configToolTargetKey(body.toolId, body.input ?? {});
      const needed = key
        ? tierPermission(await getPermissionTier(key))
        : "config_manage_safety";
      if (!holds(admin, needed)) {
        return apiError("auth.permission_denied", {
          params: { permission: needed },
          request,
        });
      }
    }

    // An approval decision needs the permission of the key it concerns; a missing or unknown
    // approval is held to the safety tier (fail closed).
    if (APPROVAL_TOOLS.has(body.toolId)) {
      const approvalId = body.input.approvalId;
      const record =
        typeof approvalId === "string" ? await getApproval(approvalId) : null;
      const needed = await requiredPermissionForKey(record?.configKey);
      if (!holds(admin, needed)) {
        return apiError("auth.permission_denied", {
          params: { permission: needed },
          request,
        });
      }
    }

    // Only the tool's own input keys, at every depth (round 10, I-A; round 11, item 3): a held
    // change records its input as its hold's payload and its proposal step's input, and free text
    // under a key no schema names would pass the erasure's register of free-text keys. Refused,
    // coded — never dropped silently. After the permission checks (a caller who may not act is
    // told so, not shown the tool's keys). The body's read (EXECUTE_BODY_SCHEMA) already refused
    // a key no config tool names, and the keys the route and dispatchConfigTool set — the operator
    // flags, heldPrevious, expectPrevious (CONFIG_SERVER_SET_INPUTS), the server's:
    // `request.field_not_accepted` (round 12, nit 1). actorId and reviewerId are the schema's, and
    // overwritten below.
    const refused = inputKeyRefusal(
      CONFIG_TOOL_SCHEMAS.get(body.toolId) as InputSchemaNode | undefined,
      body.input,
      new Set(Object.keys(CONFIG_SERVER_SET_INPUTS[body.toolId] ?? {}))
    );
    if (refused !== null) {
      return apiError(refused.code, { params: { ...refused.params }, request });
    }

    // SECURITY INVARIANT (S2): Inject actorId/reviewerId from the
    // authenticated session, overwriting any values the frontend sent.
    // This prevents a compromised frontend from spoofing a different
    // reviewer to bypass the self-approval check in config-approval.ts.
    // Do NOT remove this overwrite or allow frontend-supplied actor IDs.
    const enrichedInput = { ...body.input };
    if (WRITE_TOOLS.has(body.toolId) || APPROVAL_TOOLS.has(body.toolId)) {
      enrichedInput.actorId = actorId;
      enrichedInput.reviewerId = actorId;
      // ADR-053 D5: operator standing comes from the verified admin, never the caller.
      enrichedInput.actorIsOperator = isOperator(admin);
      enrichedInput.reviewerIsOperator = isOperator(admin);
    }

    // P3/P15/P18: Create trajectory context for this request
    const trajectoryContext: ToolExecutionContext = {
      trajectoryId: `traj-${Date.now().toString(36)}-${generateId()}`,
      agentId: `config-manager-${Date.now().toString(36)}`,
      onBehalfOf: actorId,
      steps: [],
    };

    // Execute the tool with trajectory recording
    const result = await dispatchConfigTool(
      body.toolId,
      enrichedInput,
      trajectoryContext
    );

    logger.info("Config tool executed", {
      requestId,
      route: "/api/admin/config-ai/execute",
      toolId: body.toolId,
      actorId,
      success: result.success,
      durationMs: result.durationMs,
      trajectoryId: trajectoryContext.trajectoryId,
    });

    // A7: For mutation tools, check business outcome (data.applied) for HTTP status
    // success:true = tool ran without throwing. data.applied = business operation succeeded.
    let status = result.success ? 200 : 422;
    const data = result.data as Record<string, unknown> | null;
    if (result.success && data && data.applied === false && !data.pendingConfirmation) {
      status = 422; // Business operation failed (validation error, key not found, etc.)
    }
    // A request or a review that did not go through (request_approval, approve_change,
    // reject_change answer `success: false` in their data): refused too — it answered 200
    // (round 13, I-C).
    if (result.success && data && data.success === false) status = 422;
    // Accepted, not applied, waiting on another admin — 202, as the users, entitlements and gdpr
    // routes answer a hold and the command bar a plan that stopped at one (TASK-194 round 11,
    // item 1): a dual-controlled change held as a runtime proposal (`held`), and — round 12, I-1 —
    // a change filed for two-person approval (a config approval: `requiresApproval`, filed
    // without an `approvalError`). A filing that failed stays 422.
    const pendingApproval =
      result.success &&
      data !== null &&
      data.requiresApproval === true &&
      !data.approvalError;
    if ((result as { held?: unknown }).held === true || pendingApproval) status = 202;

    // A refusal answers its registry code, params and message (round 13, I-C), at the code's own
    // status (round 14, item 4: it was 422 for every one — a change already waiting is 409, the
    // audit log unavailable 503). Its text — the error, an approval's or an apply's, the entry's
    // English reasons — is never returned (round 14, item 12); configFailure logs it when no code
    // says why (an admin.action_failed). Nor is a refused filing's `requiresApproval` or
    // `approval` (round 15, I-2): it filed nothing, and a reader must never take it as pending.
    if (status === 422) {
      const f = configFailure(result);
      const body = apiErrorBody(f.code, { params: f.params, request });
      const data =
        result.data && typeof result.data === "object"
          ? (() => {
              const {
                error: _e,
                approvalError: _a,
                applyError: _p,
                validationErrors: _v,
                requiresApproval: _r,
                approval: _ap,
                ...rest
              } = result.data as Record<string, unknown>;
              void [_e, _a, _p, _v, _r, _ap];
              return rest;
            })()
          : result.data;
      return NextResponse.json(
        {
          toolId: result.toolId,
          data,
          durationMs: result.durationMs,
          ...body,
          trajectoryId: trajectoryContext.trajectoryId,
          agentId: trajectoryContext.agentId,
          steps: trajectoryContext.steps,
        },
        { status: ERROR_CODES[f.code].status }
      );
    }
    return NextResponse.json(
      {
        ...result,
        trajectoryId: trajectoryContext.trajectoryId,
        agentId: trajectoryContext.agentId,
        steps: trajectoryContext.steps,
      },
      { status }
    );
  } catch (error) {
    logger.error("Config tool execution failed", {
      requestId,
      route: "/api/admin/config-ai/execute",
      error: error instanceof Error ? error.message : "Unknown",
    });
    return apiError("internal.error", { request });
  }
});
