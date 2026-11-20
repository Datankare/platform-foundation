/** @jest-environment jsdom */
/**
 * __tests__/app-shell.test.tsx — the signed-in app's one frame (TASK-224; SF-app-001 to 004,
 * E-113 on the app's side)
 *
 * components/app/ui/AppShell.tsx: one dark header on every page (Home, Assistant, Your account;
 * Sign in for a guest), the page you are on marked, who is signed in, and the app's one Sign out;
 * one main landmark and "Skip to content"; one dark, announced wait; a signed-out visitor sent to
 * sign-in and back to this page — its path and its query; a session-ending refusal acted on.
 * components/app/ui/ProblemPage.tsx and the pages on it: not-found, a page that failed, the
 * layout that failed — each with the way home.
 *
 * hostile:role a guest is offered sign-in, never the account's pages
 * hostile:self n/a: the frame names no account but the session's own
 * hostile:store-down a sign-out the server did not complete leaves the page as it was
 * hostile:id-spelling n/a: no id is read or sent
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const replace = jest.fn();
let mockPath = "/";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: jest.fn() }),
  usePathname: () => mockPath,
}));
const mockAuth = {
  user: null as { email: string } | null,
  isLoading: false,
  isAuthenticated: false,
  isGuest: false,
  signOut: jest.fn<Promise<boolean>, []>(),
};
jest.mock("@/platform/auth/context", () => ({
  ...jest.requireActual("@/platform/auth/context"),
  useAuth: () => mockAuth,
}));

// The last-resort page brings the app's stylesheet itself (the layout it replaces is gone).
jest.mock("@/app/globals.css", () => ({}));

import { AppShell, isCurrent, useAppSignOut } from "@/components/app/ui/AppShell";
import { ProblemPage } from "@/components/app/ui/ProblemPage";
import NotFound, { metadata as notFoundMeta } from "@/app/not-found";
import PageError from "@/app/error";
import GlobalError from "@/app/global-error";
import { SESSION_END_EVENT } from "@/platform/errors/refusal";
import { signedInLine } from "./helpers/app-shell-text";

function at(path: string) {
  mockPath = path.split("?")[0]!;
  window.history.replaceState(null, "", path);
}

beforeEach(() => {
  replace.mockReset();
  mockAuth.signOut.mockReset();
  Object.assign(mockAuth, {
    user: { email: "me@example.test" },
    isLoading: false,
    isAuthenticated: true,
    isGuest: false,
  });
  at("/");
});

describe("the app's frame (TASK-224)", () => {
  it("one header, the page's place marked, who is signed in, one main landmark", () => {
    at("/account");
    render(
      <AppShell>
        <h1>Page</h1>
      </AppShell>
    );
    const nav = within(screen.getByRole("navigation", { name: "The app" }));
    expect(nav.getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Home",
      "Assistant",
      "Your account",
    ]);
    expect(nav.getByRole("link", { name: "Your account" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(nav.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
    expect(nav.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.getByText(signedInLine("me@example.test"))).toBeInTheDocument();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute(
      "href",
      "#main"
    );
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
  });

  // Code review B-29: the address was handed to String.replace as the replacement text, where
  // "$&", "$1" and "$$" are patterns — "a$&b@…" was shown as "a{email}b@…".
  it("the signed-in line holds an address with $&, $1 or $$ in it exactly as typed", () => {
    for (const email of ["a$&b@example.test", "a$1b@example.test", "a$$b@example.test"]) {
      expect(signedInLine(email)).toBe(
        signedInLine("me@example.test").replace("me@example.test", () => email)
      );
      expect(signedInLine(email)).toContain(email);
    }
  });

  it("a guest: Home and Sign in (back to this page), never the account's pages", () => {
    Object.assign(mockAuth, { user: null, isGuest: true });
    at("/assistant");
    render(<AppShell>x</AppShell>);
    const nav = within(screen.getByRole("navigation", { name: "The app" }));
    expect(nav.queryByRole("link", { name: "Assistant" })).toBeNull();
    expect(nav.queryByRole("link", { name: "Your account" })).toBeNull();
    expect(nav.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/auth?redirect=%2Fassistant"
    );
    expect(nav.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("while the session is read: one dark wait, announced, nothing else (SF-app-003)", () => {
    mockAuth.isLoading = true;
    const { container } = render(<AppShell>secret page</AppShell>);
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    expect(container.textContent).not.toContain("secret page");
    expect(screen.getByRole("main").className).toContain("bg-[#0a0f1e]");
    expect(replace).not.toHaveBeenCalled();
  });

  it("signed out: to sign-in, asked to come back to this page and its query (E-113)", () => {
    Object.assign(mockAuth, { user: null, isAuthenticated: false });
    at("/agent/authorize?request=h-1");
    render(<AppShell>secret page</AppShell>);
    expect(replace).toHaveBeenCalledWith(
      "/auth?redirect=%2Fagent%2Fauthorize%3Frequest%3Dh-1"
    );
    expect(screen.queryByText("secret page")).toBeNull();
  });

  it.each([
    [true, ["/auth"]],
    [false, []],
  ] as const)("Sign out answered %s: to sign-in %j (TASK-219)", async (ended, to) => {
    mockAuth.signOut.mockResolvedValue(ended);
    render(<AppShell>x</AppShell>);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    });
    await waitFor(() => expect(mockAuth.signOut).toHaveBeenCalledTimes(1));
    expect(replace.mock.calls.map((c) => c[0])).toEqual(to);
  });

  it("[hostile:rejected] a sign-out that rejects is caught: no unhandled rejection, still signed in (SF-app-002)", async () => {
    mockAuth.signOut.mockRejectedValue(new TypeError("network down"));
    render(<AppShell>x</AppShell>);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    });
    await waitFor(() => expect(mockAuth.signOut).toHaveBeenCalledTimes(1));
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText("x")).toBeInTheDocument();
  });

  it("useAppSignOut: a screen that leaves by signing out says whether it ended, then sign-in", async () => {
    let leave: (() => Promise<boolean>) | null = null;
    function Leaver() {
      leave = useAppSignOut();
      return null;
    }
    render(<Leaver />);
    mockAuth.signOut.mockResolvedValueOnce(false);
    await expect(leave!()).resolves.toBe(false);
    expect(replace).not.toHaveBeenCalled();
    mockAuth.signOut.mockRejectedValueOnce(new Error("down"));
    await expect(leave!()).resolves.toBe(false);
    mockAuth.signOut.mockResolvedValueOnce(true);
    await expect(leave!()).resolves.toBe(true);
    expect(replace).toHaveBeenCalledWith("/auth");
  });

  it("a refusal that ends the session, on any page: signed out and shown sign-in with why", async () => {
    mockAuth.signOut.mockResolvedValue(true);
    render(<AppShell>x</AppShell>);
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(SESSION_END_EVENT, { detail: { code: "account.not_found" } })
      );
    });
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/auth?error=account.not_found")
    );
  });

  it("isCurrent: the home page only for /; a section for itself and below it", () => {
    expect(isCurrent("/", "/")).toBe(true);
    expect(isCurrent("/", "/account")).toBe(false);
    expect(isCurrent("/account", "/account")).toBe(true);
    expect(isCurrent("/account", "/account/x")).toBe(true);
    expect(isCurrent("/account", "/accounts")).toBe(false);
    expect(isCurrent("/account", null)).toBe(false);
  });
});

describe("the problem pages: never a dead end (SF-app-004)", () => {
  it("an unknown address: the app's own page, in its words, with the way home", () => {
    render(<NotFound />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Page not found");
    expect(screen.getByRole("link", { name: "Go to the home page" })).toHaveAttribute(
      "href",
      "/"
    );
    expect(notFoundMeta.title).toBe("Page not found");
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("a page that failed: try again, or go home", () => {
    const reset = jest.fn();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    render(<PageError error={new Error("boom")} reset={reset} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Go to the home page" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("boom");
  });

  it("the layout that failed: the same page, inside its own document", () => {
    const reset = jest.fn();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const html = renderToStaticMarkup(
      <GlobalError error={new Error("boom")} reset={reset} />
    );
    expect(html.startsWith("<html")).toBe(true);
    expect(html).toContain("Go to the home page");
    expect(html).not.toContain("boom");
    render(<ProblemPage title="T" body="B" onRetry={reset} />);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
