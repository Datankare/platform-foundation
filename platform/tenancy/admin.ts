/**
 * platform/tenancy/admin.ts — operating tenants (ADR-053 D7)
 *
 * What a platform operator (platform_operate) does to tenants: provision one, map and unmap its
 * addresses, rename, suspend and resume it, delete it (with a second operator's approval),
 * restore it before its data is purged, purge what is due, export a tenant's data, and make a
 * tenant user its first administrator. Each step is recorded in the audit log before it takes
 * effect (no record, no change), in the operator's own tenant, naming the tenant acted on.
 *
 * Every function takes the verified operator — the routes (app/api/operator/*) verify
 * platform_operate; nothing here trusts a caller-supplied identity. All of it runs on the owner
 * connection, the one place row-level security does not apply, so these are the only paths
 * that act across tenants.
 *
 * An operator never suspends or deletes the tenant they are acting from: that would lock the
 * operators out.
 *
 * @module platform/tenancy
 */

import { randomUUID } from "node:crypto";
import { audited, AuditWriteError } from "@/platform/auth/audit";
import { DEFAULT_USER_ROLE } from "@/platform/auth/user-provisioning";
import { invalidatePermissions } from "@/platform/auth/permissions-cache";
import { withOwnerSnapshot, withOwnerTx } from "@/platform/data";
import { isTenantId } from "@/platform/providers/environment-contract";
import { peekTenant } from "./context";
import { TENANT_PURGE_AFTER_DAYS } from "./postgres-directory";
import {
  CachedTenantDirectory,
  TenantDirectoryConflictError,
  getTenantDirectory,
  isTenantSlug,
  normaliseHost,
  validateTenantName,
  type TenantDomainRecord,
  type TenantRecord,
  type TenantStatus,
} from "./directory";

/** The verified operator acting. */
export interface Operator {
  /** users.id of the operator — recorded as the actor. */
  readonly userId: string;
}

export type OperatorFailure =
  | "tenant.not_found"
  | "tenant.exists"
  | "tenant.slug_taken"
  | "tenant.domain_taken"
  | "tenant.invalid"
  | "tenant.state_conflict"
  | "tenant.own_tenant"
  | "tenant.request_not_found"
  | "tenant.self_approval"
  | "tenant.user_not_found"
  | "audit.unavailable";

export type OperatorResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: OperatorFailure; readonly message: string };

const ok = <T>(value: T): OperatorResult<T> => ({ ok: true, value });
const fail = <T>(code: OperatorFailure, message: string): OperatorResult<T> => ({
  ok: false,
  code,
  message,
});

/** Record, then act; an unwritable record stops the action (audit X-8). */
async function recorded<T>(
  operator: Operator,
  type: string,
  details: Record<string, unknown>,
  act: () => Promise<OperatorResult<T>>
): Promise<OperatorResult<T>> {
  try {
    // audited() reads `success`/`error` to record the outcome; the caller gets the result alone.
    const out = await audited(
      { action: "admin_action", actorId: operator.userId, details: { type, ...details } },
      async () => {
        const result = await act();
        return result.ok
          ? { success: true as const, result }
          : { success: false as const, error: result.message, result };
      }
    );
    return out.result;
  } catch (err) {
    if (err instanceof AuditWriteError) {
      return fail(
        "audit.unavailable",
        "The audit log is unavailable, so nothing was changed."
      );
    }
    throw err;
  }
}

function ownTenant(tenantId: string): boolean {
  return peekTenant()?.tenantId === tenantId;
}

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  status_changed_at: Date | null;
  status_changed_by: string | null;
  status_reason: string | null;
}

function tenantOf(row: TenantRow): TenantRecord {
  const status: TenantStatus =
    row.status === "active" || row.status === "deleted" ? row.status : "suspended";
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.status_changed_at
      ? { statusChangedAt: row.status_changed_at.toISOString() }
      : {}),
    ...(row.status_changed_by ? { statusChangedBy: row.status_changed_by } : {}),
    ...(row.status_reason ? { statusReason: row.status_reason } : {}),
  };
}

