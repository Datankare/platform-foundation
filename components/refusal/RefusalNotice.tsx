"use client";

/**
 * components/refusal/RefusalNotice.tsx — a refused API call, shown by its kind (TASK-181)
 *
 * The small shared pieces every screen uses with platform/errors/refusal.ts:
 *
 *   <RefusalNotice refusal onRetry onSignOut />   inline: the message, and what can be done —
 *                                                 for a restricted account its decisions and
 *                                                 their appeal (the account page, TASK-210 —
 *                                                 the registry's "offer appeal") and sign-out;
 *                                                 for content the screening blocked
 *                                                 (`content.rejected`, only ever a block —
 *                                                 TASK-211) the same link; content held for a
 *                                                 moderator (`held`) is a gray wait, with none; the retry
 *                                                 delay for a rate limit, a retry for a service
 *                                                 that is down, sign-in (or "Create an account"
 *                                                 for a guest out of free uses), a gray wait for
 *                                                 consent
 *   <TenantUnavailable refusal />                 full page: this deployment's tenant cannot
 *                                                 serve (suspended, missing, unknown address)
 *
 * The session-ending kind ("signed-out-erased") is acted on by useRefusalSessionEnd; this notice
 * only says why. Every string is from the catalog (messages/en.json, screens.refusal).
 */

import React from "react";
import Link from "next/link";
import { renderMessage } from "@/platform/errors/messages";
import type { Refusal } from "@/platform/errors/refusal";
import { accountStatusLabel, waitText } from "./refusal-words";
import { useSignInHref } from "@/components/auth/useSignInHref";

const t = (key: string, values?: Record<string, string | number>) =>
  renderMessage(`screens.refusal.${key}`, values);

const ALERT =
  "rounded-xl border border-red-700 bg-red-900/30 px-4 py-3 text-sm text-red-300";
// Informational, not a failure: gray (the platform's UX rule — red is for failures only).
const INFO =
  "rounded-xl border border-gray-700 bg-gray-800/40 px-4 py-3 text-sm text-gray-300";
const BUTTON = "mt-2 rounded bg-blue-700 px-3 py-1 text-sm text-white hover:bg-blue-800";

export interface RefusalNoticeProps {
  readonly refusal: Refusal;
  /** "service-unavailable" / "not-provisioned": offered as "Try again". */
  readonly onRetry?: () => void;
  /** "restricted": offered as "Sign out". */
  readonly onSignOut?: () => void;
  /** "sign-in": where sign-in is (default: sign-in, then back to this page — E-113). */
  readonly signInHref?: string;
  /**
   * A moderation decision's link to the account page, where it is appealed (default shown):
   * false for a guest, who has no account.
   */
  readonly offerAppeal?: boolean;
}

export function RefusalNotice({
  refusal,
  onRetry,
  onSignOut,
  signInHref,
  offerAppeal = true,
}: RefusalNoticeProps) {
  const { kind, message } = refusal;
  // Signed in again, back to this page (TASK-224, E-113); an erased account starts afresh.
  const signInHere = useSignInHref();
  // Inline, inside a page that has its main landmark already (SF-app-063).
  if (kind === "tenant-unavailable")
    return <TenantUnavailable refusal={refusal} nested />;
  if (kind === "consent-wait" || kind === "age-gate" || kind === "held") {
    return (
      <div role="status" className={INFO}>
        {message}
      </div>
    );
  }
  return (
    <div role="alert" aria-live="assertive" className={ALERT} data-refusal-kind={kind}>
      <p>{message}</p>
      {kind === "restricted" && refusal.accountStatus && (
        <p className="mt-1 text-red-200">
          {t("account_status", { status: accountStatusLabel(refusal.accountStatus) })}
        </p>
      )}
      {offerAppeal && offersAppeal(refusal) && <AppealLink />}
      {kind === "restricted" && onSignOut && (
        <button type="button" className={BUTTON} onClick={onSignOut}>
          {t("sign_out")}
        </button>
      )}
      {kind === "retry-after" && refusal.retryAfterSeconds !== undefined && (
        <p className="mt-1 text-red-200">
          {t("retry_after", { wait: waitText(refusal.retryAfterSeconds) })}
        </p>
      )}
      {(kind === "service-unavailable" || kind === "not-provisioned") && onRetry && (
        <button type="button" className={BUTTON} onClick={onRetry}>
          {t("retry")}
        </button>
      )}
      {(kind === "sign-in" || kind === "signed-out-erased") && (
        <a
          className={`${BUTTON} inline-block`}
          href={signInHref ?? (kind === "sign-in" ? signInHere : "/auth")}
        >
          {refusal.code === "guest.allowance_exhausted"
            ? t("create_account")
            : t("sign_in")}
        </a>
      )}
    </div>
  );
}

/**
 * Whether a refusal is a moderation decision the user can appeal from their account page
 * (TASK-210, N-117): a restricted account (account.restricted — its registry action is "offer
 * appeal"), or content the screening rejected (content.rejected). A guest has no account: a
 * screen serving one shows no link (RefusalNotice's `offerAppeal`).
 */
export function offersAppeal(refusal: Pick<Refusal, "kind" | "code">): boolean {
  return refusal.kind === "restricted" || refusal.code === APPEALABLE_CONTENT;
}

/** The refusal of content the screening blocked. */
export const APPEALABLE_CONTENT = "content.rejected";

/** The link to the account page's decisions, where a decision is appealed. */
export function AppealLink({ className }: { readonly className?: string }) {
  return (
    <Link
      href="/account"
      className={
        className ??
        "mt-2 inline-block text-sm text-blue-300 underline hover:text-blue-200"
      }
    >
      {t("appeal")}
    </Link>
  );
}

/**
 * The deployment cannot serve this tenant (tenant.suspended / missing / unknown_host): a whole
 * page of its own, or — `nested`, inside a page that has its main landmark already — the same
 * words in a box (SF-app-063: a second `main` inside the first).
 */
export function TenantUnavailable({
  refusal,
  nested = false,
}: {
  readonly refusal: Refusal;
  readonly nested?: boolean;
}) {
  const message = <p className="max-w-md text-sm text-gray-300">{refusal.message}</p>;
  if (nested) {
    return (
      <div
        role="alert"
        className={`${ALERT} space-y-2`}
        data-refusal-kind="tenant-unavailable"
      >
        <h2 className="text-xl font-bold text-white">{t("tenant_title")}</h2>
        {message}
      </div>
    );
  }
  // A page of its own: its main landmark (a role on it would hide the landmark), the alert inside.
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#0a0f1e] p-8 text-center">
      <div role="alert" className="flex flex-col items-center gap-3">
        <h1 className="text-xl font-bold text-white">{t("tenant_title")}</h1>
        {message}
      </div>
    </main>
  );
}
