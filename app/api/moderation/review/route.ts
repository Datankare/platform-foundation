/**
 * app/api/moderation/review/route.ts — Human review queue (list + submit)
 *
 * GET  — list/filter the review queue, or queue statistics with ?view=stats
 * POST — manually submit an item for review (escalation or ban_review)
 *
 * ADR-024. RBAC (F6): every handler is gated on "can_moderate" — admin /
 * moderator only. P10: this is a human-oversight surface. P11: failures return
 * structured JSON errors rather than throwing.
 *
 * Appeals are NOT submitted here — they have their own endpoint
 * (/api/moderation/appeals) which enforces appeal eligibility + identity.
 *
 * GET pages the queue for the review screen (TASK-221): `offset` and `limit` (at most 200, 25 by
 * default), and `hasMore`. A queue that cannot be read is refused as unavailable — never an empty
 * list. Each item names its people by address (`target`, `claimer`, `resolver`: null once
 * erased or unknown; SF-admin-140, 141), says whether the viewer holds its claim
 * (`claimedByViewer`), and an escalation still open says when the escalation reaper acts on it
 * (`dueAt`: its creation plus the SLA, ADR-041; SF-admin-146).
 *
 * A submission names its submitter (TASK-194, audit C-9): POST verifies the moderator with
 * requireAdmin — adminGuard threw the identity away — and records the submission (who, which
 * account, which source) before it is filed; with no record it is not filed.
 */

import { isShownText } from "@/platform/errors/shown-text";
import { CATALOGS, DEFAULT_LOCALE, lookup } from "@/platform/errors/messages";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { auditedResponse } from "@/platform/auth/audit";
import { logger, generateRequestId } from "@/lib/logger";
import {
  getQueuePage,
  getQueueStats,
  submitForReview,
} from "@/platform/moderation/review-service";
import { loadEscalationSlaHours } from "@/platform/moderation/config";
import { namedAccounts, type NamedAccount } from "@/platform/admin/account-names";
import { sameId } from "@/platform/auth/same-id";
import type {
  ReviewItemSource,
  ReviewQueryOptions,
} from "@/platform/moderation/review-types";
import type { ModerationResult } from "@/platform/moderation/types";
import type { ExplanationChain } from "@/platform/rag/types";
import {
  apiError,
  errorFromResult,
  readJsonBody,
  type InputSchemaNode,
} from "@/platform/errors";
import { tenantRoute } from "@/platform/tenancy/route";
import { type ResponseSchema, SHOWN, stored } from "@/platform/errors/response-schema";

const MODERATE_PERMISSION = "can_moderate";
/** Most queue items one list request returns. */
const MAX_LIST = 200;
/** Items one page holds when the request names no limit. */
const PAGE_DEFAULT = 25;

/** A person a queue item names, by address — never an id (N-63). */
function shownAccount(found: NamedAccount | undefined) {
  return found ? { email: found.email, role: found.role, erased: found.erased } : null;
}

/** Sources an admin may submit manually here. Appeals use the appeals route. */
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What a moderator may submit by hand. ban_review items are created only by Sentinel, which
 * records the account's real previous status; a hand-made one could name any previous status
 * and be overturned into it (audit X-2). Appeals have their own endpoint.
 */
const VALID_SUBMIT_SOURCES: readonly ReviewItemSource[] = ["escalation"];

/**
 * The fields of a moderation result the review pipeline reads. A hand-submitted result that
 * lacks them would fail later, inside the service, as an uncoded error (release review).
 */
const S: InputSchemaNode = { type: "string" };
const N: InputSchemaNode = { type: "number" };
const B: InputSchemaNode = { type: "boolean" };
const NAMES: InputSchemaNode = { type: "array", items: S };

/**
 * A moderation reason and a context factor as the pipeline records them (TASK-209): a catalog key
 * and its named values (platform/moderation/reasons.ts) — never English. Closed: only the values
 * the catalog's moderation messages name.
 */
