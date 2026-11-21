/**
 * platform/auth/erasure-schema.ts — the erasure runs only with the rewrite functions migration 074
 * made and the step rows migration 076 made, and readiness says whenever the JSON bound or 076's
 * objects are not in force (platform TASK-229, ADR-058; TASK-230, ADR-059)
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

/**
 * The migration that makes a trajectory's steps rows (TASK-230, ADR-059): the erasure's statements
 * on steps rewrite agent_trajectory_steps, so the gate refuses without it — its readiness
 * (public.trajectory_steps_missing()) lines 1–3: 076 not recorded, the table or a counter missing,
 * the old column still there. Its other lines (a function or trigger changed, a trigger after the
 * guard, a right beyond 076's) are readiness's only.
 */
export const STEPS_MIGRATION = "076_trajectory_steps_as_rows.sql";

/** What a refused erasure says (this module's words; never a store's text). */
export const ERASURE_SCHEMA_MISSING = `the erasure's functions are not as migration ${JSON_BOUND_MIGRATIONS[0]} makes them (missing, or another definition, owner or grants), or a trajectory's steps are not rows as ${STEPS_MIGRATION} makes them: erasure is refused until they are (docs/MIGRATION_v5_to_v6.md; docs/runbooks/jobs.md, "Erasure refused: functions missing")`;

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

/**
 * 076's part of the gate (TASK-230), in one statement any role may send: without 076 its readiness
 * function is missing (the one row naming it); with it, its lines 1–3 — 076 not recorded, the
 * steps' table or a counter missing, the old column still there.
 */
export const TRAJECTORY_STEPS_GATE_SQL = `select case when to_regprocedure('public.trajectory_steps_missing()') is null
              then array['${STEPS_MIGRATION}: not applied (public.trajectory_steps_missing() is missing)']
              else null end as missing`;
/** 076's lines the gate refuses on (1–3), once its readiness function exists. */
export const TRAJECTORY_STEPS_GATE_LINES_SQL = `select coalesce(array_agg(m order by m), '{}') as missing from public.trajectory_steps_missing() m
            where m like '${STEPS_MIGRATION}: %' or m like '%: missing' or m like 'agent_trajectories.steps: %'`;
/** 076's readiness, every line (the probe's). */
export const TRAJECTORY_STEPS_MISSING_SQL = `select coalesce(array_agg(m order by m), '{}') as missing from public.trajectory_steps_missing() m`;

/** Readiness's question, in one statement (without 074: the one row naming it). */
export const JSON_BOUND_MISSING_SQL = `select case when to_regprocedure('public.json_bound_missing()') is null
              then array['${JSON_BOUND_MIGRATIONS[0]}: not applied (public.json_bound_missing() is missing)']
              else (select coalesce(array_agg(m order by m), '{}') from public.json_bound_missing() m) end as missing`;

/**
 * 076's readiness lines on `tx`'s database (`gateOnly`: lines 1–3), by name; without 076, the one
 * line naming it.
 */
async function missingTrajectorySteps(tx: Tx, gateOnly: boolean): Promise<string[]> {
  const { rows } = await tx.query<{ missing: string[] | null }>(
    TRAJECTORY_STEPS_GATE_SQL
  );
  if (rows[0]?.missing) return rows[0].missing;
  const { rows: lines } = await tx.query<{ missing: string[] }>(
    gateOnly ? TRAJECTORY_STEPS_GATE_LINES_SQL : TRAJECTORY_STEPS_MISSING_SQL
  );
  return lines[0]?.missing ?? [];
}

/**
 * What the erasure's functions and step rows lack on `tx`'s database, by name; empty when
 * nothing: 074's gate, then 076's lines 1–3 (TASK-230).
 */
export async function missingErasureFunctions(tx: Tx): Promise<string[]> {
  const { rows } = await tx.query<{ missing: string[] }>(ERASURE_FUNCTIONS_MISSING_SQL);
  return [...(rows[0]?.missing ?? []), ...(await missingTrajectorySteps(tx, true))];
}

/**
 * Every way the JSON bound, or 076's step rows, are not in force on `tx`'s database, by name;
 * empty when in force.
 */
export async function missingJsonBound(tx: Tx): Promise<string[]> {
  const { rows } = await tx.query<{ missing: string[] }>(JSON_BOUND_MISSING_SQL);
  return [...(rows[0]?.missing ?? []), ...(await missingTrajectorySteps(tx, false))];
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
              `${JSON_BOUND_MIGRATIONS.join(" and ")} in force: every stored JSON value bounded (128 levels, numbers 0 or 1e-18 <= |n| < 1e21, 8388608 bytes as text); the erasure's functions as 074 makes them; a trajectory's steps rows as ${STEPS_MIGRATION} makes them`
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
