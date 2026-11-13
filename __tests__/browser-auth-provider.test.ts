/**
 * @jest-environment jsdom
 */
/**
 * __tests__/browser-auth-provider.test.ts — the browser signs in through the server (PF v5.1.1)
 *
 * Every method with a route posts to it; every method without one answers a coded failure and
 * makes no request — never a fake success, never a call to a route that does not exist. Run in a
 * browser environment: the provider is browser code, and its calls go through apiFetch, which
 * sends the session cookie to this origin only.
 */

import { createBrowserAuthProvider } from "@/platform/auth/browser-auth-provider";
import { resetSessionStateForTests } from "@/platform/auth/context";

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock
    .mockReset()
    .mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  global.fetch = fetchMock as unknown as typeof fetch;
  resetSessionStateForTests();
});

const provider = () => createBrowserAuthProvider();

describe("methods with a route post to it", () => {
  it.each([
    [
      "signUp",
      () => provider().signUp("a@b.c", "pw"),
      "/api/auth/sign-up",
      { email: "a@b.c", password: "pw" },
    ],
    [
      "signIn",
      () => provider().signIn("a@b.c", "pw"),
      "/api/auth/sign-in",
      { email: "a@b.c", password: "pw" },
    ],
    [
      "forgotPassword",
      () => provider().forgotPassword("a@b.c"),
      "/api/auth/forgot-password",
      { email: "a@b.c" },
    ],
    [
      "confirmForgotPassword",
      () => provider().confirmForgotPassword("a@b.c", "123", "new"),
      "/api/auth/confirm-forgot-password",
      { email: "a@b.c", code: "123", newPassword: "new" },
    ],
    [
      "confirmEmailVerification",
      () => provider().confirmEmailVerification("a@b.c", "123"),
      "/api/auth/verify-email",
      { email: "a@b.c", code: "123" },
    ],
    [
      "resendEmailVerification",
      () => provider().resendEmailVerification("a@b.c"),
      "/api/auth/resend-verification",
      { email: "a@b.c" },
    ],
    [
      "respondToMfaChallenge",
      () => provider().respondToMfaChallenge("s", "123", "a@b.c"),
      "/api/auth/mfa-challenge",
      { session: "s", code: "123", username: "a@b.c" },
    ],
    [
      "respondToNewPasswordChallenge",
      () => provider().respondToNewPasswordChallenge("s", "new", "a@b.c"),
      "/api/auth/new-password-challenge",
      { session: "s", newPassword: "new", username: "a@b.c" },
    ],
  ])("%s", async (_name, call, path, body) => {
    await expect(call()).resolves.toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledWith(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // The session cookie goes with every call to this origin (apiFetch, ADR-057).
      credentials: "same-origin",
    });
  });

  it("createGuestToken posts with no body", async () => {
    await provider().createGuestToken();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/guest", {
      method: "POST",
      headers: {},
      body: undefined,
      credentials: "same-origin",
    });
  });

  it("signOut posts to the sign-out route with the cookie and no credential of its own (ADR-057)", async () => {
    await provider().signOut("tok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/sign-out");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    // The token a caller passes is never sent: the browser holds none to send.
    expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(
      /tok|[Aa]uthorization|Bearer/
    );
  });

  it("signOutEverywhere posts to its route; a refusal is a coded failure", async () => {
    await expect(provider().signOutEverywhere("user-1")).resolves.toEqual({
      success: true,
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/sign-out-everywhere");
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    await expect(provider().signOutEverywhere("user-1")).resolves.toEqual({
      success: false,
      errorCode: "service.unavailable",
    });
  });

  it("holds no token: nothing is verified or renewed from the browser", async () => {
    await expect(provider().verifyToken("t")).resolves.toBeNull();
    await expect(provider().refreshToken("r")).resolves.toBeNull();
    await expect(provider().renewSession("r", "u")).resolves.toEqual({ kind: "refused" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("methods without a route answer a coded failure and make no request", () => {
  it.each([
    ["changePassword", () => provider().changePassword("t", "old", "new")],
    ["setupMfa", () => provider().setupMfa("t")],
    ["verifyMfaSetup", () => provider().verifyMfaSetup("t", "123")],
    ["disableMfa", () => provider().disableMfa("t")],
    ["initiateSso", () => provider().initiateSso("google", "https://x/cb")],
    [
      "handleSsoCallback",
      () => provider().handleSsoCallback("google", "c", "https://x/cb"),
    ],
    ["forgetDevice", () => provider().forgetDevice("t", "d")],
    ["deleteUser", () => provider().deleteUser("t")],
  ])("%s", async (_name, call) => {
    await expect(call()).resolves.toMatchObject({
      success: false,
      errorCode: "feature.not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("verifies nothing itself: the server is the authority", async () => {
    expect(await provider().verifyToken("t")).toBeNull();
    expect(await provider().refreshToken("t")).toBeNull();
    expect(await provider().verifyGuestToken("t")).toEqual({ valid: false });
    expect(await provider().listDevices("t")).toEqual([]);
    expect(await provider().getUserInfo("t")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a failure is read from the status, not trusted from the body", () => {
  it("keeps a coded error's code", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ code: "auth.invalid_credentials", params: {} }),
    });
    await expect(provider().signIn("a@b.c", "wrong")).resolves.toMatchObject({
      success: false,
      errorCode: "auth.invalid_credentials",
    });
  });

  it("never reports success from a failing status, whatever the body says", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ success: true }) });
    await expect(provider().signIn("a@b.c", "pw")).resolves.toMatchObject({
      success: false,
      errorCode: "internal.error",
    });
  });

  it("answers a reply that is not JSON (a proxy's 502 page) as internal.error", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    await expect(provider().createGuestToken()).resolves.toMatchObject({
      success: false,
      errorCode: "internal.error",
    });
  });
});
