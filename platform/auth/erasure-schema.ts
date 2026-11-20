/**
 * platform/auth/erasure-schema.ts — the erasure runs only with the rewrite functions migration 074
 * made, and readiness says whenever the JSON bound is not in force (platform TASK-229, ADR-058)
 *
 * Two questions, kept apart (design 56e-3a §2.3, review SB-13):
 *
 * - **The gate** — `public.erasure_functions_missing()` (074): the two functions the erasure's
 *   statements call, `jsonb_erase_id_text` (the purge, the cross-tenant pass) and
 *   `jsonb_erase_address_text` (the soft delete), missing or not as 074 made them (definition,
 *   owner or grants: their fingerprint, taken by 074). Asked before the soft delete writes, before
 *   the purge's first account and before the cross-tenant pass — never on a dry run (review B-12).
 *   A row refuses the erasure: `ErasureSchemaMissing`, alerted as `gdpr.erasure_schema_missing` at
 *   most once per ten minutes per process; the purge then counts no attempt against any account
 *   (review B-13). Without 074 the function itself is missing: said in the same words.
 * - **Readiness** — `public.json_bound_missing()` (074): every way the bound on stored JSON is not
 *   in force (a trigger missing, off or edited, rows not read since, a later trigger or a rule, a
 *   column the bound cannot hold, a refusing function changed, 074/075 not recorded, the gate's
 *   rows, a function anon or authenticated may run). Probe `json-bound`, degraded only: health is
 *   degraded and the deploy smoke fails; it never refuses an erasure — with the bound switched off
 *   by the operator (public.json_bound_off) a deletion still runs, and a value over the bound met
 *   by it fails that statement loudly (design 56e-3a §2.3: an emergency switch must not turn into
 *   a refusal of every deletion).
 *
 * Both read the catalogue every time (never a remembered answer: a trigger or a grant can change
 * after it was seen) and print names, never content.
 *
 * @module platform/auth
 */

import type { Tx } from "@/platform/data";
import { withPlatformTx, hasDatabase } from "@/platform/data";
import type { HealthCheckResult, HealthProbe } from "@/platform/observability/types";
import { raiseAlert } from "@/platform/observability/alert";

/** The migrations that put the bound and the erasure's functions in place, in order. */
export const JSON_BOUND_MIGRATIONS = [
  "074_json_bound.sql",
  "075_json_bound_existing_rows.sql",
] as const;

/** What a refused erasure says (this module's words; never a store's text). */
export const ERASURE_SCHEMA_MISSING = `the erasure's functions are not as migration ${JSON_BOUND_MIGRATIONS[0]} makes them (missing, or another definition, owner or grants): erasure is refused until they are (docs/MIGRATION_v5_to_v6.md; docs/runbooks/jobs.md, "Erasure refused: functions missing")`;

/** The erasure was asked of a database whose rewrite functions are not 074's. */
export class ErasureSchemaMissing extends Error {
  /** What is wrong, by name (never content). */
  readonly missing: readonly string[];
  constructor(missing: readonly string[] = []) {
    super(ERASURE_SCHEMA_MISSING);
    this.name = "ErasureSchemaMissing";
    this.missing = missing;
  }
}

/**
 * The gate's question, in one statement any role may send: without 074 the function itself is
 * missing (to_regprocedure answers null; nothing is called), and that is the one row.
 */
export const ERASURE_FUNCTIONS_MISSING_SQL = `select case when to_regprocedure('public.erasure_functions_missing()') is null
              then array['${JSON_BOUND_MIGRATIONS[0]}: not applied (public.erasure_functions_missing() is missing)']
              else (select coalesce(array_agg(m order by m), '{}') from public.erasure_functions_missing() m) end as missing`;

/** Readiness's question, in one statement (without 074: the one row naming it). */
export const JSON_BOUND_MISSING_SQL = `select case when to_regprocedure('public.json_bound_missing()') is null
              then array['${JSON_BOUND_MIGRATIONS[0]}: not applied (public.json_bound_missing() is missing)']
              else (select coalesce(array_agg(m order by m), '{}') from public.json_bound_missing() m) end as missing`;

