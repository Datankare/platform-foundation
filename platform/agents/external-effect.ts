/**
 * platform/agents/external-effect.ts — Firing an effect through the ledger (ADR-031 D7)
 *
 * External effects are the one stage the framework cannot make idempotent by itself, so the
 * contract is explicit rather than assumed: the ledger entry is written BEFORE the call and
 * resolved after. A retry that finds an unresolved entry does not re-fire — it reports
 * indeterminate, and a human resolves it.
 *
 * Before this, the ledger existed and nothing called it: every externalCall and sendMessage
 * in the tree was a declaration or a test fixture. A ledger nothing writes to cannot prevent
 * a double-fire, so D7 was contract-only.
 *
 * @module platform/agents
 */

import type {
  EffectLedger,
  EffectLedgerEntry,
  ExternalEffectType,
} from "@/platform/kernel";
import { getEffectLedger, idempotencyKeyFor } from "./effect-ledger";
import { logCaught } from "@/platform/observability/caught-error";
import { logger } from "@/lib/logger";
import {
  fromStoredKept,
  isOmittedMarker,
  type OmittedMarker,
} from "@/platform/errors/json-limits";
import { recordMetricEvent } from "@/platform/observability/metric-event";

/** An error that leaves a sent call's outcome unknown (a timeout, an abort, a dropped socket). */
const AMBIGUOUS = /timeout|timed out|abort|socket|econnreset|network/i;

/**
 * The ledger's reasons (R-77): the call's own text is logged. Catalog keys (TASK-209, N-112: they
 * were English the ledger stored), worded where they are read (the data export).
 */
export const EFFECT_UNKNOWN = "screens.records.effect_unknown";
export const EFFECT_FAILED = "screens.records.effect_failed";
/** A retry found the entry unresolved: whether the call took effect is unknown. */
export const EFFECT_UNRESOLVED = "screens.records.effect_unresolved";

export interface ExternalEffectArgs<T> {
  readonly operationId: string;
  /** Distinguishes multiple effects within one operation. */
  readonly effectKey: string;
  readonly effectType: ExternalEffectType;
  /**
   * Performs the downstream call. Receives the idempotency key derived from operationId —
   * downstreams that accept one (most payment, messaging and mail APIs) should be given it
   * directly; the ledger exists for those that do not.
   */
  readonly call: (idempotencyKey: string) => Promise<T>;
  /**
   * Asks the downstream whether the effect landed, for a retry that finds an unresolved
   * entry. Omit when the downstream cannot be queried — the operation then surfaces as
   * indeterminate rather than being guessed at.
   */
  readonly reconcile?: (idempotencyKey: string) => Promise<T | undefined>;
  readonly request?: Record<string, unknown>;
  readonly ledger?: EffectLedger;
}

/**
 * A confirmed effect. `resultKept: false` — its receipt was over the stored-JSON bound and the
 * ledger kept only the "not kept" marker (platform TASK-229, review TA-a-4): a replay has no
 * result to give, and a caller must narrow on `resultKept` before it can read one. The live call
 * always returns its real result (`resultKept: true`) and says, in `replayable`, whether a later
 * call with the same identity will get it back: false when the receipt could not be kept — a
 * caller that would hold the result for a later step (an approval) must not, because that step
 * could never be given it (code review B-1).
 */
export type ExternalEffectOutcome<T> =
  | {
      readonly status: "confirmed";
      readonly resultKept: true;
      readonly result: T;
      /** Whether the ledger kept the receipt, so a replay returns this result. */
      readonly replayable: boolean;
      readonly entry: EffectLedgerEntry;
    }
  | {
      readonly status: "confirmed";
      readonly resultKept: false;
      /** Why the receipt was not kept: the refusal's code and limit. */
      readonly notKept: OmittedMarker["_omitted"];
      readonly entry: EffectLedgerEntry;
    }
  | {
      readonly status: "failed";
      readonly error: string;
      readonly entry: EffectLedgerEntry;
    }
  | { readonly status: "indeterminate"; readonly entry: EffectLedgerEntry };

/**
 * Fire an external effect exactly once, or report that it cannot be known.
 *
 * The sequence is the contract:
 *   1. write the ledger entry (idempotent on operationId + effectKey — a retry gets the
 *      SAME entry, never a second permission to fire)
 *   2. if it is already resolved, return that outcome without calling again
 *   3. if it is unresolved from a previous attempt, DO NOT re-fire: reconcile if the
 *      downstream can be asked, otherwise surface indeterminate
 *   4. otherwise call, and resolve the entry with what happened
 *
 * A thrown error resolves the entry as `failed` only when the call demonstrably did not
 * reach the downstream. Anything ambiguous — a timeout, a dropped connection after send —
 * resolves as `indeterminate`, because at that point nothing knows whether it landed, and a
 * guess in either direction is a violation that leaves no trace (ADR-029 D10).
 */
