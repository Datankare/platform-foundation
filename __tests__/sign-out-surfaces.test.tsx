/** @jest-environment jsdom */
/**
 * __tests__/sign-out-surfaces.test.tsx — a screen leaves for sign-in only once the session has
 * ended (TASK-219)
 *
 * Every sign-out a screen offers calls the auth context's signOut, which now resolves false when
 * the server did not end the session (the provider then says so, with "Sign out again"). A screen
 * that went to sign-in whatever it answered would show sign-in over a live session — the defect
 * of Playform's Deploy smoke run 43722206512. The home screen and the erased-account refusal are
 * checked here; the console's (app/admin/page.tsx) in e2e/sign-out.spec.ts.
 */
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";

const replace = jest.fn();
const push = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push, refresh: jest.fn() }),
  usePathname: () => "/",
}));
const signOut = jest.fn<Promise<boolean>, []>();
jest.mock("@/platform/auth/context", () => ({
  useAuth: () => ({
    user: { userId: "u1", email: "a@b.c", emailVerified: true, isGuest: false },
    isLoading: false,
    isAuthenticated: true,
    isGuest: false,
    session: { status: "signed-in" },
    signOut,
  }),
}));

import HomeClient from "@/app/HomeClient";
import { useRefusalSessionEnd } from "@/components/refusal/useRefusalSessionEnd";
import { SESSION_END_EVENT } from "@/platform/errors/refusal";

beforeEach(() => {
  replace.mockReset();
  push.mockReset();
  signOut.mockReset();
});

describe("the home screen's Sign out", () => {
  it.each([
    [true, ["/auth"]],
    [false, []],
  ] as const)("signOut resolving %s: to sign-in %j", async (ended, to) => {
    signOut.mockResolvedValue(ended);
    render(<HomeClient />);
    await act(async () => {
      screen.getByRole("button", { name: "Sign out" }).click();
    });
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(replace.mock.calls.map((c) => c[0])).toEqual(to);
  });

  it("signOut rejecting (SF-app-002): no unhandled rejection, and the page stays", async () => {
    signOut.mockRejectedValue(new Error("offline"));
    const unhandled = jest.fn();
    process.on("unhandledRejection", unhandled);
    render(<HomeClient />);
    await act(async () => {
      screen.getByRole("button", { name: "Sign out" }).click();
    });
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("an erased account's refusal signs out (useRefusalSessionEnd)", () => {
  function Screen() {
    useRefusalSessionEnd();
    return null;
  }
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent(SESSION_END_EVENT, { detail: { code: "account.not_found" } })
    );

  it("goes to sign-in with the code once the session has ended", async () => {
    signOut.mockResolvedValue(true);
    render(<Screen />);
    await act(async () => announce());
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/auth?error=account.not_found")
    );
  });

  it("stays when the sign-out did not happen, and tries again on the next refusal", async () => {
    signOut.mockResolvedValue(false);
    render(<Screen />);
    await act(async () => announce());
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(replace).not.toHaveBeenCalled();
    signOut.mockResolvedValue(true);
    await act(async () => announce());
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(2));
    expect(replace).toHaveBeenCalledWith("/auth?error=account.not_found");
  });
});