/** What the erasure's functions lack on `tx`'s database, by name; empty when nothing. */
export async function missingErasureFunctions(tx: Tx): Promise<string[]> {
  const { rows } = await tx.query<{ missing: string[] }>(ERASURE_FUNCTIONS_MISSING_SQL);
  return rows[0]?.missing ?? [];
}

/** Every way the JSON bound is not in force on `tx`'s database, by name; empty when in force. */
export async function missingJsonBound(tx: Tx): Promise<string[]> {
  const { rows } = await tx.query<{ missing: string[] }>(JSON_BOUND_MISSING_SQL);
  return rows[0]?.missing ?? [];
}

/** At most one alert per this many ms per process for refused erasures. */
export const ERASURE_SCHEMA_ALERT_EVERY_MS = 10 * 60 * 1000;
let lastAlert = Number.NEGATIVE_INFINITY;

/** Tests: forget when the last refusal was alerted. */
export function resetErasureSchemaAlert(): void {
  lastAlert = Number.NEGATIVE_INFINITY;
}

/**
 * Alert a refusal (gdpr.erasure_schema_missing), at most once per ERASURE_SCHEMA_ALERT_EVERY_MS
 * per process; `what` says which erasure was refused.
 */
export function alertErasureSchemaMissing(
  what: string,
  missing: readonly string[]
): void {
  const now = Date.now();
  if (now - lastAlert < ERASURE_SCHEMA_ALERT_EVERY_MS) return;
  lastAlert = now;
  raiseAlert({
    name: "gdpr.erasure_schema_missing",
    message: `${what} refused: ${ERASURE_SCHEMA_MISSING}. Missing: ${missing.slice(0, 10).join("; ")}${missing.length > 10 ? `; and ${missing.length - 10} more` : ""}.`,
    count: missing.length,
  });
}

/**
 * Throws ErasureSchemaMissing when the erasure's functions are not 074's on `tx`'s database —
 * asked on every call. A refusal is alerted (alertErasureSchemaMissing).
 */
export async function requireErasureFunctions(tx: Tx, what = "Erasure"): Promise<void> {
  const missing = await missingErasureFunctions(tx);
  if (missing.length === 0) return;
  alertErasureSchemaMissing(what, missing);
  throw new ErasureSchemaMissing(missing);
}

/**
 * Readiness `json-bound` (degraded only: the instance still serves everything): healthy when
 * public.json_bound_missing() is empty; degraded, naming every line, otherwise — or when it cannot
 * be read (the error's name only). The deploy smoke requires it healthy (SMOKE_HEALTHY_PROBES), and
 * so does the health watch from promotion (WATCH_CHECKS).
 */
export function createJsonBoundProbe(): HealthProbe {
  const name = "json-bound";
  return {
    name,
    async check(): Promise<HealthCheckResult> {
      const started = Date.now();
      const result = (
        status: "healthy" | "degraded",
        detail: string
      ): HealthCheckResult => ({
        name,
        status,
        latencyMs: Date.now() - started,
        detail,
        checkedAt: new Date().toISOString(),
      });
      if (!hasDatabase()) return result("healthy", "no database: nothing is stored");
      try {
        const missing = await withPlatformTx((tx) => missingJsonBound(tx));
        return missing.length === 0
          ? result(
              "healthy",
              `${JSON_BOUND_MIGRATIONS.join(" and ")} in force: every stored JSON value bounded (128 levels, numbers 0 or 1e-18 <= |n| < 1e21, 8388608 bytes as text); the erasure's functions as 074 makes them`
            )
          : result(
              "degraded",
              `the JSON bound is not in force (docs/runbooks/jobs.md, "json-bound degraded"): ${missing.join("; ")}`
            );
      } catch (err) {
        return result(
          "degraded",
          `whether the JSON bound is in force could not be read: ${err instanceof Error ? err.name : "error"}`
        );
      }
    },
  };
}
