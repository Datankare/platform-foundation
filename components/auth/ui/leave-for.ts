"use client";

/**
 * components/auth/ui/leave-for.ts — leave this page for another address, by a full navigation
 * (TASK-222)
 *
 * Single sign-on starts with GET /api/auth/sso/<provider>, which answers with a redirect to the
 * provider's hosted sign-in — something client navigation cannot follow. One function, so a test
 * can see where the page went (jsdom's `location.assign` is not replaceable).
 *
 * @module components/auth/ui
 */
export function leaveFor(url: string): void {
  window.location.assign(url);
}
