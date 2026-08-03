/**
 * platform/agents/effect-ledger.ts — External effect ledger (ADR-031 D7)
 *
 * External effects are the one stage the framework cannot make idempotent by itself. The
 * contract is explicit rather than assumed: write the ledger entry BEFORE the call, resolve
 * it after. A retry that finds an unresolved entry does not re-fire.
 *
 * `indeterminate` is a real terminal state. A downstream that times out mid-write has
 * neither confirmed nor denied, and guessing either way is a correctness violation with no
 * trace — at-most-once if the guess is failure, at-least-once if it is success.
 *
 * @module platform/agents
 */

import type {
  BeginEffectArgs,
  EffectLedger,
  EffectLedgerEntry,
  EffectStatus,
} from "@/platform/kernel";
import { generateUuid } from "./utils";

export type {
  BeginEffectArgs,
  EffectLedger,
  EffectLedgerEntry,
  EffectStatus,
  ExternalEffectType,
} from "@/platform/kernel";

/** The idempotency key handed to a downstream, derived from the operation (D7). */
export function idempotencyKeyFor(operationId: string, effectKey: string): string {
  return `${operationId}:${effectKey}`;
}

function keyOf(operationId: string, effectKey: string): string {
  return `${operationId}\u0000${effectKey}`;
}

export class InMemoryEffectLedger implements EffectLedger {
  private entries = new Map<string, EffectLedgerEntry>();

  async begin(args: BeginEffectArgs): Promise<EffectLedgerEntry> {
    const k = keyOf(args.operationId, args.effectKey);
    const existing = this.entries.get(k);
    if (existing) {
      // A retry. Return the EXISTING entry with attempts raised — never a second entry,
      // because a second entry is a second permission to fire (ADR-031 invariant 2).
      const bumped: EffectLedgerEntry = { ...existing, attempts: existing.attempts + 1 };
      this.entries.set(k, bumped);
      return bumped;
    }
    const entry: EffectLedgerEntry = {
      entryId: generateUuid(),
      operationId: args.operationId,
      effectKey: args.effectKey,
      effectType: args.effectType,
      status: "pending",
      idempotencyKey: idempotencyKeyFor(args.operationId, args.effectKey),
      request: args.request ?? {},
      attempts: 1,
      createdAt: new Date().toISOString(),
    };
    this.entries.set(k, entry);
    return entry;
  }

  async resolve(
    operationId: string,
    effectKey: string,
    status: Exclude<EffectStatus, "pending">,
    detail?: { receipt?: Record<string, unknown>; error?: string }
  ): Promise<EffectLedgerEntry | undefined> {
    const k = keyOf(operationId, effectKey);
    const existing = this.entries.get(k);
    if (!existing) return undefined;
    // Only from pending. A second resolution is a no-op, so two racing reconcilers cannot
    // both claim the outcome.
    if (existing.status !== "pending") return undefined;

    const resolved: EffectLedgerEntry = {
      ...existing,
      status,
      receipt: detail?.receipt,
      error: detail?.error,
      resolvedAt: new Date().toISOString(),
    };
    this.entries.set(k, resolved);
    return resolved;
  }

  async get(
    operationId: string,
    effectKey: string
  ): Promise<EffectLedgerEntry | undefined> {
    return this.entries.get(keyOf(operationId, effectKey));
  }

  async listUnresolved(limit?: number): Promise<readonly EffectLedgerEntry[]> {
    const out = [...this.entries.values()]
      .filter((e) => e.status === "pending" || e.status === "indeterminate")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return limit && limit > 0 ? out.slice(0, limit) : out;
  }

  clear(): void {
    this.entries.clear();
  }
}

let currentLedger: EffectLedger = new InMemoryEffectLedger();

export function getEffectLedger(): EffectLedger {
  return currentLedger;
}

export function setEffectLedger(ledger: EffectLedger): EffectLedger {
  const previous = currentLedger;
  currentLedger = ledger;
  return previous;
}

export function resetEffectLedger(): void {
  currentLedger = new InMemoryEffectLedger();
}
