"use client";

/**
 * platform/auth/SignOutFailedNotice.tsx — a sign-out that did not happen, said plainly (TASK-219)
 *
 * Shown by AuthContextProvider, over whatever screen asked to sign out, when the server did not
 * end the session (offline, an outage, a refusal that a fresh read of the session could not
 * mend). The page stays signed in — the session cookie and the server's session are still live —
 * so it says so, and offers to try again. Every string is from the catalog (messages/en.json,
 * screens.session).
 */

import React from "react";
import { renderMessage } from "@/platform/errors/messages";

const t = (key: string) => renderMessage(`screens.session.${key}`);

export function SignOutFailedNotice({
  onRetry,
  onDismiss,
}: {
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      aria-labelledby="sign-out-failed-title"
      data-testid="sign-out-failed"
      className="fixed inset-x-0 bottom-0 z-50 flex justify-center p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-red-700 bg-gray-900 p-4 text-gray-100 shadow-xl">
        <h2 id="sign-out-failed-title" className="text-base font-semibold">
          {t("sign_out_failed_title")}
        </h2>
        <p className="mt-1 text-sm text-gray-300">{t("sign_out_failed_text")}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="rounded bg-blue-700 px-3 py-2 text-sm text-white hover:bg-blue-800"
          >
            {t("sign_out_try_again")}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded border border-gray-600 px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"
          >
            {t("sign_out_dismiss")}
          </button>
        </div>
      </div>
    </div>
  );
}