const KEY_ONLY: InputSchemaNode = { type: "object", properties: { key: S } };
const FACTOR: InputSchemaNode = {
  type: "object",
  properties: {
    key: S,
    params: {
      type: "object",
      properties: { contentType: S, reduction: S, source: S, target: S },
    },
  },
};
const REASON: InputSchemaNode = {
  type: "object",
  properties: {
    key: S,
    params: {
      type: "object",
      properties: {
        categories: S,
        severity: S,
        confidence: S,
        from: S,
        to: S,
        contentType: S,
        reduction: S,
        threshold: S,
        level: KEY_ONLY,
        factors: { type: "array", items: FACTOR },
      },
    },
  },
};
const CLASSIFIER_NOTE: InputSchemaNode = {
  type: "object",
  properties: {
    key: S,
    params: {
      type: "object",
      properties: { problems: { type: "array", items: KEY_ONLY }, action: S, matches: S },
    },
  },
};

/**
 * The body this route reads (TASK-203, N-31): an item for the queue — a moderation result as the
 * pipeline makes one (ModerationResult, its classifier output included) and, optionally, its
 * explanation chain. Any other key, at any depth, is refused. An explanation step's `data` takes
 * no key here: the pipeline enqueues its own items in process (review-service); a caller of the
 * route sends the chain's catalog keys (its description and conclusion, TASK-209), never data of
 * its own shape. A reason, a factor and a classifier's note are catalog keys and their values;
 * the classifier model's own words are not kept anywhere (TASK-215, audit A-5): `rawReason` is
 * refused like any undeclared key.
 */
const ENQUEUE_BODY_SCHEMA: InputSchemaNode = {
  type: "object",
  properties: {
    source: S,
    targetUserId: S,
    moderationResult: {
      type: "object",
      properties: {
        action: S,
        triggeredBy: S,
        direction: S,
        contentType: S,
        contentRatingLevel: N,
        blocklistMatches: NAMES,
        classifierOutput: {
          type: "object",
          properties: {
            safe: B,
            categories: NAMES,
            confidence: N,
            severity: S,
            note: CLASSIFIER_NOTE,
            unjudged: B,
          },
        },
        reasoning: { type: "array", items: REASON },
        severityAdjustment: N,
        contextFactors: { type: "array", items: FACTOR },
        attributeToUser: B,
        pipelineLatencyMs: N,
        classifierCostUsd: N,
        trajectoryId: S,
        agentId: S,
        screeningUnavailable: B,
        unjudgedReason: S,
      },
    },
    explanationChain: {
      type: "object",
      properties: {
        id: S,
        requestId: S,
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              phase: S,
              description: KEY_ONLY,
              data: { type: "object", properties: {} },
              durationMs: N,
            },
          },
        },
        conclusion: KEY_ONLY,
        createdAt: S,
      },
    },
  },
};

/** A list of catalog keys under `prefix`, each one the catalog has (its values its own). */
function isCatalogList(value: unknown, prefix: string): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (v) =>
        isShownText(v) &&
        v.key.startsWith(prefix) &&
        lookup(CATALOGS[DEFAULT_LOCALE], v.key) !== undefined
    )
  );
}

function isModerationResultShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.action === "string" &&
    ["allow", "warn", "block", "escalate"].includes(m.action) &&
    // Reasons and factors as the pipeline records them: keys the catalog has (TASK-209).
    isCatalogList(m.reasoning, "screens.moderation.reasons.") &&
    typeof m.trajectoryId === "string" &&
    isCatalogList(m.contextFactors, "screens.moderation.factors.") &&
    Array.isArray(m.blocklistMatches)
  );
}

/** Translate query-string params into ReviewQueryOptions (only present keys). */
function buildQueryOptions(params: URLSearchParams): ReviewQueryOptions {
  const options: {
    status?: ReviewQueryOptions["status"];
    source?: ReviewQueryOptions["source"];
    priority?: ReviewQueryOptions["priority"];
    targetUserId?: string;
    claimedBy?: string;
    since?: string;
    before?: string;
    limit?: number;
    offset?: number;
  } = {};

  const status = params.get("status");
  if (status) options.status = status as ReviewQueryOptions["status"];
  const source = params.get("source");
  if (source) options.source = source as ReviewQueryOptions["source"];
  const priority = params.get("priority");
  if (priority) options.priority = priority as ReviewQueryOptions["priority"];
  const targetUserId = params.get("targetUserId");
  if (targetUserId) options.targetUserId = targetUserId;
  const claimedBy = params.get("claimedBy");
  if (claimedBy) options.claimedBy = claimedBy;
  const since = params.get("since");
  if (since) options.since = since;
  const before = params.get("before");
  if (before) options.before = before;
  const limit = params.get("limit");
  if (limit) {
    const n = Number.parseInt(limit, 10);
    if (Number.isFinite(n) && n > 0) options.limit = Math.min(n, MAX_LIST);
  }
  const offset = params.get("offset");
  if (offset) {
    const n = Number.parseInt(offset, 10);
    if (Number.isFinite(n) && n > 0) options.offset = n;
  }

  return options;
}

