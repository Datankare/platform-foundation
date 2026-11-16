/**
 * app/auth/AuthPageClient.tsx — the sign-in page's client
 *
 * The browser signs in through the server's /api/auth/* routes (the browser auth provider). It
 * used to start every server provider in the browser (initAuth → initProviders), which in a
 * production build refused to boot on the browser's absent store settings and left the page on
 * "Loading..." (PF v5.1.1).
 *
 * Once someone is signed in, the page goes on to the page they asked for — `?redirect=`, a page
 * of this site only (platform/auth/return-path.ts) — or to / (TASK-222, E-113: it always went
 * to /).
 */

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/platform/auth/context";
import { hasAuthProvider, registerAuthProvider } from "@/platform/auth/config";
import { createBrowserAuthProvider } from "@/platform/auth/browser-auth-provider";
import { returnPathFromLocation } from "@/platform/auth/return-path";
import type { SsoProvider } from "@/platform/auth/types";
import AuthPage from "@/components/auth/AuthPage";
import { AuthLoading } from "@/components/auth/ui/AuthLoading";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.app.auth_page.${key}`, values);

/** Registered on the first client render, before any handler can ask for the provider. */
function registerBrowserAuthProvider(): true {
  if (typeof window !== "undefined" && !hasAuthProvider()) {
    registerAuthProvider(createBrowserAuthProvider());
  }
  return true;
}

export default function AuthPageClient({
  ssoProviders = [],
}: {
  readonly ssoProviders?: SsoProvider[];
}) {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();
  useState(registerBrowserAuthProvider);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace(returnPathFromLocation(window.location) ?? "/");
    }
  }, [isAuthenticated, isLoading, router]);

  if (isLoading) {
    return <AuthLoading text={t("loading")} />;
  }

  if (isAuthenticated) return null;

  return <AuthPage ssoProviders={ssoProviders} />;
}
