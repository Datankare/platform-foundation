/** @jest-environment jsdom */
/**
 * __tests__/auth-context.test.tsx — the page's view of its session (platform/auth/context.tsx,
 * ADR-057)
 *
 * The page holds no credential: who is signed in comes from GET /api/auth/session, kept in
 * memory. Covered here: the first read; sign-in, sign-out and sign-out everywhere; "stay signed
 * in"; an outage; and the move of a browser signed in before ADR-057 — what it kept in storage
 * is deleted unread, and the server exchanges its httpOnly legacy cookie for a session.
 *
 * Hostile: a legacy token left in storage that says who is signed in (never believed); a session
 * answer of the wrong shape; a server that cannot answer; the migration refused.
 */

import React from "react";
import { renderToString } from "react-dom/server";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import {
  AuthContextProvider,
  currentSession,
  loadSession,
  noteCsrfToken,
  noteSessionEnded,
  resetSessionStateForTests,
  useAuth,
} from "@/platform/auth/context";
import { removeLegacyStoredSession } from "@/platform/auth/legacy-session-cleanup";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly credentials?: string;
}
const calls: Call[] = [];
type Handler = (call: Call) => { status?: number; body?: unknown } | "network-error";
let handler: Handler;

const signedInBody = (over: Record<string, unknown> = {}) => ({
  authenticated: true,
  user: { userId: "u1", email: "a@b.c", emailVerified: true, isGuest: false },
  csrfToken: "csrf-1",
  audience: "user",
  idleExpiresAt: Date.now() + 3_600_000,
  absoluteExpiresAt: Date.now() + 86_400_000,
  idleWarningSeconds: 120,
  ...over,
});

/** A failed first read is asked again after these waits (1 ms here: the suite does not wait them out). */
const QUICK = { firstReadRetryMs: [1, 1] } as const;

beforeEach(() => {
  calls.length = 0;
  resetSessionStateForTests(QUICK);
  localStorage.clear();
  sessionStorage.clear();
  handler = () => ({ body: { authenticated: false } });
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      credentials: init?.credentials,
    };
    calls.push(call);
    const answer = handler(call);
    if (answer === "network-error") throw new TypeError("Failed to fetch");
    const status = answer.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => answer.body,
    } as Response;
  }) as unknown as typeof fetch;
});

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AuthContextProvider>{children}</AuthContextProvider>
);

async function mounted() {
  const hook = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  return hook;
}

describe("useAuth outside the provider", () => {
  it("throws", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => useAuth())).toThrow(
      "useAuth must be used within an AuthContextProvider"
    );
    spy.mockRestore();
  });
});

