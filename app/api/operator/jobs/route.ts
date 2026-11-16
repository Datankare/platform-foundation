/**
 * app/api/operator/jobs/route.ts — the Jobs console's view (operators only, ADR-056 D2/D3)
 *
 * GET → { schedules: [...], deadLetters: [...], unresolvedEffects: [...] }
 *   schedules     every recurring job: what it does, who declared it, whether it runs for each
 *                 tenant or the platform, its governed enabled flag and interval (with bounds),
 *                 its last run, its last outcome and how many of its jobs are queued, running
 *                 and dead
 *   unresolvedEffects  every tenant's external calls whose outcome is unknown, oldest first — a
 *                 person marks each (./effects/[id], TASK-215, audit B-12)
 *   deadLetters   dead-lettered jobs, newest first, with the platform's own wording of why
 *
 * Each dead job and each unresolved call names its tenant by name (`tenantName`, null for the
 * platform or a tenant no longer in the directory) — the console showed the tenant's id
 * (TASK-221, SF-admin-102). Every recurring job says whether running it removes records for good
 * (`deletesData`): the console confirms such a run as one that cannot be undone.
 *
 * Read-only. Changing a schedule, running one now, replaying or discarding a dead job are the
 * routes below this one.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { internalError } from "@/platform/errors";
import { describeSchedules, listDeadLetters } from "@/platform/jobs/operator";
import { listUnresolvedEffects } from "@/platform/agents/effect-settlement";
import { tenantRoute } from "@/platform/tenancy/route";
import { getTenantDirectory } from "@/platform/tenancy/directory";
import { logger } from "@/lib/logger";
import { type ResponseSchema, SHOWN } from "@/platform/errors/response-schema";

const GET_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    deadLetters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tenantName: { type: ["null", "string"] },
          attempts: {
            type: "number",
          },
          createdAt: {
            type: "string",
          },
          finishedAt: {
            type: "string",
          },
          id: {
            type: "string",
          },
          kind: {
            type: "string",
          },
          lastError: {
            type: "string",
          },
          maxAttempts: {
            type: "number",
          },
          runAt: {
            type: "string",
          },
          source: {
            type: "string",
          },
          status: {
            type: "string",
          },
          tenantId: {
            type: "string",
          },
          updatedAt: {
            type: "string",
          },
        },
      },
    },
    schedules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          deletesData: { type: "boolean" },
          description: SHOWN,
          enabled: {
            type: "boolean",
          },
          intervalMinutes: {
            type: "number",
          },
          kind: {
            type: "string",
          },
          maxIntervalMinutes: {
            type: "number",
          },
          minIntervalMinutes: {
            type: "number",
          },
          owner: {
            type: "string",
          },
          required: {
            type: "boolean",
          },
          runsForSuspended: {
            type: "boolean",
          },
          scope: {
            type: "string",
          },
          settings: {
            type: "object",
            properties: {
              enabled: {
                type: "string",
              },
              interval: {
                type: "string",
              },
            },
          },
          state: {
            type: ["null", "object"],
            properties: {
              dead: {
                type: "number",
              },
              failing: {
                type: "number",
              },
              kind: {
                type: "string",
              },
              lastEnqueued: {
                type: "number",
              },
              lastError: {
                type: "string",
              },
              lastFinishedAt: {
                type: "string",
              },
              lastRunAt: {
                type: "string",
              },
              lastStatus: {
                type: "string",
              },
              nextRunAt: {
                type: "string",
              },
              queued: {
                type: "number",
              },
              reported: {
                type: "number",
              },
              running: {
                type: "number",
              },
            },
          },
          tenantOptOutKey: {
            type: ["null", "string"],
          },
        },
      },
    },
    unresolvedEffects: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tenantName: { type: ["null", "string"] },
          attempts: {
            type: "number",
          },
          createdAt: {
            type: "string",
          },
          effectKey: {
            type: "string",
          },
          effectType: {
            type: "string",
          },
          id: {
            type: "string",
          },
          operationId: {
            type: "string",
          },
          resolvedAt: {
            type: ["null", "string"],
          },
          status: {
            type: "string",
          },
          tenantId: {
            type: "string",
          },
        },
      },
    },
  },
};

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  try {
    const [schedules, deadLetters, unresolvedEffects] = await Promise.all([
      describeSchedules(),
      listDeadLetters(),
      listUnresolvedEffects(),
    ]);
    const names = await tenantNames();
    const named = <T extends { tenantId?: string | null }>(row: T) => ({
      ...row,
      tenantName: row.tenantId ? (names.get(row.tenantId.toLowerCase()) ?? null) : null,
    });
    return NextResponse.json({
      schedules,
      deadLetters: deadLetters.map(named),
      unresolvedEffects: unresolvedEffects.map(named),
    });
  } catch (error) {
    return internalError(error, { request, context: "Jobs view failed" });
  }
}, GET_RESPONSE);

/**
 * Every tenant's name, by id (the directory operators read). A read that fails names no tenant —
 * each row then says its tenant is not known — and never fails the view.
 */
async function tenantNames(): Promise<ReadonlyMap<string, string>> {
  try {
    const tenants = await getTenantDirectory().listTenants();
    return new Map(tenants.map((t) => [t.id.toLowerCase(), t.name]));
  } catch (error) {
    logger.warn("Tenant names could not be read for the Jobs view", {
      error: error instanceof Error ? error.message : String(error),
      route: "api/operator/jobs",
    });
    return new Map();
  }
}
