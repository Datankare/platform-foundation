/**
 * platform/auth/feature-permissions.ts — The permission each user feature requires (TASK-194, C-4)
 *
 * The catalog's feature permissions were granted to roles and checked nowhere: a route gated on
 * account status (requireActorWithStatus(request, "translate")) served anyone whose account was in
 * good standing, so taking can_translate from a role — or a subscription tier without it —
 * changed nothing. Each feature named here now needs its permission as well, checked by
 * requireActorWithStatus (platform/auth/actor-guard.ts) on every route that names the feature —
 * for a signed-in user from their account's role and entitlements, for a guest from the `guest`
 * role (round 1, C2) — on top of the guest allowance.
 *
 * A feature not named here needs no permission beyond the account's standing. Every catalog
 * permission is either enforced (here, a guard, requirePermission, the command bar's tool map) or
 * listed as reserved with a reason (__tests__/admin-authorization-matrix.test.ts), and every key
 * here is named at a guard call or reserved (__tests__/feature-permissions-enforced.test.ts,
 * round 1 C4 — view_profile is reserved in the platform: no platform route serves a profile).
 *
 * Not here, by design (round 1, C6): the assistant stream (POST /api/stream, feature `stream`)
 * is not gated on can_translate — it is the AI assistant, not translation, and no catalog
 * permission governs it. It needs a signed-in account in good standing (no guests), is rate
 * limited per user and counted against the daily paid quota, and screens input and output. A
 * permission for it would be a new catalog entry granted to every role first, as 061 did for
 * these three.
 *
 * @module platform/auth
 */

/** The features and the permission each requires. */
export const FEATURE_PERMISSIONS: Readonly<Record<string, string>> = {
  translate: "can_translate",
  view_profile: "can_view_profile",
  update_profile: "can_edit_profile",
};

/** The permission `feature` requires, or undefined when it needs none beyond account standing. */
export function featurePermission(feature: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(FEATURE_PERMISSIONS, feature)
    ? FEATURE_PERMISSIONS[feature]
    : undefined;
}

/**
 * The feature permissions, each once (TASK-194 round 1, A7): a role created after migration 061
 * has them by default (the command bar's create_role, unless the request leaves some out), and
 * the Roles screen and the command bar say when a role lacks any — its holders cannot use that
 * feature.
 */
export const FEATURE_PERMISSION_CODES: readonly string[] = [
  ...new Set(Object.values(FEATURE_PERMISSIONS)),
].sort();

/** The feature permissions `held` does not include, in catalog order. */
export function missingFeaturePermissions(held: readonly string[]): string[] {
  const have = new Set(held);
  return FEATURE_PERMISSION_CODES.filter((code) => !have.has(code));
}
