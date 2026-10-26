"use client";

/**
 * components/refusal/RefusalNotice.tsx — a refused API call, shown by its kind (TASK-181)
 *
 * The small shared pieces every screen uses with platform/errors/refusal.ts:
 *
 *   <RefusalNotice refusal onRetry onSignOut />   inline: the message, and what can be done —
 *                                                 sign-out for a restricted account, the retry
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
import { renderMessage } from "@/platform/errors/messages";
import type { Refusal } from "@/platform/errors/refusal";

const t = (key: string, values?: Record<string, string | number>) =>
  renderMessage(`screens.refusal.${key}`, values);

const ALERT =
  "rounded-xl border border-red-700 bg-red-900/30 px-4 py-3 text-sm text-red-300";
// Informational, not a failure: gray (the platform's UX rule — red is for failures only).
const INFO =
  "rounded-xl border border-gray-700 bg-gray-800/40 px-4 py-3 text-sm text-gray-300";
const BUTTON = "mt-2 rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-500";

export interface RefusalNoticeProps {
  readonly refusal: Refusal;
  /** "service-unavailable" / "not-provisioned": offered as "Try again". */
  readonly onRetry?: () => void;
  /** "restricted": offered as "Sign out". */
  readonly onSignOut?: () => void;
  /** "sign-in": where sign-in is (default /auth). */
  readonly signInHref?: string;
}

export function RefusalNotice({
  refusal,
  onRetry,
  onSignOut,
  signInHref = "/auth",
}: RefusalNoticeProps) {
  const { kind, message } = refusal;
  if (kind === "tenant-unavailable") return <TenantUnavailable refusal={refusal} />;
  if (kind === "consent-wait" || kind === "age-gate") {
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
          {t("account_status", { status: refusal.accountStatus })}
        </p>
      )}
      {kind === "restricted" && onSignOut && (
        <button type="button" className={BUTTON} onClick={onSignOut}>
          {t("sign_out")}
        </button>
      )}
      {kind === "retry-after" && refusal.retryAfterSeconds !== undefined && (
        <p className="mt-1 text-red-200">
          {t("retry_after", { seconds: refusal.retryAfterSeconds })}
        </p>
      )}
      {(kind === "service-unavailable" || kind === "not-provisioned") && onRetry && (
        <button type="button" className={BUTTON} onClick={onRetry}>
          {t("retry")}
        </button>
      )}
      {(kind === "sign-in" || kind === "signed-out-erased") && (
        <a className={`${BUTTON} inline-block`} href={signInHref}>
          {refusal.code === "guest.allowance_exhausted"
            ? t("create_account")
            : t("sign_in")}
        </a>
      )}
    </div>
  );
}

/** Full page: the deployment cannot serve this tenant (tenant.suspended / missing / unknown_host). */
export function TenantUnavailable({ refusal }: { readonly refusal: Refusal }) {
  return (
    <main
      role="alert"
      className="flex min-h-screen flex-col items-center justify-center gap-3 bg-[#0a0f1e] p-8 text-center"
    >
      <h1 className="text-xl font-bold text-white">{t("tenant_title")}</h1>
      <p className="max-w-md text-sm text-gray-300">{refusal.message}</p>
    </main>
  );
}
