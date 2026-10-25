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
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
jest.mock("@/platform/auth/context", () => ({
  ...jest.requireActual("@/platform/auth/context"),
  useAuth: () => ({ signOut: jest.fn(async () => undefined) }),
}));

import AdminPage from "@/app/admin/page";

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  push.mockReset();
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

  it("a session that cannot be read is refused too", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/admin/session")) throw new Error("offline");
      return { ok: false, status: 401, json: async () => ({ code: "auth.required" }) };
    });
    render(<AdminPage />);
    await waitFor(() =>
      expect(screen.getByText(/This page is for administrators/)).toBeInTheDocument()
    );
  });
});
