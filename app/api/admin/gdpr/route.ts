/**
 * Admin GDPR Hard Purge — API Route
 *
 * GenAI Principles satisfied:
 *   P3 — Input screened via admin auth + permission guard
 *   P8 — Eventually accessible via admin command bar (NL admin)
 *   P9 — Trace context propagated, operation fully observable
 *
 * POST /api/admin/gdpr/purge
 *   Body: { userId: string, reason: string, dryRun?: boolean }
 *   Requires: admin_purge_user_data (super_admin only, migration 041)
 *   Erases the account and every platform table that holds its data (platform/auth/user-data.ts,
 *   through createPlatformPurgePipeline); a dry run counts the rows. A purge that does not
 *   complete answers with its steps and is recorded as failed (audit X-15).
 *   Returns: a dry run's PurgeResult at once; an erasure is held (202 { held, proposalId }) for a
 *   second admin who holds admin_purge_user_data — not the requester, not the account erased — to
 *   approve in Approvals, and then runs once as its requester (TASK-194, audit C-6: one admin
 *   could erase any non-super_admin account irreversibly, while a reversible role change was
 *   dual-controlled). The rules and the run are the governed action purge_user_data
 *   (app/api/admin/ai/handlers/purge.ts), always held (command-bar.ts ALWAYS_HELD_ACTIONS).
 *   Tenancy: the target must be a user of the request's tenant (ADR-053 D5) — a soft-deleted one
 *   included, since erasing a deleted account is the common case — or the route answers 404
 *   admin.target_not_found before any purge step runs, whatever each purge handler would scope
 *   itself to. The protected-role check reads it in the same tenant transaction.
 *   Round 1 (TASK-194, A1/A6): the request is recorded when it is made (admin_action
 *   `gdpr_purge_requested`, before the hold; no record, no hold — 503), and an account has at
 *   most one open erasure hold: a second request answers 409 admin.erasure_pending — checked
 *   here, and kept by the database for two requests made at once (061's partial unique index
 *   proposals_purge_one_open, round 2).
 *
 * GET /api/admin/gdpr?userId=<id>
 *   Requires: admin_purge_user_data. `{ pending: { proposalId, createdAt } | null }` — the open
 *   erasure hold on the account, so the Users screen says "erasure pending approval" after a
 *   reload (A6); a hold whose period ran out is not pending (rebase I-3).
 *   Rebase I-3: the open hold is the one the index counts (openErasureHold); a lapsed one
 *   (holdLapsed) is withdrawn by the system — recorded, as a decision on it would — and the new
 *   request held.
 *
 * @module app/api/admin/gdpr
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { logger } from "@/lib/logger";
import {
  apiError,
  internalError,
  readJsonBody,
  type InputSchemaNode,
  isErrorCode,
} from "@/platform/errors";
import { tenantRoute } from "@/platform/tenancy/route";
import { withTrajectory } from "@/platform/agents/trajectory-closure";
import {
  COMMAND_BAR_ACTOR_ID,
  isErasureHoldConflict,
  openErasureHold,
  runCommandBarAction,
} from "@/app/api/admin/ai/command-bar";
import { AuditWriteError, recordAudit } from "@/platform/auth/audit";
import { withdrawLapsedHold } from "@/platform/admin/lapsed-hold";
import { approvalExpiryDays } from "@/platform/admin/hold-expiry";
import {
  checkPurgeUserData,
  handlePurgeUserData,
  PURGE_REASONS,
} from "@/app/api/admin/ai/handlers/purge";
import type { ActionResult } from "@/app/api/admin/ai/handlers";
import { withTenantTx } from "@/platform/data";
import { raiseAlert } from "@/platform/observability/alert";

/** The body this route reads (TASK-203, N-31): read against its schema — any other key refused. */
const ERASURE_BODY_SCHEMA: InputSchemaNode = {
  type: "object",
  properties: {
    userId: { type: "string" },
    reason: { type: "string" },
    dryRun: { type: "boolean" },
  },
};

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a purge answered with its PurgeResult: it ran — completed, or not completed
 * (admin.purge_incomplete: its steps say which failed) — rather than being refused.
 */
function hasPurgeResult(
  result: ActionResult & { purge?: unknown }
): result is ActionResult & { purge: object } {
  return (
    typeof result.purge === "object" &&
    result.purge !== null &&
    (!result.code || result.code === "admin.purge_incomplete")
  );
}

