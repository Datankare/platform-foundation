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
    ["anonymous", 401, { code: "auth.required" }],
    ["a user without administrative access", 403, { code: "auth.permission_denied" }],
  ])("shows %s a sign-in prompt, and no console", async (_label, status, body) => {
    fetchMock.mockResolvedValue({ ok: false, status, json: async () => body });
    render(<AdminPage />);
    await waitFor(() =>
      expect(screen.getByText(/This page is for administrators/)).toBeInTheDocument()
    );
    expect(screen.queryByText("Administrator")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Sign in"));
    expect(push).toHaveBeenCalledWith("/auth");
  });

  // TASK-181: a refusal other than "no access" is shown as itself, never as the access page.
  it("a session that cannot be reached offers a retry, which asks again", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/admin/session")) throw new Error("offline");
      return { ok: false, status: 401, json: async () => ({ code: "auth.required" }) };
    });
    render(<AdminPage />);
    expect(await screen.findByText(/Unable to reach the server/)).toBeInTheDocument();
    expect(screen.queryByText(/This page is for administrators/)).toBeNull();
    const calls = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByText("Try again"));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(calls));
  });

  const refusedWith = (status: number, body: unknown) =>
    fetchMock.mockResolvedValue({ ok: false, status, json: async () => body });

  it("a restricted account sees its status and can sign out", async () => {
    refusedWith(403, {
      code: "account.restricted",
      message: "Your account cannot use this feature right now.",
      params: { feature: "admin", status: "suspended" },
    });
    render(<AdminPage />);
    expect(await screen.findByText(/cannot use this feature/)).toBeInTheDocument();
    expect(screen.getByText("Account status: suspended")).toBeInTheDocument();
    expect(screen.queryByText(/This page is for administrators/)).toBeNull();
    fireEvent.click(screen.getByText("Sign out"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/auth"));
  });

  it("a service that is down is unavailable, with a retry — not 'refused'", async () => {
    refusedWith(503, {
      code: "service.unavailable",
      message: "The permissions service is unavailable.",
      params: { service: "permissions" },
    });
    render(<AdminPage />);
    expect(
      await screen.findByText(/permissions service is unavailable/)
    ).toBeInTheDocument();
    expect(screen.getByText("Try again")).toBeInTheDocument();
    expect(screen.queryByText(/This page is for administrators/)).toBeNull();
  });

  it("an erased account's session ends, with sign-in showing why", async () => {
    refusedWith(403, { code: "account.not_found", message: "Not found." });
    render(<AdminPage />);
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/auth?error=account.not_found")
    );
    expect(signOut).toHaveBeenCalled();
  });
});
