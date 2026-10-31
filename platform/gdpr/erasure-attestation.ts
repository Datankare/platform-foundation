/**
 * platform/gdpr/erasure-attestation.ts — two operators close an external erasure the system
 * cannot verify (TASK-193 review round 1; owner decision)
 *
 * An identity "not found" counts as erased only in the pool the erasure recorded, confirmed
 * (external-erasure.ts). An erasure whose identity lived in a pool that is gone — decommissioned,
 * or an old pool the person was deleted from by hand — stays pending and alerted for good: nothing
 * the app can call proves it. This is the governed way out, never a hand edit:
 *
 *   1. an operator (platform_operate) asks to attest the store erased, giving one of
 *      ATTESTATION_REASONS and a note — only for a store whose last attempt could not verify
 *      (`poolUnverified`); the request is recorded on the step (`attestationRequest`) and expires
 *      after ATTESTATION_REQUEST_DAYS;
 *   2. a different operator approves it (dual control: it closes an erasure without proof) — only
 *      while the step is still pending and unverifiable (a job run that records any other failure
 *      drops the open request, gdpr-deletion.ts eraseExternalStores): the
 *      step is recorded done, `attested` with who asked, who approved, when and the reason, and
 *      the erasure's purge is due again; or either rejects (withdraws) it.
 *
 * Each step is audited (`external_erasure_attestation_requested` / `_approved` / `_rejected`)
 * before it acts — no record, no change. The note is kept only in the audit record (its `note`,
 * free text erased with the account it is about), never on the erasure's record.
 *
 * The routes: app/api/operator/tenants/[id]/erasures/[userId]/attestation (TENANCY_OPERATIONS).
 *
 * @module platform/gdpr
 */

import { withOwnerTx, type Tx } from "@/platform/data";
import { AuditWriteError, audited } from "@/platform/auth/audit";
import type { Operator, OperatorResult } from "@/platform/tenancy/admin";
import { listExternalErasures, type RecordedExternalErasure } from "./external-erasure";

/** Why a step may be attested erased: the only answers accepted. */
export const ATTESTATION_REASONS = [
  /** The identity pool the account was in no longer exists. */
  "pool_decommissioned",
  /** The identity was deleted in the old pool, by an operator. */
  "deleted_in_old_pool",
  /** The account never had an identity in any pool. */
  "identity_never_existed",
] as const;
export type AttestationReason = (typeof ATTESTATION_REASONS)[number];

/** How long a request waits for its second operator. */
export const ATTESTATION_REQUEST_DAYS = 7;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AttestationTarget {
  readonly tenantId: string;
  readonly userId: string;
  /** The store (user_deletions.external_erasures key); the identity provider by default. */
  readonly store?: string;
}

const fail = <T>(
  code:
    | "tenant.not_found"
    | "tenant.invalid"
    | "tenant.state_conflict"
    | "tenant.self_approval",
  message: string
): OperatorResult<T> => ({ ok: false, code, message });

/** Audit first, then act (as platform/tenancy/admin.ts's operator acts). */
async function recorded<T>(
  operator: Operator,
  type: string,
  details: Record<string, unknown>,
  act: () => Promise<OperatorResult<T>>,
  /** As audited()'s: these acts stay in the database (no `external`). */
  options: { readonly external?: boolean } = {}
): Promise<OperatorResult<T>> {
  try {
    const out = await audited(
      { action: "admin_action", actorId: operator.userId, details: { type, ...details } },
      async () => {
        const result = await act();
        return result.ok
          ? { success: true as const, result }
          : { success: false as const, error: result.message, result };
      },
      options
    );
    return out.result;
  } catch (err) {
    if (err instanceof AuditWriteError) {
      return {
        ok: false,
        code: "audit.unavailable",
        message: "The audit log is unavailable, so nothing was changed.",
      };
    }
    throw err;
  }
}

function checked(
  target: AttestationTarget,
  note: string
): string | OperatorResult<never> {
  if (!UUID.test(target.tenantId) || !UUID.test(target.userId)) {
    return fail("tenant.not_found", "No such erasure.");
  }
  const store = target.store ?? "identity-provider";
  if (!listExternalErasures().some((e) => e.name === store)) {
    return fail("tenant.invalid", `No external store named ${store}.`);
  }
  if (note.length > 500)
    return fail("tenant.invalid", "The note is at most 500 characters.");
  return store;
}

interface StepRow extends Record<string, unknown> {
  step: RecordedExternalErasure | null;
}

async function stepOf(
  tx: Tx,
  target: AttestationTarget,
  store: string
): Promise<RecordedExternalErasure | null | undefined> {
  const { rows } = await tx.query<StepRow>(
    `select external_erasures -> $3::text as step from user_deletions
      where tenant_id = $1::uuid and user_id = $2::uuid for update`,
    [target.tenantId, target.userId, store]
  );
  return rows.length === 0 ? undefined : rows[0].step;
}

/**
 * Ask for a store's erasure of an account to be attested (step 1). Only for a step the system
 * could not verify (`poolUnverified`, not done), with one of ATTESTATION_REASONS and a note (3–500
 * characters). At most one open request per step; an expired one is replaced.
 */
