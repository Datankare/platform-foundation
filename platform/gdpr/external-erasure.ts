/**
 * platform/gdpr/external-erasure.ts — the stores outside the database that hold an erased
 * person, and how erasure reaches each (TASK-193, audit B-8/D-9)
 *
 * The database erasure (platform/auth/user-data.ts) cannot reach a store outside it. The sign-in
 * identity — its address and attributes, at the identity provider — was deleted once, by the
 * self-service route only, with the user's own access token, and never retried: an admin or a
 * retention erasure left it for good, and a self-service delete whose call failed logged it and
 * moved on.
 *
 * Every such store is registered here (the platform registers the identity provider; an app adds
 * its file store or mail list with registerExternalErasure). Erasure runs each one with the
 * provider's administrative credentials, by the account's subject kept in user_deletions, and
 * records each outcome on the erasure's record (user_deletions.external_erasures, migration 060):
 * done, or the attempts and the last error. One not done is retried by the gdpr.retention-purge
 * job until it is (retryExternalErasures, with a growing interval), alerted after a few attempts,
 * and the erasure is never marked purged while one is pending. The self-service route goes
 * through the same steps (softDeleteUser), so there is one pipeline.
 *
 * __tests__/external-erasure-registry.test.ts holds the register: every store is run by
 * softDeleteUser and the purge, its outcome recorded and retried until done.
 *
 * @module platform/gdpr
 */

/** Who the erased person was, as the external stores know them. */
export interface ErasureSubject {
  /** The account's id (users.id). */
  readonly userId: string;
  /** The identity provider's subject (users.cognito_sub), when the account had one. */
  readonly sub: string | null;
  /**
   * The identity pool the account was proven present in, recorded at the soft delete
   * (user_deletions.identity_pool): null when never proven (not found, an erasure recorded before
   * 060, or reconciled).
   */
  readonly pool?: string | null;
}

export type ExternalErasureOutcome =
  | { readonly done: true }
  | {
      readonly done: false;
      readonly error: string;
      /** Not found, but not provably in the account's pool: kept pending and alerted. */
      readonly poolUnverified?: boolean;
    };

/** One store outside the database that holds the subject. */
export interface ExternalErasure {
  /** Stable name: the key of its outcome in user_deletions.external_erasures. */
  readonly name: string;
  /** What it holds, for the register's readers. */
  readonly holds: string;
  /** Remove the subject from it. Idempotent: a subject already gone is done. Never throws. */
  erase(subject: ErasureSubject): Promise<ExternalErasureOutcome>;
}

