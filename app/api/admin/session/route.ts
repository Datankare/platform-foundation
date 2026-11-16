/**
 * app/api/admin/session/route.ts — Who the admin console is open for (audit B-14)
 *
 * GET → { userId, roleName, permissions, email, displayName }: the verified admin's own effective
 * permissions, so the console shows only the sections its user may open — and who they are
 * (TASK-216, SF-admin-005: the console's header named only the role): the address and display
 * name of the admin's own account, each null when the account has none or the read failed (who
 * is signed in is said when it can be; it is never a reason to refuse). Display only — every
 * section's data comes from its own route, which checks its own permission; this grants nothing.
 *
 * Opening the console is how staff sign in to it, and their requests otherwise go through
 * requireAdmin, not requireActor: so this read also keeps the admin's own address in step with
 * the identity provider (TASK-185, platform/auth/email-verification.ts) — best effort, after the
 * checks, and never a reason to refuse.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { tenantRoute } from "@/platform/tenancy/route";
import { syncAccountAddress } from "@/platform/auth/email-verification";
import type { ResponseSchema } from "@/platform/errors/response-schema";
import { ownAccountName } from "@/platform/admin/account-names";

const GET_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    permissions: {
      type: "array",
      items: {
        type: ["array", "null", "number", "object", "string"],
        properties: {
          code: {
            type: "string",
          },
        },
        items: {
          type: "string",
        },
      },
    },
    roleName: {
      type: "string",
    },
    userId: {
      type: "string",
    },
    // TASK-216 (SF-admin-005): who is signed in — each null when the account has none.
    email: {
      type: ["null", "string"],
    },
    displayName: {
      type: ["null", "string"],
    },
  },
};

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const verified = await requireAdmin(request, "can_access_admin");
  if (verified.error) return verified.error;
  const { admin } = verified;
  if (verified.user) await syncAccountAddress(verified.user.sub, verified.user);
  // After the address was brought in step: the header shows the one just recorded.
  const who = await ownAccountName(admin.userId);
  const response = NextResponse.json({
    userId: admin.userId,
    roleName: admin.roleName,
    permissions: [...admin.permissions],
    email: who.email,
    displayName: who.displayName,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}, GET_RESPONSE);
