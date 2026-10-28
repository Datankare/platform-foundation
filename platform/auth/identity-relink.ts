/**
 * platform/auth/identity-relink.ts — Re-link existing accounts to their identity in a new user
 * pool (TASK-174, ADR-012 amendment "Moving to a new identity pool")
 *
 * An account is bound to its identity by users.cognito_sub (platform/auth/account-identity.ts).
 * A new user pool gives every identity a new subject, so after a move every existing account —
 * staff included — is unreachable: a sign-in with the new subject finds no account and is given a
 * new, ordinary one, and nobody can sign in as an administrator to repair it. This is the repair,
 * run by an operator from a trusted machine with the owner connection (scripts/relink-identity.mjs;
 * runbook: docs/TENANCY_OPERATIONS.md §6). No hand-made data change is ever needed.
 *
 * For an address it finds the identity in the CURRENT pool (IdentityDirectory) and the address's
 * account in the database, checks that they are unambiguously the same person, and changes only
 * the account's subject (users.cognito_sub) — never its id, which every foreign key, audit record,
 * trajectory, proposal and erasure record names. Provisioning and every lookup find an account by
 * its subject, so the next sign-in reaches the account with its role, standing and data.
 *
 * The subject is the pool user's `sub` (TASK-177, ADR-012): what every token verifier names a
 * request by — the platform's Cognito provider and Playform's alike, for a native and a federated
 * user — what the account is bound to, what an account's current subject is looked up by in the
 * pool, what two plans contest, and what a stray's id is. The pool's username (`Google_…` for a
 * federated user) is never one.
 *
 * The checks (each refusal is reported with what to do; nothing is changed):
 *
 *   - the address is plain ASCII (a non-ASCII lookalike is never folded onto an ASCII address —
 *     review 15 M1; provisioning stores addresses the same way, user-provisioning storedEmail);
 *   - exactly one user of the pool has the address, enabled, confirmed (or federated), with
 *     `email_verified` true — for a federated user, the provider's claim mapped into it, believed
 *     only from an allow-listed provider (AUTH_TRUSTED_EMAIL_IDPS, default Google; never Microsoft
 *     Entra ID — review 16 L8). Of several users with the address, unconfirmed or unverified ones
 *     are ignored beside the one that proves it (review 16 L4);
 *   - the account: exactly one live account of the tenant (or, without --tenant, of any tenant)
 *     with the address that was provisioned BEFORE the pool move (`createdBefore`, review 15 H1/M1).
 *     An account made in the new pool — a stray, or anyone's unconfirmed sign-up with the
 *     address — is never a target and never counted, so nobody can block a re-link by signing up
 *     with a staff address. The address's verification is the CURRENT pool's (above), not the
 *     old account's own flag (TASK-176): accounts made by sign-up were stored unverified and
 *     nothing ever updated them, and an old-pool account can no longer sign in to be brought up
 *     to date — so the one pre-move account is the target whatever users.email_verified says
 *     (the plan says so: `accountUnverified`) — but only on the operator's confirmation for that
 *     very account (`confirmUnverified`, review 16 D4f): the current pool's verification proves
 *     only that whoever signs in now holds the address, and an address mistyped when the account
 *     was made, or one that changed hands, would hand a staff account to a stranger. Without it
 *     the account is refused (`account.needs_confirmation`) and listed. The flag still decides
 *     between several pre-move accounts: one verified is the target whatever unverified ones
 *     there are (review 15 M1) — and a named unverified one is then refused, never silently
 *     replaced (review 16 L1); several, none verified, are refused (`account.many`) unless the
 *     operator names the person's by its id (`unverifiedAccount`, which is also its
 *     confirmation);
 *   - the account is not bound to an identity of the CURRENT pool already (review 15 H1): its
 *     current subject — a legacy row's id (review 16 L3) — is not a user's subject in this pool
 *     (ListUsers by `sub`), and it was not re-linked
 *     in this pool before (an identity_relinked record names it and this pool). An account that
 *     was moved is never moved again to whoever holds its old address now (users.email is not
 *     kept in step with the pool: an address changed there, then reused, would otherwise move a
 *     staff account to a stranger). Replacing a current pool's identity is account recovery,
 *     never this command;
 *   - the pool does not hold the identity in another tenant (custom:tenant_id);
 *   - the new subject is not an erased account's (it is never given an account again);
 *   - no other account holds the new subject — or, explicitly (`mergeFrom`, the holder's id), it
 *     is the stray account the person's first sign-in created and nothing is lost by removing it:
 *     the same tenant, provisioned for this subject (id = subject), active, on the default role,
 *     the same address or none, and holding nothing but sign-in residue (its row, audit records,
 *     rate-limit counters, metrics, devices). The stray is then removed and its subject moved, in
 *     the same transaction; its audit records stay, the record of its sign-ins. Its data is
 *     counted again after the delete, in the same transaction (review 15 L7): anything written
 *     for it meanwhile (a table with no foreign key to users is not held by the row lock) undoes
 *     that address's re-link;
 *   - in a bulk run no two addresses are re-linked to one identity (review 15 M3: the same
 *     address in two tenants, one pool user) — both are refused, `subject.contested`.
 *
 * How it runs: the addresses (bulk: every account in scope, one set-based read), then the pool —
 * outside any transaction, no network call inside one: each address as stored and in lower case
 * (ListUsers is case-sensitive, review 15 L6), and each candidate account's current subject. Then
 * the plan, in read-only transactions: a dry run cannot change anything. With `apply`, every
 * address is planned first (any refusal stops the run before anything is changed, unless
 * `skipAmbiguous`), then applied in chunks of `chunkSize` addresses (review 15 M4), each chunk
 * one owner transaction that plans its addresses again under `for update` and applies them with
 * their audit records (admin_action / identity_relinked: the operator, the machine's user, the
 * reason, the pool move time, both subjects as hashes) — a chunk commits whole or not at all. An
 * address whose locked plan differs from the preview is refused (`account.changed`), and one the
 * preview refused stays refused (review 16 L2: only what the preview showed is applied). A chunk
 * whose COMMIT lost its connection is reported `indeterminate` — it may have committed (review 16
 * L7) — never "nothing was changed". The report
 * says which chunks were applied; a run interrupted after a chunk committed is run again — what
 * was applied reads `linked`, the rest is applied (idempotent). After each chunk commits, cached
 * permissions and remembered token verifications of both subjects are voided, on every instance
 * when the shared cache is reachable (the caller's `invalidate`, which throws when it was not
 * published — review 16 M2); a failure there is reported (`notInvalidated`), never taken for the
 * change not having been made (review 15 M2).
 *
 * GenAI Principles: P11 (fail-closed — ambiguity refuses), P3 (every change recorded with its
 * reason and operator)
 *
 * @module platform/auth
 */