/**
 * Another tenant's full record, read on the owner connection. The request role's directory
 * answers only a tenant's status unless it is the transaction's own tenant (049
 * directory_tenant), so an operator reads the tenant acted on here.
 */
async function tenantById(tenantId: string): Promise<TenantRecord | null> {
  if (!isTenantId(tenantId)) return null;
  const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
    tx.query<TenantRow>(
      "select id, slug, name, status, created_at, updated_at, status_changed_at, status_changed_by, status_reason from tenants where id = $1::uuid",
      [tenantId]
    )
  );
  return rows[0] ? tenantOf(rows[0]) : null;
}

/**
 * A state change made here in SQL (so it shares a transaction with what it depends on) is seen
 * at once by this instance's directory cache, as one made through the directory is.
 */
function directoryChanged(): void {
  const directory = getTenantDirectory();
  if (directory instanceof CachedTenantDirectory) directory.clear();
}

// ── Reading ───────────────────────────────────────────────────────────

export interface TenantOverview extends TenantRecord {
  readonly domains: readonly string[];
  readonly purgeAfter?: string;
  readonly purgedAt?: string;
  readonly userCount: number;
  readonly pendingDeletion?: { readonly requestId: string; readonly requestedBy: string };
}

interface OverviewRow {
  id: string;
  purge_after: Date | null;
  purged_at: Date | null;
  user_count: number;
  pending_id: string | null;
  pending_by: string | null;
}

/** Every tenant, with its addresses, user count, and any pending deletion. */
export async function listTenantOverviews(): Promise<readonly TenantOverview[]> {
  const directory = getTenantDirectory();
  const tenants = await directory.listTenants();
  const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
    tx.query<OverviewRow>(
      `select t.id, t.purge_after, t.purged_at,
              (select count(*)::int from users u where u.tenant_id = t.id) as user_count,
              r.id as pending_id, r.requested_by as pending_by
         from tenants t
         left join tenant_lifecycle_requests r
           on r.tenant_id = t.id and r.status = 'pending' and r.expires_at > now()`
    )
  );
  const extra = new Map(rows.map((r) => [r.id, r]));
  const out: TenantOverview[] = [];
  for (const t of tenants) {
    const x = extra.get(t.id);
    const domains = (await directory.listDomains(t.id)).map((d) => d.host);
    out.push({
      ...t,
      domains,
      userCount: x?.user_count ?? 0,
      ...(x?.purge_after ? { purgeAfter: x.purge_after.toISOString() } : {}),
      ...(x?.purged_at ? { purgedAt: x.purged_at.toISOString() } : {}),
      ...(x?.pending_id && x.pending_by
        ? { pendingDeletion: { requestId: x.pending_id, requestedBy: x.pending_by } }
        : {}),
    });
  }
  return out;
}

// ── Provisioning and addresses ────────────────────────────────────────

export interface ProvisionInput {
  readonly slug: string;
  readonly name: string;
  readonly domains?: readonly string[];
}

/**
 * A new, active tenant with its addresses. Its configuration is the platform defaults until its
 * administrators (or an operator) set its own; its first administrator is a user who signs up at
 * one of its addresses and is then made administrator (makeTenantAdmin).
 */
export async function provisionTenant(
  operator: Operator,
  input: ProvisionInput
): Promise<OperatorResult<TenantRecord & { readonly domains: readonly string[] }>> {
  const name = validateTenantName(input.name);
  if (!isTenantSlug(input.slug)) {
    return fail(
      "tenant.invalid",
      "The slug must be 1–40 lower-case letters, digits or hyphens."
    );
  }
  if (!name) return fail("tenant.invalid", "The name must be 2–100 characters.");
  const hosts: string[] = [];
  for (const raw of input.domains ?? []) {
    const host = normaliseHost(raw);
    if (!host) return fail("tenant.invalid", `"${raw}" is not a host name.`);
    if (!hosts.includes(host)) hosts.push(host);
  }
  const id = randomUUID();
  return recorded(
    operator,
    "tenant_provisioned",
    { tenantId: id, slug: input.slug, hosts },
    async () => {
      const directory = getTenantDirectory();
      let tenant: TenantRecord;
      try {
        tenant = await directory.createTenant({ id, slug: input.slug, name });
      } catch (err) {
        if (err instanceof TenantDirectoryConflictError)
          return fail(err.code, err.message);
        throw err;
      }
      for (const host of hosts) {
        try {
          await directory.addDomain(tenant.id, host);
        } catch (err) {
          // The tenant exists; report the address that could not be added, keep the rest.
          if (err instanceof TenantDirectoryConflictError) {
            return fail(
              err.code,
              `Tenant created, but ${host} already serves another tenant.`
            );
          }
          throw err;
        }
      }
      return ok({ ...tenant, domains: hosts });
    }
  );
}

