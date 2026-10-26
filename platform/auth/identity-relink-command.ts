/**
 * platform/auth/identity-relink-command.ts — The operator command around identity-relink.ts
 * (TASK-174): its arguments, its settings from the environment, what it prints, its exit code.
 *
 *   node scripts/relink-identity.mjs --email <address>
 *        --created-before <time> --operator <who> --reason <why>
 *        [--tenant <id>] [--merge-from <account id>] [--unverified-account <account id>]
 *        [--confirm-unverified <account id>]… [--apply]
 *   node scripts/relink-identity.mjs --all-staff | --all
 *        --created-before <time> --operator <who> --reason <why>
 *        [--tenant <id>] [--merge-strays] [--skip-ambiguous]
 *        [--confirm-unverified <account id>]… [--apply]
 *
 * A dry run unless --apply: it prints exactly what would change and changes nothing.
 * The subject an account is bound to is always the pool user's `sub` (TASK-177, ADR-012): what
 * every token verifier — the platform's Cognito provider and Playform's alike — names a request
 * by. Review 16's `--subject username|sub` is gone: `--subject sub` is still accepted for one
 * release, as a no-op with a deprecation note; `--subject username` (or anything else) is refused.
 * --created-before is when the deployment moved to the current pool (ISO 8601 with its zone):
 * accounts provisioned at or after it are the new pool's and never re-linked to (review 15 H1).
 * --confirm-unverified (repeatable) names an account whose own address was never verified that
 * the operator confirmed is the person's who verifies it in the new pool (review 16 D4f): such an
 * account is re-linked only when named; the dry run lists every one that needs it.
 * Settings come only from the environment, exported in the operator's shell (never a file, never
 * an argument): DATABASE_OWNER_URL with DATABASE_SSL and DATABASE_SSL_CA — checked as the
 * environment contract checks them, stricter for a workstation (review 15 L2: no TLS option in
 * the URL, no plaintext to a remote database, the CA given with verify-full) — the pool
 * (NEXT_PUBLIC_COGNITO_USER_POOL_ID or COGNITO_USER_POOL_ID, region from its id or
 * NEXT_PUBLIC_COGNITO_REGION / COGNITO_REGION) and a key that may call ListUsers on it
 * (COGNITO_ADMIN_ACCESS_KEY_ID, COGNITO_ADMIN_SECRET_ACCESS_KEY, COGNITO_ADMIN_SESSION_TOKEN for
 * temporary credentials), and the shared cache's settings (CACHE_PROVIDER and its own) so the
 * invalidation reaches every instance. Nothing secret is ever printed: a setting is named, never
 * echoed; subjects are shown by their first 8 characters.
 *
 * Exit (EXIT below; docs/TENANCY_OPERATIONS.md §6.3):
 *   0  done: every change applied and voided on every instance — or a dry run with nothing
 *      refused, or nothing to do;
 *   1  refused: nothing changed — an applied run stopped by a refusal, or a dry run that refused
 *      any address, --skip-ambiguous or not (review 16 L5: a refusal is never 0);
 *   2  usage or settings: nothing read;
 *   3  the pool or the database could not be reached: nothing changed;
 *   4  applied, but some addresses were refused and skipped (--skip-ambiguous) — resolve them and
 *      run again;
 *   5  applied, but cached permissions and token verifications were not voided on every instance:
 *      what they hold for the subjects is served for at most 60 s more;
 *   6  partly applied: some chunks committed, then the run stopped (a failure, or an address that
 *      changed meanwhile) — run the same command again (what was applied reads `linked`);
 *   7  indeterminate: the database connection failed while a chunk was committing — it may have
 *      committed (review 16 L7). Run the verify command (the same command without --apply): what
 *      committed reads `linked`; then run it again with --apply for the rest.
 * When more than one applies, the highest of 7, 6, 4, 5 is the code; the output says every one.
 *
 * @module platform/auth
 */