import { createHash, randomUUID } from "node:crypto";
import {
  isCommitOutcomeUnknown,
  withOwnerTx,
  withSavepoint,
  type Tx,
} from "@/platform/data";
import { eraseUserData, USER_DATA_TABLES } from "@/platform/auth/user-data";
import { isStaffPermission } from "@/platform/auth/role-governance";
import { assertStorableJson } from "@/platform/errors/json-limits";
import {
  DEFAULT_TRUSTED_EMAIL_IDPS,
  getTrustedEmailIdps,
  isTenantId,
} from "@/platform/providers/environment-contract";
import {
  emailClaimTrusted,
  filterSafeEmail,
  type DirectoryUser,
  type IdentityDirectory,
} from "@/platform/auth/identity-directory";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An ISO 8601 time with its zone (never a local time read in the operator's zone). */
const ISO_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Addresses applied per transaction (bulk). */
export const DEFAULT_CHUNK_SIZE = 500;

/** The pool statuses an identity may be re-linked in: signed up and confirmed, or federated. */
const LINKABLE_STATUSES: ReadonlySet<string> = new Set([
  "CONFIRMED",
  "EXTERNAL_PROVIDER",
]);

/** What a stray first-sign-in account may hold and still be merged (register entry names). */
export const STRAY_RESIDUE: ReadonlySet<string> = new Set([
  "profile",
  "auditLog",
  "auditMentions",
  "rateLimitBuckets",
  "aiMetrics",
  "devices",
]);
/** Of the residue, what is removed with the stray (audit records stay: the record of its sign-ins). */
const STRAY_REMOVED = ["rateLimitBuckets", "aiMetrics", "devices"] as const;

/** The agent named on the audit record. */
export const RELINK_AGENT = "operator:relink-identity";

export type RefusalCode =
  | "address.unsupported"
  | "pool.none"
  | "pool.many"
  | "pool.disabled"
  | "pool.unconfirmed"
  | "pool.unverified"
  | "pool.other_tenant"
  | "account.none"
  | "account.many"
  | "account.unverified"
  | "account.bound_in_pool"
  | "account.relinked_in_pool"
  | "account.changed"
  | "account.needs_confirmation"
  | "subject.erased"
  | "subject.held"
  | "subject.held_elsewhere"
  | "subject.contested"
  | "merge.mismatch"
  | "merge.unsafe";

/**
 * An address as compared: trimmed, its ASCII letters in lower case — nothing else folded (review
 * 15 M1: `toLowerCase()` turns the Kelvin sign U+212A into "k"). The same rule as provisioning's
 * storedEmail; a non-ASCII address is refused (acceptableEmail).
 */
export function normaliseEmail(email: string): string {
  return email.trim().replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/** Printable ASCII only: no lookalike, no control character. */
function isAscii(text: string): boolean {
  return /^[\x21-\x7e]*$/.test(text);
}

/** Whether `email` (normalised) is an address the re-link accepts: plain ASCII, one @, a dotted domain. */
export function acceptableEmail(email: string): boolean {
  if (!isAscii(email) || !filterSafeEmail(email) || /[\s,;<>]/.test(email)) return false;
  const parts = email.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts as [string, string];
  const labels = domain.split(".");
  return local.length > 0 && labels.length >= 2 && labels.every((l) => l.length > 0);
}

/** A subject (or id) as recorded: a short keyed-free hash — enough to match, never the value. */
export function subjectHint(subject: string | null): string | null {
  return subject
    ? `sha256:${createHash("sha256").update(subject.toLowerCase()).digest("hex").slice(0, 16)}`
    : null;
}

/** A subject as printed for the operator: its first 8 characters. */
export function partial(subject: string | null): string {
  return subject ? `${subject.slice(0, 8)}…` : "(none)";
}

interface AccountRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly cognito_sub: string | null;
  readonly email: string | null;
  readonly status: string;
  readonly role: string;
  readonly role_default: boolean;
  readonly deleted: boolean;
  /** users.email_verified. */
  readonly verified: boolean;
  /** Provisioned before the pool move (users.created_at < createdBefore). */
  readonly before_move: boolean;
}

/** One account's plan: what would be (or was) done, or why not. */
export type AccountPlan =
  | {
      readonly status: "relink";
      readonly email: string;
      readonly tenantId: string;
      readonly accountId: string;
      readonly role: string;
      readonly accountStatus: string;
      readonly previousSubject: string | null;
      readonly newSubject: string;
      readonly signsInWith: readonly string[];
      /** The stray account removed in the same transaction. */
      readonly merge?: { readonly accountId: string };
      /** Of several pre-move accounts none with the address verified: the operator named this one. */
      readonly unverifiedAccepted?: true;
      /**
       * The account's own users.email_verified was false (an old-pool account, typically made by
       * sign-up, or created by an administrator with an address nobody proved): the address is
       * verified only by the current pool — by whoever holds it now (review 16 D4f).
       */
      readonly accountUnverified?: true;
      /**
       * The operator confirmed, for this account, that the person verifying the address in the
       * current pool is the account's person (--confirm-unverified <id>, or --unverified-account
       * <id>): required for every accountUnverified re-link (review 16 D4f).
       */
      readonly unverifiedConfirmed?: true;
    }
  | {
      readonly status: "linked";
      readonly email: string;
      readonly tenantId: string;
      readonly accountId: string;
    }
  | { readonly status: "absent"; readonly email: string }
  | {
      readonly status: "refused";
      readonly email: string;
      readonly code: RefusalCode;
      readonly detail: string;
      /** subject.held: the stray's account id, when merging it would be safe. */
      readonly mergeCandidate?: string;
      /** account.many (none verified): the accounts one of which may be named (--unverified-account). */
      readonly unverifiedCandidates?: readonly string[];
      /**
       * account.needs_confirmation: the account whose own address was never verified, re-linked
       * only when the operator confirms it (--confirm-unverified <this id>) — review 16 D4f.
       */
      readonly needsConfirmation?: {
        readonly accountId: string;
        readonly tenantId: string;
        readonly role: string;
      };
    };

export interface RelinkRequest {
  /** One address; or `scope` for a bulk run. */
  readonly email?: string;
  readonly scope?: "all-staff" | "all";
  readonly tenantId?: string;
  /**
   * When the deployment moved to the current pool (ISO 8601 with its zone): accounts provisioned
   * at or after it are the new pool's — never a target and never counted (review 15 H1/M1).
   */
  readonly createdBefore: string;
  /** Single: the stray account (holding the new subject) to merge. */
  readonly mergeFrom?: string;
  /**
   * Single: of several pre-move accounts with the address, none with it verified, this one is the
   * person's (the operator confirmed it with them). Naming it is also its confirmation
   * (confirmUnverified).
   */
  readonly unverifiedAccount?: string;
  /**
   * The accounts (ids) whose own address was never verified that the operator confirmed are the
   * person's who verifies the address in the current pool (review 16 D4f): an accountUnverified
   * target is re-linked only when named here — single and bulk alike.
   */
  readonly confirmUnverified?: readonly string[];
  /** Bulk: merge every stray that is safe to merge. */
  readonly mergeStrays?: boolean;
  /** Bulk: skip refused addresses instead of stopping the run. */
  readonly skipAmbiguous?: boolean;
  /** Perform it; otherwise a dry run (read-only). */
  readonly apply: boolean;
  readonly operator: string;
  readonly osUser: string;
  readonly host: string;
  readonly reason: string;
}

export interface RelinkDeps {
  readonly directory: IdentityDirectory;
  /**
   * Void cached permissions and token verifications of a subject (after the commit). Resolves
   * only when the invalidation was published; throws (with why) when it was not (review 16 M2).
   */
  readonly invalidate: (subject: string) => Promise<void>;
  /**
   * The federated providers whose email_verified claim is trusted (review 16 L8); default
   * AUTH_TRUSTED_EMAIL_IDPS (Google only).
   */
  readonly trustedEmailIdps?: ReadonlySet<string>;
  /** Addresses per apply transaction; default DEFAULT_CHUNK_SIZE. */
  readonly chunkSize?: number;
  /**
   * Test seam: called inside each apply transaction once its addresses are planned under lock,
   * before anything is applied — with the chunk's index and the transaction.
   */
  readonly onChunk?: (index: number, tx: Tx) => Promise<void>;
  /**
   * Test seam (review 16 L9): the tenants a run without --tenant spans — every tenant otherwise.
   * Not an operator option: a test of a cross-tenant run stays within its own tenants.
   */
  readonly onlyTenants?: readonly string[];
}

/** What became of one chunk of an applied run. */
export interface ChunkOutcome {
  readonly index: number;
  /** Its addresses: plans[from] … plans[to - 1]. */
  readonly from: number;
  readonly to: number;
  /**
   * applied — committed (`relinked` changes); refused — an address changed since the preview and
   * the run stopped (nothing in it changed); failed — the database failed (nothing in it
   * changed); indeterminate — the connection failed while it was committing: it may have
   * committed (review 16 L7 — the verify command says); skipped — nothing in it to apply;
   * not-run — the run stopped before it.
   */
  readonly outcome:
    "applied" | "refused" | "failed" | "indeterminate" | "skipped" | "not-run";
  readonly relinked: number;
}

export interface RelinkReport {
  readonly runId: string;
  /** Whether any change was committed. */
  readonly applied: boolean;
  readonly plans: readonly AccountPlan[];
  /**
   * Why the run stopped short although asked to apply: a refusal (before anything was changed,
   * or — `chunks` says — after earlier chunks committed), a failure after earlier chunks
   * committed (a failure before any commit is thrown), or a commit whose outcome is unknown
   * (indeterminate, review 16 L7: whether that chunk changed anything is not known).
   */
  readonly stoppedBy?: "refusal" | "failure" | "indeterminate";
  /** The failure that stopped an applied run after a chunk committed (its message). */
  readonly failure?: { readonly chunk: number; readonly message: string };
  /** Apply runs: each chunk's outcome. */
  readonly chunks: readonly ChunkOutcome[];
  /** The subjects whose caches were voided after the commit. */
  readonly invalidated: readonly string[];
  /** The subjects whose caches could not be voided (review 15 M2), with why. */
  readonly notInvalidated: readonly {
    readonly subject: string;
    readonly error: string;
  }[];
  /** --confirm-unverified ids that named no account needing it in this run (a typo, or moot). */
  readonly unusedConfirmations: readonly string[];
}

/** The request is malformed: nothing was read. */
export class RelinkUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelinkUsageError";
  }
}

