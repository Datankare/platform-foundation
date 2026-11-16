/**
 * app/api/admin/users/search/route.ts — the Users list, searched (TASK-215, audit A-17)
 *
 * POST { q?, text?, role?, status?, signed_in_within_days?, created_within_days?, sort?, dir?,
 *        limit?, offset? } → the same answer as GET /api/admin/users (../route.ts documents each
 * parameter and how it is bound; ../list-users.ts reads both).
 *
 * The search box's text — part of an address or a name — was sent as `GET /api/admin/users?q=`,
 * so every proxy, CDN and access log on the way kept it. Here it is in the body, which none of them
 * records (MITRE's CWE-598, "Use of HTTP Request With Sensitive Query String"). The body is read
 * against its schema (any other key refused); each value is a string or
 * a number, given as the URL's parameters would be, and checked exactly as there.
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { apiError, readJsonBody, type InputSchemaNode } from "@/platform/errors";
import { tenantRoute } from "@/platform/tenancy/route";
import { listUsers } from "@/app/api/admin/users/list-users";
import type { ResponseSchema } from "@/platform/errors/response-schema";

/** The parameters a search may give: the list's, and the search text. */
const SEARCH_PARAMS = [
  "q",
  "text",
  "role",
  "status",
  "signed_in_within_days",
  "created_within_days",
  "sort",
  "dir",
  "limit",
  "offset",
] as const;

/** The body this route reads: read against its schema — any other key refused. */
const SEARCH_BODY_SCHEMA: InputSchemaNode = {
  type: "object",
  properties: Object.fromEntries(
    SEARCH_PARAMS.map((p) => [p, { type: ["string", "number"] }])
  ),
};

const POST_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    page: {
      type: "object",
      properties: {
        dir: {
          type: "string",
        },
        hasMore: {
          type: "boolean",
        },
        limit: {
          type: "number",
        },
        offset: {
          type: "number",
        },
        sort: {
          type: "string",
        },
        total: {
          type: "number",
        },
        totalCapped: {
          type: "boolean",
        },
      },
    },
    roles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          displayName: {
            type: "string",
          },
          id: {
            type: "string",
          },
          name: {
            type: "string",
          },
        },
      },
    },
    users: {
      type: "array",
      items: {
        type: "object",
        properties: {
          createdAt: {
            type: "string",
          },
          displayName: {
            type: ["null", "string"],
          },
          email: {
            type: ["null", "string"],
          },
          emailVerified: {
            type: "boolean",
          },
          entitlements: {
            type: "array",
            items: {
              type: "object",
              properties: {
                code: {
                  type: "string",
                },
                expiresAt: {
                  type: ["null", "string"],
                },
                name: {
                  type: "string",
                },
              },
            },
          },
          id: {
            type: "string",
          },
          isDeleted: {
            type: "boolean",
          },
          lastSignInAt: {
            type: ["null", "string"],
          },
          roleDisplayName: {
            type: "string",
          },
          roleId: {
            type: "string",
          },
          roleName: {
            type: "string",
          },
          status: {
            type: "string",
          },
          statusUntil: {
            type: ["null", "string"],
          },
        },
      },
    },
  },
};

export const POST = tenantRoute(async function POST(request: NextRequest) {
  // A POST that changes nothing (admin-mutations-audited lists it): the caller is verified as for
  // GET /api/admin/users, by name.
  const verified = await requireAdmin(request, "admin_manage_users");
  if (verified.error) return verified.error;

  const read = await readJsonBody(request, SEARCH_BODY_SCHEMA);
  if (!read.ok) return read.response;
  const params = new URLSearchParams();
  for (const name of SEARCH_PARAMS) {
    const v = read.body[name];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" && !(typeof v === "number" && Number.isFinite(v))) {
      return apiError("request.invalid_value", {
        params: { field: name, allowed: ["text", "number"] },
        request,
      });
    }
    params.set(name, String(v));
  }
  return listUsers(request, params);
}, POST_RESPONSE);
