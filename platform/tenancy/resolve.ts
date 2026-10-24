/**
 * platform/tenancy/resolve.ts — which tenant a request belongs to (ADR-053 D2)
 *
 * The tenant comes from verified identity, never from anything the caller can simply assert:
 *
 *   signed-in user   → the identity provider's tenant claim (Cognito `custom:tenant_id`)
 *   guest            → the `tid` claim inside the server-signed guest token
 *   anonymous        → the host the request was addressed to, looked up in the tenant directory
 *
 * In single mode there is exactly one tenant (TENANT_ID): an identity without a tenant claim is
 * that tenant, and one naming another tenant is refused. In shared mode an identity must carry
 * its tenant, and when the host also maps to a tenant the two must agree — a user of tenant A
 * cannot use tenant B's address. A tenant that is not active is refused everywhere.
 *
 * Where the host is read is declared, never inferred (TENANT_HOST_HEADER, required in shared
 * mode):
 *
 *   x-forwarded-host  the entry our outermost proxy put in X-Forwarded-Host (TRUSTED_PROXY_HOPS
 *                     from the right — same rule as platform/rate-limit/client-ip.ts), else Host.
 *                     For a proxy that always sets the header (Vercel).
 *   host              the Host header; X-Forwarded-Host is ignored entirely. For a proxy that
 *                     forwards Host and does not set X-Forwarded-Host (AWS ALB): there, that
 *                     header is whatever the caller sent.
 *
 * (`next start` itself fills X-Forwarded-Host from Host only when the request has none, so it
 * never overrides a caller's; with `host` that does not matter, with `x-forwarded-host` the
 * proxy in front must set it.) Even a forged host gains little: anonymous requests see only what
 * that tenant shows anyone at its own address, and for an identity the host can only cause a
 * refusal, never select a tenant. A header too long to be an address is refused unread.
 *
 * @module platform/tenancy
 */

import type { ErrorCode } from "@/platform/errors/registry";
import {
  getTenancySettings,
  getTenantHostHeader,
  getTrustedProxyHops,
  isTenantId,
  type EnvSource,
  type TenantHostHeader,
} from "@/platform/providers/environment-contract";
import type { TenancyMode, TenantContext } from "./context";
import { getTenantDirectory, normaliseHost, type TenantDirectory } from "./directory";

export type TenantRefusalCode = Extract<
  ErrorCode,
  "tenant.mismatch" | "tenant.missing" | "tenant.suspended" | "tenant.unknown_host"
>;

export type TenantResolution =
  | { readonly ok: true; readonly context: TenantContext }
  | { readonly ok: false; readonly code: TenantRefusalCode; readonly reason: string };

interface HeaderSource {
  readonly headers: { get(name: string): string | null };
}

export interface ResolveOptions {
  readonly env?: Record<string, string | undefined>;
  readonly directory?: TenantDirectory;
  readonly hops?: number;
  /** Where the host is read (default: TENANT_HOST_HEADER). */
  readonly hostHeader?: TenantHostHeader;
}

function refuse(code: TenantRefusalCode, reason: string): TenantResolution {
  return { ok: false, code, reason };
}

/** Longer than any list of addresses our proxies would write: refused without being parsed. */
const MAX_HOST_HEADER_LENGTH = 1024;

/**
 * The declared host header (TENANT_HOST_HEADER). Throws when it is not set: a shared deployment
 * that has not said where its address comes from cannot know a request's tenant (the request is
 * answered 503, and the environment contract refuses such a deployment at boot).
 */
export function tenantHostHeader(env: EnvSource = process.env): TenantHostHeader {
  const header = getTenantHostHeader(env);
  if (!header) {
    throw new Error(
      "TENANT_HOST_HEADER is not set: a shared deployment must declare where the request's address is read"
    );
  }
  return header;
}

/**
 * The host the request was addressed to, read from `header` and trusting only our own proxies.
 * Null when absent or malformed.
 */
export function requestHost(
  request: HeaderSource,
  hops: number = getTrustedProxyHops(),
  header: TenantHostHeader = tenantHostHeader()
): string | null {
  if (header === "x-forwarded-host") {
    const forwarded = request.headers.get("x-forwarded-host");
    if (forwarded) {
      if (forwarded.length > MAX_HOST_HEADER_LENGTH) return null;
      const entries = forwarded
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (entries.length > 0)
        return normaliseHost(entries[Math.max(0, entries.length - hops)]);
    }
  }
  const host = request.headers.get("host");
  if (host && host.length > MAX_HOST_HEADER_LENGTH) return null;
  return normaliseHost(host);
}

/** requestHost with the options' (or the environment's) hops and header. */
function hostOf(request: HeaderSource, options: ResolveOptions): string | null {
  const env = options.env ?? process.env;
  return requestHost(
    request,
    options.hops ?? getTrustedProxyHops(env),
    options.hostHeader ?? tenantHostHeader(env)
  );
}

async function activeContext(
  tenantId: string,
  mode: TenancyMode,
  directory: TenantDirectory
): Promise<TenantResolution> {
  const tenant = await directory.getTenant(tenantId);
  if (!tenant) {
    // Single mode's own tenant always exists by configuration; a directory that has not been
    // seeded with it (a fresh local database) must not lock everyone out.
    if (mode === "single")
      return { ok: true, context: Object.freeze({ tenantId, mode }) };
    return refuse("tenant.missing", "The tenant does not exist");
  }
  if (tenant.status !== "active") {
    return refuse("tenant.suspended", `The tenant is ${tenant.status}`);
  }
  return { ok: true, context: Object.freeze({ tenantId, mode }) };
}

/**
 * The tenant of a verified identity (a user's token or a guest's token). `claimed` is the tenant
 * the identity carries, undefined when it carries none.
 */
export async function resolveForIdentity(
  claimed: string | undefined,
  request: HeaderSource | undefined,
  options: ResolveOptions = {}
): Promise<TenantResolution> {
  const env = options.env ?? process.env;
  const directory = options.directory ?? getTenantDirectory();
  const settings = getTenancySettings(env);

  if (claimed !== undefined && !isTenantId(claimed)) {
    return refuse("tenant.missing", "The identity carries a malformed tenant");
  }

  if (settings.mode === "single") {
    const own = settings.tenantId;
    if (claimed !== undefined && claimed !== own) {
      return refuse("tenant.mismatch", "The identity belongs to another tenant");
    }
    return activeContext(own, "single", directory);
  }

  if (claimed === undefined) {
    return refuse("tenant.missing", "The identity is not assigned to a tenant");
  }
  if (request) {
    const host = hostOf(request, options);
    if (host) {
      const hostTenant = await directory.tenantForHost(host);
      if (hostTenant && hostTenant !== claimed) {
        return refuse("tenant.mismatch", "The address belongs to another tenant");
      }
    }
  }
  return activeContext(claimed, "shared", directory);
}

/** The tenant of a request with no identity: the configured one, or the one its host serves. */
export async function resolveAnonymous(
  request: HeaderSource,
  options: ResolveOptions = {}
): Promise<TenantResolution> {
  const env = options.env ?? process.env;
  const directory = options.directory ?? getTenantDirectory();
  const settings = getTenancySettings(env);
  if (settings.mode === "single")
    return activeContext(settings.tenantId, "single", directory);

  const host = hostOf(request, options);
  if (!host) return refuse("tenant.unknown_host", "The request has no usable host");
  const tenantId = await directory.tenantForHost(host);
  if (!tenantId)
    return refuse("tenant.unknown_host", "The host is not mapped to a tenant");
  return activeContext(tenantId, "shared", directory);
}