/** A person an item names (shownAccount): their address, role, and whether erased. */
const PERSON: ResponseSchema = {
  type: ["null", "object"],
  properties: {
    email: { type: ["null", "string"] },
    role: { type: ["null", "string"] },
    erased: { type: "boolean" },
  },
};

const GET_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          target: PERSON,
          claimer: PERSON,
          resolver: PERSON,
          claimedByViewer: { type: "boolean" },
          dueAt: { type: "string" },
          appealReason: {
            type: "string",
          },
          claimedAt: {
            type: "string",
          },
          claimedBy: {
            type: "string",
          },
          createdAt: {
            type: "string",
          },
          decision: {
            type: "string",
          },
          explanationChain: stored(
            "a moderation decision's stored explanation chain: each phase and the platform's notes as catalogue keys"
          ),
          id: {
            type: "string",
          },
          moderationResult: stored(
            "a moderation decision's stored record (review_queue.moderation_result): its action, categories and the platform's notes as catalogue keys"
          ),
          modifiedAction: {
            type: "string",
          },
          notesShown: SHOWN,
          originalDecisionId: {
            type: "string",
          },
          previousAccountStatus: {
            type: "string",
          },
          priority: {
            type: "string",
          },
          relatedStrikeId: {
            type: "string",
          },
          requestId: {
            type: "string",
          },
          resolvedAt: {
            type: "string",
          },
          resolvedBy: {
            type: "string",
          },
          reviewerNotes: {
            type: "string",
          },
          source: {
            type: "string",
          },
          status: {
            type: "string",
          },
          targetUserId: {
            type: "string",
          },
          updatedAt: {
            type: "string",
          },
        },
      },
    },
    hasMore: { type: "boolean" },
    stats: {
      type: "object",
      properties: {
        avgResolutionMs: {
          type: "number",
        },
        claimedCount: {
          type: "number",
        },
        pendingByPriority: {
          type: "object",
          values: {
            type: "number",
          },
        },
        pendingBySource: {
          type: "object",
          values: {
            type: "number",
          },
        },
        pendingCount: {
          type: "number",
        },
        resolvedCount: {
          type: "number",
        },
      },
    },
  },
};

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const guard = await requireAdmin(request, MODERATE_PERMISSION);
  if (guard.error) return guard.error;

  const requestId = generateRequestId();

  try {
    if (request.nextUrl.searchParams.get("view") === "stats") {
      const stats = await getQueueStats();
      return NextResponse.json({ stats });
    }

    // User filters are ids: anything else is refused, not sent to the database (where a
    // non-UUID against a uuid column is an error, not "no match").
    for (const field of ["targetUserId", "claimedBy"] as const) {
      const v = request.nextUrl.searchParams.get(field);
      if (v && !USER_ID.test(v)) {
        return apiError("request.invalid_value", {
          params: { field, allowed: ["user_id"], expected: "user_id" },
          request,
        });
      }
    }
    const options = buildQueryOptions(request.nextUrl.searchParams);
    const page = await getQueuePage({ ...options, limit: options.limit ?? PAGE_DEFAULT });
    // Every person the page names, in one read (N-63).
    const accounts = await namedAccounts(
      page.items.flatMap((i) => [i.targetUserId, i.claimedBy, i.resolvedBy])
    );
    const open = page.items.some(
      (i) => i.source === "escalation" && i.status !== "resolved"
    );
    const slaHours = open ? await loadEscalationSlaHours() : null;
    const items = page.items.map((i) => ({
      ...i,
      target: shownAccount(accounts.get(i.targetUserId)),
      claimer: i.claimedBy ? shownAccount(accounts.get(i.claimedBy)) : null,
      resolver: i.resolvedBy ? shownAccount(accounts.get(i.resolvedBy)) : null,
      claimedByViewer: sameId(i.claimedBy, guard.admin.userId),
      ...(slaHours !== null && i.source === "escalation" && i.status !== "resolved"
        ? {
            dueAt: new Date(Date.parse(i.createdAt) + slaHours * 3_600_000).toISOString(),
          }
        : {}),
    }));
    return NextResponse.json({ items, hasMore: page.hasMore });
  } catch (err) {
    logger.error("Review queue list error", {
      error: err instanceof Error ? err.message : "Unknown",
      requestId,
      route: "api/moderation/review",
    });
    // The queue could not be read: said so — never an empty list (TASK-221).
    return apiError("service.unavailable", {
      params: { service: "review_queue" },
      request,
    });
  }
}, GET_RESPONSE);