const refusal = (
  email: string,
  code: RefusalCode,
  detail: string,
  extra: {
    mergeCandidate?: string;
    unverifiedCandidates?: readonly string[];
    needsConfirmation?: { accountId: string; tenantId: string; role: string };
  } = {}
): AccountPlan => ({ status: "refused", email, code, detail, ...extra });

/** The hint for an address the pool holds unverified, or verified by an untrusted provider. */
const UNVERIFIED_FEDERATED_HINT =
  "map the provider's email_verified claim to the pool's email_verified attribute (the pool's attribute mapping) only for a provider whose claim is trustworthy — Google, Sign in with Apple — and list it in AUTH_TRUSTED_EMAIL_IDPS (default: Google); never for Microsoft Entra ID (its email is an attribute the account's own tenant can set to any address, unverified: nOAuth) — then the person signs in once more";

/** Whether a pool user's address counts as verified: the attribute, from a trusted source. */
function verifiedInPool(user: DirectoryUser, trusted: ReadonlySet<string>): boolean {
  return user.emailVerified && emailClaimTrusted(user.providers, trusted);
}

const DEFAULT_TRUSTED: ReadonlySet<string> = new Set(DEFAULT_TRUSTED_EMAIL_IDPS);

/**
 * The pool's answer for an address: its one usable identity, or why there is none.
 *
 * Several users with the address (review 16 L4): when exactly one of them is confirmed (or
 * federated) with the address verified by a trusted source — and enabled — it is the identity,
 * and the others (unconfirmed sign-ups, users whose address is not verified or verified only by
 * an untrusted provider) are ignored: none of them can prove the address, so none can block its
 * verified owner (an attacker's unconfirmed sign-up with a staff address used to refuse the
 * re-link, pool.many). Two that both prove it, or one that proves it but is disabled, are still
 * pool.many — the address does not say which is the person.
 */
export function poolIdentity(
  email: string,
  users: readonly DirectoryUser[],
  trusted: ReadonlySet<string> = DEFAULT_TRUSTED
): { readonly user: DirectoryUser } | { readonly plan: AccountPlan } {
  const matching = users.filter((u) => normaliseEmail(u.email) === email);
  const bySubject = new Map<string, DirectoryUser>();
  for (const u of matching) if (!bySubject.has(u.sub)) bySubject.set(u.sub, u);
  let found = [...bySubject.values()];
  if (found.length === 0)
    return {
      plan: refusal(email, "pool.none", "no user of the current pool has this address"),
    };
  if (found.length > 1) {
    const proving = found.filter(
      (u) => LINKABLE_STATUSES.has(u.status) && verifiedInPool(u, trusted)
    );
    if (proving.length === 1 && proving[0]!.enabled) found = proving;
  }
  if (found.length > 1)
    return {
      plan: refusal(
        email,
        "pool.many",
        `${found.length} users of the current pool have this address (${found
          .map((u) => (u.providers.length ? u.providers.join("+") : "password"))
          .join(
            ", "
          )}) — link them into one user (AdminLinkProviderForUser) or delete the extra one, then run again`
      ),
    };
  const user = found[0]!;
  if (!user.enabled)
    return { plan: refusal(email, "pool.disabled", "the pool's user is disabled") };
  if (!LINKABLE_STATUSES.has(user.status))
    return {
      plan: refusal(
        email,
        "pool.unconfirmed",
        `the pool's user is ${user.status}, not confirmed — they finish signing up first`
      ),
    };
  if (!user.emailVerified)
    return {
      plan: refusal(
        email,
        "pool.unverified",
        user.providers.length
          ? `the address is not verified in the pool (${user.providers.join("+")}): ${UNVERIFIED_FEDERATED_HINT}`
          : "the address is not verified in the pool: the person verifies it (or confirms it with the code), then run again"
      ),
    };
  if (!emailClaimTrusted(user.providers, trusted))
    return {
      plan: refusal(
        email,
        "pool.unverified",
        `the address is verified only by ${user.providers.join("+")}, whose email_verified claim is not trusted (AUTH_TRUSTED_EMAIL_IDPS): ${UNVERIFIED_FEDERATED_HINT}`
      ),
    };
  return { user };
}

// ── The addresses, and what the database holds for them (set-based: one statement per chunk) ──

/** One address to plan: its tenant (null: any), its normalised form, the forms it is stored in. */
interface AddressInput {
  readonly tenantId: string | null;
  readonly email: string;
  /** As stored (trimmed), or as typed: what the pool is asked besides the normalised form. */
  readonly stored: readonly string[];
}

/**
 * Every live account with each address (by its index in `inputs`), in its tenant or — tenant
 * null — in each tenant (expanded here, so every probe is (tenant, address): an index scan of
 * migration 055's users (tenant_id, lower(btrim(email))), never a scan of the table). Matched by
 * lower(btrim(email)) and then exactly by normaliseEmail in code: a row that Postgres's lower()
 * folds onto the address (a non-ASCII lookalike) is another address.
 */
async function accountsWithEmails(
  tx: Tx,
  inputs: readonly AddressInput[],
  createdBefore: string,
  lock: boolean,
  onlyTenants: readonly string[] | null
): Promise<Map<number, AccountRow[]>> {
  const out = new Map<number, AccountRow[]>();
  if (inputs.length === 0) return out;
  const allTenants = inputs.some((a) => a.tenantId === null)
    ? (
        await tx.query<{ id: string }>(
          "select id from tenants where $1::uuid[] is null or id = any($1::uuid[]) order by id",
          [onlyTenants]
        )
      ).rows.map((r) => r.id)
    : [];
  const probes: { i: number; t: string; e: string }[] = [];
  inputs.forEach((a, i) => {
    for (const t of a.tenantId === null ? allTenants : [a.tenantId])
      probes.push({ i, t, e: a.email });
  });
  if (probes.length === 0) return out;
  const { rows } = await tx.query<AccountRow & { i: number }>(
    lock
      ? `select q.i, u.id, u.tenant_id, u.cognito_sub, u.email, u.account_status::text as status,
                r.name as role, r.is_default as role_default, u.deleted_at is not null as deleted,
                u.email_verified as verified,
                u.created_at < $4::timestamptz as before_move
           from unnest($1::int[], $2::uuid[], $3::text[]) as q(i, t, e)
           join users u on u.tenant_id = q.t and lower(btrim(u.email)) = q.e
           join roles r on r.id = u.role_id
          where u.deleted_at is null
          order by q.i, u.tenant_id, u.id
          for update of u`
      : `select q.i, u.id, u.tenant_id, u.cognito_sub, u.email, u.account_status::text as status,
                r.name as role, r.is_default as role_default, u.deleted_at is not null as deleted,
                u.email_verified as verified,
                u.created_at < $4::timestamptz as before_move
           from unnest($1::int[], $2::uuid[], $3::text[]) as q(i, t, e)
           join users u on u.tenant_id = q.t and lower(btrim(u.email)) = q.e
           join roles r on r.id = u.role_id
          where u.deleted_at is null
          order by q.i, u.tenant_id, u.id`,
    [
      probes.map((p) => p.i),
      probes.map((p) => p.t),
      probes.map((p) => p.e),
      createdBefore,
    ]
  );
  for (const row of rows) {
    if (row.email === null || normaliseEmail(row.email) !== inputs[row.i]!.email)
      continue;
    const list = out.get(row.i) ?? [];
    list.push(row);
    out.set(row.i, list);
  }
  return out;
}

