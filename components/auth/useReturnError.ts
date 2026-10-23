/**
 * components/auth/useReturnError.ts — the error a failed SSO attempt returns with (TASK-101)
 *
 * The callback sends the browser back to the sign-in page with ?error=<code>. The code is read
 * from the address as an external store (React's useSyncExternalStore): there is none on the
 * server, so the server render and hydration agree, and no state is set inside an effect. The
 * message shows until the user dismisses it.
 */

import { useState, useSyncExternalStore } from "react";
import { isErrorCode, messageKey } from "@/platform/errors/registry";
import { renderMessage } from "@/platform/errors/messages";

/** The address does not change under the page, so there is nothing to subscribe to. */
const noSubscription = () => () => {};
const readReturnCode = () => new URLSearchParams(window.location.search).get("error");
const noReturnCode = () => null;

export function useReturnError(): {
  returnError: string | null;
  dismissReturnError: () => void;
} {
  const code = useSyncExternalStore(noSubscription, readReturnCode, noReturnCode);
  const [dismissed, setDismissed] = useState(false);
  return {
    returnError: !dismissed && isErrorCode(code) ? renderMessage(messageKey(code)) : null,
    dismissReturnError: () => setDismissed(true),
  };
}