import { hostname, userInfo } from "node:os";
import {
  COGNITO_POOL_ID,
  databaseConnectionViolations,
  getCacheProviderSetting,
  getCognitoAdminCredentials,
  getCognitoSettings,
  getDatabaseSettings,
  getTrustedEmailIdps,
  trustedEmailIdpsViolation,
  type EnvSource,
} from "@/platform/providers/environment-contract";
import {
  CognitoIdentityDirectory,
  type IdentityDirectory,
} from "@/platform/auth/identity-directory";
import {
  RelinkUsageError,
  partial,
  relinkIdentities,
  type AccountPlan,
  type RelinkReport,
  type RelinkRequest,
} from "@/platform/auth/identity-relink";

/** The exit codes (see the header). */
export const EXIT = {
  done: 0,
  refused: 1,
  usage: 2,
  unreachable: 3,
  appliedSomeSkipped: 4,
  appliedNotVoided: 5,
  partlyApplied: 6,
  indeterminate: 7,
} as const;

export const USAGE = `Re-link existing accounts to their identity in the current user pool (TASK-174).

  relink-identity --email <address> --created-before <time>
                  --operator <who> --reason <why>
                  [--tenant <id>] [--merge-from <account id>]
                  [--unverified-account <account id>]
                  [--confirm-unverified <account id>]... [--apply]
  relink-identity --all-staff | --all --created-before <time>
                  --operator <who> --reason <why>
                  [--tenant <id>] [--merge-strays] [--skip-ambiguous]
                  [--confirm-unverified <account id>]... [--apply]

Accounts are bound to the pool user's sub (no --subject: "--subject sub" is accepted and
ignored for one release; "--subject username" is refused).
--created-before: when the deployment moved to this pool (ISO 8601 with its zone,
e.g. 2026-10-20T14:00:00Z); accounts provisioned since are never re-linked to.
--confirm-unverified: an account whose own address was never verified, confirmed with its
person; the dry run lists each one that needs it. Repeat it for each account.
A dry run unless --apply. Settings from the environment only — DATABASE_OWNER_URL,
DATABASE_SSL, DATABASE_SSL_CA, NEXT_PUBLIC_COGNITO_USER_POOL_ID, COGNITO_ADMIN_ACCESS_KEY_ID,
COGNITO_ADMIN_SECRET_ACCESS_KEY (COGNITO_ADMIN_SESSION_TOKEN), CACHE_PROVIDER and its settings,
AUTH_TRUSTED_EMAIL_IDPS (default Google).
Exit: 0 done, 1 refused (a dry run that refused anything too), 2 usage/settings,
3 unreachable (nothing changed), 4 applied with addresses skipped, 5 applied but caches not
voided everywhere, 6 partly applied (run again), 7 a commit's outcome unknown (verify).
Runbook: docs/TENANCY_OPERATIONS.md §6.`;

export interface CommandIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface CommandDeps {
  /** The pool; default: Cognito, from the environment. */
  readonly directory?: IdentityDirectory;
  /**
   * Void one subject's caches, throwing when it was not published; default:
   * platform/auth/permissions-cache publishInvalidation (review 16 M2).
   */
  readonly invalidate?: (subject: string) => Promise<void>;
  /** Whether the invalidation reached the shared cache; default: a write-and-read probe. */
  readonly cacheReach?: () => Promise<CacheReach>;
  /** The machine's user and name (for the record). */
  readonly machine?: { readonly osUser: string; readonly host: string };
}

export type CacheReach = "shared" | "unreachable" | "local-only";

type Parsed =
  | { readonly help: true }
  | {
      readonly help?: never;
      readonly request: Omit<RelinkRequest, "osUser" | "host">;
      /** Notes for the operator about deprecated arguments (printed, never fatal). */
      readonly notes: readonly string[];
    };

/** The deprecation note for `--subject sub` (TASK-177; the flag is removed in the next release). */
export const SUBJECT_FLAG_DEPRECATED =
  "⚠ --subject is deprecated and ignored: accounts are always bound to the pool user's sub (TASK-177). Drop it — it is refused from the next release.";

