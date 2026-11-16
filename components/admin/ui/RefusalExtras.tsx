"use client";

/**
 * components/admin/ui/RefusalExtras.tsx — what a refusal needs beyond its sentence (TASK-216)
 *
 * PanelState and Outcome show a refusal's own sentence once, as their text; this adds only what
 * its kind needs besides (platform/errors/refusal.ts): when a rate limit lifts, a restricted
 * account's standing, the way to sign in. The words are the shared notice's (screens.refusal).
 *
 * @module components/admin/ui
 */

import React from "react";
import { renderMessage } from "@/platform/errors/messages";
import type { Refusal } from "@/platform/errors/refusal";
import { BUTTON } from "./tokens";

export function RefusalExtras({ refusal }: { readonly refusal: Refusal }) {
  const { kind } = refusal;
  if (kind === "retry-after" && refusal.retryAfterSeconds !== undefined)
    return (
      <p data-refusal-kind={kind}>
        {renderMessage("screens.refusal.retry_after", {
          seconds: refusal.retryAfterSeconds,
        })}
      </p>
    );
  if (kind === "restricted" && refusal.accountStatus)
    return (
      <p data-refusal-kind={kind}>
        {renderMessage("screens.refusal.account_status", {
          status: refusal.accountStatus,
        })}
      </p>
    );
  if (kind === "sign-in" || kind === "signed-out-erased")
    return (
      <p data-refusal-kind={kind}>
        <a href="/auth" className={BUTTON.link}>
          {renderMessage("screens.refusal.sign_in")}
        </a>
      </p>
    );
  return null;
}
