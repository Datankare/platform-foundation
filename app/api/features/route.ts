/**
 * GET /api/features — which optional features this deployment offers (ADR-050 D3, TASK-104)
 *
 * Public and cheap: booleans only, never a setting's value. The UI hides a feature that is not
 * available and labels a preview as such.
 */
import { NextResponse } from "next/server";
import { featureAvailability } from "@/platform/features";

export function GET(): NextResponse {
  return NextResponse.json(
    { features: featureAvailability() },
    { headers: { "Cache-Control": "public, max-age=60" } }
  );
}
