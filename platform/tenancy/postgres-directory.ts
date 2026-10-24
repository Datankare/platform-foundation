/**
 * platform/tenancy/postgres-directory.ts — the tenant directory on Postgres (ADR-053 D2, D7)
 *
 * Requests ask two questions — which tenant serves this host, and what state is this tenant
 * in — through the owner-rights functions directory_host() and directory_tenant(), which answer
 * one row each: the request role (app_tenant) cannot read the tenants or tenant_domains tables,
 * so no tenant can list another. The per-instance host snapshot (listHosts) reads every address
 * on the owner connection, once per refresh, never per request. Everything else — listing,
 * creating, mapping domains, changing state — is an operator's, on the owner connection
 * (withOwnerTx "tenant-lifecycle"), always through platform/tenancy/admin.ts, which audits it.
 *
 * @module platform/tenancy
 */

import { withOwnerTx, withPlatformTx, withTenantTx, type Tx } from "@/platform/data";
import { isTenantId } from "@/platform/providers/environment-contract";
import { peekTenant } from "./context";
import {
  TenantDirectoryConflictError,
  isTenantSlug,
  normaliseHost,
  validateTenantName,
  type TenantDirectory,
  type TenantDomainRecord,
  type TenantHostRecord,
  type TenantRecord,
  type TenantStatus,
} from "./directory";

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
  status_changed_at: Date | string | null;
  status_changed_by: string | null;
  status_reason: string | null;
}

interface DomainRow {
  host: string;
  tenant_id: string;
  created_at: Date | string;
}

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : v);

function status(raw: string): TenantStatus {
  if (raw === "active" || raw === "suspended" || raw === "deleted") return raw;
  // An unknown state is never "active".
  return "suspended";
}

function tenant(row: TenantRow): TenantRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: status(row.status),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.status_changed_at ? { statusChangedAt: iso(row.status_changed_at) } : {}),
    ...(row.status_changed_by ? { statusChangedBy: row.status_changed_by } : {}),
    ...(row.status_reason ? { statusReason: row.status_reason } : {}),
  };
}

function domain(row: DomainRow): TenantDomainRecord {
  return { host: row.host, tenantId: row.tenant_id, createdAt: iso(row.created_at) };
}

/** The days a deleted tenant's data is kept before it is purged (D7). */
export const TENANT_PURGE_AFTER_DAYS = 30;

export class PostgresTenantDirectory implements TenantDirectory {
  async getTenant(tenantId: string): Promise<TenantRecord | null> {
    if (!isTenantId(tenantId)) return null;
    // directory_tenant answers any tenant's status, and its slug, name and dates only inside
    // that tenant's own transaction (never who changed its status, or why): asked from within
    // the tenant, ask in its transaction. Operators read other tenants on the owner connection.
    const read = (tx: Tx) =>
      tx.query<TenantRow>("select * from public.directory_tenant($1::uuid)", [tenantId]);
    const { rows } = await (peekTenant()?.tenantId === tenantId
      ? withTenantTx(read)
      : withPlatformTx(read));
    return rows[0] ? tenant(rows[0]) : null;
  }

  async tenantForHost(host: string): Promise<string | null> {
    if (normaliseHost(host) !== host) return null;
    const { rows } = await withPlatformTx((tx) =>
      tx.query<{ t: string | null }>("select public.directory_host($1) as t", [host])
    );
    return rows[0]?.t ?? null;
  }

