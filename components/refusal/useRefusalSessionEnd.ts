"use client";

/**
 * components/refusal/useRefusalSessionEnd.ts — end the session on an erased or unmatched account
 * (TASK-181)
 *
 * A refusal of kind "signed-out-erased" (`account.not_found`, `account.identity_conflict`) cannot
 * be fixed by retrying: the screen that holds the session signs out (the server revokes it) and
 * shows sign-in with the code's message (`/auth?error=<code>`, components/auth/useReturnError) —
 * once, however many calls were refused. Hooks deep in a screen announce it
 * (announceSessionEnd, platform/errors/refusal.ts) without access to the session; the screen
 * calls this hook once.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/platform/auth/context";
import { SESSION_END_EVENT } from "@/platform/errors/refusal";

export function sessionEndAddress(code: string): string {
  return `/auth?error=${encodeURIComponent(code)}`;
}

export function useRefusalSessionEnd(): void {
  const router = useRouter();
  const { signOut } = useAuth();
  useEffect(() => {
    let handled = false;
    const onEnd = (event: Event) => {
      if (handled) return;
      handled = true;
      const code = (event as CustomEvent<{ code?: unknown }>).detail?.code;
      void (async () => {
        // Sign-in is shown once the session has ended; a sign-out that did not happen leaves the
        // screen signed in, and the provider says so, with a way to try again (TASK-219).
        let ended = false;
        try {
          ended = await signOut();
        } catch {
          /* justified */
          // Not ended: the provider's notice stands.
        }
        if (ended)
          router.replace(sessionEndAddress(typeof code === "string" ? code : ""));
        else handled = false;
      })();
    };
    window.addEventListener(SESSION_END_EVENT, onEnd);
    return () => window.removeEventListener(SESSION_END_EVENT, onEnd);
  }, [router, signOut]);
}
