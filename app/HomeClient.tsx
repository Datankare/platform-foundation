/**
 * app/HomeClient.tsx — Protected home page
 *
 * Shows the current user identity and a sign-out button above the main app.
 * Redirects to /auth if not authenticated (middleware handles this,
 * but this is a fallback for client-side navigation).
 */

"use client";

import { useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/platform/auth/context";
import SpikeApp from "@/components/SpikeApp";

export default function HomeClient() {
  const router = useRouter();
  const { user, isLoading, isAuthenticated, isGuest, signOut, getAccessToken } =
    useAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/auth");
    }
  }, [isAuthenticated, isLoading, router]);

  const handleSignOut = useCallback(async () => {
    const token = getAccessToken();
    // Call server to clear cookie + invalidate Cognito session
    await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    // Clear client-side session cookie
    document.cookie = "pf_has_session=; path=/; max-age=0; SameSite=Lax";

    signOut();
    router.replace("/auth");
  }, [signOut, router, getAccessToken]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) return null;

  return (
    <div className="min-h-screen">
      {/* User bar */}
      <div className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-2">
        <div className="text-sm text-gray-600">
          {isGuest ? (
            <span>
              Guest session —{" "}
              <button
                onClick={() => router.push("/auth")}
                className="text-blue-600 hover:underline"
              >
                Sign in for full access
              </button>
            </span>
          ) : (
            <span>{user?.email}</span>
          )}
        </div>
        <button
          onClick={handleSignOut}
          className="rounded px-3 py-1 text-sm text-gray-600 hover:bg-gray-100"
        >
          Sign Out
        </button>
      </div>

      {/* Main app */}
      <SpikeApp />
    </div>
  );
}
