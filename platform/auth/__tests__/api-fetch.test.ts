/**
 * @jest-environment jsdom
 */
/**
 * apiFetch — the session cookie goes with every call to this origin's API (and to no other),
 * a state-changing call carries the session's forgery token, and the page holds no credential
 * (platform/auth/api-fetch.ts, ADR-057).
 *
 * Hostile: a URL that only looks same-origin; a token that must never reach another origin; a
 * call that would carry a token or an Authorization header of its own; a forged-request refusal
 * answered by one retry, never a loop.
 */
import { apiFetch, HANDLED_CODES } from "@/platform/auth/api-fetch";
import {
  currentSession,
  loadSession,
  resetSessionStateForTests,
} from "@/platform/auth/context";

type Answer = { status: number; body?: unknown };
const answers: Answer[] = [];
const fetchMock = jest.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
  const next = answers.shift() ?? { status: 200, body: {} };
  return {
    ok: next.status < 400,
    status: next.status,
    json: async () => next.body,
    clone() {
      return this;
    },
  } as unknown as Response;
});

/** jsdom has no Request; a minimal one, as the browser's carries url, method and headers. */
class FakeRequest {
  readonly headers: Headers;
  readonly method: string;
  constructor(
    readonly url: string,
    init?: { headers?: Record<string, string>; method?: string }
  ) {
    this.headers = new Headers(init?.headers);
    this.method = init?.method ?? "GET";
  }
}

const session = (csrfToken: string) => ({
  status: 200,
  body: {
    authenticated: true,
    user: { userId: "u1", email: "a@b.c", emailVerified: true, isGuest: false },
    csrfToken,
    audience: "user",
    idleExpiresAt: Date.now() + 60_000,
    absoluteExpiresAt: Date.now() + 600_000,
    idleWarningSeconds: 120,
  },
});

/** The page's session, as the provider's read leaves it. */
async function signedIn(csrfToken = "csrf-1"): Promise<void> {
  answers.push(session(csrfToken));
  await loadSession();
  fetchMock.mockClear();
}

const sent = (i = 0) => {
  const [input, init] = fetchMock.mock.calls[i];
  return { input, init, headers: new Headers(init?.headers) };
};

beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
  (global as unknown as { Request: unknown }).Request = FakeRequest;
});
beforeEach(() => {
  answers.length = 0;
  fetchMock.mockClear();
  resetSessionStateForTests();
  localStorage.clear();
});

