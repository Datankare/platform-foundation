/**
 * @jest-environment jsdom
 */
/**
 * app/admin — the console's own "Sign Out" ends the session (TASK-184; pre-existing). It left for
 * "/" with a full load and nothing else: the access token and the user stayed in storage, the
 * refresh cookie stayed live, and the next page was still signed in. Now it calls the auth
 * context's signOut — the server's sign-out with the access token, then the stored session
 * forgotten — and only then leaves for /auth. Run with the real AuthContextProvider.
 */
import React from "react";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
const leaveConsole = jest.fn();
jest.mock("@/components/admin/leave-console", () => ({
  leaveConsole: (path: string) => leaveConsole(path),
}));

import AdminPage from "@/app/admin/page";
import { AuthContextProvider, resetSessionStateForTests } from "@/platform/auth/context";
import {
  CSRF_TOKEN,
  routeAnswer,
  type RouteFixtureName,
} from "@/__tests__/fixtures/route-responses";

const TOKEN = "staff-access-token";
const fetchMock = jest.fn();
type Call = [unknown, RequestInit | undefined];
const signOutCalls = () =>
  (fetchMock.mock.calls as Call[]).filter(([u]) => String(u) === "/api/auth/sign-out");

/** A route's own answer (__tests__/fixtures/route-responses.json), as fetch resolves it. */
const json = (name: RouteFixtureName) => {
  const [status, body] = routeAnswer(name);
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};

/** The server: a moderator's session, its Approvals, and sign-out answered by `signOutAnswer`. */
function serve(signOutAnswer: () => Promise<unknown>) {
  fetchMock.mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u === "/api/auth/sign-out") return signOutAnswer();
    // The page reads who is signed in from the server (ADR-057): a signed-in browser.
    if (u === "/api/auth/session") return json("GET /api/auth/session — signed in");
    if (u.startsWith("/api/admin/session"))
      return json("GET /api/admin/session — a moderator");
    if (u.startsWith("/api/admin/approvals"))
      return json("GET /api/admin/approvals — none held");
    throw new Error(`unexpected request: ${u}`);
  });
}

/** What a sign-in before ADR-057 left in the browser: removed on the first load, never used. */
function legacyStorage() {
  localStorage.setItem("pf_access_token", TOKEN);
  localStorage.setItem(
    "pf_user",
    JSON.stringify({
      userId: "u1",
      email: "staff@example.com",
      emailVerified: true,
      isGuest: false,
    })
  );
  localStorage.setItem("pf_refresh_token", "legacy-refresh");
}

const stored = () => [
  localStorage.getItem("pf_access_token"),
  localStorage.getItem("pf_user"),
  localStorage.getItem("pf_refresh_token"),
];

async function openConsole() {
  render(
    <AuthContextProvider>
      <AdminPage />
    </AuthContextProvider>
  );
  return screen.findByRole("button", { name: "Sign out" });
}

beforeEach(() => {
  fetchMock.mockReset();
  leaveConsole.mockReset();
  localStorage.clear();
  resetSessionStateForTests();
  global.fetch = fetchMock as unknown as typeof fetch;
  legacyStorage();
});

describe("the console's Sign Out ends the session (TASK-184)", () => {
  it("calls the server's sign-out with the session's forgery token and no credential of its own, then leaves for /auth", async () => {
    serve(async () => json("POST /api/auth/sign-out — signed out"));
    fireEvent.click(await openConsole());
    await waitFor(() => expect(leaveConsole).toHaveBeenCalledWith("/auth"));
    expect(signOutCalls()).toHaveLength(1);
    const [, init] = signOutCalls()[0];
    expect(init?.method).toBe("POST");
    // The session is the browser's HttpOnly cookie: the page sends the forgery token, no bearer.
    const headers = new Headers(init?.headers);
    expect(headers.get("x-csrf-token")).toBe(CSRF_TOKEN);
    expect(headers.get("authorization")).toBeNull();
    expect(init?.credentials).toBe("same-origin");
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(TOKEN);
    expect(stored()).toEqual([null, null, null]);
    expect(document.cookie).toBe("");
    expect(leaveConsole).toHaveBeenCalledTimes(1);
    expect(leaveConsole).not.toHaveBeenCalledWith("/");
  });

  it("does not leave before the server's sign-out has answered", async () => {
    let answer: (v: unknown) => void = () => undefined;
    serve(() => new Promise((resolve) => (answer = resolve)));
    fireEvent.click(await openConsole());
    await waitFor(() => expect(signOutCalls()).toHaveLength(1));
    await act(async () => await Promise.resolve());
    expect(leaveConsole).not.toHaveBeenCalled();
    await act(async () => answer(json("POST /api/auth/sign-out — signed out")));
    await waitFor(() => expect(leaveConsole).toHaveBeenCalledWith("/auth"));
    expect(stored()).toEqual([null, null, null]);
  });

  it.each([
    ["unreachable", () => Promise.reject(new Error("offline"))],
    ["answering 500", async () => json("POST /api/auth/sign-out — the provider failing")],
  ])(
    "with the server's sign-out %s, the session still ends here and the console leaves for /auth",
    async (_label, answer) => {
      serve(answer);
      fireEvent.click(await openConsole());
      await waitFor(() => expect(leaveConsole).toHaveBeenCalledWith("/auth"));
      expect(stored()).toEqual([null, null, null]);
      expect(document.cookie).toBe("");
    }
  );
});