describe("the first read", () => {
  it("is loading until the server answers, then signed out", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.user).toBeNull();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAuthenticated).toBe(false);
    expect(calls).toEqual([
      expect.objectContaining({
        url: "/api/auth/session",
        method: "GET",
        credentials: "same-origin",
      }),
    ]);
  });

  it("signed in: the user is the server's answer", async () => {
    handler = () => ({ body: signedInBody() });
    const { result } = await mounted();
    expect(result.current.user).toEqual({
      userId: "u1",
      email: "a@b.c",
      emailVerified: true,
      isGuest: false,
    });
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.isGuest).toBe(false);
    expect(result.current.session).toMatchObject({
      status: "signed-in",
      audience: "user",
    });
  });

  it("a guest", async () => {
    handler = () => ({
      body: signedInBody({
        user: { userId: "guest_x", email: "", emailVerified: false, isGuest: true },
        audience: "guest",
        idleExpiresAt: null,
      }),
    });
    const { result } = await mounted();
    expect(result.current.isGuest).toBe(true);
    expect(result.current.session).toMatchObject({
      audience: "guest",
      idleExpiresAt: null,
    });
  });

  it("the context exposes no token and no way to get one", async () => {
    handler = () => ({ body: signedInBody() });
    const { result } = await mounted();
    const value = result.current as unknown as Record<string, unknown>;
    expect(value.accessToken).toBeUndefined();
    expect(value.getAccessToken).toBeUndefined();
    expect(value.setSession).toBeUndefined();
    expect(JSON.stringify(result.current.session)).not.toMatch(
      /accessToken|refreshToken/
    );
  });

  it("nothing about the session is written to storage or a cookie", async () => {
    handler = () => ({ body: signedInBody() });
    const setItem = jest.spyOn(Storage.prototype, "setItem");
    await mounted();
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    setItem.mockRestore();
  });

  it.each([
    ["not an object", "nope"],
    [
      "authenticated without a user",
      { authenticated: true, csrfToken: "c", absoluteExpiresAt: 1 },
    ],
    [
      "no forgery token",
      { authenticated: true, user: { userId: "u" }, absoluteExpiresAt: 1 },
    ],
    ["a user id that is not text", { ...signedInBody(), user: { userId: 7 } }],
    ["no expiry", { ...signedInBody(), absoluteExpiresAt: "soon" }],
    ["null", null],
  ])(
    "hostile: an answer of the wrong shape (%s) is not a session",
    async (_name, body) => {
      handler = () => ({ body });
      const { result } = await mounted();
      expect(result.current.isAuthenticated).toBe(false);
    }
  );

  it("the server cannot answer: signed out here, never a made-up session", async () => {
    handler = () => "network-error";
    const { result } = await mounted();
    expect(result.current.isAuthenticated).toBe(false);
    handler = () => ({ status: 503, body: { code: "service.unavailable" } });
    resetSessionStateForTests(QUICK);
    const again = await mounted();
    expect(again.result.current.isAuthenticated).toBe(false);
  });

  // A signed-in person loading a page must not be shown the sign-in form because one read was
  // refused for the moment (a limit), failed on the server or was lost on the network.
  it.each([
    ["refused for now (429)", () => ({ status: 429, body: { code: "rate.limited" } })],
    [
      "a server error (503)",
      () => ({ status: 503, body: { code: "service.unavailable" } }),
    ],
    ["the network", () => "network-error" as const],
  ])(
    "a first read that fails — %s — is asked again, and the session is found",
    async (_l, failure) => {
      let n = 0;
      handler = () => (++n === 1 ? failure() : { body: signedInBody() });
      const { result } = await mounted();
      expect(result.current.isAuthenticated).toBe(true);
      expect(calls.filter((c) => c.url === "/api/auth/session")).toHaveLength(2);
    }
  );

  it("asked three times at most, with the waits between; then signed out — no loop", async () => {
    handler = () => ({ status: 503, body: { code: "service.unavailable" } });
    const { result } = await mounted();
    expect(result.current.isAuthenticated).toBe(false);
    expect(calls.filter((c) => c.url === "/api/auth/session")).toHaveLength(3);
    // The waits themselves (the default: a quarter of a second, then three quarters).
    resetSessionStateForTests({ firstReadRetryMs: [40, 40] });
    calls.length = 0;
    const started = Date.now();
    await mounted();
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(calls).toHaveLength(3);
  });

  it("hostile: a refusal that is an answer (403) is not asked again", async () => {
    handler = () => ({ status: 403, body: { code: "account.restricted" } });
    const { result } = await mounted();
    expect(result.current.isAuthenticated).toBe(false);
    expect(calls.filter((c) => c.url === "/api/auth/session")).toHaveLength(1);
  });

  it("a page already signed in is not signed out, nor asked again, by a failed later read", async () => {
    handler = () => ({ body: signedInBody() });
    const { result } = await mounted();
    calls.length = 0;
    handler = () => ({ status: 429, body: { code: "rate.limited" } });
    await act(async () => {
      await loadSession();
    });
    expect(result.current.isAuthenticated).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("two providers on one page share one read", async () => {
    handler = () => ({ body: signedInBody() });
    function Name() {
      return <span>{useAuth().user?.email ?? "-"}</span>;
    }
    render(
      <>
        <AuthContextProvider>
          <Name />
        </AuthContextProvider>
        <AuthContextProvider>
          <Name />
        </AuthContextProvider>
      </>
    );
    await waitFor(() => expect(screen.getAllByText("a@b.c")).toHaveLength(2));
    expect(calls.filter((c) => c.url === "/api/auth/session")).toHaveLength(1);
  });
});

describe("on the server", () => {
  it("renders loading, reads no storage and calls nothing, so hydration agrees", () => {
    const getItem = jest.spyOn(Storage.prototype, "getItem");
    function Probe() {
      const { isLoading, user } = useAuth();
      return <span>{isLoading ? "loading" : user ? "signed-in" : "signed-out"}</span>;
    }
    const html = renderToString(
      <AuthContextProvider>
        <Probe />
      </AuthContextProvider>
    );
    expect(html).toContain("loading");
    expect(getItem).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    getItem.mockRestore();
  });
});

