/**
 * app/api/admin/ai/handlers/shared.ts — shared handler types, and the platform-catalog
 * transaction.
 *
 * The role, permission and entitlement catalog is shared by every tenant and read-only to the
 * request role (ADR-053 D5). A command-bar change to it is allowed only when
 * mayChangePlatformCatalog(admin) (platform/admin/config-scope.ts) — a single-tenant
 * deployment's administrators, a shared deployment's operators — and then runs on the owner
 * connection (catalogTx). Everything else the handlers touch is the tenant's own data
 * (withTenantTx).
 */

import { logger } from "@/lib/logger";
import { withOwnerTx, type Tx } from "@/platform/data";
import type { RoleRefusal, VerifiedAdmin } from "@/platform/auth/role-governance";
import type { ErrorCode, ParamsOf } from "@/platform/errors/registry";
import { audited, AuditWriteError, type AuditEntry } from "@/platform/auth/audit";
import {
  describeFailure,
  type GovernedConfigOutcome,
} from "@/platform/admin/governed-config";

/** One value of a search result's table: text, a number, yes/no, or none. */
export type SearchCell = string | number | boolean | null;

/**
 * A search's rows as a table (TASK-189): the table read, its allowlisted columns, and each row's
 * cells in that order. What the command bar shows, and all the recorded step holds of the rows.
 */
export interface SearchTable {
  readonly table: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly SearchCell[])[];
  /** How many rows matched before the 20-row limit (and the size cut). */
  readonly matched?: number;
  /**
   * The filters as the server validated and applied them (TASK-190): the Users screen applies a
   * users search's to its own list. Shown to the admin only — the recorded step never holds them.
   */
  readonly filters?: Readonly<Record<string, string | number>>;
}

export type ActionResult = {
  /** True only when the action took effect. A held action is never a success (review 9 H1). */
  success: boolean;
  /**
   * The action did not take effect yet: it is held for an approval (dual control, or a safety
   * key's two-person approval). `result` says what is waiting; `proposalId` names the hold when
   * it is a runtime hold.
   */
  held?: boolean;
  proposalId?: string;
  result?: string;
  /** A search's rows, for the command bar to show as a table (TASK-189); `result` says how many. */
  table?: SearchTable;
  error?: string;
  /** The coded refusal, when an authorization rule refused the action (ADR-051). */
  code?: string;
  params?: Readonly<Record<string, string | number | readonly string[]>>;
  /**
   * The write's commit was lost with its connection (review 14 L-2): it may or may not have taken
   * effect. Never a success; audited `indeterminate`, not `failed`; what follows a write that may
   * stand (an invalidation) runs all the same.
   */
  indeterminate?: boolean;
};

/**
 * A failed result with its code of the error-code contract (TASK-199): the code is the `error`
 * too, so nothing but a code reaches the admin's screen or the execute route.
 */
export function coded<C extends ErrorCode>(
  code: C,
  ...params: keyof ParamsOf<C> extends never ? [] : [ParamsOf<C>]
): ActionResult {
  const p = params[0] as ActionResult["params"] | undefined;
  return { success: false, error: code, code, ...(p ? { params: p } : {}) };
}

/** An action refused by an authorization rule, carrying its coded error. */
export function refusal(r: RoleRefusal): ActionResult {
  return { success: false, error: r.code, code: r.code, params: r.params };
}

/**
 * An action's rules for an admin, split in two (TASK-194 round 10, I-C): `facts` reads what the
 * rules depend on — once per action, no admin in it (a read error throws: the caller fails
 * closed) — and `decide` applies them to one admin, pure. The requester's check, an approver's
 * (decideApproval) and who could approve at all (pending-approvals noEligibleDecider) all run
 * the same pair: `applyRule` for one admin, or the facts once and `decide` for each candidate.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- an input, as handlers take it */
export interface ApproverRule<F = unknown> {
  /**
   * What is decided on the input and the admin alone, before any read (round 11, nit 5): a
   * refusal here stands even when the facts cannot be read — an erasure of one's own account is
   * `admin.self_target`, never a lookup failure.
   */
  readonly beforeFacts?: (
    input: Record<string, any>,
    admin: VerifiedAdmin
  ) => ActionResult | null;
  readonly facts: (input: Record<string, any>) => Promise<F>;
  readonly decide: (
    input: Record<string, any>,
    facts: F,
    admin: VerifiedAdmin
  ) => ActionResult | null;
}

