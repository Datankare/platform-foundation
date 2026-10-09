/**
 * platform/features/guard.ts — A route for an optional feature refuses when it isn't configured
 *
 *   const off = requireFeature("music_identification", { request });
 *   if (off) return off;
 *
 * @module platform/features
 */

import type { NextResponse } from "next/server";
import { apiError } from "@/platform/errors";
import { isFeatureAvailable, type FeatureId } from "@/platform/features/availability";

/** `feature.not_configured` (501) when the feature's settings are absent; otherwise null. */
export function requireFeature(
  feature: FeatureId,
  options: { request?: { headers: Headers } } = {}
): NextResponse | null {
  if (isFeatureAvailable(feature)) return null;
  return apiError("feature.not_configured", {
    params: { feature },
    request: options.request,
  });
}
