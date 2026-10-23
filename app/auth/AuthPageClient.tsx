/**
 * app/auth/AuthPageClient.tsx — the sign-in page's client
 *
 * The browser signs in through the server's /api/auth/* routes (the browser auth provider). It
 * used to start every server provider in the browser (initAuth → initProviders), which in a
 * production build refused to boot on the browser's absent store settings and left the page on
 * "Loading..." (PF v5.1.1).
 */

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/platform/auth/context";
import { hasAuthProvider, registerAuthProvider } from "@/platform/auth/config";
import { createBrowserAuthProvider } from "@/platform/auth/browser-auth-provider";
import AuthPage from "@/components/auth/AuthPage";

/** Registered on the first client render, before any handler can ask for the provider. */
function registerBrowserAuthProvider(): true {
  if (typeof window !== "undefined" && !hasAuthProvider()) {
    registerAuthProvider(createBrowserAuthProvider());
  }
  return true;
}

export default function AuthPageClient() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();
  useState(registerBrowserAuthProvider);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace("/");
    }
  }, [isAuthenticated, isLoading, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (isAuthenticated) return null;

  return <AuthPage />;
}
