"use client";

/**
 * components/auth/useAuthSteps.ts — which sign-in step is shown, and where it is in the address
 * (TASK-222, SF-app-041)
 *
 * The sign-in page is one page of steps (sign-in, the account form, the reset, two-step
 * verification, a new password, the email check). The step was held only in the page's memory:
 * Back left the page whatever step one was on, a step could not be linked to, and moving to a
 * step left focus on a button that was gone. Here each step has its name in the address
 * (`?view=`, sign-in none), a move between steps is a history entry (Back and Forward move
 * between them inside the page), and `moved` says the page has moved to a step — its heading
 * then takes focus (AuthHeading). A step that needs what an earlier one gave cannot be opened from
 * the address or the history without it: sign-in is shown, and the address says so.
 *
 * @module components/auth
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type AuthView =
  | "login"
  | "register"
  | "forgot-password"
  | "mfa-challenge"
  | "new-password"
  | "email-verification";

/**
 * Each step's name in the address (`/auth?view=…`; sign-in has none), so Back and Forward move
 * between steps instead of leaving the page (TASK-222, SF-app-041).
 */
export const VIEW_PARAM = "view";
const VIEW_NAMES: Readonly<Record<AuthView, string | null>> = {
  login: null,
  register: "create-account",
  "forgot-password": "reset-password",
  "email-verification": "verify-email",
  "mfa-challenge": "two-step",
  "new-password": "new-password",
};

/** The step an address names; an unknown name is sign-in. */
export function viewFromSearch(search: string): AuthView {
  const name = new URLSearchParams(search).get(VIEW_PARAM);
  const found = (Object.keys(VIEW_NAMES) as AuthView[]).find(
    (v) => VIEW_NAMES[v] !== null && VIEW_NAMES[v] === name
  );
  return found ?? "login";
}

/** The step the page opens on: only a step that needs nothing earlier opens from the address. */
export function initialView(search: string): AuthView {
  const named = viewFromSearch(search);
  return named === "register" || named === "forgot-password" ? named : "login";
}

/**
 * The address of a step: this page, its return path kept, the step named — and what a single
 * sign-on attempt returned with left behind (it was dismissed by moving on).
 */
export function hrefForView(href: string, view: AuthView): string {
  const url = new URL(href);
  url.searchParams.delete("error");
  url.searchParams.delete("sso");
  const name = VIEW_NAMES[view];
  if (name) url.searchParams.set(VIEW_PARAM, name);
  else url.searchParams.delete(VIEW_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The step shown, whether the page has moved to it, and the moves. `canOpen` says whether a step
 * that needs an earlier one's answer has it; `onMove` runs on Back and Forward (what the step
 * said is the step's).
 */
export function useAuthSteps(
  canOpen: (view: AuthView) => boolean,
  onMove: () => void
): {
  view: AuthView;
  moved: boolean;
  switchView: (view: AuthView) => void;
  markMoved: () => void;
} {
  const [view, setView] = useState<AuthView>(() =>
    typeof window === "undefined" ? "login" : initialView(window.location.search)
  );
  const [moved, setMoved] = useState(false);
  // The latest judgement and reaction, read when the history moves.
  const latest = useRef({ canOpen, onMove });
  useEffect(() => {
    latest.current = { canOpen, onMove };
  });

  // An address naming a step that cannot open by itself is rewritten to the step shown.
  useEffect(() => {
    if (initialView(window.location.search) !== viewFromSearch(window.location.search))
      window.history.replaceState(
        window.history.state,
        "",
        hrefForView(window.location.href, "login")
      );
  }, []);

  // Back and Forward move between the steps this page put in the history.
  useEffect(() => {
    const onPopState = () => {
      const named = viewFromSearch(window.location.search);
      latest.current.onMove();
      setMoved(true);
      setView(latest.current.canOpen(named) ? named : "login");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const switchView = useCallback((next: AuthView) => {
    setMoved(true);
    setView(next);
    window.history.pushState(
      window.history.state,
      "",
      hrefForView(window.location.href, next)
    );
  }, []);

  const markMoved = useCallback(() => setMoved(true), []);

  return { view, moved, switchView, markMoved };
}