export async function addTenantDomain(
  operator: Operator,
  tenantId: string,
  rawHost: string
): Promise<OperatorResult<TenantDomainRecord>> {
  const host = normaliseHost(rawHost);
  if (!host) return fail("tenant.invalid", `"${rawHost}" is not a host name.`);
  const tenant = await tenantById(tenantId);
  if (!tenant) return fail("tenant.not_found", "No such tenant.");
  return recorded(operator, "tenant_domain_added", { tenantId, host }, async () => {
    try {
      return ok(await getTenantDirectory().addDomain(tenantId, host));
    } catch (err) {
      if (err instanceof TenantDirectoryConflictError) return fail(err.code, err.message);
      throw err;
    }
  });
}

/**
 * Unmap an address. The last address of the tenant the operator acts from is never removed: a
 * shared deployment would then answer tenant.unknown_host at every address of it, locking its
 * users — and the operators — out. The check and the removal are one transaction under a lock
 * on the tenant, so two removals at once cannot each leave the other's address as the last.
 */
export async function removeTenantDomain(
  operator: Operator,
  tenantId: string,
  rawHost: string
): Promise<OperatorResult<true>> {
  const host = normaliseHost(rawHost);
  if (!host) return fail("tenant.invalid", `"${rawHost}" is not a host name.`);
  if (!isTenantId(tenantId)) return fail("tenant.not_found", "No such tenant.");
  const own = ownTenant(tenantId);
  return recorded(operator, "tenant_domain_removed", { tenantId, host }, async () => {
    const result = await withOwnerTx("tenant-lifecycle", async (tx) => {
      await tx.query("select 1 from tenants where id = $1::uuid for update", [tenantId]);
      const { rows } = await tx.query<{ n: number; mapped: boolean }>(
        `select count(*)::int as n, coalesce(bool_or(host = $2), false) as mapped
           from tenant_domains where tenant_id = $1::uuid`,
        [tenantId, host]
      );
      if (!rows[0]?.mapped) {
        return fail<true>("tenant.not_found", `${host} does not serve that tenant.`);
      }
      if (own && rows[0].n <= 1) {
        return fail<true>(
          "tenant.own_tenant",
          "You cannot remove the last address of the tenant you are operating from."
        );
      }
      await tx.query(
        "delete from tenant_domains where tenant_id = $1::uuid and host = $2",
        [tenantId, host]
      );
      return ok(true as const);
    });
    if (result.ok) directoryChanged();
    return result;
  });
}

export async function renameTenant(
  operator: Operator,
  tenantId: string,
  rawName: string
): Promise<OperatorResult<TenantRecord>> {
  const name = validateTenantName(rawName);
  if (!name) return fail("tenant.invalid", "The name must be 2–100 characters.");
  return recorded(operator, "tenant_renamed", { tenantId, name }, async () => {
    const t = await getTenantDirectory().rename(tenantId, name);
    return t ? ok(t) : fail("tenant.not_found", "No such tenant.");
  });
}

// ── State ─────────────────────────────────────────────────────────────

function reasonOf(reason: string): string | null {
  const r = typeof reason === "string" ? reason.trim() : "";
  return r.length >= 3 && r.length <= 500 ? r : null;
}

