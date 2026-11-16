"use client";

/**
 * components/auth/useSignInHref.ts — a link to sign-in that comes back to this page (TASK-222,
 * E-113)
 *
 * The sign-in page returns to `?redirect=` (platform/auth/return-path.ts). A screen that offers
 * "Sign in" because the session ended links there with its own address. The address is read as
 * an external store (useSyncExternalStore): there is none on the server, where the link is plain
 * `/auth`, so the server render and hydration agree.
 */

import { useSyncExternalStore } from "react";
import { signInPath } from "@/platform/auth/return-path";

const noSubscription = () => () => {};
const here = () => signInPath(window.location.pathname + window.location.search);
const plain = () => signInPath(null);

export function useSignInHref(): string {
  return useSyncExternalStore(noSubscription, here, plain);
}
