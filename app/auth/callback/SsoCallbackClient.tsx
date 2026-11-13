"use client";

/**
 * Completes single sign-on (TASK-101): sends the returned code and state to
 * POST /api/auth/sso/callback, stores the session, and goes to the app. Any failure — the
 * provider reporting an error, a missing code, a rejected exchange — returns to the sign-in
 * screen with the error code, which renders the catalog message there.
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/platform/auth/context";
import { apiFetch } from "@/platform/auth/api-fetch";
import { isErrorCode } from "@/platform/errors/registry";
import { handleRefusal } from "@/platform/errors/refusal";
import { renderMessage } from "@/platform/errors/messages";

export default function SsoCallbackClient() {
  const router = useRouter();
  const { sessionStarted } = useAuth();
  // An authorization code is single-use; React may run effects twice in development.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const fail = (code: unknown = "auth.sso_failed") => {
      const url = new URL("/auth", window.location.origin);
      url.searchParams.set("error", isErrorCode(code) ? code : "auth.sso_failed");
      router.replace(url.pathname + url.search);
    };

    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
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
        router.replace("/");
      } catch {
        fail();
      }
    })();
  }, [router, sessionStarted]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <p role="status" className="text-gray-500">
        {renderMessage("screens.auth.signing_in")}
      </p>
    </div>
  );
}
