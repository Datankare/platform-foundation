/**
 * @jest-environment jsdom
 */
/**
 * __tests__/admin-sign-in-return.test.tsx — the console's "Sign in" comes back to the console
 * (TASK-222, E-113)
 *
 * Someone who opens /admin without a session is offered "Sign in"; it went to plain /auth, and
 * sign-in then went home. It now names the console page — the section the address named
 * included — and the sign-in page returns there (platform/auth/return-path.ts). A refusal's own
 * "Sign in" link in a section (RefusalExtras) does the same; an erased account's does not.
 */
import React from "react";
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}));

import AdminPage from "@/app/admin/page";
import { RefusalExtras } from "@/components/admin/ui/RefusalExtras";
import { AuthContextProvider, resetSessionStateForTests } from "@/platform/auth/context";
import { handleRefusal } from "@/platform/errors/refusal";
import { renderMessage } from "@/platform/errors/messages";
import { routeAnswer } from "@/__tests__/fixtures/route-responses";

beforeEach(() => {
  mockPush.mockClear();
  resetSessionStateForTests();
});

it("E-113: the console's Sign in asks sign-in to come back to the console page", async () => {
  window.history.replaceState(null, "", "/admin?section=users");
  const [status, body] = routeAnswer("GET /api/auth/session — signed out");
  global.fetch = jest.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
  render(
    <AuthContextProvider>
      <AdminPage />
    </AuthContextProvider>
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: renderMessage("screens.admin_console.sign_in"),
    })
  );
  expect(mockPush).toHaveBeenCalledWith("/auth?redirect=%2Fadmin%3Fsection%3Dusers");
});

describe("E-113: a section's refusal links to sign-in", () => {
  it("coming back to this page, for an ended session", () => {
    window.history.replaceState(null, "", "/admin?section=audit");
    render(<RefusalExtras refusal={handleRefusal("auth.token_invalid")} />);
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/auth?redirect=%2Fadmin%3Fsection%3Daudit"
    );
  });

  it("to plain sign-in for an erased account", () => {
    window.history.replaceState(null, "", "/admin?section=audit");
    render(<RefusalExtras refusal={handleRefusal("account.not_found")} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/auth");
  });
});
