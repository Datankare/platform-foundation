/**
 * platform/tenancy/context.ts — the tenant a request runs for (ADR-053 D3)
 *
 * `TenantContext { tenantId, mode }` is established once per request by the verifiers (or, for an
 * anonymous request, the rate limiter) and held in request-scoped AsyncLocalStorage, so every store, cache and limiter reads the same tenant without
 * it being passed through every call. Reading it where none is set throws — fail closed: work that
 * does not know its tenant must not touch tenant data.
 *
 * Server only (node:async_hooks). Anchored on globalThis like every platform singleton (ADR-032),
 * so a bundle that duplicates this module still shares one storage.
 *
 * @module platform/tenancy
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_TENANT_ID, isTenantId } from "@/platform/providers/environment-contract";

export { DEFAULT_TENANT_ID, isTenantId };

export type TenancyMode = "single" | "shared";

export interface TenantContext {
  readonly tenantId: string;
  readonly mode: TenancyMode;
}

export class TenantContextError extends Error {
  readonly code = "tenant.context_missing";
  constructor(
    message = "No tenant context: this work ran outside a verified request or job"
  ) {
    super(message);
    this.name = "TenantContextError";
  }
}

/**
 * What the storage holds: a cell for one request or job. A job's cell holds its tenant from the
 * start (runWithTenant). A request's cell starts empty (runRequestScope) and is filled
 * once by the verifiers or the limiter (enterTenant), which run inside helpers the handler
 * awaits — a value set with AsyncLocalStorage.enterWith inside an awaited helper would not be
 * visible to the handler after the await, so the cell is created around the whole handler and
 * the helpers fill it.
 */
interface Cell {
  ctx: TenantContext | undefined;
}

const KEY = Symbol.for("datankare.platform.tenancy.storage.v2");
type Holder = { [KEY]?: AsyncLocalStorage<Cell> };

function storage(): AsyncLocalStorage<Cell> {
  const g = globalThis as Holder;
  g[KEY] ??= new AsyncLocalStorage<Cell>();
  return g[KEY];
}

function checked(ctx: TenantContext): TenantContext {
  if (typeof ctx !== "object" || ctx === null || !isTenantId(ctx.tenantId)) {
    throw new TenantContextError("Malformed tenant id");
  }
  if (ctx.mode !== "single" && ctx.mode !== "shared") {
    throw new TenantContextError("Malformed tenancy mode");
  }
  return Object.freeze({ tenantId: ctx.tenantId, mode: ctx.mode });
}

/** Run `fn` with `ctx` as the tenant — for jobs, tests and anything that is not a request. */
export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return storage().run({ ctx: checked(ctx) }, fn);
}

/**
 * Run a request handler in its own, empty tenant scope (platform/tenancy/route.ts wraps every
 * route in this). The verifiers and the limiter fill it; until then there is no tenant.
 */
export function runRequestScope<T>(fn: () => T): T {
  return storage().run({ ctx: undefined }, fn);
}

/** True inside a request scope or a job — where enterTenant can take effect. */
export function hasTenantScope(): boolean {
  return storage().getStore() !== undefined;
}

/**
 * Establish the tenant for the rest of the current request (the verifiers and the limiter call
 * this). A scope that already has a different tenant is refused: a tenant never changes within
 * a request or job. Outside any scope (a verifier called directly, as in a unit test) it only
 * validates and returns the context — nothing is stored, so tenant data stays unreadable there.
 */
export function enterTenant(ctx: TenantContext): TenantContext {
  const next = checked(ctx);
  const cell = storage().getStore();
  if (!cell) return next;
  const current = cell.ctx;
  if (current) {
    if (current.tenantId !== next.tenantId || current.mode !== next.mode) {
      throw new TenantContextError("A request cannot change tenant");
    }
    return current;
  }
  cell.ctx = next;
  return next;
}

/** The current tenant; throws TenantContextError when there is none. */
export function currentTenant(): TenantContext {
  const ctx = storage().getStore()?.ctx;
  if (!ctx) throw new TenantContextError();
  return ctx;
}

/** The current tenant id; throws when there is none. */
export function currentTenantId(): string {
  return currentTenant().tenantId;
}

/** The current tenant, or undefined — only for code that reports, never for code that reads data. */
export function peekTenant(): TenantContext | undefined {
  return storage().getStore()?.ctx;
}

/** Run `fn` with no tenant and no scope — for tests proving that work outside a tenant is refused. */
export function runWithoutTenant<T>(fn: () => T): T {
  return storage().exit(fn);
}