export async function performExternalEffect<T>(
  args: ExternalEffectArgs<T>
): Promise<ExternalEffectOutcome<T>> {
  const ledger = args.ledger ?? getEffectLedger();
  const key = idempotencyKeyFor(args.operationId, args.effectKey);

  const existing = await ledger.get(args.operationId, args.effectKey);

  if (existing && existing.status !== "pending") {
    // Already resolved. Replaying a stage with the same identity is a no-op returning the
    // original result (ADR-031 invariant 7).
    if (existing.status === "confirmed") {
      // A receipt the ledger could not keep (over the stored-JSON bound) is replayed as such —
      // never as the result (TASK-229, TA-a-4).
      if (isOmittedMarker(existing.receipt)) {
        logger.warn("A confirmed effect was replayed whose receipt was not kept", {
          operationId: args.operationId,
          effectKey: args.effectKey,
          code: existing.receipt._omitted.code,
          route: "platform/agents/external-effect",
        });
        recordMetricEvent(
          "effect.receipt_not_kept_replayed",
          { count: 1 },
          { code: existing.receipt._omitted.code }
        );
        return {
          status: "confirmed",
          resultKept: false,
          notKept: existing.receipt._omitted,
          entry: existing,
        };
      }
      return {
        status: "confirmed",
        resultKept: true,
        // A receipt of the marker's own shape was stored wrapped (asStoredKept): read back whole.
        result: (fromStoredKept(existing.receipt) as T) ?? (undefined as T),
        replayable: true,
        entry: existing,
      };
    }
    if (existing.status === "failed") {
      return {
        status: "failed",
        error: existing.error ?? EFFECT_FAILED,
        entry: existing,
      };
    }
    return { status: "indeterminate", entry: existing };
  }

  const entry = await ledger.begin({
    operationId: args.operationId,
    effectKey: args.effectKey,
    effectType: args.effectType,
    request: args.request,
  });

  // An unresolved entry from a previous attempt means the effect MAY have fired. Calling
  // again would be an at-least-once violation; assuming it failed would be at-most-once.
  if (entry.attempts > 1) {
    if (args.reconcile) {
      const found = await args.reconcile(key);
      if (found !== undefined) {
        const resolved = await ledger.resolve(
          args.operationId,
          args.effectKey,
          "confirmed",
          {
            receipt: found as Record<string, unknown>,
          }
        );
        return {
          status: "confirmed",
          resultKept: true,
          result: found,
          replayable: !isOmittedMarker(resolved?.receipt),
          entry: resolved ?? entry,
        };
      }
    }
    const resolved = await ledger.resolve(
      args.operationId,
      args.effectKey,
      "indeterminate",
      { error: EFFECT_UNRESOLVED }
    );
    return { status: "indeterminate", entry: resolved ?? entry };
  }

  try {
    const result = await args.call(key);
    const resolved = await ledger.resolve(args.operationId, args.effectKey, "confirmed", {
      receipt: result as Record<string, unknown>,
    });
    return {
      status: "confirmed",
      resultKept: true,
      result,
      replayable: !isOmittedMarker(resolved?.receipt),
      entry: resolved ?? entry,
    };
  } catch (err) {
    // Ambiguity resolves to indeterminate, never to failure. A timeout after send is not a
    // failure — it is an unknown, and recording it as failure invites a retry that
    // double-fires.
    const status = AMBIGUOUS.test(err instanceof Error ? err.message : "")
      ? "indeterminate"
      : "failed";
    // The ledger's entry is read by people (the admin console, reconciliation): it says which,
    // and the call's own text goes to the log (R-77).
    logCaught(logger, "External effect call failed", err, {
      operationId: args.operationId,
      effectKey: args.effectKey,
      status,
      route: "platform/agents/external-effect",
    });
    const resolved = await ledger.resolve(args.operationId, args.effectKey, status, {
      error: status === "indeterminate" ? EFFECT_UNKNOWN : EFFECT_FAILED,
    });
    return status === "indeterminate"
      ? { status: "indeterminate", entry: resolved ?? entry }
      : { status: "failed", error: EFFECT_FAILED, entry: resolved ?? entry };
  }
}