describe("after a sign-in step", () => {
  it("sessionStarted reads the new session from the server", async () => {
    const { result } = await mounted();
    handler = () => ({ body: signedInBody() });
    let started = false;
    await act(async () => {
      started = await result.current.sessionStarted();
    });
    expect(started).toBe(true);
    expect(result.current.user?.userId).toBe("u1");
  });

  it("sessionStarted is false when the server knows no session (the cookie was not set)", async () => {
    const { result } = await mounted();
    let started = true;
    await act(async () => {
      started = await result.current.sessionStarted();
    });
    expect(started).toBe(false);
    expect(result.current.isAuthenticated).toBe(false);
  });
});

describe("sign-out", () => {
  it.each([
    ["signOut", "/api/auth/sign-out"],
    ["signOutEverywhere", "/api/auth/sign-out-everywhere"],
  ] as const)(
    "%s posts with the session's forgery token, then forgets the session",
    async (method, url) => {
      handler = () => ({ body: signedInBody() });
      const { result } = await mounted();
      calls.length = 0;
      handler = () => ({ body: { success: true } });
      await act(async () => {
        await result.current[method]();
      });
      expect(calls).toEqual([
        expect.objectContaining({
          url,
          method: "POST",
          credentials: "same-origin",
          headers: { "x-csrf-token": "csrf-1" },
        }),
      ]);
      expect(result.current.user).toBeNull();
      expect(currentSession().status).toBe("signed-out");
    }
  );

  it("sign-out everywhere says whether the server did it — and never claims a sign-out that did not happen", async () => {
    for (const [failure, done] of [
      [() => ({ status: 500, body: { code: "internal.error" } }), false],
      [() => ({ status: 403, body: { code: "auth.csrf_failed" } }), false],
      [() => ({ status: 200, body: {} }), false],
      [() => "network-error" as const, false],
      // The session had already ended on the server: nothing is left to end from here.
      [() => ({ status: 401, body: { code: "auth.token_invalid" } }), true],
      [() => ({ status: 200, body: { success: true, sessionsEnded: 2 } }), true],
    ] as const) {
      resetSessionStateForTests(QUICK);
      handler = () => ({ body: signedInBody() });
      const { result, unmount } = await mounted();
      handler = failure;
      let answered: boolean | undefined;
      await act(async () => {
        answered = await result.current.signOutEverywhere();
      });
      expect(answered).toBe(done);
      // Not done: the person is still signed in here, and can try again.
      expect(result.current.isAuthenticated).toBe(!done);
      unmount();
    }
  });

  it("the session is forgotten here whatever the server answers, or if it cannot be reached", async () => {
    for (const failure of [
      () => ({ status: 500, body: { code: "internal.error" } }),
      () => "network-error" as const,
    ]) {
      resetSessionStateForTests(QUICK);
      handler = () => ({ body: signedInBody() });
      const { result, unmount } = await mounted();
      handler = failure;
      await act(async () => {
        await result.current.signOut();
      });
      expect(result.current.user).toBeNull();
      unmount();
    }
  });
});

describe("stay signed in", () => {
  it("posts with the forgery token and takes the server's new idle limit", async () => {
    const soon = Date.now() + 60_000;
    handler = () => ({ body: signedInBody({ audience: "staff", idleExpiresAt: soon }) });
    const { result } = await mounted();
    const later = Date.now() + 1_800_000;
    calls.length = 0;
    handler = () => ({ body: signedInBody({ audience: "staff", idleExpiresAt: later }) });
    let alive = false;
    await act(async () => {
      alive = await result.current.staySignedIn();
    });
    expect(alive).toBe(true);
    expect(calls[0]).toMatchObject({
      url: "/api/auth/session",
      method: "POST",
      headers: { "x-csrf-token": "csrf-1" },
    });
    expect(result.current.session).toMatchObject({ idleExpiresAt: later });
  });

  it("a network failure keeps the session held; the next read decides", async () => {
    handler = () => ({ body: signedInBody() });
    const { result } = await mounted();
    handler = () => "network-error";
    let alive = false;
    await act(async () => {
      alive = await result.current.staySignedIn();
    });
    expect(alive).toBe(true);
    expect(result.current.isAuthenticated).toBe(true);
  });
});

