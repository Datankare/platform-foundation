/**
 * app/HomeClient.tsx — Protected home page
 *
 * Shows the current user identity, a link to their account page (the decisions about their
 * content and their appeals, TASK-210) and a sign-out button above the app's home — the consumer
 * seam platform/modules/app-home.tsx, so this core page imports no module's UI (ADR-054).
 * Redirects to /auth if not authenticated (middleware handles this,
 * but this is a fallback for client-side navigation).
 */

"use client";

import { useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/platform/auth/context";
import AppHome from "@/platform/modules/app-home";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.home.${key}`, values);

export default function HomeClient() {
  const router = useRouter();
  const { user, isLoading, isAuthenticated, isGuest, signOut } = useAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/auth");
    }
  }, [isAuthenticated, isLoading, router]);

  const handleSignOut = useCallback(async () => {
    // The server revokes the session (refresh cookie and access token), then it ends here.
    await signOut();
    router.replace("/auth");
  }, [signOut, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-gray-500">{t("loading")}</div>
      </div>
    );
  }

  if (!isAuthenticated) return null;

  return (
    <div className="min-h-screen">
      {/* User bar */}
      <div className="flex items-center justify-between gap-2 border-b border-gray-200 bg-white px-4 py-2">
        <div className="text-sm text-gray-600">
          {isGuest ? (
            <span>
              {t("guest_session")}{" "}
              <button
                onClick={() => router.push("/auth")}
                className="text-blue-600 hover:underline"
              >
                {t("sign_in_for_full_access")}
              </button>
            </span>
          ) : (
            <span className="break-all">{user?.email}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!isGuest && (
            <Link
              href="/account"
              className="rounded px-3 py-1 text-sm text-blue-700 hover:bg-gray-100 hover:underline"
            >
              {t("your_account")}
            </Link>
          )}
          <button
            onClick={handleSignOut}
            className="rounded px-3 py-1 text-sm text-gray-600 hover:bg-gray-100"
          >
            {t("sign_out")}
          </button>
        </div>
      </div>

      {/* The app's home (consumer seam) */}
      <AppHome />
    </div>
  );
}
