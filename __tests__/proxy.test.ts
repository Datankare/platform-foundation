/**
 * proxy.ts — route protection at the edge of every request. Untested until 7A (TASK-102): its
 * 401 was free text, outside the ADR-051 error contract, because no test or scan covered it.
 */
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

function req(path: string, init: { auth?: boolean; cookie?: boolean } = {}) {
  const headers = new Headers();
  if (init.auth) headers.set("authorization", "Bearer t");
  if (init.cookie) headers.set("cookie", "pf_has_session=true");
  return new NextRequest(`https://app.example${path}`, { headers });
}

describe("proxy", () => {
  it.each(["/auth", "/auth/callback", "/api/auth/guest", "/api/health", "/api/features"])(
    "lets the public route %s through",
    (path) => {
      expect(proxy(req(path)).headers.get("x-middleware-next")).toBe("1");
    }
  );

  it("refuses an API call with no credentials — coded auth.required (ADR-051)", async () => {
    const res = proxy(req("/api/process"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("auth.required");
    expect(typeof body.message).toBe("string");
  });

  it("lets an API call with a bearer token or session cookie through to the route", () => {
    expect(
      proxy(req("/api/process", { auth: true })).headers.get("x-middleware-next")
    ).toBe("1");
    expect(
      proxy(req("/api/process", { cookie: true })).headers.get("x-middleware-next")
    ).toBe("1");
  });

  it("redirects a page without a session to /auth, remembering where it was going", () => {
    const res = proxy(req("/profile"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://app.example/auth?redirect=%2Fprofile"
    );
  });

  it("serves a page with a session", () => {
    expect(
      proxy(req("/profile", { cookie: true })).headers.get("x-middleware-next")
    ).toBe("1");
  });
});
