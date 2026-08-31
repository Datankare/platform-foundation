/**
 * app/api/admin/capabilities/route.ts — GET the discovered capabilities (Sprint 3c U2).
 *
 * READ-ONLY. Capabilities are derived from the code-registered workflow registry (ADR-030 D8),
 * not admin-editable config — there is nothing to govern here, so this panel is a view, not a
 * governance surface (see ADR-035 and the UX design doc). It renders the same document as
 * /api/agent/capabilities, admin-guarded.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { getActiveProviders } from "@/platform/providers/registry";
import { listWorkflows, buildCapabilities } from "@/platform/agents";

export async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_view_audit");
  if (denied) return denied;

  const capabilities = buildCapabilities(
    listWorkflows(),
    getActiveProviders() as unknown as Record<string, string>
  );
  return NextResponse.json(capabilities);
}