/**
 * The subject an account row is bound to (account-identity.ts bindingOf): its cognito_sub, or —
 * a legacy row with none — its id (review 16 L3).
 */
export function boundSubject(row: {
  readonly id: string;
  readonly cognito_sub: string | null;
}): string {
  return row.cognito_sub ?? row.id;
}

/** Whether the row is bound to `subject` (bindingOf: by cognito_sub, or a legacy row by its id). */
function bindsTo(
  row: { readonly id: string; readonly cognito_sub: string | null },
  subject: string
): boolean {
  return row.cognito_sub !== null
    ? row.cognito_sub === subject
    : UUID.test(subject) && row.id.toLowerCase() === subject.toLowerCase();
}

/** The account (live or erased-not-purged) holding each subject — a legacy row by its id. */
async function holdersOf(
  tx: Tx,
  subjects: readonly string[],
  lock: boolean
): Promise<Map<string, AccountRow>> {
  if (subjects.length === 0) return new Map();
  const ids = subjects.filter((s) => UUID.test(s)).map((s) => s.toLowerCase());
  const { rows } = await tx.query<AccountRow>(
    lock
      ? `select u.id, u.tenant_id, u.cognito_sub, u.email, u.account_status::text as status,
                r.name as role, r.is_default as role_default, u.deleted_at is not null as deleted,
                u.email_verified as verified, true as before_move
           from users u join roles r on r.id = u.role_id
          where u.cognito_sub = any($1::text[])
             or (u.cognito_sub is null and u.id = any($2::uuid[]))
          for update of u`
      : `select u.id, u.tenant_id, u.cognito_sub, u.email, u.account_status::text as status,
                r.name as role, r.is_default as role_default, u.deleted_at is not null as deleted,
                u.email_verified as verified, true as before_move
           from users u join roles r on r.id = u.role_id
          where u.cognito_sub = any($1::text[])
             or (u.cognito_sub is null and u.id = any($2::uuid[]))`,
    [subjects, ids]
  );
  const holders = new Map<string, AccountRow>();
  for (const s of subjects) {
    const row = rows.find((r) => bindsTo(r, s));
    if (row) holders.set(s, row);
  }
  return holders;
}

/** The subjects that name an erased account (by its record's subject, or its id). */
async function erasedSubjects(tx: Tx, subjects: readonly string[]): Promise<Set<string>> {
  if (subjects.length === 0) return new Set();
  const ids = subjects.filter((s) => UUID.test(s)).map((s) => s.toLowerCase());
  const { rows } = await tx.query<{ cognito_sub: string | null; user_id: string }>(
    `select cognito_sub, user_id::text as user_id from user_deletions
      where cognito_sub = any($1::text[]) or user_id = any($2::uuid[])`,
    [subjects, ids]
  );
  const erased = new Set<string>();
  for (const s of subjects)
    if (rows.some((r) => r.cognito_sub === s || r.user_id === s.toLowerCase()))
      erased.add(s);
  return erased;
}

/** Of `accountIds`, those already re-linked in `poolId` (an identity_relinked record names them). */
async function relinkedInPool(
  tx: Tx,
  accountIds: readonly string[],
  poolId: string
): Promise<Set<string>> {
  if (accountIds.length === 0) return new Set();
  const { rows } = await tx.query<{ target_id: string }>(
    `select distinct target_id::text as target_id from audit_log
      where target_id = any($1::uuid[]) and action = 'admin_action'::audit_action
        and details->>'type' = 'identity_relinked' and details->>'pool' = $2
        and details->>'outcome' = 'succeeded'`,
    [accountIds, poolId]
  );
  return new Set(rows.map((r) => r.target_id.toLowerCase()));
}

/** Why the stray `holder` may not be merged (empty: it may), for the address `email`. */
async function strayProblems(
  tx: Tx,
  holder: AccountRow,
  email: string
): Promise<string[]> {
  const problems: string[] = [];
  if (holder.id.toLowerCase() !== (holder.cognito_sub ?? "").toLowerCase())
    problems.push("it is not a first-sign-in account (its id is not its subject)");
  if (holder.status !== "active") problems.push(`its standing is ${holder.status}`);
  if (!holder.role_default) problems.push(`its role is ${holder.role}, not the default`);
  if (holder.email !== null && normaliseEmail(holder.email) !== email)
    problems.push("it has another address");
  const held = await strayData(tx, holder.id);
  if (held.length > 0) problems.push(`it holds data (${held.join(", ")})`);
  return problems;
}

/** What the account `id` holds beyond sign-in residue, as `entry: rows`. */
async function strayData(tx: Tx, id: string): Promise<string[]> {
  return (await eraseUserData(tx, id, { dryRun: true }))
    .filter((s) => s.rows > 0 && !STRAY_RESIDUE.has(s.name))
    .map((s) => `${s.name}: ${s.rows}`);
}

interface PlanContext {
  readonly poolByEmail: ReadonlyMap<string, readonly DirectoryUser[]>;
  /**
   * For each candidate account's current subject (boundSubject): the pool's users with it as
   * their subject (undefined: not asked).
   */
  readonly poolBySubject: ReadonlyMap<string, readonly DirectoryUser[]>;
  readonly poolId: string;
  readonly createdBefore: string;
  readonly bulk: boolean;
  readonly trusted: ReadonlySet<string>;
  readonly mergeFrom?: string;
  readonly mergeStrays?: boolean;
  readonly unverifiedAccount?: string;
  /** The confirmed unverified accounts (lower-case ids). */
  readonly confirmUnverified: ReadonlySet<string>;
  /** RelinkDeps.onlyTenants (tests), or null: every tenant. */
  readonly onlyTenants: readonly string[] | null;
}

/** Plan a chunk of addresses in `tx`; `lock`: the rows read are locked (the apply transaction). */
async function planChunk(
  tx: Tx,
  inputs: readonly AddressInput[],
  context: PlanContext,
  lock: boolean
): Promise<AccountPlan[]> {
  // A non-ASCII address is refused (review 15 M1); another that is no address the pool can be
  // asked for is not in the pool (bulk: absent).
  const identities = inputs.map((a) =>
    isAscii(a.email)
      ? poolIdentity(a.email, context.poolByEmail.get(a.email) ?? [], context.trusted)
      : {
          plan: refusal(
            a.email,
            "address.unsupported",
            "the address is not plain ASCII: a lookalike is never matched to another address — this account is re-linked through account recovery, not by this command"
          ),
        }
  );
  const subjects = [
    ...new Set(identities.flatMap((x) => ("user" in x ? [x.user.sub] : []))),
  ];
  const holders = await holdersOf(tx, subjects, lock);
  const accounts = await accountsWithEmails(
    tx,
    inputs,
    context.createdBefore,
    lock,
    context.onlyTenants
  );
  const erased = await erasedSubjects(tx, subjects);
  const relinked = await relinkedInPool(
    tx,
    [...accounts.values()].flat().map((r) => r.id),
    context.poolId
  );
  const plans: AccountPlan[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const identity = identities[i]!;
    const email = inputs[i]!.email;
    if ("plan" in identity) {
      plans.push(
        context.bulk &&
          identity.plan.status === "refused" &&
          identity.plan.code === "pool.none"
          ? { status: "absent", email }
          : identity.plan
      );
      continue;
    }
    plans.push(
      await planAddress(tx, inputs[i]!, identity.user, {
        holder: holders.get(identity.user.sub) ?? null,
        rows: accounts.get(i) ?? [],
        erased: erased.has(identity.user.sub),
        relinked,
        context,
      })
    );
  }
  return plans;
}