const SUB_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long one positive pool check counts (a job run's length). */
const POOL_CHECK_MS = 10 * 60_000;
let poolCheck: { readonly pool: string; readonly at: number } | undefined;

/** The auth provider, loaded when needed: the erasure modules are imported by the auth layer. */
async function provider() {
  const { initAuth } = await import("@/platform/auth/auth-init");
  const { getAuthProvider } = await import("@/platform/auth/config");
  initAuth();
  return getAuthProvider();
}

/**
 * The identity's subject: the account's identity subject — or, for an account bound by its id (a
 * legacy one with no recorded subject), its id when that has a subject's shape. Null: none.
 */
export function identitySubjectOf(
  subject: Pick<ErasureSubject, "userId" | "sub">
): string | null {
  return subject.sub ?? (SUB_SHAPE.test(subject.userId) ? subject.userId : null);
}

/**
 * The pool to record on an erasure (S2 round 2): the current pool only when the identity is
 * PROVEN present in it — the provider found it there (`identityInPool`: its own lookup, or a
 * subject learnt from a token this pool verified). Anything else — not found, a lookup that
 * failed, a provider without the check — is null: a later "not found" then stays unverified, and
 * only two operators' attestation closes it (erasure-attestation.ts).
 */
export async function provenIdentityPool(
  subject: Pick<ErasureSubject, "userId" | "sub">
): Promise<string | null> {
  const sub = identitySubjectOf(subject);
  if (!sub) return null;
  try {
    const auth = await provider();
    const pool = auth.identityPoolId?.();
    if (!pool || !auth.identityInPool) return null;
    return (await auth.identityInPool(sub)) === true ? pool : null;
  } catch {
    return null;
  }
}

/** Forget the positive pool check (tests). */
export function resetIdentityPoolCheck(): void {
  poolCheck = undefined;
}

/**
 * The identity provider: the sign-in identity, deleted with the administrative credentials.
 *
 * Round 1 (TASK-193): the subject is the account's identity subject — or, for an account bound by
 * its id (a legacy one with no recorded subject), its id when that has a subject's shape. A
 * provider's "not found" counts as erased only when the erasure recorded the pool the provider
 * deletes from and a positive pool check (confirmIdentityPool) passed in this run: otherwise it
 * stays pending, marked `poolUnverified`, and the job alerts (gdpr.identity_pool_unverified) — an
 * identity in another pool (an old one) is not erased by not being found in this one. The pool is
 * recorded only when the identity was proven present in it (provenIdentityPool); an erasure with
 * none recorded is closed only by two operators' attestation (erasure-attestation.ts).
 */
export const IDENTITY_ERASURE: ExternalErasure = {
  name: "identity-provider",
  holds: "the sign-in identity: its address, attributes and sign-in history",
  async erase(subject) {
    const sub = identitySubjectOf(subject);
    // No subject, and an id no identity can have: there is none to delete.
    if (!sub) return { done: true };
    try {
      const auth = await provider();
      if (!auth.adminDeleteUser) {
        return {
          done: false,
          error: "the identity provider has no administrative delete (adminDeleteUser)",
        };
      }
      const r = await auth.adminDeleteUser(sub);
      if (!r.success) {
        return {
          done: false,
          error: (r.error ?? "the identity was not deleted").slice(0, 300),
        };
      }
      if (!r.notFound) return { done: true };
      const current = auth.identityPoolId?.();
      const recorded = subject.pool ?? null;
      if (!current || !recorded || recorded !== current) {
        return {
          done: false,
          poolUnverified: true,
          error: `not found in pool ${current ?? "(unknown)"}; the identity was ${recorded ? `proven in pool ${recorded}` : "never proven present in a pool"}`,
        };
      }
      const fresh =
        poolCheck?.pool === current && Date.now() - poolCheck.at < POOL_CHECK_MS;
      if (!fresh) {
        if (!(await auth.confirmIdentityPool?.())) {
          return {
            done: false,
            poolUnverified: true,
            error: `not found, and pool ${current} could not be confirmed`,
          };
        }
        poolCheck = { pool: current, at: Date.now() };
      }
      return { done: true };
    } catch (err) {
      return {
        done: false,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      };
    }
  },
};

const registered: ExternalErasure[] = [IDENTITY_ERASURE];

/**
 * Add a store outside the database that holds the people an erasure removes (an app's file
 * store, mail list). Replaces one of the same name.
 */
export function registerExternalErasure(erasure: ExternalErasure): void {
  const at = registered.findIndex((e) => e.name === erasure.name);
  if (at >= 0) registered[at] = erasure;
  else registered.push(erasure);
}

/** Every registered external store, the identity provider first. */
export function listExternalErasures(): readonly ExternalErasure[] {
  return [...registered];
}

/** Back to the platform's own register (tests). */
export function resetExternalErasures(): void {
  registered.splice(0, registered.length, IDENTITY_ERASURE);
}

/** A recorded outcome (user_deletions.external_erasures[name]). */
export interface RecordedExternalErasure {
  readonly doneAt?: string;
  readonly attempts?: number;
  readonly error?: string;
  readonly retryAt?: string;
  /** The last attempt found nothing, in a pool it could not prove the account's (round 1). */
  readonly poolUnverified?: boolean;
  /** An operator's request to attest it erased, awaiting a second operator (erasure-attestation.ts). */
  readonly attestationRequest?: {
    readonly by: string;
    readonly at: string;
    readonly reason: string;
    readonly expiresAt: string;
  };
  /** Closed by two operators' attestation, not by proof (erasure-attestation.ts). */
  readonly attested?: {
    readonly by: string;
    readonly requestedBy: string;
    readonly at: string;
    readonly reason: string;
  };
}

/** After this many attempts a pending store is alerted (gdpr.external_erasure_pending). */
export const EXTERNAL_ERASURE_ALERT_ATTEMPTS = 3;

/** When a store that failed `attempts` times is tried again: 15 min, doubling, at most a day. */
export function externalRetryAt(attempts: number, now: number = Date.now()): string {
  const minutes = Math.min(24 * 60, 15 * 2 ** Math.max(0, attempts - 1));
  return new Date(now + minutes * 60_000).toISOString();
}

/**
 * Run every registered store not yet done for `subject` (`recorded`: the outcomes so far), each
 * outcome recorded as the store's entry. Returns the new map and the names still pending.
 */
export async function runExternalErasures(
  subject: ErasureSubject,
  recorded: Readonly<Record<string, RecordedExternalErasure>>,
  now: () => number = Date.now
): Promise<{
  readonly outcomes: Record<string, RecordedExternalErasure>;
  readonly pending: readonly string[];
}> {
  const outcomes: Record<string, RecordedExternalErasure> = { ...recorded };
  const pending: string[] = [];
  for (const store of listExternalErasures()) {
    if (outcomes[store.name]?.doneAt) continue;
    const r = await store
      .erase(subject)
      .catch((err: unknown): ExternalErasureOutcome => ({
        done: false,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      }));
    const attempts = (outcomes[store.name]?.attempts ?? 0) + 1;
    if (r.done) {
      outcomes[store.name] = { doneAt: new Date(now()).toISOString(), attempts };
    } else {
      outcomes[store.name] = {
        attempts,
        error: r.error,
        retryAt: externalRetryAt(attempts, now()),
        ...(r.poolUnverified ? { poolUnverified: true } : {}),
      };
      pending.push(store.name);
    }
  }
  return { outcomes, pending };
}

/** The registered stores `recorded` does not show done. */
export function pendingExternalErasures(
  recorded: Readonly<Record<string, RecordedExternalErasure>>
): readonly string[] {
  return listExternalErasures()
    .map((e) => e.name)
    .filter((name) => !recorded[name]?.doneAt);
}
