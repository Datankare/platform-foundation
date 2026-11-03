/**
 * platform/auth/same-id.ts — whether two ids name the same account or actor (TASK-194 rebase,
 * rounds 2 and 3)
 *
 * An authorization decision that compares ids — "never one's own account", "the requester is not
 * the approver", "the owner only" — compared them with `===`. A users.id is a UUID, and Postgres
 * reads one in many spellings: any case, with or without hyphens (a hyphen may follow any group of
 * four hex digits), inside braces. An id typed in another spelling named the same account and
 * slipped past the self-change rule (platform/auth/entitlements.ts).
 *
 * The rule:
 *   - two ids that are UUIDs in any spelling Postgres accepts are the same exactly when their
 *     canonical forms (lower case, 8-4-4-4-12) are — so a "not the same" never holds for two
 *     spellings Postgres would match (the dangerous direction);
 *   - any other id (an agent's "agent:x", a subject that is no UUID) compares exactly, so two
 *     different actors never collapse into one;
 *   - a missing or empty id is never the same as anything.
 *
 * And at the boundary: a public function that writes by a user id refuses one without the
 * canonical UUID shape (hasCanonicalUuidShape: 8-4-4-4-12, any case — Postgres folds the case,
 * and sameId compares it folded) — as entitlements.ts does — so neither braces nor another
 * hyphenation reach the database. canonicalUuid gives the one lower-case form.
 * __tests__/id-equality.test.ts bans a raw comparison of ids in the authorization code.
 *
 * @module platform/auth
 */

/** A UUID in every spelling Postgres accepts: optional braces, a hyphen after any group of 4. */
const PG_UUID = /^\{?[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}\}?$/i;
const CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The canonical form (lower case, 8-4-4-4-12) of a UUID in any Postgres spelling, or null. */
export function canonicalUuid(value: string): string | null {
  if (!PG_UUID.test(value)) return null;
  // Braces only as a pair.
  if (value.startsWith("{") !== value.endsWith("}")) return null;
  const hex = value.replace(/[{}-]/g, "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Whether `value` has the canonical UUID shape — 8-4-4-4-12 hex, in any case (the shape, not the
 * lower-case form canonicalUuid returns: case is the one difference sameId and Postgres fold).
 */
export function hasCanonicalUuidShape(value: unknown): value is string {
  return typeof value === "string" && CANONICAL.test(value);
}

/** Whether `a` and `b` are the same id (the rule above). */
export function sameId(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a === "" || b === "")
    return false;
  if (a === b) return true;
  const ca = canonicalUuid(a);
  const cb = canonicalUuid(b);
  return ca !== null && ca === cb;
}

/**
 * sameId for ids that may be absent on both sides (a role a user may not have): two absent ids
 * (null / undefined) are the same "none"; one absent and one present are not; two present ids
 * by sameId.
 */
export function sameOptionalId(a: unknown, b: unknown): boolean {
  const none = (v: unknown) => v === null || v === undefined;
  if (none(a) || none(b)) return none(a) && none(b);
  return sameId(a, b);
}
