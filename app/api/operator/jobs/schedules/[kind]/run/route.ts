/**
 * app/api/operator/jobs/schedules/[kind]/run/route.ts — run a recurring job now
 * (operators only, ADR-056 D3)
 *
 * POST → { result: { enqueued, report } }
 *   Recorded first; then the kind is enqueued for every active tenant (or the platform) and
 *   what fits in a short budget runs inside this request. The rest runs on the next tick.
 *   Its schedule is not moved.
 *
 * A JSON body may say why: { reason } (TASK-221, SF-admin-100 — the console asks it for a job that
 * removes records), recorded with the run. Sent with no body, the run is recorded without one.
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import {
  apiError,
  internalError,
  readJsonBody,
  type InputSchemaNode,
} from "@/platform/errors";
import { runNow } from "@/platform/jobs/operator";
import { jobsResponse } from "@/platform/jobs/operator-http";
import { tenantRoute } from "@/platform/tenancy/route";
import type { ResponseSchema } from "@/platform/errors/response-schema";

/** Long enough for RUN_NOW_BUDGET_MS and the answer. */
export const maxDuration = 60;

type Params = { params: Promise<{ kind: string }> };

/** The body this route reads, when it has one: why the job is run now. */
const RUN_BODY_SCHEMA: InputSchemaNode = {
  type: "object",
  properties: { reason: { type: "string" } },
};

/** The most characters a reason keeps (the console's own limit, REASON_MAX). */
const REASON_MAX = 500;

const POST_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    result: {
      type: "object",
      properties: {
        enqueued: {
          type: "number",
        },
        report: {
          type: "object",
          properties: {
            claimed: {
              type: "number",
            },
            continued: {
              type: "number",
            },
            dead: {
              type: "number",
            },
            durationMs: {
              type: "number",
            },
            hung: {
              type: "number",
            },
            lostLease: {
              type: "number",
            },
            released: {
              type: "number",
            },
            retried: {
              type: "number",
            },
            scheduleErrors: {
              type: "number",
            },
            scheduled: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  enqueued: {
                    type: "number",
                  },
                  kind: {
                    type: "string",
                  },
                },
              },
            },
            skipped: {
              type: "number",
            },
            stoppedBy: {
              type: "string",
            },
            succeeded: {
              type: "number",
            },
            workerId: {
              type: "string",
            },
          },
        },
      },
    },
  },
};

export const POST = tenantRoute(async function POST(
  request: NextRequest,
  { params }: Params
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { kind } = await params;
  let reason: string | undefined;
  // A body is optional: sent with none (or an empty one), the run is recorded without a reason.
  const text = await request.text().catch(() => "");
  if (text.trim() !== "") {
    const read = await readJsonBody(
      { headers: request.headers, json: async () => JSON.parse(text) as unknown },
      RUN_BODY_SCHEMA
    );
    if (!read.ok) return read.response;
    const given = read.body.reason;
    if (given !== undefined && (typeof given !== "string" || given.length > REASON_MAX)) {
      return apiError("request.invalid_value", {
        params: {
          field: "reason",
          allowed: ["text_max"],
          expected: "text_max",
          max: REASON_MAX,
        },
        request,
      });
    }
    reason = typeof given === "string" && given.trim() !== "" ? given.trim() : undefined;
  }
  try {
    return jobsResponse(await runNow(guard.admin, kind, reason), request);
  } catch (error) {
    return internalError(error, { request, context: "Run now failed" });
  }
}, POST_RESPONSE);
