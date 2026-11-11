/**
 * @jest-environment jsdom
 */
/**
 * app/admin — the console decides what to show from the server's answer (audit B-14): someone
 * the session route refuses sees a sign-in prompt, not the console shell under an
 * "Administrator" label.
 */
import React from "react";
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const push = jest.fn();
const replace = jest.fn();
const signOut = jest.fn(async () => undefined);
jest.mock("next/navigation", () => ({ useRouter: () => ({ push, replace }) }));
jest.mock("@/platform/auth/context", () => ({
  ...jest.requireActual("@/platform/auth/context"),
  useAuth: () => ({ signOut }),
}));

import AdminPage from "@/app/admin/page";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";

/** The session route's own answer (__tests__/fixtures/route-responses.json), as fetch resolves it. */
const answer = (name: RouteFixtureName) => {
  const [status, body] = routeAnswer(name);
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  push.mockReset();
  replace.mockReset();
  signOut.mockClear();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("admin console when the session is refused (B-14)", () => {
  it.each([
    ["anonymous", "GET /api/admin/session — refused (signed out)"],
    [
      "a user without administrative access",
      "GET /api/admin/session — refused (no administrative access)",
    ],
  ] as [string, RouteFixtureName][])(
    "shows %s a sign-in prompt, and no console",
    async (_label, name) => {
      fetchMock.mockResolvedValue(answer(name));
      render(<AdminPage />);
      await waitFor(() =>
        expect(screen.getByText(/This page is for administrators/)).toBeInTheDocument()
      );
      expect(screen.queryByText("Administrator")).not.toBeInTheDocument();
      fireEvent.click(screen.getByText("Sign in"));
      expect(push).toHaveBeenCalledWith("/auth");
    }
  );

  // TASK-181: a refusal other than "no access" is shown as itself, never as the access page.
  it("a session that cannot be reached offers a retry, which asks again", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/admin/session")) throw new Error("offline");
      return answer("GET /api/admin/session — refused (signed out)");
    });
    render(<AdminPage />);
    expect(await screen.findByText(/Unable to reach the server/)).toBeInTheDocument();
    expect(screen.queryByText(/This page is for administrators/)).toBeNull();
    const calls = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByText("Try again"));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(calls));
  });

  const refusedWith = (name: RouteFixtureName) =>
    fetchMock.mockResolvedValue(answer(name));

  it("a restricted account sees its status and can sign out", async () => {
    refusedWith("GET /api/admin/session — refused (a suspended staff account)");
    render(<AdminPage />);
    expect(await screen.findByText(/cannot use this feature/)).toBeInTheDocument();
    expect(screen.queryByText(/This page is for administrators/)).toBeNull();
    fireEvent.click(screen.getByText("Sign out"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/auth"));
  });

  it("a service that is down is unavailable, with a retry — not 'refused'", async () => {
    refusedWith("GET /api/admin/session — the permissions store down");
    render(<AdminPage />);
    expect(await screen.findByText(/unavailable right now/)).toBeInTheDocument();
    expect(screen.getByText("Try again")).toBeInTheDocument();
    expect(screen.queryByText(/This page is for administrators/)).toBeNull();
  });
});
