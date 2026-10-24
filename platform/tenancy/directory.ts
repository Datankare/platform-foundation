/**
 * platform/tenancy/directory.ts — which tenants exist, their state, and their addresses
 * (ADR-053 D1, D2, D7)
 *
 * The directory is platform-owned, not tenant-scoped: it answers "which tenant does this host
 * serve" and "is this tenant active" for every request, and holds what an operator manages
 * (tenants, their domains, their state). Request paths only read it; writes are operator paths
 * (platform/tenancy/admin.ts), always audited.
 *
 * Reads are cached per instance for a short time (30 s) because every request asks; a
 * suspension therefore takes effect within that time on every instance. Hosts are answered from
 * a snapshot of every address (CachedTenantDirectory), so a request for an unknown host costs no
 * query and leaves nothing behind.
 *
 * @module platform/tenancy
 */

import { logger } from "@/lib/logger";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";
import { DEFAULT_TENANT_ID, isTenantId } from "@/platform/providers/environment-contract";

export type TenantStatus = "active" | "suspended" | "deleted";

export interface TenantRecord {
  readonly id: string;
  /** Short, unique, stable: lower-case letters, digits and hyphens (e.g. "acme"). */
  readonly slug: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** When it was suspended or deleted, and by whom (operator user id). */
  readonly statusChangedAt?: string;
  readonly statusChangedBy?: string;
  readonly statusReason?: string;
}

export interface TenantDomainRecord {
  readonly host: string;
  readonly tenantId: string;
  readonly createdAt: string;
}

/** One address and the tenant it serves (listHosts). */
export interface TenantHostRecord {
  readonly host: string;
  readonly tenantId: string;
}

/** Read and operator-write access to the tenant directory. */
export interface TenantDirectory {
  getTenant(tenantId: string): Promise<TenantRecord | null>;
  getTenantBySlug(slug: string): Promise<TenantRecord | null>;
  /** The tenant a host is mapped to, or null. `host` is already normalised (see normaliseHost). */
  tenantForHost(host: string): Promise<string | null>;
  listTenants(): Promise<readonly TenantRecord[]>;
  listDomains(tenantId: string): Promise<readonly TenantDomainRecord[]>;
  /**
   * Every address of every tenant — what CachedTenantDirectory answers hosts from, so that a
   * host no tenant has costs no query (one read per refresh, whatever the traffic).
   */
  listHosts(): Promise<readonly TenantHostRecord[]>;
  /** Fails when the id or slug exists. */
  createTenant(input: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
  }): Promise<TenantRecord>;
  /** Fails when the host is mapped to any tenant. */
  addDomain(tenantId: string, host: string): Promise<TenantDomainRecord>;
  /** False when the host was not mapped to that tenant. */
  removeDomain(tenantId: string, host: string): Promise<boolean>;
  /** Compare-and-set: returns null when the tenant is not in `from`. */
  setStatus(input: {
    readonly tenantId: string;
    readonly from: readonly TenantStatus[];
    readonly to: TenantStatus;
    readonly by: string;
    readonly reason: string;
  }): Promise<TenantRecord | null>;
  rename(tenantId: string, name: string): Promise<TenantRecord | null>;
}

export class TenantDirectoryConflictError extends Error {
  readonly code: "tenant.exists" | "tenant.slug_taken" | "tenant.domain_taken";
  constructor(code: TenantDirectoryConflictError["code"], message: string) {
    super(message);
    this.name = "TenantDirectoryConflictError";
    this.code = code;
  }
}

// ── Validation shared by every implementation ─────────────────────────

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isTenantSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG.test(value);
}

/**
 * A host as the directory stores it: lower case, no port, no trailing dot, valid DNS labels
 * (or "localhost"). Returns null for anything else — an IP literal, an empty label, a space, a
 * port without a host — so a malformed Host header never matches a tenant.
 */
export function normaliseHost(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let host = raw.trim().toLowerCase();
  if (!host || host.length > 255) return null;
  if (host.startsWith("[")) return null; // IPv6 literal
  const colon = host.lastIndexOf(":");
  if (colon !== -1) {
    const port = host.slice(colon + 1);
    if (!/^\d{1,5}$/.test(port)) return null;
    host = host.slice(0, colon);
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "localhost") return host;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  if (labels.every((l) => /^\d+$/.test(l))) return null; // IPv4 literal
  if (!labels.every((l) => LABEL.test(l))) return null;
  return host;
}