describe("what the transport tells the page", () => {
  it("a session the server says has ended is forgotten", async () => {
    handler = () => ({ body: signedInBody() });
    const { result } = await mounted();
    act(() => noteSessionEnded());
    expect(result.current.isAuthenticated).toBe(false);
  });

  it("a factor change's new forgery token replaces the one held", async () => {
    handler = () => ({ body: signedInBody() });
    const { result } = await mounted();
    act(() => noteCsrfToken("csrf-2"));
    expect(result.current.session).toMatchObject({ csrfToken: "csrf-2" });
    act(() => noteCsrfToken(""));
    expect(result.current.session).toMatchObject({ csrfToken: "csrf-2" });
  });
});

describe("a browser signed in before ADR-057 (TASK-214)", () => {
  const legacy = () => {
    localStorage.setItem("pf_access_token", "legacy-access-token");
    localStorage.setItem("pf_refresh_token", "legacy-refresh-token");
    localStorage.setItem(
      "pf_user",
      JSON.stringify({ userId: "attacker-chosen", email: "x@y.z", emailVerified: true })
    );
    localStorage.setItem("unrelated", "kept");
  };

  it("its stored token is deleted unread, and the server moves its session: no new sign-in", async () => {
    legacy();
    const getItem = jest.spyOn(Storage.prototype, "getItem");
    let migrated = false;
    handler = (call) => {
      if (call.url === "/api/auth/session/migrate") {
        migrated = true;
        return { body: { success: true, userId: "u1", migrated: true } };
      }
      return { body: migrated ? signedInBody() : { authenticated: false } };
    };
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    // Never read: a value script could read is not trusted to say who is signed in.
    expect(getItem).not.toHaveBeenCalled();
    expect(localStorage.getItem("pf_access_token")).toBeNull();
    expect(localStorage.getItem("pf_refresh_token")).toBeNull();
    expect(localStorage.getItem("pf_user")).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("kept");
    // The user is the server's, not the stored profile's.
    expect(result.current.user?.userId).toBe("u1");
    // The stored token is sent nowhere.
    expect(JSON.stringify(calls)).not.toContain("legacy-access-token");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/auth/session",
      "POST /api/auth/session/migrate",
      "GET /api/auth/session",
    ]);
    getItem.mockRestore();
  });

  it("the migration refused (no legacy cookie, or the provider refuses it): signed out, storage clean", async () => {
    legacy();
    handler = (call) =>
      call.url === "/api/auth/session/migrate"
        ? { body: { success: true, migrated: false } }
        : { body: { authenticated: false } };
    const { result } = await mounted();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/migrate"))).toBe(true));
    expect(result.current.isAuthenticated).toBe(false);
    expect(localStorage.getItem("pf_access_token")).toBeNull();
  });

  it("the migration unreachable: signed out, storage clean, no loop", async () => {
    legacy();
    handler = (call) =>
      call.url === "/api/auth/session/migrate"
        ? "network-error"
        : { body: { authenticated: false } };
    const { result } = await mounted();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/migrate"))).toBe(true));
    expect(result.current.isAuthenticated).toBe(false);
    expect(calls.filter((c) => c.url.endsWith("/migrate"))).toHaveLength(1);
    expect(localStorage.getItem("pf_access_token")).toBeNull();
  });

  it("already on a server-side session: storage is cleaned and no migration is asked for", async () => {
    legacy();
    handler = () => ({ body: signedInBody() });
    await mounted();
    expect(calls.some((c) => c.url.endsWith("/migrate"))).toBe(false);
    expect(localStorage.getItem("pf_access_token")).toBeNull();
  });

  it("a browser with nothing legacy asks for no migration", async () => {
    await mounted();
    expect(calls.map((c) => c.url)).toEqual(["/api/auth/session"]);
  });

  it("removeLegacyStoredSession: true only when a legacy key was there; storage that throws is 'nothing'", () => {
    expect(removeLegacyStoredSession()).toBe(false);
    localStorage.setItem("pf_user", "{}");
    expect(removeLegacyStoredSession()).toBe(true);
    expect(removeLegacyStoredSession()).toBe(false);
    const key = jest.spyOn(Storage.prototype, "key").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    localStorage.setItem("pf_access_token", "t");
    expect(removeLegacyStoredSession()).toBe(false);
    key.mockRestore();
  });
});