/** Plan one address, given its pool identity and what the database holds for it. */
async function planAddress(
  tx: Tx,
  input: AddressInput,
  user: DirectoryUser,
  found: {
    readonly holder: AccountRow | null;
    readonly rows: readonly AccountRow[];
    readonly erased: boolean;
    readonly relinked: ReadonlySet<string>;
    readonly context: PlanContext;
  }
): Promise<AccountPlan> {
  const { holder, context } = found;
  const email = input.email;
  const tenantId = input.tenantId;
  // The subject every verifier names this identity by (TASK-177): its `sub` — what the account
  // is bound to, and searched by.
  const sub = user.sub;
  const others = found.rows.filter((a) => !bindsTo(a, sub));
  // Accounts made in the new pool are never a target and never counted (review 15 H1/M1).
  const considered = others.filter((a) => a.before_move);
  const late = others.length - considered.length;
  const lateNote =
    late > 0
      ? ` (${late} account(s) with it provisioned at or after --created-before, in the new pool, are not considered)`
      : "";

  if (considered.length === 0) {
    if (holder && !holder.deleted && (tenantId === null || holder.tenant_id === tenantId))
      return {
        status: "linked",
        email,
        tenantId: holder.tenant_id,
        accountId: holder.id,
      };
    return refusal(
      email,
      "account.none",
      (tenantId
        ? "no live account of this tenant provisioned before the pool move has this address"
        : "no live account provisioned before the pool move has this address") + lateNote
    );
  }

  const verified = considered.filter((a) => a.verified);
  const unverified = considered.filter((a) => !a.verified);
  let target: AccountRow;
  let unverifiedAccepted = false;
  const many = (
    list: readonly AccountRow[],
    what: string,
    extra: { unverifiedCandidates?: readonly string[] } = {},
    hint = ""
  ) => {
    const tenants = new Set(list.map((c) => c.tenant_id));
    return refusal(
      email,
      "account.many",
      (tenants.size > 1 && tenantId === null
        ? `${list.length} live accounts${what} in ${tenants.size} tenants have this address — name the tenant (--tenant)`
        : `${list.length} live accounts${what} of the tenant have this address — the address does not say which one is the person's`) +
        hint,
      extra
    );
  };
  if (verified.length > 1) {
    return many(verified, " with the address verified");
  } else if (verified.length === 1) {
    // One account whose address was verified: never blocked by unverified ones (review 15 M1).
    target = verified[0]!;
    // But never silently instead of the account the operator named (review 16 L1).
    if (
      context.unverifiedAccount !== undefined &&
      context.unverifiedAccount.toLowerCase() !== target.id.toLowerCase()
    )
      return refusal(
        email,
        "account.unverified",
        `the account named by --unverified-account is not the one this address re-links: account ${target.id} (its address verified) is — run again without --unverified-account to re-link that one, or resolve the accounts first`
      );
  } else if (context.unverifiedAccount !== undefined) {
    // Named by the operator: for an address with several pre-move accounts, none verified.
    const named = unverified.find(
      (a) => a.id.toLowerCase() === context.unverifiedAccount!.toLowerCase()
    );
    if (!named)
      return refusal(
        email,
        "account.unverified",
        "the account named by --unverified-account is not a live account with this address provisioned before the pool move"
      );
    target = named;
    unverifiedAccepted = true;
  } else if (unverified.length > 1) {
    const tenants = new Set(unverified.map((c) => c.tenant_id));
    return many(
      unverified,
      " (none with the address verified)",
      { unverifiedCandidates: unverified.map((a) => a.id) },
      tenants.size > 1 && tenantId === null
        ? ""
        : `. If you have confirmed with the person which is theirs, run again with --email and --unverified-account <its id> (one of ${unverified.map((a) => a.id).join(", ")})`
    );
  } else {
    // The one pre-move account: its own flag is not evidence either way (TASK-176) — the
    // address is verified by the current pool (poolIdentity).
    target = unverified[0]!;
  }

  if (user.tenantId !== null && user.tenantId !== target.tenant_id)
    return refusal(
      email,
      "pool.other_tenant",
      "the pool holds this identity in another tenant (custom:tenant_id) — it is never moved by a re-link"
    );

  // Never moved away from an identity of the current pool (review 15 H1) — a legacy row (no
  // cognito_sub) is bound by its id and asked by it (review 16 L3).
  {
    const bound = boundSubject(target);
    const current = context.poolBySubject.get(bound);
    if (current === undefined)
      return refusal(
        email,
        "account.changed",
        "the account's subject changed since the pool was read — run again"
      );
    if (current.length > 0)
      return refusal(
        email,
        "account.bound_in_pool",
        `the account is already bound to an identity of the current pool (${partial(bound)}): it is never moved to another — the address in the database follows the pool only when the account's own person signs in (TASK-185), so it can be behind the pool's, and whoever holds that address now is not the account's person. If the person really lost that identity, that is account recovery, not a pool move`
      );
  }
  if (found.relinked.has(target.id.toLowerCase()))
    return refusal(
      email,
      "account.relinked_in_pool",
      "the account was already re-linked in the current pool (its identity_relinked record): it is never moved again by this command — whoever holds its old address now is not the account's person. If the person really lost that identity, that is account recovery, not a pool move"
    );

  if (found.erased)
    return refusal(
      email,
      "subject.erased",
      "the pool's identity belongs to an erased account — it is never given an account again"
    );

  let merge: { accountId: string } | undefined;
  if (holder) {
    if (holder.tenant_id !== target.tenant_id)
      return refusal(
        email,
        "subject.held_elsewhere",
        "the new identity already has an account in another tenant — never merged across tenants"
      );
    if (holder.deleted)
      return refusal(
        email,
        "subject.erased",
        "the new identity's account was erased — it is never given an account again"
      );
    const problems = await strayProblems(tx, holder, email);
    const asked =
      context.mergeFrom !== undefined
        ? context.mergeFrom.toLowerCase() === holder.id.toLowerCase()
        : context.mergeStrays === true;
    if (context.mergeFrom !== undefined && !asked)
      return refusal(
        email,
        "merge.mismatch",
        "the account named to merge is not the one holding the new identity"
      );
    if (!asked)
      return refusal(
        email,
        "subject.held",
        problems.length === 0
          ? `the new identity already has its own account (made at its first sign-in): it holds only sign-in residue and may be merged — run again with --merge-from ${holder.id}`
          : `the new identity already has its own account, which cannot be merged: ${problems.join("; ")} — the person's data there would be lost`,
        problems.length === 0 ? { mergeCandidate: holder.id } : {}
      );
    if (problems.length > 0)
      return refusal(
        email,
        "merge.unsafe",
        `the account holding the new identity cannot be merged: ${problems.join("; ")}`
      );
    merge = { accountId: holder.id };
  } else if (context.mergeFrom !== undefined) {
    return refusal(
      email,
      "merge.mismatch",
      "no account holds the new identity — there is nothing to merge"
    );
  }

  // The account's own address was never verified (review 16 D4f): the current pool's
  // verification proves only that whoever signs in now holds the address — an address mistyped
  // when the account was made, or one that changed hands, would give a staff account to a
  // stranger. Re-linked only on the operator's explicit confirmation for this very account (the
  // old pool, which could have said more, is gone: docs/TENANCY_OPERATIONS.md §6.6).
  const confirmed =
    unverifiedAccepted || context.confirmUnverified.has(target.id.toLowerCase());
  if (!target.verified && !confirmed)
    return refusal(
      email,
      "account.needs_confirmation",
      `the account's own address was never verified (users.email_verified is false: made before the move, by sign-up or by an administrator): whoever verifies ${email} in the current pool would get account ${target.id} (role ${target.role}). Confirm with the account's person — out of band — that this address is theirs and that they are the one signing in with it now, then run again with --confirm-unverified ${target.id}`,
      {
        needsConfirmation: {
          accountId: target.id,
          tenantId: target.tenant_id,
          role: target.role,
        },
      }
    );

  return {
    status: "relink",
    email,
    tenantId: target.tenant_id,
    accountId: target.id,
    role: target.role,
    accountStatus: target.status,
    previousSubject: target.cognito_sub,
    newSubject: sub,
    signsInWith: user.providers.length ? user.providers : ["password"],
    ...(merge ? { merge } : {}),
    ...(unverifiedAccepted ? { unverifiedAccepted: true as const } : {}),
    ...(!target.verified
      ? { accountUnverified: true as const, unverifiedConfirmed: true as const }
      : {}),
  };
}

