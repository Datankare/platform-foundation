/** @jest-environment jsdom */
/**
 * __tests__/sso-callback-client.test.tsx — where single sign-on goes when the provider returns
 * the browser (TASK-101, TASK-222)
 *
 * SF-app-048: cancelling at the provider is said as a cancellation. E-113: a completed sign-on
 * goes to the page the attempt was asked for — the callback route's `returnTo`, checked here
 * again as a page of this site.
 */
import React from "react";
import { render, waitFor } from "@testing-library/react";

const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace: mockReplace }) }));
const mockSessionStarted = jest.fn(async () => true);
jest.mock("@/platform/auth/context", () => ({
  ...jest.requireActual("@/platform/auth/context"),
  useAuth: () => ({ sessionStarted: mockSessionStarted }),
}));
const mockApiFetch = jest.fn();
jest.mock("@/platform/auth/api-fetch", () => ({
  apiFetch: (...a: unknown[]) => mockApiFetch(...a),
}));

import SsoCallbackClient, { backToSignIn } from "@/app/auth/callback/SsoCallbackClient";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";

beforeEach(() => {
  jest.clearAllMocks();
});

const at = async (search: string) => {
  window.history.replaceState(null, "", `/auth/callback${search}`);
  render(<SsoCallbackClient />);
  await waitFor(() => expect(mockReplace).toHaveBeenCalled());
  return mockReplace.mock.calls[0][0] as string;
};

const answers = (
  name: RouteFixtureName,
  edit?: (body: Record<string, unknown>) => void
) => {
  const [status, body] = routeAnswer(name) as [number, Record<string, unknown>];
  edit?.(body);
  mockApiFetch.mockResolvedValue({ ok: status < 400, status, json: async () => body });
};

describe("SsoCallbackClient", () => {
  it("SF-app-048: a cancellation at the provider returns as a cancellation, not a failure", async () => {
    expect(await at("?error=access_denied&error_description=user+cancelled")).toBe(
      "/auth?sso=cancelled"
    );
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("any other error from the provider is a failure", async () => {
    expect(await at("?error=server_error")).toBe("/auth?error=auth.sso_failed");
  });

  it("a missing code or state is a failure", async () => {
    expect(await at("?code=abc")).toBe("/auth?error=auth.sso_failed");
  });

  it("E-113: a completed sign-on goes to the page the attempt was asked for", async () => {
    answers("POST /api/auth/sso/callback — signed on, the page asked for answered");
    expect(await at("?code=abc&state=xyz")).toBe("/admin?section=users");
  });

  it("E-113: home when none was asked for", async () => {
    answers("POST /api/auth/sign-in — signed in");
    expect(await at("?code=abc&state=xyz")).toBe("/");
  });

  it("hostile:open-redirect — never to another site, whatever the answer says", async () => {
    answers(
      "POST /api/auth/sso/callback — signed on, the page asked for answered",
      (b) => {
        b.returnTo = "//evil.example/";
      }
    );
    expect(await at("?code=abc&state=xyz")).toBe("/");
  });

  it("a refused exchange returns with the refusal's code", async () => {
    answers("POST /api/auth/sign-in — refused (wrong password)");
    expect(await at("?code=abc&state=xyz")).toBe("/auth?error=auth.invalid_credentials");
  });

  it("builds the sign-in address it returns to", () => {
    expect(backToSignIn("https://x.test", { error: "auth.sso_failed" })).toBe(
      "/auth?error=auth.sso_failed"
    );
    expect(backToSignIn("https://x.test", { cancelled: true })).toBe(
      "/auth?sso=cancelled"
    );
  });
});
