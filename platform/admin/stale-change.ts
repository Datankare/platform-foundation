/**
 * platform/admin/stale-change.ts — A held change whose value it replaces has changed (review 12 H2)
 *
 * Every held config change records the value it replaces when it is requested (`heldPrevious` on a
 * runtime hold's payload, `current_value` on a two-person approval). It is applied only with a
 * compare-and-set against that value: if the key was changed since — a kill switch, a power
 * reduction, another approved change — nothing is applied (a reset also compares the platform default
 * it would inherit, review 13 M1), the hold is withdrawn (audited), and the
 * decision answers approvals.stale (409): the requester asks again, against what is there now.
 * Before, an approval applied the whole value it was requested with, silently undoing whatever
 * had happened since — an approved scope change re-activated every agent a kill switch had just
 * suspended.
 *
 * @module platform/admin
 */

/** What a held change replaces: the target's value at request time (reset: and whether overridden). */
export interface HeldPrevious {
  readonly value: unknown;
  /** reset_config only: whether the tenant had its own value when the reset was requested. */
  readonly overridden?: boolean;
  /**
   * reset_config only (review 13 M1): the platform default the reset would inherit, when it was
   * requested — what the approver is shown as the value the tenant gets. An approval applies the
   * reset only while the default is still this one.
   */
  readonly inherited?: unknown;
}

/** The marker a stale change's failure text starts with, through the pipeline's error reason. */
export const STALE_CHANGE_PREFIX = "approvals.stale: ";

/** The failure text of a stale change for `key`. */
export function staleChangeMessage(key: string): string {
  return `${STALE_CHANGE_PREFIX}"${key}" changed since this change was requested, so nothing was changed. The request is withdrawn; ask again against the current value.`;
}

/** Whether a failure text is a stale change's. */
export function isStaleChangeFailure(reason: string | undefined): boolean {
  return typeof reason === "string" && reason.startsWith(STALE_CHANGE_PREFIX);
}

/** Whether `v` is a recorded HeldPrevious (from a payload: untyped). */
export function isHeldPrevious(v: unknown): v is HeldPrevious {
  return typeof v === "object" && v !== null && !Array.isArray(v) && "value" in v;
}