export function validateTenantName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length < 2 || trimmed.length > 100) return null;
  // No control characters.
  for (const ch of trimmed) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return null;
  }
  return trimmed;
}

// ── In-memory implementation (tests, local; production refuses it) ───

export class InMemoryTenantDirectory implements TenantDirectory {
  private readonly tenants = new Map<string, TenantRecord>();
  private readonly domains = new Map<string, TenantDomainRecord>();

  constructor(seed: { readonly withDefault?: boolean } = { withDefault: true }) {
    if (seed.withDefault !== false) {
      const now = new Date(0).toISOString();
      this.tenants.set(DEFAULT_TENANT_ID, {
        id: DEFAULT_TENANT_ID,
        slug: "default",
        name: "Default",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      this.domains.set("localhost", {
        host: "localhost",
        tenantId: DEFAULT_TENANT_ID,
        createdAt: now,
      });
    }
  }

  async getTenant(tenantId: string): Promise<TenantRecord | null> {
    return this.tenants.get(tenantId) ?? null;
  }

  async getTenantBySlug(slug: string): Promise<TenantRecord | null> {
    for (const t of this.tenants.values()) if (t.slug === slug) return t;
    return null;
  }

  async tenantForHost(host: string): Promise<string | null> {
    return this.domains.get(host)?.tenantId ?? null;
  }

  async listTenants(): Promise<readonly TenantRecord[]> {
    return [...this.tenants.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async listDomains(tenantId: string): Promise<readonly TenantDomainRecord[]> {
    return [...this.domains.values()]
      .filter((d) => d.tenantId === tenantId)
      .sort((a, b) => a.host.localeCompare(b.host));
  }

  async listHosts(): Promise<readonly TenantHostRecord[]> {
    return [...this.domains.values()].map((d) => ({
      host: d.host,
      tenantId: d.tenantId,
    }));
  }

  async createTenant(input: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
  }): Promise<TenantRecord> {
    if (!isTenantId(input.id)) throw new Error("Malformed tenant id");
    if (!isTenantSlug(input.slug)) throw new Error("Malformed tenant slug");
    const name = validateTenantName(input.name);
    if (!name) throw new Error("Malformed tenant name");
    if (this.tenants.has(input.id)) {
      throw new TenantDirectoryConflictError("tenant.exists", "Tenant id exists");
    }
    if (await this.getTenantBySlug(input.slug)) {
      throw new TenantDirectoryConflictError("tenant.slug_taken", "Tenant slug is taken");
    }
    const now = new Date().toISOString();
    const record: TenantRecord = {
      id: input.id,
      slug: input.slug,
      name,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.tenants.set(record.id, record);
    return record;
  }

  async addDomain(tenantId: string, host: string): Promise<TenantDomainRecord> {
    const normal = normaliseHost(host);
    if (!normal || normal !== host) throw new Error("Malformed host");
    if (!this.tenants.has(tenantId)) throw new Error("Unknown tenant");
    if (this.domains.has(host)) {
      throw new TenantDirectoryConflictError("tenant.domain_taken", "Host is mapped");
    }
    const record = { host, tenantId, createdAt: new Date().toISOString() };
    this.domains.set(host, record);
    return record;
  }

  async removeDomain(tenantId: string, host: string): Promise<boolean> {
    const d = this.domains.get(host);
    if (!d || d.tenantId !== tenantId) return false;
    this.domains.delete(host);
    return true;
  }

  async setStatus(input: {
    readonly tenantId: string;
    readonly from: readonly TenantStatus[];
    readonly to: TenantStatus;
    readonly by: string;
    readonly reason: string;
  }): Promise<TenantRecord | null> {
    const t = this.tenants.get(input.tenantId);
    if (!t || !input.from.includes(t.status)) return null;
    const now = new Date().toISOString();
    const next: TenantRecord = {
      ...t,
      status: input.to,
      updatedAt: now,
      statusChangedAt: now,
      statusChangedBy: input.by,
      statusReason: input.reason,
    };
    this.tenants.set(t.id, next);
    return next;
  }

  async rename(tenantId: string, name: string): Promise<TenantRecord | null> {
    const t = this.tenants.get(tenantId);
    const clean = validateTenantName(name);
    if (!t || !clean) return null;
    const next = { ...t, name: clean, updatedAt: new Date().toISOString() };
    this.tenants.set(t.id, next);
    return next;
  }
}

// ── Per-instance read cache ───────────────────────────────────────────

const DEFAULT_CACHE_MS = 30_000;
/** How long the last good host snapshot is still served while it cannot be refreshed. */
const DEFAULT_HOST_GRACE_MS = 5 * 60_000;
/** After a failed refresh, how long before the next attempt (bounds queries in an outage). */
const DEFAULT_HOST_RETRY_MS = 5_000;

export interface CachedTenantDirectoryOptions {
  /** How long a read stays fresh (default 30 s). */
  readonly ttlMs?: number;
  /** How long past `ttlMs` the last good host snapshot is served when refreshing fails. */
  readonly hostGraceMs?: number;
  /** The pause after a failed host refresh before the next is tried. */
  readonly hostRetryMs?: number;
  readonly now?: () => number;
}

interface HostSnapshot {
  readonly hosts: ReadonlyMap<string, string>;
  /** When it was read, and the cache generation it was read in. */
  readonly at: number;
  readonly generation: number;
}

/**
 * Caches what every request reads:
 *
 *   tenant by id    per id, for the cache time. Ids come from verified identities and from the
 *                   host snapshot, never from free text.
 *   tenant for host from a snapshot of every address (listHosts), refreshed every cache time
 *                   by one read at a time. A host in no tenant costs no query and adds no entry,
 *                   however many distinct hosts arrive. When a refresh fails, the last good
 *                   snapshot is served for a bounded grace (`hostGraceMs`) with a pause between
 *                   attempts; with no snapshot, or past the grace, lookups throw — which a
 *                   request answers 503 service.unavailable (fail closed, never a guess).
 *
 * Writes go straight through and invalidate everything, before and after the write, so an
 * operator's change — a new address, a suspension, a provisioned tenant — is visible at once on
 * the instance that made it, and within the cache time on every other. Invalidation bumps a
 * generation: a read that started before it never stores its (possibly older) answer.
 */
export class CachedTenantDirectory implements TenantDirectory {
  private readonly byId = new Map<string, { at: number; value: TenantRecord | null }>();
  private generation = 0;
  private snapshot: HostSnapshot | undefined;
  private refreshing:
    { readonly generation: number; readonly promise: Promise<HostSnapshot> } | undefined;
  private failure: { readonly generation: number; readonly retryAt: number } | undefined;
  private readonly ttlMs: number;
  private readonly hostGraceMs: number;
  private readonly hostRetryMs: number;
  private readonly now: () => number;

  constructor(
    private readonly inner: TenantDirectory,
    options: CachedTenantDirectoryOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_CACHE_MS;
    this.hostGraceMs = options.hostGraceMs ?? DEFAULT_HOST_GRACE_MS;
    this.hostRetryMs = options.hostRetryMs ?? DEFAULT_HOST_RETRY_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Forget every cached answer: the next read of each asks the directory again. The last host
   * snapshot is kept only as the fallback for a failed refresh.
   */
  clear(): void {
    this.generation++;
    this.byId.clear();
    this.failure = undefined;
  }

  async getTenant(tenantId: string): Promise<TenantRecord | null> {
    const hit = this.byId.get(tenantId);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const generation = this.generation;
    const value = await this.inner.getTenant(tenantId);
    // A write (and its invalidation) while this read was out may have changed the answer.
    if (generation === this.generation)
      this.byId.set(tenantId, { at: this.now(), value });
    return value;
  }

  getTenantBySlug(slug: string): Promise<TenantRecord | null> {
    return this.inner.getTenantBySlug(slug);
  }

  async tenantForHost(host: string): Promise<string | null> {
    // Only a normalised host can be an address; anything else is no tenant, without a lookup.
    if (normaliseHost(host) !== host) return null;
    return (await this.hosts()).get(host) ?? null;
  }

  /** The current host snapshot, refreshed when stale (see the class comment). */
  private async hosts(): Promise<ReadonlyMap<string, string>> {
    const t = this.now();
    const snap = this.snapshot;
    if (snap && snap.generation === this.generation && t - snap.at < this.ttlMs) {
      return snap.hosts;
    }
    const failed = this.failure;
    if (failed && failed.generation === this.generation && t < failed.retryAt) {
      return this.stale(snap, t, new Error("Tenant addresses unavailable (retrying)"));
    }
    try {
      const fresh = await this.refresh();
      this.failure = undefined;
      return fresh.hosts;
    } catch (err) {
      this.failure = { generation: this.generation, retryAt: t + this.hostRetryMs };
      logger.error("Tenant addresses could not be refreshed", {
        route: "platform/tenancy/directory",
        error: err instanceof Error ? err.message : String(err),
        servingSnapshotFrom: snap ? new Date(snap.at).toISOString() : null,
      });
      return this.stale(snap, t, err);
    }
  }

  /** The last good snapshot while within its grace; otherwise fail closed. */
  private stale(
    snap: HostSnapshot | undefined,
    t: number,
    err: unknown
  ): ReadonlyMap<string, string> {
    if (snap && t - snap.at < this.ttlMs + this.hostGraceMs) return snap.hosts;
    throw err instanceof Error ? err : new Error(String(err));
  }

  /** One read of every address at a time, per generation. */
  private refresh(): Promise<HostSnapshot> {
    const generation = this.generation;
    if (this.refreshing?.generation === generation) return this.refreshing.promise;
    const flight = {
      generation,
      promise: this.load(generation).finally(() => {
        if (this.refreshing === flight) this.refreshing = undefined;
      }),
    };
    this.refreshing = flight;
    return flight.promise;
  }

  /** Read every address; keep it unless a snapshot of a later generation is already held. */
  private async load(generation: number): Promise<HostSnapshot> {
    const rows = await this.inner.listHosts();
    const hosts = new Map<string, string>();
    for (const r of rows) hosts.set(r.host, r.tenantId);
    const next: HostSnapshot = { hosts, at: this.now(), generation };
    if (!this.snapshot || this.snapshot.generation <= generation) this.snapshot = next;
    return next;
  }

  listTenants(): Promise<readonly TenantRecord[]> {
    return this.inner.listTenants();
  }

  listDomains(tenantId: string): Promise<readonly TenantDomainRecord[]> {
    return this.inner.listDomains(tenantId);
  }

  listHosts(): Promise<readonly TenantHostRecord[]> {
    return this.inner.listHosts();
  }

  /** A write: invalidated before (no read now in flight stores) and after (it is seen at once). */
  private async write<T>(fn: () => Promise<T>): Promise<T> {
    this.clear();
    try {
      return await fn();
    } finally {
      this.clear();
    }
  }

  createTenant(input: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
  }): Promise<TenantRecord> {
    return this.write(() => this.inner.createTenant(input));
  }

  addDomain(tenantId: string, host: string): Promise<TenantDomainRecord> {
    return this.write(() => this.inner.addDomain(tenantId, host));
  }

  removeDomain(tenantId: string, host: string): Promise<boolean> {
    return this.write(() => this.inner.removeDomain(tenantId, host));
  }

  setStatus(
    input: Parameters<TenantDirectory["setStatus"]>[0]
  ): Promise<TenantRecord | null> {
    return this.write(() => this.inner.setStatus(input));
  }

  rename(tenantId: string, name: string): Promise<TenantRecord | null> {
    return this.write(() => this.inner.rename(tenantId, name));
  }
}

// ── The process's directory (ADR-032 singleton) ───────────────────────

const KEY = "platform.tenancy.directory";

export function getTenantDirectory(): TenantDirectory {
  return getSingleton<TenantDirectory>(
    KEY,
    () => new CachedTenantDirectory(new InMemoryTenantDirectory())
  );
}

export function setTenantDirectory(directory: TenantDirectory): void {
  setSingleton(KEY, directory);
}
