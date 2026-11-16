/** @jest-environment jsdom */
/**
 * __tests__/auth-page-client-return.test.tsx — signed in, the sign-in page goes on to the page
 * asked for, a page of this site only (TASK-222, E-113: it always went to /)
 *
 * hostile:open-redirect: another site, by any spelling, and the sign-in page itself, are never
 * where it goes (platform/auth/return-path.ts; every spelling: __tests__/return-path.test.ts).
 */

import React from "react";
import { render, screen } from "@testing-library/react";

const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace: mockReplace }) }));
const mockAuth = { isLoading: false, isAuthenticated: true };
jest.mock("@/platform/auth/context", () => ({
  ...jest.requireActual("@/platform/auth/context"),
  useAuth: () => mockAuth,
}));
jest.mock("@/components/auth/AuthPage", () => ({
  __esModule: true,
  default: () => <div>sign-in form</div>,
}));

import AuthPageClient from "@/app/auth/AuthPageClient";

const wentTo = (address: string): string => {
  mockReplace.mockClear();
  window.history.replaceState(null, "", address);
  const { unmount } = render(<AuthPageClient />);
  unmount();
  expect(mockReplace).toHaveBeenCalledTimes(1);
  return mockReplace.mock.calls[0][0] as string;
};

describe("E-113: signed in, the sign-in page goes where it was asked to", () => {
  it("to the page asked for", () => {
    expect(wentTo("/auth?redirect=%2Fagent%2Fauthorize%3Frequest%3Dabc")).toBe(
      "/agent/authorize?request=abc"
    );
    expect(wentTo("/auth?redirect=%2Fadmin%3Fsection%3Dusers&view=create-account")).toBe(
      "/admin?section=users"
    );
  });

  it("home when none is asked for", () => {
    expect(wentTo("/auth")).toBe("/");
  });

  it.each([
    "/auth?redirect=https%3A%2F%2Fevil.example%2F",
    "/auth?redirect=%2F%2Fevil.example%2F",
    "/auth?redirect=%2F%5Cevil.example",
    "/auth?redirect=javascript%3Aalert(1)",
  ])("home when the page asked for is another site's: %s", (address) => {
    expect(wentTo(address)).toBe("/");
  });

  it("home when the page asked for is the sign-in page itself", () => {
    expect(wentTo("/auth?redirect=%2Fauth%3Fview%3Dtwo-step")).toBe("/");
  });
});

describe("SF-app-003 (sign-in): while the session is read", () => {
  it("the wait is on the sign-in page's own dark page, its line a status", () => {
    mockAuth.isLoading = true;
    mockReplace.mockClear();
    try {
      render(<AuthPageClient />);
      const status = screen.getByRole("status");
      expect(status.closest("main")?.className).toMatch(/bg-\[#0a0f1e\]/);
      expect(mockReplace).not.toHaveBeenCalledWith(expect.anything());
    } finally {
      mockAuth.isLoading = false;
    }
  });
});