/**
 * Close a recorded request ("attempted") that was refused (N-28): its "refused" record, with the
 * code. A record that cannot be written is never swallowed — logged and alerted
 * (`gdpr.request_record_unclosed`), so an attempted request without its outcome is seen.
 */
async function closeRefusedRequest(
  admin: { readonly userId: string },
  input: { readonly userId: string; readonly reason: string },
  code: string
): Promise<void> {
  try {
    await recordAudit({
      action: "admin_action",
      actorId: admin.userId,
      targetId: input.userId,
      details: {
        type: "gdpr_purge_requested",
        purgeReason: input.reason,
        outcome: "refused",
        code,
      },
    });
  } catch (err) {
    raiseAlert({
      name: "gdpr.request_record_unclosed",
      message:
        "An erasure request was refused, but its refusal could not be recorded: the audit log shows the request attempted with no outcome.",
      tags: {
        targetId: input.userId,
        requestedBy: admin.userId,
        code,
        error: err instanceof Error ? err.name : "error",
      },
    });
  }
}

/** A refused or failed action as its coded answer. */
function refusedResponse(result: ActionResult, request: NextRequest): NextResponse {
  if (result.code && isErrorCode(result.code)) {
    return apiError(result.code, { params: result.params ?? {}, request });
  }
  return apiError("internal.error", { request });
}