const VALUE_FLAGS = new Set([
  "--email",
  "--subject",
  "--tenant",
  "--created-before",
  "--merge-from",
  "--unverified-account",
  "--operator",
  "--reason",
]);
/** Value flags that may be given more than once. */
const REPEATABLE_FLAGS = new Set(["--confirm-unverified"]);
const BOOL_FLAGS = new Set([
  "--apply",
  "--dry-run",
  "--all-staff",
  "--all",
  "--merge-strays",
  "--skip-ambiguous",
  "--help",
]);

/** The arguments, or RelinkUsageError. `--flag=value` and `--flag value` are both accepted. */
export function parseArgs(argv: readonly string[]): Parsed {
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUE_FLAGS.has(name) || REPEATABLE_FLAGS.has(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || (eq < 0 && value.startsWith("--")))
        throw new RelinkUsageError(`${name} needs a value`);
      if (REPEATABLE_FLAGS.has(name)) {
        repeated.set(name, [...(repeated.get(name) ?? []), value]);
        continue;
      }
      if (values.has(name)) throw new RelinkUsageError(`${name} is given twice`);
      values.set(name, value);
    } else if (BOOL_FLAGS.has(name) && eq < 0) {
      flags.add(name);
    } else {
      throw new RelinkUsageError(`Unknown argument: ${arg.slice(0, 40)}`);
    }
  }
  if (flags.has("--help")) return { help: true };
  if (flags.has("--apply") && flags.has("--dry-run"))
    throw new RelinkUsageError("--apply and --dry-run together");
  if (flags.has("--all") && flags.has("--all-staff"))
    throw new RelinkUsageError("--all and --all-staff together");
  const scope = flags.has("--all")
    ? ("all" as const)
    : flags.has("--all-staff")
      ? ("all-staff" as const)
      : undefined;
  // TASK-177: the subject is always the `sub`. Review 16's flag is kept one release as a no-op;
  // `username` — never what any verifier names an identity by now — is refused, not ignored.
  const subject = values.get("--subject");
  const notes: string[] = [];
  if (subject !== undefined) {
    if (subject !== "sub")
      throw new RelinkUsageError(
        "--subject is removed: accounts are always bound to the pool user's sub (TASK-177) — the platform's provider no longer names an identity by its username. Drop the flag (docs/TENANCY_OPERATIONS.md §6)"
      );
    notes.push(SUBJECT_FLAG_DEPRECATED);
  }
  const confirm = repeated.get("--confirm-unverified") ?? [];
  return {
    notes,
    request: {
      ...(values.has("--email") ? { email: values.get("--email")! } : {}),
      ...(scope ? { scope } : {}),
      ...(values.has("--tenant") ? { tenantId: values.get("--tenant")! } : {}),
      createdBefore: values.get("--created-before") ?? "",
      ...(values.has("--merge-from") ? { mergeFrom: values.get("--merge-from")! } : {}),
      ...(values.has("--unverified-account")
        ? { unverifiedAccount: values.get("--unverified-account")! }
        : {}),
      ...(confirm.length ? { confirmUnverified: confirm } : {}),
      ...(flags.has("--merge-strays") ? { mergeStrays: true } : {}),
      ...(flags.has("--skip-ambiguous") ? { skipAmbiguous: true } : {}),
      apply: flags.has("--apply"),
      operator: values.get("--operator") ?? "",
      reason: values.get("--reason") ?? "",
    },
  };
}

/**
 * What is wrong with the settings the command needs — a missing one named, a wrong one described
 * — never a value. The database connection is checked as the environment contract checks it, and
 * stricter for a workstation (review 15 L2): no TLS option in the URL (node-postgres would let it
 * override DATABASE_SSL), DATABASE_SSL=disable only for a database on this machine, and
 * DATABASE_SSL_CA with verify-full.
 */