/** Refuse every request of the tenant (tenant.suspended) until resumed. */
export async function suspendTenant(
  operator: Operator,
  tenantId: string,
  reason: string
): Promise<OperatorResult<TenantRecord>> {
  const why = reasonOf(reason);
  if (!why) return fail("tenant.invalid", "Give a reason (3–500 characters).");
  if (ownTenant(tenantId)) {
    return fail(
      "tenant.own_tenant",
      "You cannot suspend the tenant you are operating from."
    );
  }
  return recorded(operator, "tenant_suspended", { tenantId, reason: why }, async () => {
    const t = await getTenantDirectory().setStatus({
      tenantId,
      from: ["active"],
      to: "suspended",
      by: operator.userId,
      reason: why,
    });
    return t ? ok(t) : stateConflict(tenantId, "active");
  });
}

export async function resumeTenant(
  operator: Operator,
  tenantId: string,
  reason: string
): Promise<OperatorResult<TenantRecord>> {
  const why = reasonOf(reason);
  if (!why) return fail("tenant.invalid", "Give a reason (3–500 characters).");
  return recorded(operator, "tenant_resumed", { tenantId, reason: why }, async () => {
    const t = await getTenantDirectory().setStatus({
      tenantId,
      from: ["suspended"],
      to: "active",
      by: operator.userId,
      reason: why,
    });
    return t ? ok(t) : stateConflict(tenantId, "suspended");
  });
}

async function stateConflict<T>(
  tenantId: string,
  expected: string
): Promise<OperatorResult<T>> {
  const t = await tenantById(tenantId);
  return t
    ? fail("tenant.state_conflict", `The tenant is ${t.status}, not ${expected}.`)
    : fail("tenant.not_found", "No such tenant.");
}

// ── Deletion: two operators ───────────────────────────────────────────