export async function requestErasureAttestation(
  operator: Operator,
  target: AttestationTarget,
  reason: string,
  note: string
): Promise<OperatorResult<RecordedExternalErasure>> {
  const store = checked(target, note);
  if (typeof store !== "string") return store;
  if (!(ATTESTATION_REASONS as readonly string[]).includes(reason)) {
    return fail(
      "tenant.invalid",
      `The reason is one of: ${ATTESTATION_REASONS.join(", ")}.`
    );
  }
  if (note.trim().length < 3)
    return fail("tenant.invalid", "Give a note (3–500 characters).");
  return recorded(
    operator,
    "external_erasure_attestation_requested",
    {
      tenantId: target.tenantId,
      userId: target.userId,
      store,
      attestation: reason,
      note,
    },
    () =>
      withOwnerTx("operator", async (tx) => {
        const step = await stepOf(tx, target, store);
        if (step === undefined)
          return fail<RecordedExternalErasure>("tenant.not_found", "No such erasure.");
        if (!step || step.doneAt || !step.poolUnverified) {
          return fail<RecordedExternalErasure>(
            "tenant.state_conflict",
            "Only a step the system could not verify (pending, pool unverified) can be attested."
          );
        }
        if (
          step.attestationRequest &&
          Date.parse(step.attestationRequest.expiresAt) > Date.now()
        ) {
          return fail<RecordedExternalErasure>(
            "tenant.state_conflict",
            "An attestation is already awaiting a second operator."
          );
        }
        const { rows } = await tx.query<StepRow>(
          `update user_deletions
              set external_erasures = jsonb_set(external_erasures, array[$3::text],
                    (external_erasures -> $3::text) || jsonb_build_object('attestationRequest',
                      jsonb_build_object('by', $4::text, 'reason', $5::text,
                        'at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                        'expiresAt', to_char((now() + make_interval(days => $6::int)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))))
            where tenant_id = $1::uuid and user_id = $2::uuid
            returning external_erasures -> $3::text as step`,
          [
            target.tenantId,
            target.userId,
            store,
            operator.userId,
            reason,
            ATTESTATION_REQUEST_DAYS,
          ]
        );
        return { ok: true, value: rows[0].step as RecordedExternalErasure };
      })
  );
}

/**
 * Decide an attestation request (step 2). Approval must come from an operator other than the one
 * who asked: the step is recorded done and `attested`, and the erasure's purge is due again (its
 * next gdpr.retention-purge run completes it). Either operator may reject (withdraw) it.
 */
export async function decideErasureAttestation(
  operator: Operator,
  target: AttestationTarget,
  approve: boolean,
  note: string
): Promise<OperatorResult<RecordedExternalErasure>> {
  const store = checked(target, note);
  if (typeof store !== "string") return store;
  return recorded(
    operator,
    approve
      ? "external_erasure_attestation_approved"
      : "external_erasure_attestation_rejected",
    { tenantId: target.tenantId, userId: target.userId, store, note },
    () =>
      withOwnerTx("operator", async (tx) => {
        const step = await stepOf(tx, target, store);
        if (step === undefined)
          return fail<RecordedExternalErasure>("tenant.not_found", "No such erasure.");
        const asked = step?.attestationRequest;
        if (!step || step.doneAt || !asked) {
          return fail<RecordedExternalErasure>(
            "tenant.state_conflict",
            "No attestation is awaiting a decision."
          );
        }
        if (Date.parse(asked.expiresAt) <= Date.now()) {
          return fail<RecordedExternalErasure>(
            "tenant.state_conflict",
            "The attestation request has expired; ask again."
          );
        }
        // Still what was asked about (S2 round 2): pending AND unverifiable. A step the job has
        // since recorded another way (refused, unavailable — its request is then dropped) or
        // done is not closed by an attestation of an unverifiable pool.
        if (approve && !step.poolUnverified) {
          return fail<RecordedExternalErasure>(
            "tenant.state_conflict",
            "The step is no longer unverifiable; ask again if it becomes so."
          );
        }
        if (approve && asked.by === operator.userId) {
          return fail<RecordedExternalErasure>(
            "tenant.self_approval",
            "A different operator must approve an attestation you asked for."
          );
        }
        const { rows } = await tx.query<StepRow>(
          approve
            ? `update user_deletions
                  set external_erasures = jsonb_set(external_erasures, array[$3::text],
                        ((external_erasures -> $3::text) - 'attestationRequest' - 'retryAt' - 'error' - 'poolUnverified')
                        || jsonb_build_object(
                             'doneAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                             'attested', jsonb_build_object('by', $4::text,
                               'requestedBy', external_erasures -> $3::text -> 'attestationRequest' ->> 'by',
                               'reason', external_erasures -> $3::text -> 'attestationRequest' ->> 'reason',
                               'at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))),
                      purge_retry_at = null
                where tenant_id = $1::uuid and user_id = $2::uuid
                returning external_erasures -> $3::text as step`
            : `update user_deletions
                  set external_erasures = jsonb_set(external_erasures, array[$3::text],
                        (external_erasures -> $3::text) - 'attestationRequest')
                -- $4 (the operator) is recorded in the audit record, not here.
                where tenant_id = $1::uuid and user_id = $2::uuid and $4::text is not null
                returning external_erasures -> $3::text as step`,
          [target.tenantId, target.userId, store, operator.userId]
        );
        return { ok: true, value: rows[0].step as RecordedExternalErasure };
      })
  );
}
