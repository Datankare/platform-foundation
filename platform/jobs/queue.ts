/**
 * platform/jobs/queue.ts — putting work on the queue (ADR-056 D2)
 *
 *   await enqueueJob("social.welcome", { idempotencyKey: `welcome:${userId}`, payload: { userId } });
 *
 * A job is bound to the kind's scope and to the caller's tenant:
 *
 *   - only a registered kind is accepted;
 *   - a per-tenant kind is enqueued for the current tenant. Naming another tenant needs a
 *     JobAuthority (./authority.ts — a platform job's handler or a verified operator holds one):
 *     code running in tenant A can never put work into tenant B;
 *   - a platform kind is enqueued as a platform job (no tenant), and only with a JobAuthority;
 *     a per-tenant kind is never a platform job, and a platform kind never a tenant's;
 *   - `runAt` in the past is clamped to now, so a job cannot jump the queue ahead of work that
 *     was due first (the stores clamp again, against the database's clock).
 *
 * The idempotency key makes a repeat harmless: the same key for the same tenant and kind is the
 * same job (`created: false`), however often it is enqueued — so a request that retries, or two
 * instances that both react to one event, enqueue once. The same key in another tenant is another
 * tenant's job.
 *
 * @module platform/jobs
 */

import { peekTenant } from "@/platform/tenancy/context";
import { TenantContextError } from "@/platform/tenancy/context";
import { isTenantId } from "@/platform/providers/environment-contract";
import { isJobAuthority } from "./authority";
import { getJobDefinition, JobDefinitionError } from "./registry";
import { getJobStore } from "./store";
import type { EnqueueResult, JobAuthority } from "./types";

/** The largest payload a job may carry, as JSON (the 050 jobs_payload_size check). */
export const MAX_PAYLOAD_BYTES = 65_536;

export interface EnqueueOptions {
  readonly idempotencyKey: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  /** Not before this time (default now; a past time is clamped to now). */
  readonly runAt?: Date;
  /**
   * A per-tenant kind: the tenant (default: the current one; another needs `authority`).
   * A platform kind: null or left out — a platform job, which needs `authority`.
   */
  readonly tenantId?: string | null;
  /** The capability to enqueue beyond the current tenant (./authority.ts). */
  readonly authority?: JobAuthority;
}

/** A refused enqueue: the request is malformed. Nothing was stored. */
export class JobEnqueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobEnqueueError";
  }
}

export async function enqueueJob(
  kind: string,
  options: EnqueueOptions
): Promise<EnqueueResult> {
  const def = getJobDefinition(kind);
  if (!def) throw new JobDefinitionError(kind, "no such job kind is registered");
  const key = options.idempotencyKey;
  if (typeof key !== "string" || key.length < 1 || key.length > 200) {
    throw new JobEnqueueError("idempotencyKey must be 1–200 characters");
  }
  const payload = options.payload ?? {};
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new JobEnqueueError("payload must be an object");
  }
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch {
    throw new JobEnqueueError("payload must be JSON-serialisable");
  }
  if (size > MAX_PAYLOAD_BYTES) {
    throw new JobEnqueueError(`payload is larger than ${MAX_PAYLOAD_BYTES} bytes`);
  }
  if (
    options.runAt !== undefined &&
    (!(options.runAt instanceof Date) || Number.isNaN(options.runAt.getTime()))
  ) {
    throw new JobEnqueueError("runAt is not a valid time");
  }
  const authorized = options.authority !== undefined && isJobAuthority(options.authority);
  if (options.authority !== undefined && !authorized) {
    throw new JobEnqueueError("authority is not one the platform issued");
  }
  const tenantId = resolveTenant(kind, def.scope, options.tenantId, authorized);
  const now = Date.now();
  const runAt =
    options.runAt && options.runAt.getTime() > now ? options.runAt : undefined;
  return getJobStore().enqueue({
    tenantId,
    kind,
    payload,
    idempotencyKey: key,
    ...(runAt ? { runAt } : {}),
    maxAttempts: def.maxAttempts,
    source: "enqueue",
    runsForSuspended: def.runsForSuspended,
  });
}

/** The tenant a job is for, or null for a platform job; throws when the caller may not ask. */
function resolveTenant(
  kind: string,
  scope: "platform" | "each-tenant",
  requested: string | null | undefined,
  authorized: boolean
): string | null {
  if (scope === "platform") {
    if (requested !== undefined && requested !== null) {
      throw new JobEnqueueError(
        `"${kind}" is a platform job kind: it is never enqueued for a tenant`
      );
    }
    if (!authorized) {
      throw new JobEnqueueError(
        `"${kind}" is a platform job kind: enqueuing it needs the runner's or an operator's authority`
      );
    }
    return null;
  }
  if (requested === null) {
    throw new JobEnqueueError(
      `"${kind}" is a per-tenant job kind: it is never enqueued as a platform job`
    );
  }
  const current = peekTenant()?.tenantId;
  if (requested === undefined) {
    if (!current) throw new TenantContextError();
    return current;
  }
  if (!isTenantId(requested)) throw new JobEnqueueError("tenantId is not a tenant id");
  if (requested !== current && !authorized) {
    throw new JobEnqueueError(
      "a job is enqueued for the current tenant only; another tenant needs the runner's or an operator's authority"
    );
  }
  return requested;
}
