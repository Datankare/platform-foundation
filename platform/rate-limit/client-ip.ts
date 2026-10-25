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

import { isIP } from "node:net";
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

/**
 * The bucket an address is counted in (audit G-8, A-6). An IPv6 client is routinely given a
 * whole /64 — 18 quintillion addresses — so counting per address let one client take a fresh
 * allowance with every request. IPv6 is counted per /64 prefix; an IPv4-mapped IPv6 address
 * (::ffff:192.0.2.1) as the IPv4 address it is; IPv4 per address; anything that is not an
 * address as one shared bucket ("unknown"), which errs towards limiting.
 */
export function addressBucket(address: string): string {
  const raw = address
    .trim()
    .replace(/^\[|\]$/g, "")
    .split("%")[0];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];
  const kind = isIP(raw);
  if (kind === 4) return raw;
  if (kind !== 6) return "unknown";
  // Expand "::" to the zero groups it stands for, then keep the first four groups.
  const [head, tail = ""] = raw.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = raw.includes("::") ? (tail ? tail.split(":") : []) : [];
  // A trailing embedded IPv4 (…:192.0.2.1) is two groups; it is never in the first four that
  // matter unless the address is mostly empty, where it reads as zeros.
  const groups = raw.includes("::")
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  const prefix = groups
    .slice(0, 4)
    .map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? g.replace(/^0+(?=.)/, "") : "0"));
  while (prefix.length < 4) prefix.push("0");
  return `${prefix.join(":")}::/64`;
}

/** The caller's address bucket: getClientIp, then addressBucket. */
export function getClientBucket(
  request: HeaderSource,
  hops: number = getTrustedProxyHops()
): string {
  return addressBucket(getClientIp(request, hops));
}
