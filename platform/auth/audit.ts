/**
 * platform/auth/audit.ts — Audit logging
 *
 * Writes immutable audit log entries for all security-relevant events:
 * role changes, permission grants/revokes, entitlement changes,
 * profile updates, admin actions, login events.
 *
 * Records are written and read through platform/data in the request's tenant (ADR-053 D4):
 * tenant_id is filled by the column default and row-level security keeps each tenant's records
 * apart. The application never updates or deletes an audit row — append-only by design.
 *
 * A security-relevant action is recorded BEFORE it takes effect and does not run when the record
 * cannot be written (audited(), recordAudit()). Until Sprint 7X every write was fire-and-forget:
 * placeholder actor ids and an action the enum rejected meant whole classes of admin and
 * moderation actions were never recorded, and nothing noticed (audit X-8).
 *
 * Sprint 3, Task 3.6 · Sprint 7X (fail closed)
 */

import {
  inTransaction,
  onRollback,
  withSeparateTenantTx,
  withTenantTx,
  type Tx,
} from "@/platform/data";
import { currentAuditCorrelation } from "@/platform/kernel/audit-correlation";
import { randomUUID } from "node:crypto";
import { assertStorableJson } from "@/platform/errors/json-limits";
import { ExportTooLargeError } from "@/platform/auth/user-data";
import { logger } from "@/lib/logger";
import { AUDIT_ACTIONS, type AuditAction } from "@/platform/auth/audit-actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The action names live in ./audit-actions (client-safe, TASK-190: the command bar's confirm
// panel validates a search's `action` filter with the server's own check).
export { AUDIT_ACTIONS, type AuditAction };

export interface AuditEntry {
  action: AuditAction;
  /** The person who acted: a users.id. Never a placeholder — a non-id is refused. */
  actorId?: string;
  /** The agent or system process that acted, when no person did (e.g. "escalation-reaper"). */
  agent?: string;
  /** The person acted upon: a users.id. */
  targetId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/** An audit record could not be written, so the action it records must not proceed. */
export class AuditWriteError extends Error {
  constructor(
    readonly action: AuditAction,
    cause: string
  ) {
    super(`Audit record for ${action} could not be written: ${cause}`);
    this.name = "AuditWriteError";
  }
}

/**
 * An act that reaches outside the database was audited inside an open transaction (review 13 L5):
 * a rollback could not undo it, so its record could not be true. A programming error: run the act
 * outside the transaction, or make it database-only.
 */
export class AuditedExternalActError extends Error {
  readonly code = "data.scope";
  constructor(readonly action: AuditAction) {
    super(
      `audited(${action}) is an external act and cannot run inside a transaction: a rollback would not undo it`
    );
    this.name = "AuditedExternalActError";
  }
}

/**
 * Write an audit record, or throw AuditWriteError. Use for every security-relevant action —
 * through audited() when the record must precede the action.
 */
export async function recordAudit(
  entry: AuditEntry,
  options: { readonly outsideTransaction?: boolean } = {}
): Promise<void> {
  // Placeholder actor ids ("authenticated-admin", "dev-admin", agent names) went into a uuid
  // column, failed, and were swallowed (audit X-8). An agent or process is named in `agent`.
  for (const [field, value] of [
    ["actorId", entry.actorId],
    ["targetId", entry.targetId],
  ] as const) {
    if (value && !UUID.test(value)) {
      logger.error("Audit record refused: not a user id", {
        field,
        action: entry.action,
        route: "platform/auth/audit",
      });
      throw new AuditWriteError(entry.action, `${field} is not a user id`);
    }
  }
  const details = entry.agent
    ? { ...entry.details, agent: entry.agent }
    : entry.details || {};
  // Details often carry caller-shaped JSON: bounded before they are stored (review 9 H2). A
  // refusal is coded (request.json_too_deep / json_too_large), and the audited act does not run.
  assertStorableJson(details, "audit_log.details");
  let failure: string | undefined;
  // A record of an attempt is written in its own transaction when asked (review 11 L-6): inside
  // an atomic action's transaction it would roll back with the action it records.
  // (A stand-in data layer — a test's — that has no notion of an open transaction joins none.)
  const joined = typeof inTransaction === "function" && inTransaction();
  const inTx = options.outsideTransaction && joined ? withSeparateTenantTx : withTenantTx;
  try {
    await inTx((tx) =>
      tx.query(
        `insert into audit_log (action, actor_id, target_id, details, ip_address, user_agent)
         values ($1::audit_action, $2::uuid, $3::uuid, $4::jsonb, $5::inet, $6)`,
        [
          entry.action,
          entry.actorId || null,
          entry.targetId || null,
          JSON.stringify(details),
          entry.ipAddress || null,
          entry.userAgent || null,
        ]
      )
    );
  } catch (err) {
    failure = err instanceof Error ? err.message : "Unknown error";
  }
  if (failure !== undefined) {
    logger.error("Audit record could not be written", {
      error: failure,
      action: entry.action,
      actorId: entry.actorId,
      targetId: entry.targetId,
      route: "platform/auth/audit",
    });
    throw new AuditWriteError(entry.action, failure);
  }
}

/**
 * Whether `value` — an act's error or its result — says the act's own transaction lost its commit:
 * the act may have taken effect (platform/data CommitOutcomeUnknownError, or a result carrying
 * `indeterminate: true`). Read by shape, not by class: a stand-in data layer (a test's) has its own.
 */
function isIndeterminate(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { indeterminate?: unknown }).indeterminate === true
  );
}