/**
 * Two addresses planned onto one identity (review 15 M3: one address in two tenants, one pool
 * user): both refused, never one of them guessed — and never a unique violation mid-run.
 */
function refuseContested(
  plans: readonly AccountPlan[],
  alsoContested: ReadonlySet<string> = new Set()
): AccountPlan[] {
  const count = new Map<string, number>();
  for (const p of plans)
    if (p.status === "relink")
      count.set(p.newSubject, (count.get(p.newSubject) ?? 0) + 1);
  return plans.map((p) =>
    p.status === "relink" &&
    ((count.get(p.newSubject) ?? 0) > 1 || alsoContested.has(p.newSubject))
      ? refusal(
          p.email,
          "subject.contested",
          "more than one account (this address in more than one tenant) would be bound to the pool's one identity for it — re-link the person's own account alone (--email with --tenant)"
        )
      : p
  );
}

/** The subjects two or more plans would bind. */
function contestedSubjects(plans: readonly AccountPlan[]): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const p of plans)
    if (p.status === "relink") {
      if (seen.has(p.newSubject)) twice.add(p.newSubject);
      seen.add(p.newSubject);
    }
  return twice;
}

/** An address changed between the preview and its locked plan (or while it was applied). */
class ChangedMeanwhile extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string
  ) {
    super(message);
    this.name = "ChangedMeanwhile";
  }
}

/** The run stops in this chunk: its transaction rolls back, carrying the chunk's plans. */
class ChunkStopped extends Error {
  constructor(readonly plans: AccountPlan[]) {
    super("chunk stopped by a refusal");
    this.name = "ChunkStopped";
  }
}

function samePlan(a: AccountPlan, b: AccountPlan): boolean {
  return (
    a.status === "relink" &&
    b.status === "relink" &&
    a.accountId === b.accountId &&
    a.tenantId === b.tenantId &&
    a.previousSubject === b.previousSubject &&
    a.newSubject === b.newSubject &&
    a.merge?.accountId === b.merge?.accountId
  );
}

type RelinkPlan = Extract<AccountPlan, { status: "relink" }>;

interface ApplyContext {
  readonly runId: string;
  readonly poolId: string;
  readonly mode: string;
  readonly createdBefore: string;
}

/** The audit record of one re-link (admin_action / identity_relinked): never a whole subject. */
function relinkRecord(
  plan: RelinkPlan,
  request: RelinkRequest,
  context: ApplyContext
): string {
  const details = {
    type: "identity_relinked",
    agent: RELINK_AGENT,
    operator: request.operator,
    osUser: request.osUser,
    host: request.host,
    reason: request.reason,
    pool: context.poolId,
    poolMovedAt: context.createdBefore,
    mode: context.mode,
    runId: context.runId,
    previousSubject: subjectHint(plan.previousSubject),
    newSubject: subjectHint(plan.newSubject),
    signsInWith: plan.signsInWith,
    ...(plan.merge ? { mergedAccount: subjectHint(plan.merge.accountId) } : {}),
    ...(plan.unverifiedAccepted ? { unverifiedAccepted: true } : {}),
    ...(plan.accountUnverified ? { accountUnverified: true } : {}),
    ...(plan.unverifiedConfirmed ? { unverifiedConfirmed: true } : {}),
    outcome: "succeeded",
  };
  assertStorableJson(details, "audit_log.details");
  return JSON.stringify(details);
}

/**
 * Re-link the plans of a chunk and write their records — two statements for the whole chunk
 * (review 15 M4: a statement per account took most of a bulk run). Each account changes only if
 * it is still as planned (its tenant, live, its previous subject); the ids changed are answered,
 * and only they are recorded.
 */
async function relinkAll(
  tx: Tx,
  plans: readonly RelinkPlan[],
  request: RelinkRequest,
  context: ApplyContext
): Promise<Set<string>> {
  if (plans.length === 0) return new Set();
  const { rows } = await tx.query<{ id: string }>(
    `update users u set cognito_sub = q.sub, updated_at = now()
       from unnest($1::uuid[], $2::text[], $3::uuid[], $4::text[]) as q(id, sub, tenant, prev)
      where u.id = q.id and u.tenant_id = q.tenant and u.deleted_at is null
        and u.cognito_sub is not distinct from q.prev
     returning u.id::text as id`,
    [
      plans.map((p) => p.accountId),
      plans.map((p) => p.newSubject),
      plans.map((p) => p.tenantId),
      plans.map((p) => p.previousSubject),
    ]
  );
  const changed = new Set(rows.map((r) => r.id.toLowerCase()));
  const done = plans.filter((p) => changed.has(p.accountId.toLowerCase()));
  if (done.length > 0)
    await tx.query(
      `insert into audit_log (tenant_id, action, target_id, details)
       select q.tenant, 'admin_action'::audit_action, q.target, q.details
         from unnest($1::uuid[], $2::uuid[], $3::jsonb[]) as q(tenant, target, details)`,
      [
        done.map((p) => p.tenantId),
        done.map((p) => p.accountId),
        done.map((p) => relinkRecord(p, request, context)),
      ]
    );
  return changed;
}

/**
 * Merge a stray into its account (under a savepoint, by the caller): the stray's residue and row
 * removed, its data counted again, the account re-linked and recorded.
 */
async function mergeAndRelink(
  tx: Tx,
  plan: RelinkPlan & { readonly merge: { readonly accountId: string } },
  request: RelinkRequest,
  context: ApplyContext
): Promise<void> {
  const strayId = plan.merge.accountId.toLowerCase();
  for (const name of STRAY_REMOVED) {
    const entry = USER_DATA_TABLES.find((e) => e.name === name)!;
    await tx.query(entry.erase, [strayId]);
  }
  const removed = await tx.query(
    "delete from users where id = $1::uuid and cognito_sub = $2 and tenant_id = $3::uuid",
    [plan.merge.accountId, plan.newSubject, plan.tenantId]
  );
  if (removed.rowCount !== 1)
    throw new ChangedMeanwhile("merge.unsafe", "the stray account changed meanwhile");
  // Counted again after the delete, in this transaction (review 15 L7): the row lock holds
  // every table with a foreign key to users, but not one without — anything written there for
  // the stray since it was counted is not lost: this re-link is undone.
  const gained = await strayData(tx, strayId);
  if (gained.length > 0)
    throw new ChangedMeanwhile(
      "merge.unsafe",
      `the stray account gained data meanwhile (${gained.join(", ")}) — it is not merged`
    );
  const changed = await relinkAll(tx, [plan], request, context);
  if (!changed.has(plan.accountId.toLowerCase()))
    throw new ChangedMeanwhile("account.changed", "the account changed meanwhile");
}