  async getTenantBySlug(slug: string): Promise<TenantRecord | null> {
    if (!isTenantSlug(slug)) return null;
    const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query<TenantRow>(
        `select id, slug, name, status, created_at, updated_at, status_changed_at,
                status_changed_by, status_reason
           from tenants where slug = $1`,
        [slug]
      )
    );
    return rows[0] ? tenant(rows[0]) : null;
  }

  async listTenants(): Promise<readonly TenantRecord[]> {
    const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query<TenantRow>(
        `select id, slug, name, status, created_at, updated_at, status_changed_at,
                status_changed_by, status_reason
           from tenants order by slug`
      )
    );
    return rows.map(tenant);
  }

  async listDomains(tenantId: string): Promise<readonly TenantDomainRecord[]> {
    if (!isTenantId(tenantId)) return [];
    const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query<DomainRow>(
        "select host, tenant_id, created_at from tenant_domains where tenant_id = $1::uuid order by host",
        [tenantId]
      )
    );
    return rows.map(domain);
  }

  /**
   * Every address, for the per-instance host snapshot (CachedTenantDirectory): one read per
   * refresh on the owner connection — the request role cannot list addresses, and must not.
   */
  async listHosts(): Promise<readonly TenantHostRecord[]> {
    const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query<{ host: string; tenant_id: string }>(
        "select host, tenant_id from tenant_domains"
      )
    );
    return rows.map((r) => ({ host: r.host, tenantId: r.tenant_id }));
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
    try {
      const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
        tx.query<TenantRow>(
          `insert into tenants (id, slug, name) values ($1::uuid, $2, $3)
           returning id, slug, name, status, created_at, updated_at, status_changed_at,
                     status_changed_by, status_reason`,
          [input.id, input.slug, name]
        )
      );
      return tenant(rows[0]);
    } catch (err) {
      throw conflict(err) ?? err;
    }
  }

  async addDomain(tenantId: string, host: string): Promise<TenantDomainRecord> {
    if (normaliseHost(host) !== host) throw new Error("Malformed host");
    if (!isTenantId(tenantId)) throw new Error("Unknown tenant");
    try {
      const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
        tx.query<DomainRow>(
          `insert into tenant_domains (host, tenant_id) values ($1, $2::uuid)
           returning host, tenant_id, created_at`,
          [host, tenantId]
        )
      );
      return domain(rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === "23503") throw new Error("Unknown tenant");
      throw conflict(err) ?? err;
    }
  }

  async removeDomain(tenantId: string, host: string): Promise<boolean> {
    if (!isTenantId(tenantId)) return false;
    const r = await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query("delete from tenant_domains where tenant_id = $1::uuid and host = $2", [
        tenantId,
        host,
      ])
    );
    return r.rowCount === 1;
  }

  async setStatus(input: {
    readonly tenantId: string;
    readonly from: readonly TenantStatus[];
    readonly to: TenantStatus;
    readonly by: string;
    readonly reason: string;
  }): Promise<TenantRecord | null> {
    if (!isTenantId(input.tenantId)) return null;
    const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query<TenantRow>(
        `update tenants
            set status = $3, status_changed_at = now(), status_changed_by = $4,
                status_reason = $5, updated_at = now(),
                purge_after = case when $3 = 'deleted'
                                   then now() + make_interval(days => $6)
                                   else null end
          where id = $1::uuid and status = any($2::text[])
          returning id, slug, name, status, created_at, updated_at, status_changed_at,
                    status_changed_by, status_reason`,
        [
          input.tenantId,
          input.from,
          input.to,
          input.by,
          input.reason,
          TENANT_PURGE_AFTER_DAYS,
        ]
      )
    );
    return rows[0] ? tenant(rows[0]) : null;
  }

  async rename(tenantId: string, name: string): Promise<TenantRecord | null> {
    const clean = validateTenantName(name);
    if (!clean || !isTenantId(tenantId)) return null;
    const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query<TenantRow>(
        `update tenants set name = $2, updated_at = now() where id = $1::uuid
         returning id, slug, name, status, created_at, updated_at, status_changed_at,
                   status_changed_by, status_reason`,
        [tenantId, clean]
      )
    );
    return rows[0] ? tenant(rows[0]) : null;
  }
}

/** A unique violation as the directory's conflict error. */
function conflict(err: unknown): TenantDirectoryConflictError | null {
  const e = err as { code?: string; constraint?: string };
  if (e.code !== "23505") return null;
  if (e.constraint === "tenants_pkey") {
    return new TenantDirectoryConflictError("tenant.exists", "Tenant id exists");
  }
  if (e.constraint === "tenants_slug_key") {
    return new TenantDirectoryConflictError("tenant.slug_taken", "Tenant slug is taken");
  }
  if (e.constraint === "tenant_domains_pkey") {
    return new TenantDirectoryConflictError("tenant.domain_taken", "Host is mapped");
  }
  return null;
}
