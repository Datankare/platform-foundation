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
