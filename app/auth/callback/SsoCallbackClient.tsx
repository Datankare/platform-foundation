"use client";

/**
 * Completes single sign-on (TASK-101): sends the returned code and state to
 * POST /api/auth/sso/callback, stores the session, and goes on. Any failure — the provider
 * reporting an error, a missing code, a rejected exchange — returns to the sign-in screen with
 * the error code, which renders the catalog message there.
 *
 * TASK-222: a person who cancelled at the provider (OAuth `error=access_denied`, RFC 6749
 * §4.1.2.1) returns with `?sso=cancelled` — said as a cancellation, not a failure (SF-app-048).
 * And a completed sign-on goes to the page asked for before leaving (E-113): the callback route
 * answers it (`returnTo`, kept in the attempt's httpOnly cookie), checked here again as a page
 * of this site (platform/auth/return-path.ts).
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/platform/auth/context";
import { apiFetch } from "@/platform/auth/api-fetch";
import { isErrorCode } from "@/platform/errors/registry";
import { handleRefusal } from "@/platform/errors/refusal";
import { renderMessage } from "@/platform/errors/messages";
import { safeReturnPath } from "@/platform/auth/return-path";
import { AuthLoading } from "@/components/auth/ui/AuthLoading";

/** The sign-in page this callback returns to, saying what happened. */
export function backToSignIn(
  origin: string,
  outcome: { readonly error: string } | { readonly cancelled: true }
): string {
  const url = new URL("/auth", origin);
  if ("cancelled" in outcome) url.searchParams.set("sso", "cancelled");
  else url.searchParams.set("error", outcome.error);
  return url.pathname + url.search;
}

export default function SsoCallbackClient() {
  const router = useRouter();
  const { sessionStarted } = useAuth();
  // An authorization code is single-use; React may run effects twice in development.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const fail = (code: unknown = "auth.sso_failed") => {
      router.replace(
        backToSignIn(window.location.origin, {
          error: isErrorCode(code) ? code : "auth.sso_failed",
        })
      );
    };

    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (params.get("error") === "access_denied") {
      router.replace(backToSignIn(window.location.origin, { cancelled: true }));
      return;
    }
    if (params.get("error") || !code || !state) {
      fail();
      return;
    }

    (async () => {
      try {
        const res = await apiFetch("/api/auth/sso/callback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, state }),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok || typeof data.userId !== "string") {
          // Every refusal returns to sign-in with its code's message (the shared handler names
          // it; an erased or unmatched account is no different here — there is no session yet).
          fail(res.ok ? undefined : handleRefusal(data.code).code || undefined);
          return;
        }
        // The server set the session cookie and kept the provider's tokens (ADR-057): the page
        // reads who is signed in from the server.
        if (!(await sessionStarted())) {
          fail();
          return;
        }
        const asked = typeof data.returnTo === "string" ? data.returnTo : null;
        router.replace(safeReturnPath(asked, window.location.origin) ?? "/");
      } catch {
        fail();
      }
    })();
  }, [router, sessionStarted]);

  return <AuthLoading text={renderMessage("screens.auth.signing_in")} />;
}
