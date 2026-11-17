"use client";

/**
 * components/app/ui/useSignedIn.ts — a page that needs a session sends a signed-out visitor to
 * sign-in, and back here afterwards (TASK-224, E-113 on the app's side)
 *
 * The proxy sends a request without a session cookie to `/auth?redirect=<the page>` before the
 * page renders (proxy.ts). A page whose session ends while it is open, or whose cookie names a
 * session that no longer exists, learns it from the session read: each page then did
 * `router.replace("/auth")`, so signing in again landed on the home page, never on the account
 * page, the assistant or the authorization request the person was on (E-113). Here, once, for
 * every page: the sign-in page is asked to return to this page — its path and its query, so an
 * authorization request keeps its handle (platform/auth/return-path.ts checks it on the way back).
 *
 * @module components/app/ui
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/platform/auth/context";
import { useSignInHref } from "@/components/auth/useSignInHref";

/** Whether the page may show itself: true once the session is read and someone is signed in. */
export function useSignedIn(): boolean {
  const router = useRouter();
  const { isLoading, isAuthenticated } = useAuth();
  const signIn = useSignInHref();
  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace(signIn);
  }, [isLoading, isAuthenticated, router, signIn]);
  return !isLoading && isAuthenticated;
}
