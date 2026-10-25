/**
 * @jest-environment jsdom
 */
/**
 * __tests__/auth-context-hydration.test.tsx
 *
 * Stale-session hydration guard (Phase 4 close fix).
 *
 * The pf_has_session cookie (max-age 3600) and localStorage tokens expire on
 * different clocks. Hydrating a stale token leaves middleware (no cookie ->
 * /auth) and the client (isAuthenticated -> leave /auth) in permanent
 * disagreement: blank auth page. Found via a 51-day-old guest token.
 *
 * Contract pinned here:
 *  1. Stale guest_<id>_<ts> token -> purged, starts signed-out.
 *  2. Expired JWT (exp in the past) -> renewed from the server's refresh cookie
 *     (POST /api/auth/refresh, audit A-14), else purged and signed out.
 *  3. Valid session -> hydrates AND re-issues the pf_has_session cookie.
 *  4. Undeterminable token -> hydrates (server remains the authority).
 */

import React from "react";
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthContextProvider, useAuth } from "@/platform/auth/context";

function Probe() {
  const { user, isLoading, isAuthenticated } = useAuth();
  if (isLoading) return <div>loading</div>;
  return (
    <div>
      <span data-testid="authed">{String(isAuthenticated)}</span>
      <span data-testid="userid">{user?.userId ?? "none"}</span>
    </div>
  );
}

function b64(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

function makeJwt(payload: Record<string, unknown>): string {
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

const USER_JSON = JSON.stringify({
  userId: "user-1",
  email: "t@example.com",
  emailVerified: true,
  isGuest: false,
});
const GUEST_JSON = JSON.stringify({
  userId: "guest-1",
  email: "",
  emailVerified: false,
  isGuest: true,
});

function seed(token: string, userJson: string) {
  localStorage.setItem("pf_access_token", token);
  localStorage.setItem("pf_user", userJson);
}

beforeEach(() => {
  localStorage.clear();
  document.cookie = "pf_has_session=; path=/; max-age=0";
});

describe("auth context hydration validity", () => {
  it("purges a stale guest_<id>_<ts> token instead of hydrating it", async () => {
    const fiftyOneDaysAgo = Date.now() - 51 * 86_400_000;
    seed(`guest_abc-def_${fiftyOneDaysAgo}`, GUEST_JSON);

    render(
      <AuthContextProvider>
        <Probe />
      </AuthContextProvider>
    );

    await waitFor(() => expect(screen.getByTestId("authed")).toHaveTextContent("false"));
    expect(localStorage.getItem("pf_access_token")).toBeNull();
    expect(localStorage.getItem("pf_user")).toBeNull();
    expect(document.cookie).not.toContain("pf_has_session=true");
  });

  it("purges an expired JWT when the server cannot renew it", async () => {
    seed(makeJwt({ sub: "user-1", exp: Math.floor(Date.now() / 1000) - 60 }), USER_JSON);
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ code: "auth.token_invalid" }),
    }) as unknown as typeof fetch;

    render(
      <AuthContextProvider>
        <Probe />
      </AuthContextProvider>
    );

    await waitFor(() => expect(screen.getByTestId("authed")).toHaveTextContent("false"));
    expect(localStorage.getItem("pf_access_token")).toBeNull();
  });

  it("renews an expired user session from the refresh cookie (audit A-14)", async () => {
    seed(makeJwt({ sub: "user-1", exp: Math.floor(Date.now() / 1000) - 60 }), USER_JSON);
    const fresh = makeJwt({ sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3600 });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, userId: "user-1", accessToken: fresh }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(
      <AuthContextProvider>
        <Probe />
      </AuthContextProvider>
    );

    await waitFor(() => expect(screen.getByTestId("authed")).toHaveTextContent("true"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/refresh",
      expect.objectContaining({ method: "POST", credentials: "same-origin" })
    );
    expect(localStorage.getItem("pf_access_token")).toBe(fresh);
  });

  it("refuses a renewed session for another user", async () => {
    seed(makeJwt({ sub: "user-1", exp: Math.floor(Date.now() / 1000) - 60 }), USER_JSON);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, userId: "someone-else", accessToken: "x.y.z" }),
    }) as unknown as typeof fetch;

    render(
      <AuthContextProvider>
        <Probe />
      </AuthContextProvider>
    );

    await waitFor(() => expect(screen.getByTestId("authed")).toHaveTextContent("false"));
    expect(localStorage.getItem("pf_access_token")).toBeNull();
  });

  it("hydrates a fresh guest token and re-issues the session cookie", async () => {
    seed(`guest_abc-def_${Date.now() - 1000}`, GUEST_JSON);

    render(
      <AuthContextProvider>
        <Probe />
      </AuthContextProvider>
    );

    await waitFor(() => expect(screen.getByTestId("authed")).toHaveTextContent("true"));
    expect(screen.getByTestId("userid")).toHaveTextContent("guest-1");
    expect(document.cookie).toContain("pf_has_session=true");
  });

  it("hydrates a valid unexpired JWT and re-issues the session cookie", async () => {
    seed(
      makeJwt({ sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3600 }),
      USER_JSON
    );

    render(
      <AuthContextProvider>
        <Probe />
      </AuthContextProvider>
    );

    await waitFor(() => expect(screen.getByTestId("authed")).toHaveTextContent("true"));
    expect(document.cookie).toContain("pf_has_session=true");
  });

  it("hydrates an undeterminable token (server remains the authority)", async () => {
    seed("opaque-mock-token", USER_JSON);

    render(
      <AuthContextProvider>
        <Probe />
      </AuthContextProvider>
    );

    await waitFor(() => expect(screen.getByTestId("authed")).toHaveTextContent("true"));
  });
});
