/** @jest-environment jsdom */
/**
 * __tests__/auth-page-client.test.tsx — the sign-in page registers the browser provider and
 * never starts the server's providers in the browser (PF v5.1.1)
 */

import React from "react";
import { render, screen } from "@testing-library/react";

jest.mock("next/navigation", () => ({ useRouter: () => ({ replace: jest.fn() }) }));
jest.mock("@/platform/auth/auth-init", () => ({
  initAuth: () => {
    throw new Error("the server's providers must not start in the browser");
  },
}));
jest.mock("@/components/auth/AuthPage", () => ({
  __esModule: true,
  default: () => <div>sign-in form</div>,
}));

import AuthPageClient from "@/app/auth/AuthPageClient";
import { AuthContextProvider } from "@/platform/auth/context";
import { getAuthProvider, hasAuthProvider } from "@/platform/auth/config";

it("registers the browser provider on first render and shows the form", async () => {
  expect(hasAuthProvider()).toBe(false);
  render(
    <AuthContextProvider>
      <AuthPageClient />
    </AuthContextProvider>
  );
  expect(await screen.findByText("sign-in form")).toBeTruthy();
  const fetchMock = jest
    .fn()
    .mockResolvedValue({ json: async () => ({ success: false }) });
  global.fetch = fetchMock as unknown as typeof fetch;
  await getAuthProvider().signIn("a@b.c", "pw");
  expect(fetchMock).toHaveBeenCalledWith("/api/auth/sign-in", expect.any(Object));
});