/** The staff roles: those that hold a staff permission, directly or inherited. */
async function staffRoleIds(tx: Tx): Promise<Set<string>> {
  const { rows } = await tx.query<{ role_id: string; code: string }>(
    `select x.role_id, p.code from (
       select rp.role_id, rp.permission_id from role_permissions rp
       union
       select ri.role_id, rp.permission_id from role_inheritance ri
         join role_permissions rp on rp.role_id = ri.inherits_from_id
     ) x join permissions p on p.id = x.permission_id`
  );
  return new Set(rows.filter((r) => isStaffPermission(r.code)).map((r) => r.role_id));
}

/**
 * The addresses a bulk run covers: (tenant, address) of each live account in scope, with every
 * form the address is stored in — one statement.
 */
async function bulkAddresses(
  tx: Tx,
  scope: "all-staff" | "all",
  tenantId: string | null,
  onlyTenants: readonly string[] | null
): Promise<AddressInput[]> {
  const { rows } = await tx.query<{ tenant_id: string; email: string; role_id: string }>(
    `select u.tenant_id, btrim(u.email) as email, u.role_id
       from users u
      where u.deleted_at is null and u.email is not null and btrim(u.email) <> ''
        and ($1::uuid is null or u.tenant_id = $1::uuid)
        and ($2::uuid[] is null or u.tenant_id = any($2::uuid[]))
      order by u.tenant_id, lower(btrim(u.email)), u.id`,
    [tenantId, onlyTenants]
  );
  const staff = scope === "all-staff" ? await staffRoleIds(tx) : null;
  const byKey = new Map<
    string,
    { tenantId: string; email: string; stored: Set<string> }
  >();
  for (const r of rows) {
    if (staff && !staff.has(r.role_id)) continue;
    const email = normaliseEmail(r.email);
    const key = `${r.tenant_id}\u0000${email}`;
    const entry = byKey.get(key) ?? { tenantId: r.tenant_id, email, stored: new Set() };
    entry.stored.add(r.email);
    byKey.set(key, entry);
  }
  return [...byKey.values()].map((e) => ({
    tenantId: e.tenantId,
    email: e.email,
    stored: [...e.stored].filter((s) => s !== e.email),
  }));
}

