/**
 * platform/rate-limit/client-ip.ts — the caller's network address, resistant to spoofing (ADR-052)
 *
 * X-Forwarded-For is a list each proxy appends to. Only the entries added by proxies we run
 * are trustworthy; anything to their left was supplied by the caller and can be forged. With
 * TRUSTED_PROXY_HOPS proxies in front of the app (Vercel, or one load balancer: 1), the client
 * address is the entry that many places from the right.
 *
 * Without the header, X-Real-IP is used; without either, "unknown" — every such caller then
 * shares one bucket, which errs towards limiting rather than not limiting.
 *
 * @module platform/rate-limit
 */

import { getTrustedProxyHops } from "@/platform/providers/environment-contract";

interface HeaderSource {
  readonly headers: { get(name: string): string | null };
}

export function getClientIp(
  request: HeaderSource,
  hops: number = getTrustedProxyHops()
): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const entries = forwarded
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (entries.length > 0) {
      // Fewer entries than trusted hops: the leftmost is the best available (it was added by
      // our outermost proxy, not the caller).
      return entries[Math.max(0, entries.length - hops)];
    }
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "unknown";
}
