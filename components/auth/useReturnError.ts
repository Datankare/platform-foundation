/**
 * components/auth/useReturnError.ts — what a single sign-on attempt returns to the sign-in page
 * with (TASK-101, TASK-222)
 *
 * The callback sends the browser back to the sign-in page with ?error=<code> when sign-on failed,
 * or ?sso=cancelled when the person cancelled it at the provider — not a failure, and not said as
 * one ("Single sign-on did not complete" read as if something broke; SF-app-048). Both are read
 * from the address as an external store (React's useSyncExternalStore): there is none on the
 * server, so the server render and hydration agree, and no state is set inside an effect. The
 * message shows until the person dismisses it (any action on the page) — and dismissing takes
 * the parameter out of the address too, so a reload does not show it again (SF-app-049).
 */

import { useState, useSyncExternalStore } from "react";
import { isErrorCode, messageKey } from "@/platform/errors/registry";
import { renderMessage } from "@/platform/errors/messages";

/** The parameter the callback sets when the person cancelled at the provider. */
export const SSO_PARAM = "sso";
export const SSO_CANCELLED = "cancelled";

/** The address does not change under the page, so there is nothing to subscribe to. */
const noSubscription = () => () => {};
const readReturnCode = () => new URLSearchParams(window.location.search).get("error");
const readSsoState = () => new URLSearchParams(window.location.search).get(SSO_PARAM);
const nothing = () => null;

/** The address without what the callback put there, the rest (a return path) kept. */
export function withoutReturnParams(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("error");
  url.searchParams.delete(SSO_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function useReturnError(): {
  returnError: string | null;
  returnNotice: string | null;
  dismissReturnError: () => void;
} {
  const code = useSyncExternalStore(noSubscription, readReturnCode, nothing);
  const sso = useSyncExternalStore(noSubscription, readSsoState, nothing);
  const [dismissed, setDismissed] = useState(false);
  return {
    returnError: !dismissed && isErrorCode(code) ? renderMessage(messageKey(code)) : null,
    returnNotice:
      !dismissed && sso === SSO_CANCELLED
        ? renderMessage("screens.auth.sso.cancelled")
        : null,
    dismissReturnError: () => {
      setDismissed(true);
      if (code !== null || sso !== null) {
        // The page's own entry, rewritten in place: Back still leaves the page as before.
        window.history.replaceState(
          window.history.state,
          "",
          withoutReturnParams(window.location.href)
        );
      }
    },
  };
}