/** Whether `text` holds a control character (C0 or DEL): nothing printed may move the cursor. */
function hasControlCharacter(text: string): boolean {
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** The pool move time as recorded and compared (ISO, UTC); RelinkUsageError when it is not one. */
export function poolMoveTime(value: string | undefined, now = Date.now()): string {
  if (value === undefined || !ISO_TIME.test(value.trim()))
    throw new RelinkUsageError(
      "--created-before <time> is required: when the deployment moved to this pool, ISO 8601 with its zone (e.g. 2026-10-20T14:00:00Z)"
    );
  const at = Date.parse(value.trim());
  if (!Number.isFinite(at)) throw new RelinkUsageError("--created-before is not a time");
  if (at > now + 60_000)
    throw new RelinkUsageError(
      "--created-before is in the future — it is when the deployment moved to this pool"
    );
  return new Date(at).toISOString();
}

function validate(request: RelinkRequest): string {
  const single = request.email !== undefined;
  if (single === (request.scope !== undefined))
    throw new RelinkUsageError("Give either --email <address> or --all-staff / --all");
  if (request.tenantId !== undefined && !isTenantId(request.tenantId))
    throw new RelinkUsageError("--tenant is not a tenant id");
  if (single && !acceptableEmail(normaliseEmail(request.email!)))
    throw new RelinkUsageError(
      "--email is not an address the re-link accepts (plain ASCII, one @, a dotted domain)"
    );
  if (request.mergeFrom !== undefined && (!single || !UUID.test(request.mergeFrom)))
    throw new RelinkUsageError("--merge-from takes an account id, with --email only");
  if (
    request.unverifiedAccount !== undefined &&
    (!single || !UUID.test(request.unverifiedAccount))
  )
    throw new RelinkUsageError(
      "--unverified-account takes an account id, with --email only"
    );
  if ((request.confirmUnverified ?? []).some((id) => !UUID.test(id)))
    throw new RelinkUsageError("--confirm-unverified takes an account id");
  if (single && (request.mergeStrays || request.skipAmbiguous))
    throw new RelinkUsageError("--merge-strays and --skip-ambiguous are for bulk runs");
  if (!request.operator.trim() || request.operator.length > 200)
    throw new RelinkUsageError(
      "--operator (who runs this) is required, at most 200 characters"
    );
  if (request.reason.trim().length < 5 || request.reason.length > 500)
    throw new RelinkUsageError("--reason is required: 5–500 characters");
  if (hasControlCharacter(request.operator + request.reason))
    throw new RelinkUsageError("--operator and --reason take no control characters");
  return poolMoveTime(request.createdBefore);
}

async function readOnly<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withOwnerTx("operator", async (tx) => {
    await tx.query("set transaction read only");
    return fn(tx);
  });
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Run a re-link: plan it (a dry run), or plan and apply it in owner transactions of one chunk of
 * addresses each. Throws RelinkUsageError for a malformed request; the pool's or the database's
 * unavailability before anything was committed propagates (nothing is changed then) — after a
 * chunk committed, it is reported (`stoppedBy: "failure"`).
 */
export async function relinkIdentities(
  request: RelinkRequest,
  deps: RelinkDeps
): Promise<RelinkReport> {
  const createdBefore = validate(request);
  const runId = randomUUID();
  const tenantId = request.tenantId ?? null;
  const bulk = request.scope !== undefined;
  const chunkSize = Math.max(1, deps.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const poolId = deps.directory.poolId;

  // Which addresses: one, or every one in scope (read without a lock; re-read locked below).
  const addresses: AddressInput[] = bulk
    ? await readOnly((tx) =>
        bulkAddresses(tx, request.scope!, tenantId, deps.onlyTenants ?? null)
      )
    : [
        {
          tenantId,
          email: normaliseEmail(request.email!),
          stored: [request.email!.trim()].filter((s) => s !== normaliseEmail(s)),
        },
      ];

  // The pool first, outside any transaction: no network call inside one. Each address in lower
  // case and as stored (or typed) — ListUsers matches exactly (review 15 L6).
  const asked = new Map<string, readonly DirectoryUser[]>();
  const ask = async (variant: string) => {
    if (!asked.has(variant))
      asked.set(variant, await deps.directory.findByEmail(variant));
    return asked.get(variant)!;
  };
  const poolByEmail = new Map<string, readonly DirectoryUser[]>();
  for (const a of addresses) {
    if (!acceptableEmail(a.email)) continue;
    const found = [...(poolByEmail.get(a.email) ?? [])];
    for (const v of [a.email, ...a.stored])
      if (filterSafeEmail(v)) found.push(...(await ask(v)));
    poolByEmail.set(a.email, found);
  }

  // Each candidate account's current subject (a legacy row's: its id, review 16 L3), asked of
  // the pool by its `sub` (review 15 H1): read first.
  const trusted = deps.trustedEmailIdps ?? getTrustedEmailIdps();
  const chunks = chunked(addresses, chunkSize);
  const toAsk = new Set<string>();
  for (const chunk of chunks) {
    const accounts = await readOnly((tx) =>
      accountsWithEmails(tx, chunk, createdBefore, false, deps.onlyTenants ?? null)
    );
    chunk.forEach((a, i) => {
      const identity = poolIdentity(a.email, poolByEmail.get(a.email) ?? [], trusted);
      const subject = "user" in identity ? identity.user.sub : null;
      for (const row of accounts.get(i) ?? [])
        if (row.before_move && (subject === null || !bindsTo(row, subject)))
          toAsk.add(boundSubject(row));
    });
  }
  const poolBySubject = new Map<string, readonly DirectoryUser[]>();
  for (const s of toAsk) poolBySubject.set(s, await deps.directory.findBySub(s));

  const confirmUnverified = new Set(
    (request.confirmUnverified ?? []).map((id) => id.toLowerCase())
  );
  const context: PlanContext = {
    poolByEmail,
    poolBySubject,
    poolId,
    createdBefore,
    bulk,
    trusted,
    mergeFrom: request.mergeFrom,
    mergeStrays: request.mergeStrays,
    unverifiedAccount: request.unverifiedAccount,
    confirmUnverified,
    onlyTenants: deps.onlyTenants ?? null,
  };

  // The preview: every address planned, read-only.
  const preview: AccountPlan[] = [];
  for (const chunk of chunks)
    preview.push(...(await readOnly((tx) => planChunk(tx, chunk, context, false))));
  const contested = contestedSubjects(preview);
  const plans = refuseContested(preview);
  const unusedConfirmations = [...confirmUnverified].filter(
    (id) =>
      !plans.some(
        (p) =>
          (p.status === "relink" &&
            p.unverifiedConfirmed &&
            p.accountId.toLowerCase() === id) ||
          (p.status === "refused" && p.needsConfirmation?.accountId.toLowerCase() === id)
      )
  );
  const skip = bulk && request.skipAmbiguous === true;
  const base = {
    runId,
    invalidated: [] as string[],
    notInvalidated: [],
    unusedConfirmations,
  };
  // A refusal stops the run before anything is changed (and says so in a dry run), unless
  // refused addresses are to be skipped.
  if (plans.some((p) => p.status === "refused") && !skip)
    return { ...base, applied: false, plans, stoppedBy: "refusal", chunks: [] };
  if (!request.apply) return { ...base, applied: false, plans, chunks: [] };

  // Applied chunk by chunk: each one owner transaction, planned again under lock.
  const mode = bulk ? request.scope! : "single";
  const invalidated: string[] = [];
  const notInvalidated: { subject: string; error: string }[] = [];
  /** Every subject tried (a Set: a bulk run voids two per account). */
  const voided = new Set<string>();
  const voidAll = async (done: readonly RelinkPlan[]) => {
    // After the commit; a failure here is reported, never taken for the change not made. The
    // previous subject of a legacy row is its id (review 16 L3).
    for (const p of done)
      for (const s of [p.previousSubject ?? p.accountId, p.newSubject]) {
        if (voided.has(s)) continue;
        voided.add(s);
        try {
          await deps.invalidate(s);
          invalidated.push(s);
        } catch (e) {
          notInvalidated.push({
            subject: s,
            error: e instanceof Error ? e.message.slice(0, 200) : String(e),
          });
        }
      }
  };
  const outcomes: ChunkOutcome[] = [];
  let relinkedTotal = 0;
  let stoppedBy: RelinkReport["stoppedBy"];
  let failure: RelinkReport["failure"];
  for (let c = 0; c < chunks.length; c++) {
    const from = c * chunkSize;
    const to = from + chunks[c]!.length;
    if (stoppedBy) {
      outcomes.push({ index: c, from, to, outcome: "not-run", relinked: 0 });
      continue;
    }
    if (!plans.slice(from, to).some((p) => p.status === "relink")) {
      outcomes.push({ index: c, from, to, outcome: "skipped", relinked: 0 });
      continue;
    }
    /** What this chunk would apply, as planned under lock (for an indeterminate commit). */
    let attempted: RelinkPlan[] = [];
    let chunkPlans: AccountPlan[];
    try {
      chunkPlans = await withOwnerTx("operator", async (tx) => {
        const locked = refuseContested(
          await planChunk(tx, chunks[c]!, context, true),
          contested
        ).map((p, i) => {
          const before = plans[from + i]!;
          if (p.status !== "relink") return p;
          // Only what the preview showed is applied (review 16 L2): an address the preview
          // refused stays refused — with the preview's own reason — and one it did not show as
          // a re-link (absent, linked) is refused as changed, even with --skip-ambiguous.
          if (before.status === "refused") return before;
          if (before.status === "relink" && samePlan(p, before)) return p;
          return refusal(
            p.email,
            "account.changed",
            "the account or the identity changed since the plan was read — run again"
          );
        });
        const newlyRefused = locked.some(
          (p, i) => p.status === "refused" && plans[from + i]!.status !== "refused"
        );
        if (newlyRefused && !skip) throw new ChunkStopped(locked);
        await deps.onChunk?.(c, tx);
        const applying: ApplyContext = {
          runId,
          poolId,
          mode,
          createdBefore,
        };
        attempted = locked.filter((p): p is RelinkPlan => p.status === "relink");
        // A merge alone, under a savepoint: refused, only its own statements are undone.
        for (let i = 0; i < locked.length; i++) {
          const p = locked[i]!;
          if (p.status !== "relink" || !p.merge) continue;
          try {
            await withSavepoint(tx, () =>
              mergeAndRelink(tx, { ...p, merge: p.merge! }, request, applying)
            );
          } catch (err) {
            if (!(err instanceof ChangedMeanwhile)) throw err;
            locked[i] = refusal(p.email, err.code, err.message);
            if (!skip) throw new ChunkStopped(locked);
          }
        }
        // The rest in two statements; an account no longer as planned is not changed.
        const plain = locked.filter(
          (p): p is RelinkPlan => p.status === "relink" && !p.merge
        );
        const changed = await relinkAll(tx, plain, request, applying);
        for (let i = 0; i < locked.length; i++) {
          const p = locked[i]!;
          if (p.status !== "relink" || p.merge || changed.has(p.accountId.toLowerCase()))
            continue;
          locked[i] = refusal(
            p.email,
            "account.changed",
            "the account changed meanwhile"
          );
          if (!skip) throw new ChunkStopped(locked);
        }
        attempted = locked.filter((p): p is RelinkPlan => p.status === "relink");
        return locked;
      });
    } catch (err) {
      if (err instanceof ChunkStopped) {
        plans.splice(from, to - from, ...err.plans);
        outcomes.push({ index: c, from, to, outcome: "refused", relinked: 0 });
        stoppedBy = "refusal";
        continue;
      }
      // The connection failed at COMMIT (review 16 L7): the chunk may have committed. Never
      // "nothing was changed" — reported as unknown, its subjects voided anyway (harmless if it
      // did not commit), and the run stops: the verify command (a dry run) says what holds.
      if (isCommitOutcomeUnknown(err)) {
        outcomes.push({ index: c, from, to, outcome: "indeterminate", relinked: 0 });
        stoppedBy = "indeterminate";
        failure = {
          chunk: c,
          message: err instanceof Error ? err.message.slice(0, 300) : "unknown error",
        };
        await voidAll(attempted);
        continue;
      }
      // Nothing committed yet: as before — nothing was changed, the error propagates.
      if (relinkedTotal === 0) throw err;
      outcomes.push({ index: c, from, to, outcome: "failed", relinked: 0 });
      stoppedBy = "failure";
      failure = {
        chunk: c,
        message: err instanceof Error ? err.message.slice(0, 300) : "unknown error",
      };
      continue;
    }
    plans.splice(from, to - from, ...chunkPlans);
    const done = chunkPlans.filter((p): p is RelinkPlan => p.status === "relink");
    relinkedTotal += done.length;
    outcomes.push({ index: c, from, to, outcome: "applied", relinked: done.length });
    await voidAll(done);
  }
  return {
    runId,
    applied: relinkedTotal > 0,
    plans,
    ...(stoppedBy ? { stoppedBy } : {}),
    ...(failure ? { failure } : {}),
    chunks: outcomes,
    invalidated,
    notInvalidated,
    unusedConfirmations,
  };
}