export interface DeletionRequest {
  readonly id: string;
  readonly tenantId: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly status: "pending" | "executed" | "rejected" | "expired";
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface RequestRow {
  id: string;
  tenant_id: string;
  requested_by: string;
  reason: string;
  status: DeletionRequest["status"];
  created_at: Date;
  expires_at: Date;
}

const request = (r: RequestRow): DeletionRequest => ({
  id: r.id,
  tenantId: r.tenant_id,
  requestedBy: r.requested_by,
  reason: r.reason,
  status: r.status,
  createdAt: r.created_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
});

/**
 * Ask for a tenant to be deleted. Nothing changes until a different operator approves; the
 * request expires after 7 days. A tenant has at most one open request.
 */
export async function requestTenantDeletion(
  operator: Operator,
  tenantId: string,
  reason: string
): Promise<OperatorResult<DeletionRequest>> {
  const why = reasonOf(reason);
  if (!why) return fail("tenant.invalid", "Give a reason (3–500 characters).");
  if (!isTenantId(tenantId)) return fail("tenant.not_found", "No such tenant.");
  if (ownTenant(tenantId)) {
    return fail(
      "tenant.own_tenant",
      "You cannot delete the tenant you are operating from."
    );
  }
  return recorded(operator, "tenant_deletion_requested", { tenantId, reason: why }, () =>
    withOwnerTx("tenant-lifecycle", async (tx) => {
      const t = await tx.query<{ status: string }>(
        "select status from tenants where id = $1::uuid for update",
        [tenantId]
      );
      if (!t.rows[0]) return fail<DeletionRequest>("tenant.not_found", "No such tenant.");
      if (t.rows[0].status === "deleted") {
        return fail<DeletionRequest>(
          "tenant.state_conflict",
          "The tenant is already deleted."
        );
      }
      // An expired open request no longer counts.
      await tx.query(
        `update tenant_lifecycle_requests set status = 'expired', decided_at = now()
          where tenant_id = $1::uuid and status = 'pending' and expires_at <= now()`,
        [tenantId]
      );
      const { rows } = await tx.query<RequestRow>(
        `insert into tenant_lifecycle_requests (tenant_id, action, reason, requested_by)
         values ($1::uuid, 'delete', $2, $3)
         on conflict (tenant_id, action) where status = 'pending' do nothing
         returning id, tenant_id, requested_by, reason, status, created_at, expires_at`,
        [tenantId, why, operator.userId]
      );
      return rows[0]
        ? ok(request(rows[0]))
        : fail<DeletionRequest>(
            "tenant.state_conflict",
            "A deletion is already awaiting approval."
          );
    })
  );
}

/**
 * Decide a deletion request. Approval must come from an operator other than the requester; it
 * marks the tenant deleted (every request refused at once) and sets its purge time — in the
 * same transaction that marks the request executed, so a request is never executed while its
 * tenant stays undeleted, nor a tenant deleted with its request still open. The requester may
 * reject (withdraw) their own request.
 */
export async function decideTenantDeletion(
  operator: Operator,
  requestId: string,
  approve: boolean,
  note: string
): Promise<OperatorResult<DeletionRequest>> {
  if (!isTenantId(requestId)) return fail("tenant.request_not_found", "No such request.");
  return recorded(
    operator,
    approve ? "tenant_deletion_approved" : "tenant_deletion_rejected",
    { requestId, note },
    async () => {
      const outcome = await withOwnerTx("tenant-lifecycle", async (tx) => {
        const { rows } = await tx.query<RequestRow>(
          `select id, tenant_id, requested_by, reason, status, created_at, expires_at
             from tenant_lifecycle_requests where id = $1::uuid for update`,
          [requestId]
        );
        const r = rows[0];
        if (!r)
          return fail<DeletionRequest>("tenant.request_not_found", "No such request.");
        if (r.status !== "pending") {
          return fail<DeletionRequest>(
            "tenant.state_conflict",
            `The request is ${r.status}.`
          );
        }
        if (r.expires_at <= new Date()) {
          await tx.query(
            "update tenant_lifecycle_requests set status = 'expired', decided_at = now() where id = $1::uuid",
            [requestId]
          );
          return fail<DeletionRequest>(
            "tenant.state_conflict",
            "The request has expired."
          );
        }
        if (approve && r.requested_by === operator.userId) {
          return fail<DeletionRequest>(
            "tenant.self_approval",
            "A different operator must approve a deletion you requested."
          );
        }
        if (approve && ownTenant(r.tenant_id)) {
          return fail<DeletionRequest>(
            "tenant.own_tenant",
            "You cannot delete the tenant you are operating from."
          );
        }
        if (approve) {
          // First, so a tenant not in a deletable state leaves the request as it was.
          const deleted = await tx.query(
            `update tenants
                set status = 'deleted', status_changed_at = now(), status_changed_by = $2,
                    status_reason = $3, updated_at = now(),
                    purge_after = now() + make_interval(days => $4)
              where id = $1::uuid and status in ('active', 'suspended')`,
            [r.tenant_id, operator.userId, r.reason, TENANT_PURGE_AFTER_DAYS]
          );
          if (deleted.rowCount !== 1) {
            return fail<DeletionRequest>(
              "tenant.state_conflict",
              "The tenant is no longer active or suspended."
            );
          }
        }
        const decided = await tx.query<RequestRow>(
          `update tenant_lifecycle_requests
              set status = $2, decided_by = $3, decided_at = now(), decision_note = $4
            where id = $1::uuid and status = 'pending'
            returning id, tenant_id, requested_by, reason, status, created_at, expires_at`,
          [
            requestId,
            approve ? "executed" : "rejected",
            operator.userId,
            note.slice(0, 500),
          ]
        );
        return ok(request(decided.rows[0]));
      });
      if (outcome.ok && approve) directoryChanged();
      return outcome;
    }
  );
}

/**
 * Bring a deleted tenant back, suspended, before its data is purged. One statement changes the
 * tenant only while it is deleted and not purged; a purge locks the same row and re-reads its
 * state (049 tenant_purge), so a restore and a purge at once end with exactly one of them done.
 */
export async function restoreTenant(
  operator: Operator,
  tenantId: string,
  reason: string
): Promise<OperatorResult<TenantRecord>> {
  const why = reasonOf(reason);
  if (!why) return fail("tenant.invalid", "Give a reason (3–500 characters).");
  if (!isTenantId(tenantId)) return fail("tenant.not_found", "No such tenant.");
  const before = await withOwnerTx("tenant-lifecycle", (tx) =>
    tx.query<{ purged_at: Date | null }>(
      "select purged_at from tenants where id = $1::uuid",
      [tenantId]
    )
  );
  if (!before.rows[0]) return fail("tenant.not_found", "No such tenant.");
  if (before.rows[0].purged_at) return purgedAlready();
  return recorded(operator, "tenant_restored", { tenantId, reason: why }, async () => {
    const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query<TenantRow>(
        `update tenants
            set status = 'suspended', status_changed_at = now(), status_changed_by = $2,
                status_reason = $3, updated_at = now(), purge_after = null
          where id = $1::uuid and status = 'deleted' and purged_at is null
          returning id, slug, name, status, created_at, updated_at, status_changed_at,
                    status_changed_by, status_reason`,
        [tenantId, operator.userId, why]
      )
    );
    if (rows[0]) {
      directoryChanged();
      return ok(tenantOf(rows[0]));
    }
    const now = await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query<{ purged_at: Date | null }>(
        "select purged_at from tenants where id = $1::uuid",
        [tenantId]
      )
    );
    return now.rows[0]?.purged_at ? purgedAlready() : stateConflict(tenantId, "deleted");
  });
}

