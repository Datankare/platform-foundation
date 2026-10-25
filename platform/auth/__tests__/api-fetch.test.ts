/**
 * @jest-environment jsdom
 */
/**
 * apiFetch — the signed-in user's token goes with every call to this origin's API, and nowhere
 * else (platform/auth/api-fetch.ts).
 */
import { apiFetch } from "@/platform/auth/api-fetch";

const fetchMock = jest.fn(async () => ({ ok: true }) as Response);
/** jsdom has no Request; a minimal one, as the browser's carries url and headers. */
class FakeRequest {
  readonly headers: Headers;
  constructor(
    readonly url: string,
    init?: { headers?: Record<string, string> }
  ) {
    this.headers = new Headers(init?.headers);
  }
}
beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
  (global as unknown as { Request: unknown }).Request = FakeRequest;
});
beforeEach(() => {
  fetchMock.mockClear();
  localStorage.clear();
});

/** A JWT-shaped token whose exp is `secondsFromNow` away. */
function jwt(secondsFromNow: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64({ exp: Math.floor(Date.now() / 1000) + secondsFromNow })}.sig`;
}
function signIn(token: string) {
  localStorage.setItem("pf_access_token", token);
  localStorage.setItem(
    "pf_user",
    JSON.stringify({ userId: "u1", email: "a@b.c", emailVerified: true, isGuest: false })
  );
}
const sentHeaders = (n = 0) =>
  new Headers((fetchMock.mock.calls[n] as unknown as [unknown, RequestInit])[1]?.headers);

describe("apiFetch", () => {
  it("without a session it is plain fetch, the arguments untouched", async () => {
    const init = { method: "POST", headers: { "Content-Type": "application/json" } };
    await apiFetch("/api/admin/users", init);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/users", init);
  });

  it("attaches the token to a same-origin path, keeping the caller's headers and options", async () => {
    const token = jwt(600);
    signIn(token);
    await apiFetch("/api/admin/users?x=1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/admin/users?x=1");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe("{}");
    expect(sentHeaders().get("authorization")).toBe(`Bearer ${token}`);
    expect(sentHeaders().get("content-type")).toBe("application/json");
  });

  it("attaches it to an absolute URL on this origin, and a URL object", async () => {
    signIn(jwt(600));
    await apiFetch(`${window.location.origin}/api/health`);
    await apiFetch(new URL("/api/health", window.location.origin));
    expect(sentHeaders(0).get("authorization")).toMatch(/^Bearer /);
    expect(sentHeaders(1).get("authorization")).toMatch(/^Bearer /);
  });

  it.each([
    "https://evil.example/api/admin/users",
    "//evil.example/api/admin/users",
    "/\\evil.example/api",
    "http://localhost:9999/api/admin/users",
    "javascript:alert(1)",
    // The parser drops tabs and newlines, so each of these is "//evil.example".
    "/\t/evil.example/api",
    "/\n/evil.example/api",
    "/\r/evil.example/api",
    "/\r\n/evil.example/api",
    "\t//evil.example/api",
    "/\t\\evil.example/api",
    "\\\\evil.example/api",
  ])("never sends the token to another origin (%j)", async (url) => {
    signIn(jwt(600));
    // The premise: the browser's parser really does read it as another origin.
    expect(new URL(url, window.location.href).origin).not.toBe(window.location.origin);
    await apiFetch(url);
    expect(sentHeaders().get("authorization")).toBeNull();
  });

  it.each(["%2f%2fevil.example/api", "/%2f/evil.example/api", "/%5cevil.example/api"])(
    "an encoded slash stays a path on this origin (%j), so the token goes",
    async (url) => {
      signIn(jwt(600));
      expect(new URL(url, window.location.href).origin).toBe(window.location.origin);
      await apiFetch(url);
      expect(sentHeaders().get("authorization")).toMatch(/^Bearer /);
    }
  );

  it("keeps an Authorization header the caller set", async () => {
    signIn(jwt(600));
    await apiFetch("/api/stream", { headers: { Authorization: "Bearer other" } });
    expect(sentHeaders().get("authorization")).toBe("Bearer other");
  });

  it("sends no expired or corrupt session's token", async () => {
    signIn(jwt(-10));
    await apiFetch("/api/admin/users");
    expect(sentHeaders().get("authorization")).toBeNull();
    localStorage.setItem("pf_access_token", jwt(600));
    localStorage.setItem("pf_user", "{not json");
    await apiFetch("/api/admin/users");
    expect(sentHeaders(1).get("authorization")).toBeNull();
  });

  it("carries a Request's own headers when no init is given", async () => {
    signIn(jwt(600));
    await apiFetch(
      new Request(`${window.location.origin}/api/x`, { headers: { "X-A": "1" } })
    );
    expect(sentHeaders().get("x-a")).toBe("1");
    expect(sentHeaders().get("authorization")).toMatch(/^Bearer /);
  });
});

describe("apiFetch — an expired access token is renewed once (audit A-14)", () => {
  const respond = (status: number, body: unknown = {}) =>
    ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

  it("on 401, renews from the refresh cookie and repeats the call with the new token", async () => {
    signIn(jwt(600));
    const fresh = jwt(3600);
    fetchMock
      .mockResolvedValueOnce(respond(401))
      .mockResolvedValueOnce(respond(200, { userId: "u1", accessToken: fresh }))
      .mockResolvedValueOnce(respond(200));
    const res = await apiFetch("/api/admin/users", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe("/api/auth/refresh");
    expect(sentHeaders(2).get("authorization")).toBe(`Bearer ${fresh}`);
    expect(localStorage.getItem("pf_access_token")).toBe(fresh);
  });

  it("returns the 401 and ends the session when the refresh is refused", async () => {
    signIn(jwt(600));
    fetchMock.mockResolvedValueOnce(respond(401)).mockResolvedValueOnce(respond(401));
    const res = await apiFetch("/api/admin/users");
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem("pf_access_token")).toBeNull();
  });

  it("does not retry a call whose body is a stream (it cannot be sent twice)", async () => {
    signIn(jwt(600));
    fetchMock.mockResolvedValueOnce(respond(401));
    // Any body that is not one of the re-sendable kinds (a stream, in a browser).
    const body = { getReader() {} } as unknown as BodyInit;
    const res = await apiFetch("/api/process", { method: "POST", body });
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never renews for a guest", async () => {
    localStorage.setItem("pf_access_token", jwt(600));
    localStorage.setItem(
      "pf_user",
      JSON.stringify({ userId: "g", email: "", emailVerified: false, isGuest: true })
    );
    fetchMock.mockResolvedValueOnce(respond(401));
    await apiFetch("/api/process");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("makes one refresh for calls that fail at once", async () => {
    signIn(jwt(600));
    const fresh = jwt(3600);
    fetchMock.mockImplementation((async (url: string) =>
      url === "/api/auth/refresh"
        ? respond(200, { userId: "u1", accessToken: fresh })
        : respond(sentAuth(url) === fresh ? 200 : 401)) as never);
    function sentAuth(_url: string): string | undefined {
      const last = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as unknown as [
        string,
        RequestInit,
      ];
      return new Headers(last[1]?.headers).get("authorization")?.slice(7);
    }
    await Promise.all([apiFetch("/api/a"), apiFetch("/api/b"), apiFetch("/api/c")]);
    const refreshes = fetchMock.mock.calls.filter(
      (c) => (c as unknown as [string])[0] === "/api/auth/refresh"
    );
    expect(refreshes).toHaveLength(1);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ({ ok: true }) as Response);
  });
});
