/**
 * app/api/operator/jobs/effects/[id]/route.ts — an operator's decision on an external call whose
 * outcome is unknown (operators only; TASK-215, audit B-12; ADR-031 D7)
 *
 * POST { outcome: "took_effect" | "no_effect" }
 *   took_effect   the ledger entry becomes confirmed
 *   no_effect     the ledger entry becomes failed
 * Only an indeterminate entry changes; recorded in the audit log before it does
 * (platform/agents/effect-settlement.ts). 404 effects.not_found, 409 effects.not_indeterminate,
 * 503 service.unavailable (the audit log could not be written: nothing changed).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import {
  apiError,
  internalError,
  readJsonBody,
  type InputSchemaNode,
} from "@/platform/errors";
import { resolveIndeterminateEffect } from "@/platform/agents/effect-settlement";
import { tenantRoute } from "@/platform/tenancy/route";
import type { ResponseSchema } from "@/platform/errors/response-schema";

/** The body this route reads: read against its schema — any other key refused. */
const OUTCOME_BODY_SCHEMA: InputSchemaNode = {
  type: "object",
  properties: {
    outcome: { type: "string" },
  },
};

type Params = { params: Promise<{ id: string }> };

const POST_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    id: {
      type: "string",
    },
    status: {
      type: "string",
    },
  },
};

export const POST = tenantRoute(async function POST(
  request: NextRequest,
  { params }: Params
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { id } = await params;
  const read = await readJsonBody(request, OUTCOME_BODY_SCHEMA);
  if (!read.ok) return read.response;
  const { outcome } = read.body as Record<string, unknown>;
  if (outcome !== "took_effect" && outcome !== "no_effect") {
    return apiError("request.invalid_value", {
      params: { field: "outcome", allowed: ["took_effect", "no_effect"] },
      request,
    });
  }
  try {
    const r = await resolveIndeterminateEffect(guard.admin, id, outcome);
    if (!r.ok)
      return r.code === "audit.unavailable"
        ? apiError("service.unavailable", { params: { service: "audit" }, request })
        : apiError(r.code, { request });
    return NextResponse.json({ id, status: r.status });
  } catch (error) {
    return internalError(error, {
      request,
      context: "Resolving an external call failed",
    });
  }
}, POST_RESPONSE);