function purgedAlready<T>(): OperatorResult<T> {
  return fail(
    "tenant.state_conflict",
    "The tenant's data has been purged; it cannot be restored."
  );
}

/** Purge the data of every deleted tenant whose purge time has passed. */
export async function purgeDueTenants(
  operator: Operator
): Promise<OperatorResult<readonly { tenantId: string; rows: number }[]>> {
  const due = await withOwnerTx("tenant-lifecycle", (tx) =>
    tx.query<{ id: string }>(
      `select id from tenants
        where status = 'deleted' and purged_at is null and purge_after <= now()
        order by purge_after`
    )
  );
  const done: { tenantId: string; rows: number }[] = [];
  for (const { id } of due.rows) {
    const r = await recorded(operator, "tenant_purged", { tenantId: id }, async () => {
      const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
        tx.query<{ deleted: string }>(
          "select deleted from public.tenant_purge($1::uuid)",
          [id]
        )
      );
      return ok(rows.reduce((n, x) => n + Number(x.deleted), 0));
    });
    if (!r.ok) return r;
    done.push({ tenantId: id, rows: r.value });
  }
  return ok(done);
}

// ── Export ────────────────────────────────────────────────────────────

/**
 * Write every row a tenant owns to `write`, as newline-delimited JSON — one
 * `{ "table": …, "row": … }` per line — from one consistent snapshot, read through a cursor so a
 * large tenant is never held in memory. `write` may wait (a slow reader); the snapshot waits
 * with it. Returns the number of rows written.
 */
export async function writeTenantExport(
  tenantId: string,
  write: (chunk: string) => Promise<void>
): Promise<number> {
  return withOwnerSnapshot("tenant-lifecycle", async (tx) => {
    // First line: what this export is — the tenant, its addresses, and the snapshot's time —
    // so a file says whose data it holds and as of when, without the operator's notes.
    const { rows: head } = await tx.query<{ header: unknown }>(
      `select json_build_object(
                'format', 1,
                'tenant', json_build_object('id', t.id, 'slug', t.slug, 'name', t.name,
                                            'status', t.status, 'createdAt', t.created_at),
                'domains', coalesce((select json_agg(d.host order by d.host)
                                       from public.tenant_domains d where d.tenant_id = t.id),
                                    '[]'::json),
                'at', transaction_timestamp()) as header
         from public.tenants t where t.id = $1::uuid`,
      [tenantId]
    );
    await write(JSON.stringify({ export: head[0]?.header ?? null }) + "\n");
    const { rows: tables } = await tx.query<{ table_name: string }>(
      "select table_name from public.tenant_tables()"
    );
    let count = 0;
    for (const { table_name } of tables) {
      await tx.query(
        "declare tenant_export no scroll cursor for select r from public.tenant_export_rows($1, $2::uuid) r",
        [table_name, tenantId]
      );
      for (;;) {
        const { rows } = await tx.query<{ r: unknown }>("fetch 500 from tenant_export");
        if (rows.length === 0) break;
        let chunk = "";
        for (const { r } of rows)
          chunk += JSON.stringify({ table: table_name, row: r }) + "\n";
        count += rows.length;
        await write(chunk);
      }
      await tx.query("close tenant_export");
    }
    return count;
  });
}

