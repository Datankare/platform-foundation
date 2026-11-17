/** @jest-environment jsdom */
/**
 * __tests__/account-page.test.tsx — the account page, and the header's way to it (TASK-210,
 * N-117; TASK-225, E-126 and SF-app-073)
 *
 * app/account/AccountClient.tsx: signed out → sign-in and back here (E-113); a guest is told a
 * guest session has no account, and offered sign-in, and nothing is read; a signed-in person sees
 * one page with every section — an app's own (the seam), sign-in and security, their data, the
 * decisions about their content (the appeals route's own answer) and their devices — and "On
 * this page" links to each; a deleted account replaces the page with what was done.
 * app/HomeClient.tsx: "Your account" in the app's header for a signed-in user, none for a guest.
 * Each route is answered with its own fixture (the route's answer, route-responses.json).
 */
import React from "react";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { routeAnswer } from "@/__tests__/fixtures/route-responses";

const replace = jest.fn();
const push = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push }),
  usePathname: () => window.location.pathname,
}));

const mockAuth = {
  user: null as { email: string } | null,
  isLoading: false,
  isAuthenticated: false,
  isGuest: false,
  signOut: jest.fn(async () => undefined),
  signOutEverywhere: jest.fn(async () => true),
};
jest.mock("@/platform/auth/context", () => ({
  ...jest.requireActual("@/platform/auth/context"),
  useAuth: () => mockAuth,
}));
// The home's own content is the app's (its seam): not what this test is about.
jest.mock("@/platform/modules/app-home", () => ({
  __esModule: true,
  default: () => null,
}));
// An app's own section of the account page, as Playform's profile is (the seam, SF-app-073).
const mockAppSections = { on: false };
jest.mock("@/platform/modules/app-account", () => {
  const React = jest.requireActual("react");
  return {
    __esModule: true,
    get APP_ACCOUNT_SECTIONS() {
      return mockAppSections.on ? [{ id: "profile", title: "Your profile" }] : [];
    },
    default: () =>
      mockAppSections.on
        ? React.createElement(
            "section",
            { id: "profile", "aria-label": "Your profile" },
            "the app's own section"
          )
        : null,
  };
});

import AccountClient from "@/app/account/AccountClient";
import AccountPage, { metadata } from "@/app/account/page";
import HomeClient from "@/app/HomeClient";