const POST_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    item: {
      type: "object",
      properties: {
        appealReason: {
          type: "string",
        },
        claimedAt: {
          type: "string",
        },
        claimedBy: {
          type: "string",
        },
        createdAt: {
          type: "string",
        },
        decision: {
          type: "string",
        },
        explanationChain: stored(
          "a moderation decision's stored explanation chain: each phase and the platform's notes as catalogue keys"
        ),
        id: {
          type: "string",
        },
        moderationResult: stored(
          "a moderation decision's stored record (review_queue.moderation_result): its action, categories and the platform's notes as catalogue keys"
        ),
        modifiedAction: {
          type: "string",
        },
        notesShown: SHOWN,
        originalDecisionId: {
          type: "string",
        },
        previousAccountStatus: {
          type: "string",
        },
        priority: {
          type: "string",
        },
        relatedStrikeId: {
          type: "string",
        },
        requestId: {
          type: "string",
        },
        resolvedAt: {
          type: "string",
        },
        resolvedBy: {
          type: "string",
        },
        reviewerNotes: {
          type: "string",
        },
        source: {
          type: "string",
        },
        status: {
          type: "string",
        },
        targetUserId: {
          type: "string",
        },
        updatedAt: {
          type: "string",
        },
      },
    },
  },
};

export const POST = tenantRoute(async function POST(request: NextRequest) {
  const guard = await requireAdmin(request, MODERATE_PERMISSION);
  if (guard.error) return guard.error;
  const { admin } = guard;

  const requestId = generateRequestId();

  // An account's standing before a case is the server's to record, never a caller's.
  const read = await readJsonBody(request, ENQUEUE_BODY_SCHEMA, {
    notAccepted: ["previousAccountStatus"],
  });
  if (!read.ok) return read.response;
  const body = read.body as {
    source?: ReviewItemSource;
    moderationResult?: unknown;
    targetUserId?: string;
    explanationChain?: unknown;
  };

  const { source, moderationResult, targetUserId } = body;

  if (!source || !moderationResult || !targetUserId) {
    return apiError("request.missing_fields", {
      params: { fields: ["source", "moderationResult", "targetUserId"] },
      request,
    });
  }
  if (typeof targetUserId !== "string" || !USER_ID.test(targetUserId)) {
    return apiError("request.invalid_value", {
      params: { field: "targetUserId", allowed: ["user_id"], expected: "user_id" },
      request,
    });
  }
  if (!isModerationResultShape(moderationResult)) {
    return apiError("request.invalid_body", { request });
  }
  if (!VALID_SUBMIT_SOURCES.includes(source)) {
    return apiError("request.invalid_value", {
      params: { field: "source", allowed: [...VALID_SUBMIT_SOURCES] },
      request,
    });
  }

  try {
    // Recorded before it is filed, naming the moderator who filed it (audit C-9).
    return await auditedResponse(
      {
        action: "admin_action",
        actorId: admin.userId,
        targetId: targetUserId,
        details: { type: "review_submitted", source, requestId },
      },
      async () => {
        const result = await submitForReview({
          source,
          moderationResult: moderationResult as ModerationResult,
          targetUserId,
          requestId,
          explanationChain: body.explanationChain as ExplanationChain | undefined,
        });
        if (!result.success) {
          logger.error("Review queue submit failed", {
            error: result.error,
            requestId,
            route: "api/moderation/review",
          });
          return {
            success: false,
            error: result.error ?? "admin.action_failed",
            response: errorFromResult(result, {
              request,
              context: "Review queue submit failed",
            }),
          };
        }
        return {
          success: true,
          response: NextResponse.json({ item: result.item }, { status: 201 }),
        };
      },
      () => apiError("service.unavailable", { params: { service: "audit" }, request })
    );
  } catch (err) {
    logger.error("Review queue submit error", {
      error: err instanceof Error ? err.message : "Unknown",
      requestId,
      route: "api/moderation/review",
    });
    return apiError("internal.error", { params: { requestId }, request });
  }
}, POST_RESPONSE);