export function missingSettings(env: EnvSource): string[] {
  const missing: string[] = [];
  if (!getDatabaseSettings(env).ownerUrl) missing.push("DATABASE_OWNER_URL");
  else
    missing.push(
      ...databaseConnectionViolations(env, "DATABASE_OWNER_URL", { requireCa: true })
    );
  const poolId = getCognitoSettings(env).userPoolId;
  if (!poolId) missing.push("NEXT_PUBLIC_COGNITO_USER_POOL_ID (or COGNITO_USER_POOL_ID)");
  else if (!COGNITO_POOL_ID.test(poolId))
    missing.push(
      "NEXT_PUBLIC_COGNITO_USER_POOL_ID (or COGNITO_USER_POOL_ID) has the wrong shape — expected <region>_<id>"
    );
  if (!getCognitoAdminCredentials(env))
    missing.push("COGNITO_ADMIN_ACCESS_KEY_ID and COGNITO_ADMIN_SECRET_ACCESS_KEY");
  // Review 17 L3: a malformed allow-list would trust no provider — refused, not run on.
  const idps = trustedEmailIdpsViolation(env);
  if (idps) missing.push(idps);
  return missing;
}

/**
 * Whether a settings problem is checked even when the pool is given in code: the database's, and
 * the allow-list of trusted providers (review 17 L3), which the run's decisions read either way.
 */
const isDatabaseProblem = (problem: string) =>
  problem.startsWith("DATABASE_") || problem.startsWith("AUTH_TRUSTED_EMAIL_IDPS");

function line(plan: AccountPlan, pending: boolean): string[] {
  switch (plan.status) {
    case "relink":
      return [
        `  ${pending ? "pending" : "relink "}  ${plan.email}${pending ? " — NOT applied (its chunk did not commit)" : ""}`,
        `           tenant ${plan.tenantId}, account ${plan.accountId}, role ${plan.role} (${plan.accountStatus})`,
        `           subject ${partial(plan.previousSubject)} → ${partial(plan.newSubject)} (signs in with ${plan.signsInWith.join(", ")})`,
        ...(plan.unverifiedAccepted
          ? [
              "           of several accounts with this address, none verified: named by the operator",
            ]
          : []),
        ...(plan.accountUnverified && !plan.unverifiedAccepted
          ? [
              "           the account's own address was never verified: re-linked on the operator's confirmation (--confirm-unverified)",
            ]
          : []),
        ...(plan.merge
          ? [
              `           merge: removes the first-sign-in account ${plan.merge.accountId} (sign-in residue only; its audit records stay)`,
            ]
          : []),
      ];
    case "linked":
      return [
        `  linked   ${plan.email} — account ${plan.accountId} is already bound to the pool's identity; nothing to do`,
      ];
    case "absent":
      return [`  absent   ${plan.email} — not in the pool yet; nothing to do`];
    case "refused":
      return [`  refused  ${plan.email} [${plan.code}]`, `           ${plan.detail}`];
  }
}

/** The accounts the dry run refused only for want of --confirm-unverified (review 16 D4f). */
function needingConfirmation(report: RelinkReport) {
  return report.plans.flatMap((p) =>
    p.status === "refused" && p.needsConfirmation
      ? [{ email: p.email, ...p.needsConfirmation }]
      : []
  );
}

function summary(report: RelinkReport, apply: boolean): string {
  const count = (s: AccountPlan["status"]) =>
    report.plans.filter((p) => p.status === s).length;
  return `${report.plans.length} address(es): ${count("relink")} ${apply ? "re-linked or pending" : "to re-link"}, ${count("linked")} already linked, ${count("absent")} not in the pool, ${count("refused")} refused`;
}

async function defaultCacheReach(env: EnvSource): Promise<CacheReach> {
  const provider = getCacheProviderSetting(env);
  if (provider !== "upstash" && provider !== "valkey") return "local-only";
  try {
    const { getCache } = await import("@/platform/cache");
    const key = `identity-relink:probe:${Date.now()}`;
    await getCache().set(key, "1", { ttlSeconds: 30 });
    return (await getCache().get<string>(key)) === "1" ? "shared" : "unreachable";
  } catch {
    return "unreachable";
  }
}

/** How long what an instance cached for a subject is served without the invalidation. */
const STALENESS =
  "other instances serve what they cached for these subjects for at most 60 s more (permissions: 60 s; remembered token verifications: auth.token_cache_seconds, at most 60 s — longer only while Cognito's GetUser is unavailable, by auth.token_stale_grace_seconds)";