describe("apiFetch", () => {
  it("a read of this origin sends the cookie and no token of any kind", async () => {
    await signedIn();
    await apiFetch("/api/things", { headers: { "X-Mine": "1" } });
    const { input, init, headers } = sent();
    expect(input).toBe("/api/things");
    expect(init?.credentials).toBe("same-origin");
    expect(headers.get("x-mine")).toBe("1");
    expect(headers.get("x-csrf-token")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "post"])(
    "a %s to this origin carries the session's forgery token, keeping the caller's headers and body",
    async (method) => {
      await signedIn("csrf-abc");
      await apiFetch("/api/things", {
        method,
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const { init, headers } = sent();
      expect(headers.get("x-csrf-token")).toBe("csrf-abc");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("authorization")).toBeNull();
      expect(init?.body).toBe("{}");
      expect(init?.credentials).toBe("same-origin");
    }
  );

  it("an absolute URL on this origin, and a URL object, are this origin's", async () => {
    await signedIn();
    await apiFetch(`${window.location.origin}/api/a`, { method: "POST" });
    await apiFetch(new URL("/api/b", window.location.origin), { method: "POST" });
    expect(sent(0).headers.get("x-csrf-token")).toBe("csrf-1");
    expect(sent(1).headers.get("x-csrf-token")).toBe("csrf-1");
  });

  it.each([
    "https://evil.example/api/x",
    "//evil.example/api/x",
    "/\\evil.example/api/x",
    "/\t/evil.example/api/x",
    "\\\\evil.example/api/x",
    "https://localhost.evil.example/api/x",
    `${"http://localhost"}:9999/api/x`,
    "https://localhost/api/x",
  ])(
    "hostile: %p is another origin — no token, no credentials option, the arguments untouched",
    async (url) => {
      await signedIn("csrf-secret");
      const init = { method: "POST", body: "x" };
      await apiFetch(url, init);
      const [input, passed] = fetchMock.mock.calls[0];
      expect(input).toBe(url);
      expect(passed).toBe(init);
      expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("csrf-secret");
    }
  );

  it("the page keeps nothing about the session in browser storage or a cookie", async () => {
    await signedIn("csrf-kept-in-memory");
    await apiFetch("/api/x", { method: "POST" });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    expect(currentSession().status).toBe("signed-in");
  });

  it("signed out, a state-changing call goes without a token (the server refuses it)", async () => {
    answers.push({ status: 200, body: { authenticated: false } });
    await loadSession();
    fetchMock.mockClear();
    await apiFetch("/api/x", { method: "POST" });
    expect(sent().headers.get("x-csrf-token")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("with no session read under way it does not start one: one call, no token", async () => {
    await apiFetch("/api/x", { method: "POST" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent().input).toBe("/api/x");
  });

  it("a call made while the session is being read waits for it, and carries its token", async () => {
    answers.push(session("csrf-late"));
    const reading = loadSession();
    const call = apiFetch("/api/x", { method: "POST" });
    await Promise.all([reading, call]);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "/api/auth/session",
      "/api/x",
    ]);
    expect(sent(1).headers.get("x-csrf-token")).toBe("csrf-late");
  });

  it("carries a Request's own headers and method when no init is given", async () => {
    await signedIn();
    const request = new FakeRequest(`${window.location.origin}/api/x`, {
      method: "POST",
      headers: { "X-Mine": "1" },
    });
    await apiFetch(request as unknown as Request);
    const { headers } = sent();
    expect(headers.get("x-mine")).toBe("1");
    expect(headers.get("x-csrf-token")).toBe("csrf-1");
  });
});

describe("apiFetch — a forged-request refusal (auth.csrf_failed) is answered once", () => {
  it("declares the code it handles for every caller", () => {
    expect([...HANDLED_CODES]).toEqual(["auth.csrf_failed"]);
  });

  it("the session moved to a new id elsewhere: the session is read again and the call made once more with its token", async () => {
    await signedIn("stale");
    answers.push({ status: 403, body: { code: "auth.csrf_failed" } }, session("fresh"), {
      status: 200,
      body: { done: true },
    });
    const res = await apiFetch("/api/x", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "/api/x",
      "/api/auth/session",
      "/api/x",
    ]);
    expect(sent(0).headers.get("x-csrf-token")).toBe("stale");
    expect(sent(2).headers.get("x-csrf-token")).toBe("fresh");
    expect(sent(2).init?.body).toBe("{}");
  });

  it("refused again with the fresh token: returned as it is — never a second retry", async () => {
    await signedIn("stale");
    answers.push({ status: 403, body: { code: "auth.csrf_failed" } }, session("fresh"), {
      status: 403,
      body: { code: "auth.csrf_failed" },
    });
    const res = await apiFetch("/api/x", { method: "POST" });
    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("the token read again is the same one: no retry (it would be refused the same way)", async () => {
    await signedIn("same");
    answers.push({ status: 403, body: { code: "auth.csrf_failed" } }, session("same"));
    const res = await apiFetch("/api/x", { method: "POST" });
    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("another 403 (a missing permission) is not retried, and the session is not read", async () => {
    await signedIn();
    answers.push({ status: 403, body: { code: "auth.permission_denied" } });
    const res = await apiFetch("/api/x", { method: "POST" });
    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a call whose body is a stream (it cannot be sent twice)", async () => {
    await signedIn("stale");
    answers.push({ status: 403, body: { code: "auth.csrf_failed" } });
    const body = { getReader: () => ({}) };
    const res = await apiFetch("/api/x", {
      method: "POST",
      body: body as unknown as BodyInit,
    });
    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("makes one read of the session for calls refused at once", async () => {
    await signedIn("stale");
    answers.push(
      { status: 403, body: { code: "auth.csrf_failed" } },
      { status: 403, body: { code: "auth.csrf_failed" } },
      session("fresh"),
      { status: 200 },
      { status: 200 }
    );
    await Promise.all([
      apiFetch("/api/a", { method: "POST" }),
      apiFetch("/api/b", { method: "POST" }),
    ]);
    expect(fetchMock.mock.calls.filter((c) => c[0] === "/api/auth/session")).toHaveLength(
      1
    );
  });
});

describe("apiFetch — an ended session", () => {
  it.each(["auth.token_invalid", "auth.required"])(
    "a 401 %s forgets the session here, and the response is returned for the screen",
    async (code) => {
      await signedIn();
      answers.push({ status: 401, body: { code } });
      const res = await apiFetch("/api/x");
      expect(res.status).toBe(401);
      expect(currentSession().status).toBe("signed-out");
      // Nothing is renewed from the browser: there is no token here to renew.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it("a caller that restarts the session itself can leave it: the response comes back and the page still holds the session", async () => {
    await signedIn();
    answers.push({ status: 401, body: { code: "auth.token_invalid" } });
    const res = await apiFetch("/api/x", undefined, { onSessionEnded: "leave" });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth.token_invalid");
    // Not forgotten here: the caller decides (and calls noteSessionEnded when it cannot go on).
    expect(currentSession().status).toBe("signed-in");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a 401 of another kind (a guest on a sign-in route) leaves the session as it is", async () => {
    await signedIn();
    answers.push({ status: 401, body: { code: "auth.sign_in_required" } });
    await apiFetch("/api/x");
    expect(currentSession().status).toBe("signed-in");
  });

  it("a response that is not JSON is returned untouched", async () => {
    await signedIn();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      clone() {
        return { json: async () => Promise.reject(new SyntaxError("not json")) };
      },
    } as unknown as Response);
    const res = await apiFetch("/api/x", { method: "POST" });
    expect(res.status).toBe(403);
    expect(currentSession().status).toBe("signed-in");
  });
});