const INDETERMINATE_REASON =
  "the connection failed while the transaction it ran in was committing: whether it took effect is unknown";

/** Whether an action's result reports failure ({ success: false } or { error }). */
function reportsFailure(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as { success?: unknown; error?: unknown };
  return r.success === false || (r.error !== undefined && r.error !== null);
}

/**
 * Record `entry`, then run `act`. If the record cannot be written, `act` never runs and
 * AuditWriteError is thrown. If `act` reports failure or throws, a follow-up record says so
 * (best effort — the attempt is already on file). With `recordSuccess`, a follow-up record says
 * when it succeeded, too (attempted → succeeded | failed: the kill switch, review 12 L3).
 *
 * Inside a transaction (review 12 L1): the records name the approved run they belong to (its hold
 * and operation, when the pipeline set them — audit-correlation.ts) and an `attemptId` shared by
 * all of them; if the act succeeded and the transaction then rolls back, a `rolled_back` record
 * is written after the rollback — "attempted" alone is never left standing for an act that was
 * undone. If the transaction's commit was lost with its connection, whether the act stands is not
 * known: the record says `indeterminate` (review 13 L5), never `rolled_back`.
 *
 * Outside a transaction, an act that opens its own and loses ITS commit (review 14 L-2) — it
 * throws platform/data's CommitOutcomeUnknownError, or reports `{ indeterminate: true }` — is
 * recorded `indeterminate` too, never `failed`: the change may stand.
 *
 * AN ACT RUN INSIDE A TRANSACTION MUST BE DATABASE-ONLY (review 13 L5): a rollback undoes its
 * writes, and `rolled_back` is true only of them. An act that reaches outside the database (an
 * identity provider, e-mail, a webhook, another service) cannot be undone by a rollback, so its
 * `rolled_back` record would be false. Such an act passes `{ external: true }`: inside an open
 * transaction it is refused (AuditedExternalActError — nothing recorded, nothing run); outside
 * one it runs as before. A step that must follow the transaction's writes (a cache invalidation)
 * is registered with onCommit (platform/data), not run inside the act.
 * __tests__/audited-external-guard.test.ts reads every call site (TypeScript compiler API, review
 * 14 L-6): an act that calls an external module (Cognito, AWS, e-mail, fetch, the AI and speech
 * providers) or a function tagged `@external` in its JSDoc — directly or through a function of its
 * own file — must carry `{ external: true }`, and an act that does not, must not. A helper that
 * reaches outside (or runs hooks that may) carries `@external`; a wrapper of audited() forwards
 * its `options`.
 */