/** Run the command; resolves the exit code. Never throws. */
export async function runRelinkCommand(
  argv: readonly string[],
  env: EnvSource,
  io: CommandIo,
  deps: CommandDeps = {}
): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    io.err(`✗ ${(err as Error).message}`);
    io.err(USAGE);
    return EXIT.usage;
  }
  if (parsed.help) {
    io.out(USAGE);
    return EXIT.done;
  }
  for (const note of parsed.notes) io.err(note);
  const missing = missingSettings(env).filter(
    (problem) => !deps.directory || isDatabaseProblem(problem)
  );
  if (missing.length > 0) {
    io.err(`✗ Settings in this shell: ${missing.join("; ")}`);
    io.err(
      "  Export them in the shell (docs/TENANCY_OPERATIONS.md §6) — never in a file."
    );
    return EXIT.usage;
  }

  let directory: IdentityDirectory;
  try {
    directory =
      deps.directory ??
      new CognitoIdentityDirectory({
        userPoolId: getCognitoSettings(env).userPoolId,
        region: getCognitoSettings(env).region,
        credentials: getCognitoAdminCredentials(env)!,
      });
  } catch (err) {
    io.err(`✗ ${(err as Error).message}`);
    return EXIT.usage;
  }
  const machine = deps.machine ?? { osUser: safeOsUser(), host: hostname() };
  // Strict (review 16 M2): resolves only when both stamps were published, throws with why when
  // either was not — so the report's notInvalidated is what happened, never an assumption.
  const invalidate =
    deps.invalidate ??
    (async (subject: string) => {
      const { publishInvalidation } = await import("@/platform/auth/permissions-cache");
      const outcome = await publishInvalidation(subject);
      const failed = [
        ...(outcome.permissions.published
          ? []
          : [`permissions: ${outcome.permissions.error}`]),
        ...(outcome.tokens.published
          ? []
          : [`token verifications: ${outcome.tokens.error}`]),
      ];
      if (failed.length > 0) throw new Error(`not published (${failed.join("; ")})`);
    });

  let report: RelinkReport;
  try {
    report = await relinkIdentities(
      { ...parsed.request, osUser: machine.osUser, host: machine.host },
      {
        directory,
        invalidate,
        trustedEmailIdps: getTrustedEmailIdps(env),
      }
    );
  } catch (err) {
    if (err instanceof RelinkUsageError) {
      io.err(`✗ ${err.message}`);
      io.err(USAGE);
      return EXIT.usage;
    }
    // Thrown only before anything committed (a failure after a commit is in the report, and a
    // commit whose outcome is unknown is reported as such — never thrown). The message names
    // what failed (a pool error type, a database error): no setting's value.
    io.err(
      `✗ Nothing was changed: ${err instanceof Error ? err.message.slice(0, 300) : "unknown error"}`
    );
    return EXIT.unreachable;
  }

  const apply = parsed.request.apply;
  io.out(
    `${report.applied ? "Applied" : apply ? "Not applied" : "Dry run"} — pool ${directory.poolId}, run ${report.runId}`
  );
  const pendingFrom = (i: number) =>
    apply &&
    report.chunks.some((c) => i >= c.from && i < c.to && c.outcome !== "applied");
  report.plans.forEach((plan, i) => {
    for (const l of line(plan, pendingFrom(i))) io.out(l);
  });
  io.out(summary(report, apply));

  const confirmations = needingConfirmation(report);
  if (confirmations.length > 0) {
    io.out(
      `${confirmations.length} account(s) whose own address was never verified need the operator's confirmation — confirm with each person that the address is theirs and that they sign in with it now, then add for each:`
    );
    for (const c of confirmations)
      io.out(
        `  --confirm-unverified ${c.accountId}   (${c.email}, tenant ${c.tenantId}, role ${c.role})`
      );
  }
  for (const id of report.unusedConfirmations)
    io.out(
      `⚠ --confirm-unverified ${id} named no account that needs it in this run (check the id)`
    );

  const refused = report.plans.some((p) => p.status === "refused");
  const indeterminate = report.stoppedBy === "indeterminate";
  if (!report.applied && !indeterminate) {
    if (report.stoppedBy === "refusal" || refused) {
      io.out(
        apply
          ? "Nothing was changed: an address was refused (bulk: --skip-ambiguous re-links the rest)."
          : parsed.request.skipAmbiguous
            ? "Dry run — nothing changed. An address was refused: --apply would skip it and re-link the rest (exit 1 until nothing is refused)."
            : "An address was refused: --apply would change nothing until it is resolved."
      );
      return EXIT.refused;
    }
    const toDo = report.plans.some((p) => p.status === "relink");
    io.out(
      toDo
        ? "Dry run — nothing changed. Run the same command with --apply to make these changes."
        : "Nothing to change."
    );
    return EXIT.done;
  }

  // Applied (some or all), or a commit whose outcome is unknown.
  const applied = report.chunks.filter((c) => c.outcome === "applied");
  const relinked = applied.reduce((n, c) => n + c.relinked, 0);
  if (report.chunks.length > 1 || report.stoppedBy)
    for (const c of report.chunks)
      io.out(
        `  chunk ${c.index + 1}/${report.chunks.length} (addresses ${c.from + 1}–${c.to}): ${
          c.outcome === "applied"
            ? `applied, ${c.relinked} re-linked`
            : c.outcome === "refused"
              ? "NOT applied — an address changed since the plan (refused above); nothing in it changed"
              : c.outcome === "failed"
                ? `NOT applied — ${report.failure?.message ?? "failed"}; nothing in it changed`
                : c.outcome === "indeterminate"
                  ? "UNKNOWN — the database connection failed while it was committing: it MAY HAVE COMMITTED"
                  : c.outcome === "skipped"
                    ? "nothing to apply"
                    : "not run"
        }`
      );
  io.out(`${relinked} account(s) known re-linked, each with its audit record.`);

  const committed = indeterminate ? "" : " The change itself is committed.";
  let voidedEverywhere = report.notInvalidated.length === 0;
  if (report.notInvalidated.length > 0) {
    io.out(
      `⚠ Not voided for ${report.notInvalidated.length} subject(s) (${report.notInvalidated
        .map((n) => `${partial(n.subject)}: ${n.error}`)
        .join("; ")}): ${STALENESS}.${committed}`
    );
  }
  if (report.invalidated.length > 0) {
    const reach = await (deps.cacheReach ?? (() => defaultCacheReach(env)))();
    if (reach === "shared") {
      io.out(
        `Cached permissions and token verifications voided for ${report.invalidated.length} subject(s), on every instance.`
      );
    } else {
      voidedEverywhere = false;
      io.out(
        reach === "unreachable"
          ? `⚠ Not voided on the deployment's instances: the shared cache did not answer — ${STALENESS}.${committed}`
          : `⚠ Not voided on the deployment's instances (no shared cache in this shell's settings: CACHE_PROVIDER) — ${STALENESS}.${committed}`
      );
    }
  }

  if (indeterminate) {
    io.out(
      `⚠ Outcome unknown: the database connection failed while chunk ${(report.failure?.chunk ?? 0) + 1} was committing (${report.failure?.message ?? "connection lost"}) — its changes MAY HAVE COMMITTED. Do not assume either way: run the verify command (the same command without --apply) — each address that committed reads 'linked' — then run it with --apply again for the rest.`
    );
    return EXIT.indeterminate;
  }
  if (report.stoppedBy) {
    io.out(
      "Partly applied: the chunks above marked NOT applied changed nothing. Run the same command again — what was applied reads 'linked', the rest is applied."
    );
    return EXIT.partlyApplied;
  }
  io.out(
    "Check: run the same command again without --apply — each re-linked address now reads 'linked'."
  );
  if (refused) {
    io.out(
      "Applied, with addresses refused and skipped (above): resolve each, then run again."
    );
    return EXIT.appliedSomeSkipped;
  }
  return voidedEverywhere ? EXIT.done : EXIT.appliedNotVoided;
}

function safeOsUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}
