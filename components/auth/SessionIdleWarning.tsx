"use client";

/**
 * components/auth/SessionIdleWarning.tsx — warn a staff member before an idle sign-out
 * (ADR-057 D5, TASK-214)
 *
 * A staff session ends after a short time without a request (auth.session.staff_idle_seconds,
 * default 30 minutes). Typing into a form makes no request, so someone part-way through one would
 * be signed out and lose it. While a staff member is signed in this component asks the server how
 * long the session has left — a read that does not itself count as use — and, shortly before the
 * idle limit, shows a notice over the page with the time left and two actions: "Stay signed in"
 * (one request that counts as use; the page and whatever is typed in it stay as they are) and
 * "Sign out". It renders nothing for a user or a guest, whose idle limits are days long, or when
 * signed out.
 *
 * Mounted once, inside <AuthContextProvider> (app/layout.tsx). Every string is from the catalog
 * (messages/en.json, screens.session).
 */

import React, { useEffect, useRef, useState } from "react";
import { loadSession, useAuth } from "@/platform/auth/context";
import { renderMessage } from "@/platform/errors/messages";

const t = (key: string, values?: Record<string, string | number>) =>
  renderMessage(`screens.session.${key}`, values);

/** How often the server is asked how long the session has left. */
const POLL_MS = 30_000;

export default function SessionIdleWarning() {
  const { session, staySignedIn, signOut } = useAuth();
  const staff = session.status === "signed-in" && session.audience === "staff";
  const idleExpiresAt = session.status === "signed-in" ? session.idleExpiresAt : null;
  const warnSeconds = session.status === "signed-in" ? session.idleWarningSeconds : 0;
  const [now, setNow] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const stay = useRef<HTMLButtonElement>(null);

  // Ask the server how long is left: other tabs and requests move the limit.
  useEffect(() => {
    if (!staff) return;
    const poll = setInterval(() => void loadSession(), POLL_MS);
    return () => clearInterval(poll);
  }, [staff]);

  // The clock the countdown reads (never Date.now() during render).
  useEffect(() => {
    if (!staff) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [staff]);

  const remaining =
    staff && idleExpiresAt !== null && now !== null
      ? Math.ceil((idleExpiresAt - now) / 1000)
      : null;
  const warning = remaining !== null && remaining <= warnSeconds;

  // The limit passed: the server decides (it ends the session; the page then shows sign-in).
  const expired = remaining !== null && remaining <= 0;
  useEffect(() => {
    if (expired) void loadSession();
  }, [expired]);

  useEffect(() => {
    if (warning) stay.current?.focus();
  }, [warning]);

  if (!warning || remaining === null) return null;

  const onStay = async () => {
    setBusy(true);
    try {
      await staySignedIn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-idle-title"
      aria-describedby="session-idle-text"
      data-testid="session-idle-warning"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-sm rounded-xl border border-gray-700 bg-gray-900 p-5 text-gray-100 shadow-xl">
        <h2 id="session-idle-title" className="text-lg font-semibold">
          {t("idle_title")}
        </h2>
        {/* Not a live region: the dialog announces the text once when it opens; a countdown
            read out every second would drown the two actions. */}
        <p id="session-idle-text" className="mt-2 text-sm text-gray-300">
          {t("idle_text", { seconds: Math.max(0, remaining) })}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            ref={stay}
            type="button"
            onClick={() => void onStay()}
            disabled={busy}
            className="rounded bg-blue-700 px-3 py-2 text-sm text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {t("stay_signed_in")}
          </button>
          <button
            type="button"
            onClick={() => void signOut()}
            disabled={busy}
            className="rounded border border-gray-600 px-3 py-2 text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-60"
          >
            {t("sign_out")}
          </button>
        </div>
      </div>
    </div>
  );
}