export async function audited<T>(
  entry: AuditEntry,
  act: () => Promise<T>,
  options: {
    readonly recordSuccess?: boolean;
    /** The act reaches outside the database: refused inside a transaction (review 13 L5). */
    readonly external?: boolean;
  } = {}
): Promise<T> {
  const joined = typeof inTransaction === "function" && inTransaction();
  if (options.external && joined) {
    throw new AuditedExternalActError(entry.action);
  }
  const correlation = currentAuditCorrelation();
  const tagged: AuditEntry =
    joined || correlation
      ? {
          ...entry,
          details: {
            ...entry.details,
            ...(correlation?.holdId ? { holdId: correlation.holdId } : {}),
            ...(correlation?.operationId ? { operationId: correlation.operationId } : {}),
            ...(joined ? { attemptId: randomUUID() } : {}),
          },
        }
      : entry;
  // The attempt and the failure are records of what was tried: each in its own transaction, so
  // an action run inside a larger one (an atomic approved run, review 11 L-6) that rolls back
  // still leaves them — and the run's own failure is recorded after the rollback (tool-invoker).
  await recordAudit(
    { ...tagged, details: { ...tagged.details, outcome: "attempted" } },
    { outsideTransaction: true }
  );
  let result: T;
  try {
    result = await act();
  } catch (err) {
    if (isIndeterminate(err)) {
      await recordOutcome(tagged, "indeterminate", INDETERMINATE_REASON);
    } else {
      await recordOutcome(
        tagged,
        "failed",
        err instanceof Error ? err.message : String(err)
      );
    }
    throw err;
  }
  if (isIndeterminate(result)) {
    await recordOutcome(tagged, "indeterminate", INDETERMINATE_REASON);
    return result;
  }
  const failed = reportsFailure(result);
  if (failed) {
    const error = (result as { error?: unknown }).error;
    await recordOutcome(
      tagged,
      "failed",
      typeof error === "string" ? error : "reported failure"
    );
  } else if (options.recordSuccess) {
    await recordOutcome(tagged, "succeeded");
  }
  // Done, inside a transaction that may yet roll back: if it does, say so (review 12 L1).
  if (!failed && joined && typeof onRollback === "function") {
    onRollback((ended) =>
      ended === "indeterminate"
        ? recordOutcome(tagged, "indeterminate", INDETERMINATE_REASON)
        : recordOutcome(tagged, "rolled_back", "the transaction it ran in rolled back")
    );
  }
  return result;
}

async function recordOutcome(
  entry: AuditEntry,
  outcome: "failed" | "succeeded" | "rolled_back" | "indeterminate",
  reason?: string
): Promise<void> {
  try {
    await recordAudit(
      {
        ...entry,
        details: {
          ...entry.details,
          outcome,
          ...(reason !== undefined ? { reason: reason.slice(0, 500) } : {}),
        },
      },
      { outsideTransaction: true }
    );
  } catch {
    // Already logged by recordAudit; the attempt record stands.
  }
}

/**
 * Write an audit entry without blocking the caller on failure — for events that are records of
 * something already done elsewhere and must not undo it (sign-in telemetry, nudges). Failures
 * are logged. Every security-relevant action uses audited() or recordAudit() instead.
 */
export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  try {
    await recordAudit(entry);
  } catch {
    // Logged by recordAudit.
  }
}

/**
 * writeAuditLog in a transaction of its own: never rolled back with a transaction the caller is
 * in (review 11 L-6). For records of an outcome written after the run they describe.
 */
export async function writeAuditLogOutsideTransaction(entry: AuditEntry): Promise<void> {
  try {
    await recordAudit(entry, { outsideTransaction: true });
  } catch {
    // Logged by recordAudit.
  }
}

/** An audit row as stored; timestamps as ISO strings (the JSON form of the row). */
export type AuditRow = Record<string, unknown> & {
  id: string;
  action: string;
  actor_id: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
};

/**
 * Audit rows of the current tenant where `userId` is the actor or the target, newest first, at
 * most `limit`, inside the caller's transaction. `userId` must be a UUID (callers check).
 */
export async function auditRowsForUser(
  tx: Tx,
  userId: string,
  limit: number
): Promise<AuditRow[]> {
  const { rows } = await tx.query<{ r: AuditRow }>(
    `select to_jsonb(a) as r from audit_log a
      where a.actor_id = $1::uuid or a.target_id = $1::uuid
      order by a.created_at desc, a.id
      limit $2`,
    [userId, limit]
  );
  return rows.map((row) => row.r);
}

/**
 * The keys of an audit row's details that describe what was done to the account (review 7 M1),
 * given on export when someone else did it: the change itself (from, to, the role, the
 * entitlement, until when), never the actor's own record of it (their notes, reasons, internal
 * ids such as review items or trajectories). The user's own acts are exported with their details
 * whole.
 */
export const EXPORTED_DETAIL_KEYS: readonly string[] = [
  "type",
  "phase",
  "from",
  "to",
  "until",
  "oldRole",
  "newRole",
  "entitlementGroupId",
  "expiresAt",
  "decision",
  "modifiedAction",
  "originalAction",
  "source",
  "status",
  "previousStatus",
  "newStatus",
  "feature",
  "consentType",
  "granted",
  "factor",
  "method",
];

/** An audit row as an export gives it (review 7 M1); see auditRowsForExport. */
export type ExportedAuditRow = Record<string, unknown> & {
  id: string;
  action: string;
  created_at: string;
};

