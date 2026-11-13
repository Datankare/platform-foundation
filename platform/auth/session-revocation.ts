/**
 * platform/auth/session-revocation.ts — ending sign-in sessions (ADR-057 D6, TASK-214)
 *
 * What ends a session other than its own lifetimes: sign-out, sign-out everywhere, a password or
 * factor change, a role change, a suspension or ban, erasure. A session is ended in its record
 * first — that is what refuses the id from then on — and its refresh token is then revoked at
 * the identity provider (best effort: the record already decides).
 *
 * Kept apart from platform/auth/session.ts, which answers HTTP requests: the modules that end an
 * account's sessions (moderation, erasure, tenancy administration) run in jobs and in code that
 * loads no web server. It asks for the registered provider and never initialises one: the
 * providers are registered at boot (instrumentation.ts), and loading the registry from here
 * would load everything it selects.
 *
 * @module platform/auth
 */

import { logger } from "@/lib/logger";
import { getAuthProvider } from "@/platform/auth/config";
import {
  getSessionStore,
  type RevocationReason,
  type SessionRecord,
} from "@/platform/auth/session-store";
import { SessionVaultError, openForProvider } from "@/platform/auth/session-vault";

/** Revoke a session's refresh token at the provider. Best effort: the record is what ends it. */
async function revokeAtProvider(record: SessionRecord): Promise<void> {
  if (record.kind !== "user") return;
  try {
    const refreshToken = openForProvider(
      record.sealedTokens,
      record.idHash,
      "revocation"
    );
    if (!refreshToken) return;
    await getAuthProvider().signOut("", refreshToken);
  } catch (err) {
    logger.warn("A session's refresh token was not revoked at the provider", {
      route: "platform/auth/session-revocation",
      reason: err instanceof SessionVaultError ? err.reason : "provider",
    });
  }
}

export async function endRecord(
  record: SessionRecord,
  reason: RevocationReason
): Promise<boolean> {
  const ended = await getSessionStore().revoke(record.idHash, reason, Date.now());
  if (ended) await revokeAtProvider(record);
  return ended;
}

export interface SubjectRevocation {
  /** Sessions ended in the record. */
  readonly ended: number;
  /**
   * Whether the provider also ended every token of the user (`everywhere`): true, false (it
   * refused or could not — the sessions here are ended all the same, each refresh token revoked
   * one by one), or undefined when it was not asked.
   */
  readonly providerSignedOut?: boolean;
}

/**
 * End every session of `subject` in the current tenant — a password or factor change, a role
 * change, a restriction, erasure, "sign out everywhere". `except`: the one session to keep (the
 * caller's own, after a change it made itself). `everywhere`: also ask the provider to end every
 * token it issued the user (tokens this platform never held included); never with `except`, whose
 * session it would end too.
 */
export async function revokeSubjectSessions(
  subject: string,
  reason: RevocationReason,
  options: { readonly except?: string; readonly everywhere?: boolean } = {}
): Promise<SubjectRevocation> {
  if (!subject) return { ended: 0 };
  const ended = await getSessionStore().revokeSubject(
    subject,
    reason,
    Date.now(),
    options.except
  );
  for (const record of ended) await revokeAtProvider(record);
  if (!options.everywhere || options.except) return { ended: ended.length };
  let providerSignedOut = false;
  try {
    const result = await getAuthProvider().signOutEverywhere(subject);
    providerSignedOut = result.success;
    if (!result.success) {
      logger.warn("The provider did not sign the user out everywhere", {
        route: "platform/auth/session-revocation",
        errorCode: result.errorCode ?? "internal.error",
      });
    }
  } catch (err) {
    logger.warn("The provider could not be asked to sign the user out everywhere", {
      route: "platform/auth/session-revocation",
      error: err instanceof Error ? err.name : "unknown",
    });
  }
  return { ended: ended.length, providerSignedOut };
}

/**
 * End every session of an account whose standing or authority changed — a role change, a
 * suspension or ban, erasure — on every device, and ask the provider to end its tokens. Never
 * throws: the change itself is the control (permissions and standing are read on every request),
 * and a session that could not be ended here is logged for the operator.
 */
export async function endSubjectSessions(
  subject: string | null | undefined,
  reason: RevocationReason
): Promise<void> {
  if (!subject) return;
  try {
    await revokeSubjectSessions(subject, reason, { everywhere: true });
  } catch (err) {
    logger.error("An account's sessions could not be ended", {
      route: "platform/auth/session-revocation",
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