export const POST = tenantRoute(async function POST(request: NextRequest) {
  // Rate limited, verified, permission and account standing checked (requireAdmin).
  const verified = await requireAdmin(request, "admin_purge_user_data");
  if (verified.error) return verified.error;
  const { admin } = verified;

  // Parse and validate input
  const read = await readJsonBody(request, ERASURE_BODY_SCHEMA);
  if (!read.ok) return read.response;
  const body = read.body as { userId?: string; reason?: string; dryRun?: boolean };

  if (!body.userId || typeof body.userId !== "string") {
    return apiError("request.missing_fields", {
      params: { fields: ["userId"] },
      request,
    });
  }
  if (!USER_ID.test(body.userId)) {
    return apiError("request.invalid_value", {
      params: { field: "userId", allowed: ["user_id"], expected: "user_id" },
      request,
    });
  }
  if (!body.reason || !(PURGE_REASONS as readonly string[]).includes(body.reason)) {
    return apiError("request.invalid_value", {
      params: { field: "reason", allowed: [...PURGE_REASONS] },
      request,
    });
  }
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    return apiError("request.invalid_value", {
      params: { field: "dryRun", allowed: ["true", "false"] },
      request,
    });
  }
  const input = {
    // One spelling of the account (round 3, L1): an upper-case id is the same account, and the
    // one-open-erasure index compares lower case.
    userId: body.userId.toLowerCase(),
    reason: body.reason,
    dryRun: body.dryRun === true,
  };

  // Not one's own account, and not a protected role's: erasing another super_admin, or oneself,
  // through the admin route is refused (release review, Sprint 7X). The target is looked up in
  // this tenant only (ADR-053 D5), deleted accounts included.
  let exists: boolean;
  try {
    const refused = await checkPurgeUserData(input, admin);
    if (refused) return refusedResponse(refused, request);
    exists = await withTenantTx(async (tx) => {
      const { rows } = await tx.query("select 1 from users where id = $1::uuid", [
        input.userId,
      ]);
      return rows.length > 0;
    });
  } catch {
    return apiError("service.unavailable", { params: { service: "roles" }, request });
  }
  if (!exists) {
    // Not this tenant's user (or no user at all): nothing is purged, anywhere.
    return apiError("admin.target_not_found", { params: { target: "user" }, request });
  }

  logger.info("GDPR purge initiated", {
    targetId: input.userId,
    requestedBy: admin.userId,
    reason: input.reason,
    dryRun: input.dryRun,
  });

  // Whether the request was recorded "attempted": from then on every way out closes it (N-28).
  let attempted = false;
  try {
    // A dry run counts and changes nothing: it answers at once, recorded as a dry run.
    if (input.dryRun) {
      const result = await handlePurgeUserData(input, admin);
      // A coded refusal (audit unavailable, no handler ran) is that answer; otherwise the
      // pipeline's result, completed or not (its status says which — one that did not complete
      // carries admin.purge_incomplete, and the Users screen reads its steps: round 3, I-3).
      if (hasPurgeResult(result)) return NextResponse.json(result.purge);
      return refusedResponse(result, request);
    }
    // One open erasure per account (A6): a second request is refused, the first one stands.
    let open: Awaited<ReturnType<typeof openErasureHold>>;
    try {
      open = await openErasureHold(input.userId);
    } catch {
      return apiError("service.unavailable", {
        params: { service: "approvals" },
        request,
      });
    }
    // A hold whose period ran out (holdLapsed: undecided, or approved and never run) no longer
    // stands: it is withdrawn by the system, recorded as a decision on it would be, and the new
    // request goes on (rebase I-3: the index, 061, still counts it until then). Any other open
    // hold refuses the request.
    if (open?.lapsed) {
      try {
        await withdrawLapsedHold({
          proposal: open.proposal,
          days: await approvalExpiryDays(),
          source: "runtime",
          foundBy: admin.userId,
        });
      } catch (err) {
        if (err instanceof AuditWriteError) {
          return apiError("service.unavailable", {
            params: { service: "audit" },
            request,
          });
        }
        return apiError("service.unavailable", {
          params: { service: "approvals" },
          request,
        });
      }
    } else if (open) {
      return apiError("admin.erasure_pending", { request });
    }
    // Recorded when it is asked for (A1), before the hold: no record, no hold.
    try {
      await recordAudit({
        action: "admin_action",
        actorId: admin.userId,
        targetId: input.userId,
        details: {
          type: "gdpr_purge_requested",
          purgeReason: input.reason,
          outcome: "attempted",
        },
      });
    } catch {
      return apiError("service.unavailable", { params: { service: "audit" }, request });
    }
    attempted = true;
    // The erasure itself is held for a second admin (always: ALWAYS_HELD_ACTIONS). Its
    // trajectory is ended with the request (TASK-193) — unless held, when the hold's decision,
    // withdrawal or expiry ends it.
    const outcome = await withTrajectory(
      {
        subject: { kind: "agent", id: COMMAND_BAR_ACTOR_ID },
        trigger: "admin-gdpr:purge_user_data",
        scopeType: "platform",
      },
      (trajectoryId) =>
        runCommandBarAction({
          tool: "purge_user_data",
          input,
          admin,
          trajectoryId,
          stepIndex: 0,
        }),
      (o) =>
        o.kind === "ran" && (o.result.success || o.result.held) ? "completed" : "failed"
    );
    if (outcome.kind === "held") {
      return NextResponse.json(
        { success: false, held: true, proposalId: outcome.proposalId },
        { status: 202 }
      );
    }
    // Ran (only were it ever unheld): its outcome, as a dry run's is shown.
    const ran = outcome.result as ActionResult & { purge?: unknown };
    if (hasPurgeResult(ran)) return NextResponse.json(ran.purge);
    // Refused before it was held — no approver (N-24), a store down: the request recorded above
    // is closed as refused, so no record claims a request still open (N-28).
    await closeRefusedRequest(admin, input, ran.code ?? "internal.error");
    return refusedResponse(ran, request);
  } catch (error) {
    // Two requests at once: the database kept one open erasure for the account (round 2, A6).
    // The request recorded above is closed as refused (round 3), so no record claims a hold.
    if (isErasureHoldConflict(error)) {
      await closeRefusedRequest(admin, input, "admin.erasure_pending");
      return apiError("admin.erasure_pending", { request });
    }
    if (attempted) await closeRefusedRequest(admin, input, "internal.error");
    return internalError(error, { request, context: "GDPR purge failed" });
  }
});

/** The open erasure hold on an account, for the Users screen (A6). */
export const GET = tenantRoute(async function GET(request: NextRequest) {
  // Rate limited, verified, permission and account standing checked (requireAdmin).
  const verified = await requireAdmin(request, "admin_purge_user_data");
  if (verified.error) return verified.error;
  const userId = (request.nextUrl.searchParams.get("userId") ?? "").toLowerCase();
  if (!USER_ID.test(userId)) {
    return apiError("request.invalid_value", {
      params: { field: "userId", allowed: ["user_id"], expected: "user_id" },
      request,
    });
  }
  try {
    // Pending as the Approvals list offers it (rebase I-3): a lapsed hold is not — the next
    // request withdraws it.
    const open = await openErasureHold(userId);
    return NextResponse.json({
      pending:
        open && !open.lapsed
          ? { proposalId: open.proposalId, createdAt: open.createdAt }
          : null,
    });
  } catch {
    return apiError("service.unavailable", { params: { service: "approvals" }, request });
  }
});