/**
 * Every audit row of the current tenant where `userId` is the actor or the target, newest first,
 * read in pages of `pageSize` inside the caller's transaction (one snapshot: data-export) —
 * every row, never cut off (review 7 M2: the export stopped at 500). More than `maxRows`:
 * ExportTooLargeError, the export is refused whole.
 *
 * What a row holds depends on whose act it records (review 7 M1 — before, `to_jsonb(a)` gave a
 * staff member's network address, browser, id and notes on every act about the user):
 *   - the user's own act: id, action, when, actor and target, their own address and browser,
 *     the details;
 *   - an act by someone else on the user: id, action, when, `by` ("another account" or "the
 *     platform"), the target (the user) and of the details only EXPORTED_DETAIL_KEYS — no actor
 *     id, address, browser or notes.
 */
export async function auditRowsForExport(
  tx: Tx,
  userId: string,
  options: { readonly pageSize: number; readonly maxRows: number }
): Promise<ExportedAuditRow[]> {
  if (!UUID.test(userId)) throw new Error("invalid user id");
  const out: ExportedAuditRow[] = [];
  let after: { at: string; id: string } | null = null;
  for (;;) {
    const page: { rows: { r: ExportedAuditRow; kc: string; ki: string }[] } =
      await tx.query<{ r: ExportedAuditRow; kc: string; ki: string }>(
        `select case when a.actor_id = $1::uuid
                  then jsonb_build_object('id', a.id, 'action', a.action, 'created_at', a.created_at,
                         'actor_id', a.actor_id, 'target_id', a.target_id,
                         'ip_address', a.ip_address, 'user_agent', a.user_agent,
                         'details', a.details)
                  else jsonb_build_object('id', a.id, 'action', a.action, 'created_at', a.created_at,
                         'by', case when a.actor_id is null then 'the platform'
                                    else 'another account' end,
                         'target_id', a.target_id,
                         'details', coalesce((select jsonb_object_agg(e.key, e.value)
                                                from jsonb_each(a.details) e
                                               where e.key = any($3::text[])), '{}'::jsonb))
                end as r,
                a.created_at::text as kc, a.id::text as ki
           from audit_log a
          where (a.actor_id = $1::uuid or a.target_id = $1::uuid)
            and ($4::text is null or (a.created_at, a.id) < ($4::timestamptz, $5::uuid))
          order by a.created_at desc, a.id desc
          limit $2::int`,
        [
          userId,
          options.pageSize,
          EXPORTED_DETAIL_KEYS,
          after?.at ?? null,
          after?.id ?? null,
        ]
      );
    for (const row of page.rows) out.push(row.r);
    if (out.length > options.maxRows) throw new ExportTooLargeError(options.maxRows);
    if (page.rows.length < options.pageSize) return out;
    const last = page.rows[page.rows.length - 1];
    after = { at: last.kc, id: last.ki };
  }
}

/**
 * Read audit log entries for a specific user, in the current tenant.
 * Returns entries where the user is either actor or target; an unreadable log reads as none.
 * Admin only — the routes that call this check the permission.
 */
export async function getAuditLogForUser(
  userId: string,
  limit: number = 50
): Promise<AuditEntry[]> {
  // A non-UUID is refused before it reaches the query.
  if (!UUID.test(userId)) return [];
  const bounded = Math.max(1, Math.min(Math.trunc(limit) || 50, 500));
  let rows: AuditRow[];
  try {
    rows = await withTenantTx((tx) => auditRowsForUser(tx, userId, bounded));
  } catch (err) {
    logger.error("Audit log unreadable", {
      error: err instanceof Error ? err.message : String(err),
      route: "platform/auth/audit",
    });
    return [];
  }

  return rows.map((row) => ({
    action: row.action as AuditAction,
    actorId: row.actor_id || undefined,
    targetId: row.target_id || undefined,
    details: row.details,
    ipAddress: row.ip_address || undefined,
    userAgent: row.user_agent || undefined,
  }));
}

/**
 * For API routes: run `act` under audited(), returning its response, or a 503 coded error when
 * the audit record cannot be written (the action then never ran). `act` reports success so a
 * failed action gets its follow-up record. A route's act that reaches outside the database (the
 * admin purge runs every registered module's erasure hook) passes `{ external: true }`, exactly as
 * to audited() — auditedResponse decides nothing itself (review 14 L-6; it was said before that
 * every route's act was database-only, and the purge route's is not).
 */
export async function auditedResponse<R>(
  entry: AuditEntry,
  act: () => Promise<{
    readonly success: boolean;
    readonly error?: string;
    readonly indeterminate?: boolean;
    readonly response: R;
  }>,
  unavailable: () => R,
  options: { readonly external?: boolean } = {}
): Promise<R> {
  try {
    return (await audited(entry, act, options)).response;
  } catch (err) {
    if (err instanceof AuditWriteError) return unavailable();
    throw err;
  }
}
