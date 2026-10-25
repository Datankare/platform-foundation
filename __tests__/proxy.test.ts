/**
 * proxy.ts — route protection at the edge of every request. Untested until 7A (TASK-102): its
 * 401 was free text, outside the ADR-051 error contract, because no test or scan covered it.
 */
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { contentSecurityPolicy } from "@/platform/security/csp";

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

describe("Content Security Policy (audit G-10)", () => {
  const policyOf = (res: Response) => res.headers.get("content-security-policy") ?? "";
  const nonceOf = (policy: string) => /'nonce-([^']+)'/.exec(policy)?.[1];

  it.each([
    ["a page", "/", { cookie: "pf_has_session=true" }],
    ["the sign-in page", "/auth", {}],
    ["an API call", "/api/process", { authorization: "Bearer t" }],
    ["a refused API call", "/api/process", {}],
    ["a redirect to sign-in", "/admin", {}],
  ])(
    "sets a nonce policy on %s, allowing no inline or eval'd script",
    (_l, path, headers) => {
      const res = proxy(new NextRequest(`http://localhost${path}`, { headers }));
      const policy = policyOf(res);
      expect(policy).toMatch(
        /script-src 'self' 'nonce-[A-Za-z0-9+/=]{20,}' 'strict-dynamic'/
      );
      const scriptSrc =
        policy.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
      expect(scriptSrc).not.toContain("'unsafe-inline'");
      expect(policy).not.toContain("'unsafe-eval'");
      for (const directive of [
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "connect-src 'self'",
      ]) {
        expect(policy).toContain(directive);
      }
    }
  );

  it("gives every response its own nonce", () => {
    const nonces = new Set(
      Array.from({ length: 50 }, () =>
        nonceOf(policyOf(proxy(new NextRequest("http://localhost/auth"))))
      )
    );
    expect(nonces.size).toBe(50);
  });

  it("passes the nonce to the app on the request (Next.js puts it on its scripts)", () => {
    const res = proxy(new NextRequest("http://localhost/auth"));
    const nonce = nonceOf(policyOf(res));
    // NextResponse.next({ request: { headers } }) carries overridden request headers in these.
    expect(res.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(
      policyOf(res)
    );
  });

  it("allows eval only in development", () => {
    expect(contentSecurityPolicy("n", { development: true })).toContain("'unsafe-eval'");
    expect(contentSecurityPolicy("n")).not.toContain("'unsafe-eval'");
  });
});
