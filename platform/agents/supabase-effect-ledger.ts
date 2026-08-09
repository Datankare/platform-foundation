/**
 * platform/agents/supabase-effect-ledger.ts — Durable effect ledger
 *
 * Raw fetch against /rest/v1/, the pattern every conformance-testable store here uses.
 *
 * `begin` is an upsert on (operation_id, effect_key) via Prefer: resolution=merge-duplicates
 * so a retry cannot create a second entry — a second entry would be a second permission to
 * fire the effect. `resolve` is conditional on status=eq.pending, so a second resolution
 * matches no row.
 *
 * Table: effect_ledger (migration 028).
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
import { idempotencyKeyFor } from "./effect-ledger";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

const TABLE = "effect_ledger";

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
  created_at: string;
  resolved_at: string | null;
}

function headers(key: string, prefer?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
  if (prefer) h["Prefer"] = prefer;
  return h;
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
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}

export class SupabaseEffectLedger implements EffectLedger {
  private readonly url: string;
  private readonly key: string;

  constructor(url: string, serviceKey: string) {
    this.url = url.replace(/\/+$/, "");
    this.key = serviceKey;
  }

  private endpoint(query = ""): string {
    return `${this.url}/rest/v1/${TABLE}${query}`;
  }

  async begin(args: BeginEffectArgs): Promise<EffectLedgerEntry> {
    const existing = await this.get(args.operationId, args.effectKey);
    if (existing) {
      const res = await fetchWithTimeout(
        this.endpoint(
          `?operation_id=eq.${encodeURIComponent(args.operationId)}` +
            `&effect_key=eq.${encodeURIComponent(args.effectKey)}`
        ),
        {
          timeoutMs: 10_000,
          // Retry is the caller's: reduceCommit loops on version conflict and the effect
          // ledger owns at-most-once. A transport retrying a PATCH underneath either can
          // double-apply a committed write (ADR-028 D5, ADR-031 D7).
          maxRetries: 0,
          method: "PATCH",
          headers: headers(this.key, "return=representation"),
          body: JSON.stringify({ attempts: existing.attempts + 1 }),
        }
      );
      if (!res.ok) {
        throw new Error(
          `agents: ledger retry failed (${res.status}): ${await res.text()}`
        );
      }
      const rows = (await res.json()) as LedgerRow[];
      return rows.length
        ? mapRow(rows[0])
        : { ...existing, attempts: existing.attempts + 1 };
    }

    const body = {
      id: generateUuid(),
      operation_id: args.operationId,
      effect_key: args.effectKey,
      effect_type: args.effectType,
      status: "pending",
      idempotency_key: idempotencyKeyFor(args.operationId, args.effectKey),
      request: args.request ?? {},
      attempts: 1,
      created_at: new Date().toISOString(),
    };
    const res = await fetchWithTimeout(this.endpoint(), {
      timeoutMs: 10_000,
      // Retry is the caller's: reduceCommit loops on version conflict and the effect
      // ledger owns at-most-once. A transport retrying a PATCH underneath either can
      // double-apply a committed write (ADR-028 D5, ADR-031 D7).
      maxRetries: 0,
      method: "POST",
      headers: headers(this.key, "return=representation"),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`agents: ledger begin failed (${res.status}): ${await res.text()}`);
    }
    const rows = (await res.json()) as LedgerRow[];
    if (!rows.length) throw new Error("agents: ledger begin returned no row");
    return mapRow(rows[0]);
  }

  async resolve(
    operationId: string,
    effectKey: string,
    status: Exclude<EffectStatus, "pending">,
    detail?: { receipt?: Record<string, unknown>; error?: string }
  ): Promise<EffectLedgerEntry | undefined> {
    const res = await fetchWithTimeout(
      this.endpoint(
        `?operation_id=eq.${encodeURIComponent(operationId)}` +
          `&effect_key=eq.${encodeURIComponent(effectKey)}&status=eq.pending`
      ),
      {
        timeoutMs: 10_000,
        // Retry is the caller's: reduceCommit loops on version conflict and the effect
        // ledger owns at-most-once. A transport retrying a PATCH underneath either can
        // double-apply a committed write (ADR-028 D5, ADR-031 D7).
        maxRetries: 0,
        method: "PATCH",
        headers: headers(this.key, "return=representation"),
        body: JSON.stringify({
          status,
          receipt: detail?.receipt ?? null,
          error: detail?.error ?? null,
          resolved_at: new Date().toISOString(),
        }),
      }
    );
    if (!res.ok) {
      throw new Error(
        `agents: ledger resolve failed (${res.status}): ${await res.text()}`
      );
    }
    const rows = (await res.json()) as LedgerRow[];
    return rows.length ? mapRow(rows[0]) : undefined;
  }

  async get(
    operationId: string,
    effectKey: string
  ): Promise<EffectLedgerEntry | undefined> {
    const res = await fetchWithTimeout(
      this.endpoint(
        `?operation_id=eq.${encodeURIComponent(operationId)}` +
          `&effect_key=eq.${encodeURIComponent(effectKey)}`
      ),
      {
        timeoutMs: 10_000,
        // Retry is the caller's: reduceCommit loops on version conflict and the effect
        // ledger owns at-most-once. A transport retrying a PATCH underneath either can
        // double-apply a committed write (ADR-028 D5, ADR-031 D7).
        maxRetries: 0,
        method: "GET",
        headers: headers(this.key),
      }
    );
    if (!res.ok) {
      throw new Error(`agents: ledger read failed (${res.status}): ${await res.text()}`);
    }
    const rows = (await res.json()) as LedgerRow[];
    return rows.length ? mapRow(rows[0]) : undefined;
  }

  async listUnresolved(limit?: number): Promise<readonly EffectLedgerEntry[]> {
    const params = ["status=in.(pending,indeterminate)", "order=created_at.asc"];
    if (limit && limit > 0) params.push(`limit=${limit}`);
    const res = await fetchWithTimeout(this.endpoint(`?${params.join("&")}`), {
      timeoutMs: 10_000,
      // Retry is the caller's: reduceCommit loops on version conflict and the effect
      // ledger owns at-most-once. A transport retrying a PATCH underneath either can
      // double-apply a committed write (ADR-028 D5, ADR-031 D7).
      maxRetries: 0,
      method: "GET",
      headers: headers(this.key),
    });
    if (!res.ok) {
      throw new Error(`agents: ledger list failed (${res.status}): ${await res.text()}`);
    }
    return ((await res.json()) as LedgerRow[]).map(mapRow);
  }
}