/** The rule for one admin: what needs no read, then its facts read and decided. */
export async function applyRule<F>(
  rule: ApproverRule<F>,
  input: Record<string, any>,
  admin: VerifiedAdmin
): Promise<ActionResult | null> {
  return (
    rule.beforeFacts?.(input, admin) ?? rule.decide(input, await rule.facts(input), admin)
  );
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/** No facts to read: a rule decided on its input and the admin alone. */
export const NO_FACTS = async (): Promise<null> => null;

/** A change to the shared catalog refused to an admin who may not make it (ADR-053 D5). */
export function operatorOnly(): ActionResult {
  return { success: false, error: "admin.operator_only", code: "admin.operator_only" };
}

/**
 * Run `fn` in one owner transaction, for a catalog change the caller has already allowed
 * (mayChangePlatformCatalog) — and for the reads that guard it, so they see what the change
 * will see.
 */
export function catalogTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withOwnerTx("operator", fn);
}

/**
 * Run a write that reports its own outcome; a thrown database error becomes a failed result
 * carrying its message, as a returned `{ error }` did before (the transaction rolled back).
 */
export async function failedAsResult(
  write: () => Promise<ActionResult>
): Promise<ActionResult> {
  try {
    return await write();
  } catch (err) {
    if ((err as { indeterminate?: unknown } | null)?.indeterminate === true) {
      // The commit's answer was lost with its connection (review 14 L-2): it may have landed.
      logger.error(
        "Admin command write's commit was lost: whether it took effect is unknown",
        {
          route: "app/api/admin/ai/handlers",
        }
      );
      return { ...coded("admin.write_indeterminate"), indeterminate: true };
    }
    // The database's message (table, constraint, column) is logged, never shown; a unique
    // violation is said in plain words, since it is the admin's to fix.
    logger.error("Admin command write failed", {
      error: err instanceof Error ? err.message : String(err),
      route: "app/api/admin/ai/handlers",
    });
    if ((err as { code?: unknown } | null)?.code === "23505") {
      return coded("admin.already_exists");
    }
    return coded("service.unavailable", { service: "database" });
  }
}

/** A governed config write's outcome as a command-bar result (audit X-7). */
export function fromGovernedConfig(
  outcome: GovernedConfigOutcome,
  key: string,
  summary: string
): ActionResult {
  switch (outcome.kind) {
    case "applied":
      return { success: true, result: summary };
    case "pending": {
      // Held, not applied: a distinct result, never success (review 9 H1). It is the key's own
      // hold — the one hold on this change (review 10 H1): an approver needs the key's tier
      // permission, and the change applies when the hold is approved.
      const proposalId = outcome.result.approval?.proposalId;
      return {
        success: false,
        held: true,
        result: `${summary} — held for approval (${key} is under dual control) before it takes effect`,
        error: "Held for approval; it has not taken effect",
        ...(proposalId ? { proposalId } : {}),
      };
    }
    case "refused":
      return {
        success: false,
        error: "auth.permission_denied",
        code: "auth.permission_denied",
        params: { permission: outcome.permission },
      };
    case "refused_scope":
      return coded("admin.config_scope_refused", { key });
    case "not_found":
      return {
        success: false,
        error: "admin.target_not_found",
        code: "admin.target_not_found",
        params: { target: key },
      };
    case "invalid": {
      // The structured reason, worded by the message (round 14, item 2).
      const { reason, ...bounds } = outcome.params;
      return {
        success: false,
        error: "admin.config_invalid_value",
        code: "admin.config_invalid_value",
        params: { ...bounds, key, reason },
      };
    }
    case "failed":
      // Its code when it has one — a change already waiting, the audit log unavailable, a lost
      // commit (round 14, item 1: every one answered admin.action_failed) — else
      // admin.action_failed. Its text is logged, never returned (TASK-199).
      if (outcome.code && outcome.code !== "admin.action_failed") {
        return {
          success: false,
          error: outcome.code,
          code: outcome.code,
          params: { ...(outcome.params ?? {}) },
          // A lost commit may stand (round 15, I-3): audited `indeterminate`, never `failed`.
          ...(outcome.code === "admin.write_indeterminate"
            ? { indeterminate: true }
            : {}),
        };
      }
      logger.error("Governed config write failed", {
        key,
        error: describeFailure(outcome.result),
        route: "app/api/admin/ai/handlers",
      });
      return coded("admin.action_failed");
  }
}

/**
 * Run a command-bar action after recording it (platform/auth/audit.ts audited): when the record
 * cannot be written the action does not run, and the admin is told why (audit X-8).
 */
export async function runAudited(
  entry: AuditEntry,
  act: () => Promise<ActionResult>,
  options: { readonly external?: boolean } = {}
): Promise<ActionResult> {
  try {
    return await audited(entry, act, options);
  } catch (err) {
    if (err instanceof AuditWriteError) {
      return coded("service.unavailable", { service: "audit" });
    }
    throw err;
  }
}
