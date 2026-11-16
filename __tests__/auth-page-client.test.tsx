/** @jest-environment jsdom */
/**
 * __tests__/auth-page-client.test.tsx — the sign-in page registers the browser provider and
 * never starts the server's providers in the browser (PF v5.1.1); where it goes once signed in:
 * __tests__/auth-page-client-return.test.tsx (TASK-222, E-113)
 */

import React from "react";
import { render, screen } from "@testing-library/react";

const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock("@/platform/auth/auth-init", () => ({
  initAuth: () => {
    throw new Error("the server's providers must not start in the browser");
  },
}));
const mockAuthPage = jest.fn((props: { ssoProviders?: string[] }) => (
  <div>sign-in form {(props.ssoProviders ?? []).join(",")}</div>
));
jest.mock("@/components/auth/AuthPage", () => ({
  __esModule: true,
  default: (props: { ssoProviders?: string[] }) => mockAuthPage(props),
}));

import AuthPageClient from "@/app/auth/AuthPageClient";
import { AuthContextProvider } from "@/platform/auth/context";
import { getAuthProvider, hasAuthProvider } from "@/platform/auth/config";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";

function answerWith(name: RouteFixtureName) {
  const [status, body] = routeAnswer(name);
  global.fetch = jest.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  mockReplace.mockClear();
  window.history.replaceState(null, "", "/auth");
});

it("registers the browser provider on first render and shows the form", async () => {
  expect(hasAuthProvider()).toBe(false);
  // The page's first read of its session: the server says no one is signed in.
  answerWith("GET /api/auth/session — signed out");
  render(
    <AuthContextProvider>
      <AuthPageClient ssoProviders={["google"]} />
    </AuthContextProvider>
  );
  expect(await screen.findByText("sign-in form google")).toBeTruthy();
  const [status, body] = routeAnswer("POST /api/auth/sign-in — refused (wrong password)");
  const fetchMock = jest
    .fn()
    .mockResolvedValue({ ok: status < 400, status, json: async () => body });
  global.fetch = fetchMock as unknown as typeof fetch;
  await getAuthProvider().signIn("a@b.c", "pw");
  expect(fetchMock).toHaveBeenCalledWith("/api/auth/sign-in", expect.any(Object));
});