const fetchMock = jest.fn();
/** Every route the page reads, answered with its own fixture. */
function answerRoutes(
  decisions: Parameters<
    typeof routeAnswer
  >[0] = "GET /api/moderation/appeals — one appealable"
) {
  fetchMock.mockImplementation(async (url: string) => {
    const [status, body] = routeAnswer(
      String(url).startsWith("/api/account/security")
        ? "GET /api/account/security — signed in, two-step verification on"
        : decisions
    );
    return { ok: status < 300, status, json: async () => body };
  });
}
beforeEach(() => {
  mockAppSections.on = false;
  Object.assign(mockAuth, {
    user: null,
    isLoading: false,
    isAuthenticated: false,
    isGuest: false,
  });
  replace.mockReset();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

const signedIn = () =>
  Object.assign(mockAuth, { user: { email: "me@example.test" }, isAuthenticated: true });

describe("the account page (TASK-210)", () => {
  it("is titled from the catalog and renders the client page", () => {
    expect(metadata.title).toBe("Your account");
    expect(AccountPage().type).toBe(AccountClient);
  });

  it("signed out: sent to sign-in and back here (E-113), nothing shown or read", () => {
    window.history.replaceState(null, "", "/account");
    render(<AccountClient />);
    expect(replace).toHaveBeenCalledWith("/auth?redirect=%2Faccount");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    window.history.replaceState(null, "", "/");
  });

  it("loading: says so, and decides nothing yet", () => {
    mockAuth.isLoading = true;
    render(<AccountClient />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    expect(replace).not.toHaveBeenCalled();
  });

  it("a guest: no decisions to read — told so, with sign-in", () => {
    Object.assign(mockAuth, { isAuthenticated: true, isGuest: true });
    render(<AccountClient />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your account");
    expect(screen.getByText(/A guest session has no account/)).toBeInTheDocument();
    expect(
      within(screen.getByRole("main")).getByRole("link", { name: "Sign in" })
    ).toHaveAttribute("href", "/auth?redirect=%2Faccount");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signed in: the decisions about their content, under its heading, and the way home", async () => {
    signedIn();
    answerRoutes();
    render(<AccountClient />);
    const section = screen.getByRole("region", { name: "Decisions about your content" });
    expect(await within(section).findByTestId("decision-traj-1")).toBeInTheDocument();
    expect(screen.getByText("Signed in as me@example.test")).toBeInTheDocument();
    // The app's header is the way home (SF-app-001): the page has no link of its own.
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("link", { name: "← Back to home" })).toBeNull();
  });

  it("one page for the whole account: every section, and a link to each (E-126, SF-app-073)", async () => {
    signedIn();
    mockAppSections.on = true;
    answerRoutes();
    render(<AccountClient />);
    const names = [
      "Sign-in and security",
      "Your data",
      "Decisions about your content",
      "Signed-in devices",
    ];
    for (const name of names)
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    // The app's own section, through the seam, first.
    expect(screen.getByRole("region", { name: "Your profile" })).toBeInTheDocument();
    const onThisPage = within(screen.getByRole("navigation", { name: "On this page" }));
    expect(onThisPage.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      "#profile",
      "#security",
      "#data",
      "#decisions",
      "#sessions",
    ]);
    // Each link's target is a section with that id.
    for (const id of ["security", "data", "decisions", "sessions"])
      expect(document.getElementById(id)?.tagName).toBe("SECTION");
    await screen.findByTestId("decision-traj-1");
  });

  it("a page has one main landmark, the app's (no page draws its own)", async () => {
    signedIn();
    answerRoutes();
    render(<AccountClient />);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    await screen.findByTestId("decision-traj-1");
  });
});

describe("sign out everywhere, from the account page (ADR-057 D6)", () => {
  const signedIn = () => {
    Object.assign(mockAuth, { user: { email: "a@b.c" }, isAuthenticated: true });
    // The sections beside it read their own routes: answered as those routes answer.
    answerRoutes();
    render(<AccountClient />);
    return within(screen.getByRole("region", { name: "Signed-in devices" }));
  };
  beforeEach(() => mockAuth.signOutEverywhere.mockReset());

  it("a guest has no devices to sign out: the section is not shown", () => {
    Object.assign(mockAuth, { isAuthenticated: true, isGuest: true });
    render(<AccountClient />);
    expect(screen.queryByRole("region", { name: "Signed-in devices" })).toBeNull();
  });

  it("asks before acting; Cancel does nothing", async () => {
    const section = signedIn();
    fireEvent.click(section.getByRole("button", { name: "Sign out everywhere" }));
    expect(
      section.getByText("Sign out of every device, including this one?")
    ).toBeVisible();
    expect(
      section.getByRole("button", { name: "Yes, sign out everywhere" })
    ).toHaveFocus();
    expect(mockAuth.signOutEverywhere).not.toHaveBeenCalled();
    fireEvent.click(section.getByRole("button", { name: "Cancel" }));
    expect(mockAuth.signOutEverywhere).not.toHaveBeenCalled();
    expect(section.getByRole("button", { name: "Sign out everywhere" })).toBeVisible();
  });

  it("confirmed and done: once, then to sign-in", async () => {
    mockAuth.signOutEverywhere.mockResolvedValue(true);
    const section = signedIn();
    fireEvent.click(section.getByRole("button", { name: "Sign out everywhere" }));
    await act(async () => {
      fireEvent.click(section.getByRole("button", { name: "Yes, sign out everywhere" }));
    });
    expect(mockAuth.signOutEverywhere).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/auth");
  });

  it("the server could not do it: says so, stays on the page, and can be tried again", async () => {
    mockAuth.signOutEverywhere.mockResolvedValue(false);
    const section = signedIn();
    fireEvent.click(section.getByRole("button", { name: "Sign out everywhere" }));
    await act(async () => {
      fireEvent.click(section.getByRole("button", { name: "Yes, sign out everywhere" }));
    });
    expect(section.getByRole("alert")).toHaveTextContent(
      "We could not sign you out everywhere. You are still signed in here."
    );
    expect(replace).not.toHaveBeenCalledWith("/auth");
    expect(section.getByRole("button", { name: "Sign out everywhere" })).toBeEnabled();
  });

  it("while it works the two buttons cannot be pressed twice", async () => {
    let finish: (done: boolean) => void = () => undefined;
    mockAuth.signOutEverywhere.mockReturnValue(
      new Promise<boolean>((resolve) => (finish = resolve))
    );
    const section = signedIn();
    fireEvent.click(section.getByRole("button", { name: "Sign out everywhere" }));
    fireEvent.click(section.getByRole("button", { name: "Yes, sign out everywhere" }));
    expect(section.getByRole("button", { name: "Signing out…" })).toBeDisabled();
    expect(section.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await act(async () => finish(true));
  });
});

describe("the header's way to the account page (TASK-210, TASK-224)", () => {
  it("a signed-in user: Your account, beside Sign out", () => {
    signedIn();
    render(<HomeClient />);
    expect(screen.getByRole("link", { name: "Your account" })).toHaveAttribute(
      "href",
      "/account"
    );
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("a guest: no account, so no link", () => {
    Object.assign(mockAuth, { isAuthenticated: true, isGuest: true });
    render(<HomeClient />);
    expect(screen.queryByRole("link", { name: "Your account" })).toBeNull();
  });
});
