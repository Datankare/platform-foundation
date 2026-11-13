/** @jest-environment jsdom */
/**
 * __tests__/account-page.test.tsx — the account page, and the home bar's way to it (TASK-210,
 * N-117)
 *
 * app/account/AccountClient.tsx: signed out → sign-in; a guest is told a guest session has no
 * decisions, and offered sign-in, and nothing is read; a signed-in user sees the decisions about
 * their content (the appeals route's own answer). app/HomeClient.tsx: "Your account" for a
 * signed-in user, none for a guest.
 */
import React from "react";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { routeAnswer } from "@/__tests__/fixtures/route-responses";

const replace = jest.fn();
const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace, push }) }));

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

import AccountClient from "@/app/account/AccountClient";
import AccountPage, { metadata } from "@/app/account/page";
import HomeClient from "@/app/HomeClient";

const fetchMock = jest.fn();
beforeEach(() => {
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

  it("signed out: sent to sign-in, nothing shown or read", () => {
    const { container } = render(<AccountClient />);
    expect(replace).toHaveBeenCalledWith("/auth");
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/auth"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signed in: the decisions about their content, under its heading, and the way home", async () => {
    signedIn();
    const [status, body] = routeAnswer("GET /api/moderation/appeals — one appealable");
    fetchMock.mockResolvedValueOnce({ ok: true, status, json: async () => body });
    render(<AccountClient />);
    const section = screen.getByRole("region", { name: "Decisions about your content" });
    expect(await within(section).findByTestId("decision-traj-1")).toBeInTheDocument();
    expect(screen.getByText("me@example.test")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "← Back to home" })).toHaveAttribute(
      "href",
      "/"
    );
  });
});

describe("sign out everywhere, from the account page (ADR-057 D6)", () => {
  const signedIn = () => {
    Object.assign(mockAuth, { user: { email: "a@b.c" }, isAuthenticated: true });
    // The decisions section beside it reads its own route: answered as that route answers.
    const [status, body] = routeAnswer("GET /api/moderation/appeals — one appealable");
    fetchMock.mockResolvedValue({ ok: true, status, json: async () => body });
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

describe("the home bar's way to the account page (TASK-210)", () => {
  it("a signed-in user: Your account, beside Sign Out", () => {
    signedIn();
    render(<HomeClient />);
    expect(screen.getByRole("link", { name: "Your account" })).toHaveAttribute(
      "href",
      "/account"
    );
    expect(screen.getByRole("button", { name: "Sign Out" })).toBeInTheDocument();
  });

  it("a guest: no account, so no link", () => {
    Object.assign(mockAuth, { isAuthenticated: true, isGuest: true });
    render(<HomeClient />);
    expect(screen.queryByRole("link", { name: "Your account" })).toBeNull();
  });
});
