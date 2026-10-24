/**
 * GET /api/features — which optional features this deployment offers (ADR-050 D3, TASK-104)
 *
 * Public and cheap: booleans only, never a setting's value. The UI hides a feature that is not
 * available and labels a preview as such.
 */
import { NextResponse, type NextRequest } from "next/server";
import { featureAvailability } from "@/platform/features";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";

export const GET = tenantRoute(async function GET(
  request: NextRequest
): Promise<NextResponse> {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.API_GLOBAL);
  if (limited) return limited;
  return NextResponse.json(
    { features: featureAvailability() },
    { headers: { "Cache-Control": "public, max-age=60" } }
  );
});
