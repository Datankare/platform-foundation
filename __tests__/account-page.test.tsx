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
import { render, screen, within } from "@testing-library/react";
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
