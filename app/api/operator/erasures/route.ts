/**
 * app/api/operator/erasures/route.ts — the erasures still open, across tenants (operators only;
 * TASK-202, S3-E19)
 *
 * GET → { erasures, operators, reasons } (platform/gdpr/erasure-status.ts): each erasure whose
 * data purge or external step (the sign-in identity) is not done, with its steps, any open
 * attestation request and who asked it, and whether a second operator exists to approve one. The
 * Erasures view reads it; it attests through
 * POST /api/operator/tenants/[id]/erasures/[userId]/attestation (the rules are unchanged).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { internalError } from "@/platform/errors";
import { listOpenErasures } from "@/platform/gdpr/erasure-status";
import { tenantRoute } from "@/platform/tenancy/route";
import type { ResponseSchema } from "@/platform/errors/response-schema";

const GET_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    erasures: {
      type: "array",
      items: {
        type: "object",
        properties: {
          purgeAfter: {
            type: "string",
          },
          purgeAttempts: {
            type: "number",
          },
          purgeFailing: {
            type: "boolean",
          },
          purgeRetryAt: {
            type: "null",
          },
          purgedAt: {
            type: "null",
          },
          requestedBy: {
            type: "object",
            properties: {
              email: {
                type: "string",
              },
              kind: {
                type: "string",
              },
            },
          },
          secondOperator: {
            type: "boolean",
          },
          softDeletedAt: {
            type: "string",
          },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                attempts: {
                  type: "number",
                },
                attestationRequest: {
                  type: "object",
                  properties: {
                    at: {
                      type: "string",
                    },
                    by: {
                      type: "object",
                      properties: {
                        email: {
                          type: "string",
                        },
                        kind: {
                          type: "string",
                        },
                      },
                    },
                    byViewer: {
                      type: "boolean",
                    },
                    expired: {
                      type: "boolean",
                    },
                    expiresAt: {
                      type: "string",
                    },
                    reason: {
                      type: "string",
                    },
                  },
                },
                attested: {
                  type: "object",
                  properties: {
                    at: {
                      type: "string",
                    },
                    by: {
                      type: "object",
                      properties: {
                        email: {
                          type: ["null", "string"],
                        },
                        kind: {
                          type: "string",
                        },
                      },
                    },
                    reason: {
                      type: "string",
                    },
                    requestedBy: {
                      type: "object",
                      properties: {
                        email: {
                          type: ["null", "string"],
                        },
                        kind: {
                          type: "string",
                        },
                      },
                    },
                  },
                },
                done: {
                  type: "boolean",
                },
                doneAt: {
                  type: "string",
                },
                poolUnverified: {
                  type: "boolean",
                },
                retryAt: {
                  type: "string",
                },
                store: {
                  type: "string",
                },
              },
            },
          },
          tenantId: {
            type: "string",
          },
          tenantName: {
            type: ["null", "string"],
          },
          tenantSlug: {
            type: "string",
          },
          userId: {
            type: "string",
          },
        },
      },
    },
    operators: {
      type: "number",
    },
    reasons: {
      type: "array",
      items: {
        type: "string",
      },
    },
  },
};

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  try {
    const overview = await listOpenErasures(guard.admin.userId);
    const response = NextResponse.json(overview);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return internalError(error, { request, context: "Erasure list failed" });
  }
}, GET_RESPONSE);
