/**
 * app/api/internal/jobs/tick/route.ts — the host's tick: run due background work (ADR-056 D2)
 *
 * Called by the host's scheduler, never by a user: Vercel Cron (vercel.json, GET with
 * `Authorization: Bearer $CRON_SECRET`), or the CLI worker on a container host
 * (scripts/jobs-worker.mjs, POST with the same header). requireJobTick admits that header and
 * nothing else (platform/jobs/tick-auth.ts); an unset CRON_SECRET refuses every tick (503).
 *
 * Each tick takes the due schedule slots and runs due jobs for at most TICK_BUDGET_MS — inside
 * the function's own limit (maxDuration), so a tick never outlives its request. What does not fit
 * runs on the next tick. Not rate limited: the secret is checked first, in constant time, and
 * the work is bounded by the budget; the limiter would also need a tenant this caller does not
 * have.
 *
 * GET | POST → 200 { result: { scheduled, claimed, succeeded, retried, dead, … } }
 */

import { NextRequest, NextResponse } from "next/server";
import { internalError } from "@/platform/errors";
import { requireJobTick } from "@/platform/jobs/tick-auth";
import { runDue } from "@/platform/jobs/runner";
import { tenantRoute } from "@/platform/tenancy/route";
import type { ResponseSchema } from "@/platform/errors/response-schema";

/** The function's limit on Vercel, in seconds (a Pro plan allows up to 300). */
export const maxDuration = 60;

/** How long one tick runs jobs: the function's limit less time to answer. */
const TICK_BUDGET_MS = 45_000;

async function tick(request: NextRequest): Promise<NextResponse> {
  try {
    const result = await runDue({ budgetMs: TICK_BUDGET_MS });
    return NextResponse.json({ result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return internalError(error, { request, context: "Job tick failed" });
  }
}

const GET_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    result: {
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
};

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const refused = requireJobTick(request);
  if (refused) return refused;
  return tick(request);
}, GET_RESPONSE);

const POST_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    result: {
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
};

export const POST = tenantRoute(async function POST(request: NextRequest) {
  const refused = requireJobTick(request);
  if (refused) return refused;
  return tick(request);
}, POST_RESPONSE);
