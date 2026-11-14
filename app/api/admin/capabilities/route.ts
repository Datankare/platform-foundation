/**
 * app/api/admin/capabilities/route.ts — GET the discovered capabilities (Sprint 3c U2).
 *
 * READ-ONLY. Capabilities are derived from the code-registered workflow registry (ADR-030 D8),
 * not admin-editable config — there is nothing to govern here, so this panel is a view, not a
 * governance surface (see ADR-035 and the UX design doc). It renders the same document as
 * /api/agent/capabilities, admin-guarded: the providers stripped to what each capability uses
 * (capabilitySelections) — the platform's plumbing (stores, cache, limiter) is an operator's to
 * see, not every holder of admin_view_audit's (TASK-194, audit C-10, as C-21 did for the agent
 * route).
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { getActiveProviders } from "@/platform/providers/registry";
import { listWorkflows, buildCapabilities } from "@/platform/agents";
import { capabilitySelections } from "@/platform/agents/capabilities";
import { tenantRoute } from "@/platform/tenancy/route";
import type { ResponseSchema } from "@/platform/errors/response-schema";

const GET_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    goals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: {
            type: "string",
          },
          endpoint: {
            type: "string",
          },
          estimatedCostUSD: {
            type: "number",
          },
          goal: {
            type: "string",
          },
          requiredCapability: {
            type: ["null", "string"],
          },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                estimatedCostUSD: {
                  type: "number",
                },
                intent: {
                  type: "string",
                },
              },
            },
          },
        },
      },
    },
    notReported: {
      type: "array",
      items: {
        type: "string",
      },
    },
    providerSelections: {
      type: "object",
      properties: {
        ai: {
          type: "string",
        },
        audioConverter: {
          type: "string",
        },
        embeddingProvider: {
          type: "string",
        },
        songId: {
          type: "string",
        },
        stt: {
          type: "string",
        },
        translation: {
          type: "string",
        },
        tts: {
          type: "string",
        },
      },
      values: {
        type: "string",
      },
    },
  },
};

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_view_audit");
  if (denied) return denied;

  const capabilities = buildCapabilities(
    listWorkflows(),
    capabilitySelections(getActiveProviders() as unknown as Record<string, string>)
  );
  return NextResponse.json(capabilities);
}, GET_RESPONSE);
