"use client";

/**
 * components/app/ui/AppShell.tsx — the signed-in app's one page frame: its header, its main
 * landmark and its wait (TASK-224; SCREEN-FINDINGS P12, P15, SF-app-001 to 003)
 *
 * The 2026-11-12 review found the user's pages each building their own top: a white bar above
 * the dark home (Assistant, Your account, Sign out), a second bar on Playform's translate screen
 * (its own "Profile" link), a "Back to home" link on the account and assistant pages, a profile
 * page with a sign-out of its own and no way to the account page; and white loading pages, most
 * not announced, between dark ones. Every page of the app is now this frame:
 *
 *   - one dark header on every page: the app's name (home), Home, Assistant and Your account for
 *     an account, Sign in for a guest; the page you are on marked (`aria-current`); who is
 *     signed in; and the one Sign out of the app's pages;
 *   - Sign out ends the session on the server first (TASK-219): a sign-out that did not happen
 *     leaves the page signed in and the auth provider says so; it never rejects unhandled;
 *   - a "Skip to content" link, and one `main` landmark — a page's content never writes its own;
 *   - while the session is read, one dark wait, announced (role="status");
 *   - a signed-out visitor goes to sign-in and comes back here (./useSignedIn.ts, E-113);
 *   - a refusal that ends the session (an erased account) signs out and shows sign-in with its
 *     reason, on every page (components/refusal/useRefusalSessionEnd.ts).
 *
 * The header wraps on a phone: nothing scrolls sideways at 390 px.
 *
 * @module components/app/ui
 */

import React, { useCallback } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/platform/auth/context";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { AuthLoading } from "@/components/auth/ui/AuthLoading";
import { useSignInHref } from "@/components/auth/useSignInHref";
import { FOCUS_RING, SURFACE, TEXT } from "@/components/admin/ui/tokens";
import { useRefusalSessionEnd } from "@/components/refusal/useRefusalSessionEnd";
import { useSignedIn } from "./useSignedIn";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.app_shell.${key}`, values);

/** The app's pages in the header, in order; `account`: shown to an account only, not a guest. */
export const APP_NAV: readonly {
  readonly href: string;
  readonly key: string;
  readonly account: boolean;
}[] = [
  { href: "/", key: "home", account: false },
  { href: "/assistant", key: "assistant", account: true },
  { href: "/account", key: "account", account: true },
];

/** The id of the page's main landmark: where "Skip to content" goes. */
export const MAIN_ID = "main";

const NAV_LINK = `rounded px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-800 hover:text-white aria-[current=page]:bg-gray-800 aria-[current=page]:font-semibold aria-[current=page]:text-white ${FOCUS_RING}`;

/** Whether `href` is the page at `path` (the home page only for "/" itself). */
export function isCurrent(href: string, path: string | null): boolean {
  if (!path) return false;
  return href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
}

/**
 * The app's one sign-out: the server ends the session first; one that did not end stays signed in,
 * and the auth provider says so (TASK-219). Ended, to sign-in. Never an unhandled rejection
 * (SF-app-002). For the header's Sign out, and for a screen that leaves by signing out (Playform's
 * date-of-birth step) — a screen never calls signOut() itself
 * (__tests__/app-shared-components-guard.test.ts). Resolves whether the session ended.
 */
export function useAppSignOut(): () => Promise<boolean> {
  const router = useRouter();
  const { signOut } = useAuth();
  return useCallback(async () => {
    let ended = false;
    try {
      ended = await signOut();
    } catch {
      ended = false;
    }
    if (ended) router.replace("/auth");
    return ended;
  }, [signOut, router]);
}

export function AppHeader() {
  const path = usePathname();
  const { user, isGuest } = useAuth();
  const signInHref = useSignInHref();
  const handleSignOut = useAppSignOut();

  return (
    <header className={`border-b border-gray-800 ${SURFACE.page}`}>
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2">
        <Link
          href="/"
          className={`text-base font-bold tracking-tight text-white ${FOCUS_RING}`}
        >
          {renderMessage("screens.app.meta.site_title")}
        </Link>
        <nav aria-label={t("nav_label")} className="min-w-0">
          <ul className="flex flex-wrap items-center gap-1">
            {APP_NAV.filter((item) => !(item.account && isGuest)).map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={isCurrent(item.href, path) ? "page" : undefined}
                  className={NAV_LINK}
                >
                  {t(item.key)}
                </Link>
              </li>
            ))}
            <li>
              {isGuest ? (
                <a href={signInHref} className={NAV_LINK}>
                  {t("sign_in")}
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleSignOut()}
                  className={NAV_LINK}
                >
                  {t("sign_out")}
                </button>
              )}
            </li>
          </ul>
        </nav>
        <p className={`w-full min-w-0 break-words text-xs ${TEXT.faint}`}>
          {isGuest
            ? t("guest")
            : user?.email
              ? t("signed_in_as", { email: user.email })
              : null}
        </p>
      </div>
    </header>
  );
}

export function AppShell({
  children,
  wide = false,
}: {
  readonly children: React.ReactNode;
  /** A page that needs the width (the translate screen); the others read better narrow. */
  readonly wide?: boolean;
}) {
  const ready = useSignedIn();
  // A refusal that ends the session (an erased account, an identity that no longer reaches its
  // account) is acted on here, once, for every page of the app (TASK-181).
  useRefusalSessionEnd();
  if (!ready) return <AuthLoading text={t("loading")} />;
  return (
    <div className={`min-h-screen ${SURFACE.page} text-gray-100`}>
      <a
        href={`#${MAIN_ID}`}
        className={`sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-blue-700 focus:px-3 focus:py-2 focus:text-white ${FOCUS_RING}`}
      >
        {t("skip")}
      </a>
      <AppHeader />
      <main
        id={MAIN_ID}
        tabIndex={-1}
        className={`mx-auto w-full min-w-0 px-4 py-6 focus:outline-none sm:px-6 ${
          wide ? "max-w-5xl" : "max-w-2xl"
        }`}
      >
        {children}
      </main>
    </div>
  );
}
