/**
 * platform/agents/postgres-effect-ledger.ts — Durable effect ledger (ADR-031 D7, ADR-053 D4)
 *
 * EffectLedger on Postgres through platform/data, in the request's tenant: row-level security
 * keeps each tenant's ledger apart; tenant_id is filled by its column default.
 *
 * `begin` is one insert … on conflict (tenant_id, operation_id, effect_key) do update that
 * raises `attempts`, so a retry — or two concurrent begins — can never create a second entry
 * (a second entry would be a second permission to fire the effect). `resolve` is conditional
 * on status = 'pending', so a second resolution matches no row.
 *
 * Table: effect_ledger (migration 028; unique per tenant since 049).
 *
 * Stored JSON is bounded (platform TASK-229, migration 074): a request over the bound is refused,
 * coded, by `begin` — before the effect runs. A receipt is kept up to EFFECT_RECEIPT_MAX_TEXT
 * (6 MiB as the database prints it — a generated image of about 4.4 MiB; code review B-1: the
 * 1 MiB of other documents made a held image undeliverable). One that cannot be kept (the effect
 * has happened) is stored as the "not kept" marker (`{"_omitted": {code, max}}`), logged and
 * counted (`effect.receipt_not_kept`) — receiptToStore, the one rule of both ledgers;
 * performExternalEffect replays such an entry as `resultKept: false`, never as the result.
 *
 * @module platform/agents
 */

import type {
  BeginEffectArgs,
  EffectLedger,
  EffectLedgerEntry,
  EffectStatus,
  ExternalEffectType,
} from "@/platform/kernel";
import { generateUuid } from "./utils";
import { idempotencyKeyFor, receiptToStore } from "./effect-ledger";
import { withTenantTx } from "@/platform/data";
import { assertWithinDatabaseBound } from "@/platform/errors/json-limits";

interface LedgerRow {
  id: string;
  operation_id: string;
  effect_key: string;
  effect_type: string;
  status: string;
  idempotency_key: string;
  request: unknown;
  receipt: unknown;
  error: string | null;
  attempts: number;
  created_at: Date;
  resolved_at: Date | null;
}

function mapRow(row: LedgerRow): EffectLedgerEntry {
  return {
    entryId: row.id,
    operationId: row.operation_id,
    effectKey: row.effect_key,
    effectType: row.effect_type as ExternalEffectType,
    status: row.status as EffectStatus,
    idempotencyKey: row.idempotency_key,
    request: (typeof row.request === "object" && row.request !== null
      ? row.request
      : {}) as Record<string, unknown>,
    receipt:
      typeof row.receipt === "object" && row.receipt !== null
        ? (row.receipt as Record<string, unknown>)
        : undefined,
    error: row.error ?? undefined,
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : undefined,
  };
}

export class PostgresEffectLedger implements EffectLedger {
  async begin(args: BeginEffectArgs): Promise<EffectLedgerEntry> {
    // A retry returns the EXISTING entry with attempts raised; its request, type and status
    // are left as first written. A request the database would refuse is refused here, coded,
    // before anything is written or fired (TASK-229).
    assertWithinDatabaseBound(args.request ?? {}, "effect_ledger.request");
    const { rows } = await withTenantTx((tx) =>
      tx.query<LedgerRow>(
        `insert into effect_ledger
           (id, operation_id, effect_key, effect_type, status, idempotency_key, request, attempts)
         values ($1::uuid, $2, $3, $4, 'pending', $5, $6::jsonb, 1)
         on conflict (tenant_id, operation_id, effect_key)
           do update set attempts = effect_ledger.attempts + 1
         returning id, operation_id, effect_key, effect_type, status, idempotency_key, request,
                   receipt, error, attempts, created_at, resolved_at`,
        [
          generateUuid(),
          args.operationId,
          args.effectKey,
          args.effectType,
          idempotencyKeyFor(args.operationId, args.effectKey),
          JSON.stringify(args.request ?? {}),
        ]
      )
    );
    if (!rows.length) throw new Error("agents: ledger begin returned no row");
    return mapRow(rows[0]);
  }

  async resolve(
    operationId: string,
    effectKey: string,
    status: Exclude<EffectStatus, "pending">,
    detail?: { receipt?: Record<string, unknown>; error?: string }
  ): Promise<EffectLedgerEntry | undefined> {
    // What is kept of the receipt: itself, or the "not kept" marker (TASK-229, TA-a-4, B-1).
    const receipt = receiptToStore(detail?.receipt, operationId, effectKey) ?? null;
    const { rows } = await withTenantTx((tx) =>
      tx.query<LedgerRow>(
        `update effect_ledger
            set status = $3, receipt = $4::jsonb, error = $5, resolved_at = now()
          where operation_id = $1 and effect_key = $2 and status = 'pending'
          returning id, operation_id, effect_key, effect_type, status, idempotency_key, request,
                    receipt, error, attempts, created_at, resolved_at`,
        [
          operationId,
          effectKey,
          status,
          receipt === null ? null : JSON.stringify(receipt),
          detail?.error ?? null,
        ]
      )
    );
    return rows.length ? mapRow(rows[0]) : undefined;
  }

  async get(
    operationId: string,
    effectKey: string
  ): Promise<EffectLedgerEntry | undefined> {
    const { rows } = await withTenantTx((tx) =>
      tx.query<LedgerRow>(
        `select id, operation_id, effect_key, effect_type, status, idempotency_key, request,
                receipt, error, attempts, created_at, resolved_at
           from effect_ledger where operation_id = $1 and effect_key = $2`,
        [operationId, effectKey]
      )
    );
    return rows.length ? mapRow(rows[0]) : undefined;
  }

  async listUnresolved(limit?: number): Promise<readonly EffectLedgerEntry[]> {
    const { rows } = await withTenantTx((tx) =>
      tx.query<LedgerRow>(
        `select id, operation_id, effect_key, effect_type, status, idempotency_key, request,
                receipt, error, attempts, created_at, resolved_at
           from effect_ledger
          where status in ('pending', 'indeterminate')
          order by created_at asc
          limit $1::int`,
        [limit && limit > 0 ? limit : null]
      )
    );
    return rows.map(mapRow);
  }
}