/** Record an export (no record, no export), then stream it to `write`. */
export async function exportTenantData(
  operator: Operator,
  tenantId: string,
  write: (chunk: string) => Promise<void>
): Promise<OperatorResult<number>> {
  const t = await tenantById(tenantId);
  if (!t) return fail("tenant.not_found", "No such tenant.");
  return recorded(operator, "tenant_exported", { tenantId }, async () =>
    ok(await writeTenantExport(tenantId, write))
  );
}

// ── The first administrator ───────────────────────────────────────────

interface PromotionRow {
  live: number;
  verified: number;
  id: string | null;
  cognito_sub: string | null;
}

/**
 * Make a user of the tenant (found by email) its administrator — how a new tenant gets its first
 * admin. The user must already exist in that tenant (signed up at one of its addresses), and be
 * the one live account with that address: not deleted, its email verified (users.email_verified,
 * recorded from the identity provider when the account was created). Exactly one such account
 * is promoted, or none: one statement counts the candidates and updates only when there is
 * exactly one, so an address shared by two accounts never makes both administrators.
 *
 * Emails are not unique per tenant in the schema: nothing at sign-up stops two identities of one
 * tenant from carrying the same address, so a unique index on (tenant_id, lower(email)) could
 * fail on existing data and is not added; the refusal below covers it.
 */
export async function makeTenantAdmin(
  operator: Operator,
  tenantId: string,
  email: string
): Promise<OperatorResult<{ readonly userId: string }>> {
  const address = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+$/.test(address) || address.length > 320) {
    return fail("tenant.invalid", "Give the user's email address.");
  }
  if (!isTenantId(tenantId)) return fail("tenant.not_found", "No such tenant.");
  return recorded(operator, "tenant_admin_granted", { tenantId, email: address }, () =>
    withOwnerTx("tenant-lifecycle", async (tx) => {
      const { rows } = await tx.query<PromotionRow>(
        `with candidates as (
           select id, email_verified from users
            where tenant_id = $1::uuid and lower(email) = $2 and deleted_at is null
            for update
         ),
         tally as (
           select count(*)::int as live,
                  count(*) filter (where email_verified)::int as verified
             from candidates
         ),
         promoted as (
           update users u set role_id = (select r.id from roles r where r.name = 'admin')
             from tally
            where tally.live = 1 and tally.verified = 1
              and u.tenant_id = $1::uuid
              and u.id in (select c.id from candidates c)
           returning u.id, u.cognito_sub
         )
         select tally.live, tally.verified, p.id, p.cognito_sub
           from tally left join promoted p on true`,
        [tenantId, address]
      );
      const r = rows[0];
      if (!r || r.live === 0) {
        return fail<{ userId: string }>(
          "tenant.user_not_found",
          "No user with that email in this tenant; they must sign up at one of its addresses first."
        );
      }
      if (r.live > 1) {
        return fail<{ userId: string }>(
          "tenant.state_conflict",
          "More than one account in this tenant has that email; none was made administrator."
        );
      }
      if (!r.id) {
        return fail<{ userId: string }>(
          "tenant.state_conflict",
          "That account has not verified its email; it was not made administrator."
        );
      }
      if (r.cognito_sub) invalidatePermissions(r.cognito_sub);
      return ok({ userId: r.id });
    })
  );
}

/** The role a tenant's users start with, re-exported for the operator console's display. */
export const TENANT_DEFAULT_ROLE = DEFAULT_USER_ROLE;
