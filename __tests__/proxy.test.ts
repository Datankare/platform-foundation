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
  // The session cookie's name in this (non-production) build; the proxy never reads its value.
  if (init.cookie) headers.set("cookie", `pf_session=${"s".repeat(43)}`);
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

  it("a machine's credential of any scheme passes to its route; an empty Authorization header is none", () => {
    const withAuthorization = (value: string) =>
      proxy(
        new NextRequest("http://localhost/api/agent/delegation/token", {
          method: "POST",
          headers: { authorization: value },
        })
      ).status;
    // An agent's client credential at its token endpoint (RFC 6749 §2.3.1), a bearer.
    expect(withAuthorization("Basic YWdlbnQ6c2VjcmV0")).toBe(200);
    expect(withAuthorization("Bearer t")).toBe(200);
    // Nothing presented: refused before any route.
    expect(withAuthorization("   ")).toBe(401);
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

  it("the old indicator cookie is no session: a page is sent to sign-in, an API call refused (ADR-057)", async () => {
    const headers = { cookie: "pf_has_session=true" };
    expect(
      proxy(new NextRequest("https://app.example/profile", { headers })).status
    ).toBe(307);
    expect(
      proxy(new NextRequest("https://app.example/api/process", { headers })).status
    ).toBe(401);
  });

  describe("in a production build the cookie is __Host-pf_session", () => {
    const saved = process.env.NODE_ENV;
    const setNodeEnv = (value: string | undefined) =>
      Object.defineProperty(process.env, "NODE_ENV", {
        value,
        configurable: true,
        writable: true,
        enumerable: true,
      });
    afterEach(() => setNodeEnv(saved));

    it("serves a page with it, and not with the local name", () => {
      setNodeEnv("production");
      const page = (cookie: string) =>
        proxy(new NextRequest("https://app.example/profile", { headers: { cookie } }));
      expect(
        page(`__Host-pf_session=${"s".repeat(43)}`).headers.get("x-middleware-next")
      ).toBe("1");
      expect(page(`pf_session=${"s".repeat(43)}`).status).toBe(307);
    });
  });
});

describe("a state-changing API request from another origin (ADR-057 D4)", () => {
  const post = (path: string, headers: Record<string, string>, method = "POST") =>
    proxy(new NextRequest(`https://app.example${path}`, { method, headers }));

  it.each([
    ["/api/auth/sign-in", "POST"],
    ["/api/auth/sign-up", "POST"],
    ["/api/auth/guest", "POST"],
    ["/api/auth/sign-out", "POST"],
    ["/api/process", "POST"],
    ["/api/admin/config", "PUT"],
    ["/api/admin/users", "PATCH"],
    ["/api/account/delete", "DELETE"],
  ])(
    "%s %s is refused before any route runs — auth.csrf_failed",
    async (path, method) => {
      for (const origin of [
        "https://evil.example",
        "https://app.example.evil.example",
        "http://app.example",
        "https://sub.app.example",
        "null",
      ]) {
        const res = post(
          path,
          { origin, cookie: `pf_session=${"s".repeat(43)}` },
          method
        );
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe("auth.csrf_failed");
      }
    }
  );

  it("a cross-site Referer with no Origin is refused too", async () => {
    const res = post("/api/auth/sign-in", { referer: "https://evil.example/page" });
    expect(res.status).toBe(403);
  });

  it("this origin passes, and so does a request that names no origin (a machine client)", () => {
    expect(
      post("/api/auth/sign-in", { origin: "https://app.example" }).headers.get(
        "x-middleware-next"
      )
    ).toBe("1");
    expect(post("/api/auth/sign-in", {}).headers.get("x-middleware-next")).toBe("1");
    expect(
      post("/api/internal/jobs/tick", { authorization: "Bearer t" }).headers.get(
        "x-middleware-next"
      )
    ).toBe("1");
  });

  it("behind a proxy that forwards the browser's host and scheme, that origin is this one", () => {
    const res = proxy(
      new NextRequest("http://10.0.0.5:3000/api/auth/sign-in", {
        method: "POST",
        headers: {
          origin: "https://play.example",
          "x-forwarded-host": "play.example",
          "x-forwarded-proto": "https",
        },
      })
    );
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("a read from another origin is not this check's (the route and SameSite decide)", () => {
    const res = proxy(
      new NextRequest("https://app.example/api/health", {
        headers: { origin: "https://evil.example" },
      })
    );
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("a page navigation from another site is not refused (a link into the app)", () => {
    const res = proxy(
      new NextRequest("https://app.example/auth", {
        headers: { origin: "https://evil.example" },
      })
    );
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("Content Security Policy (audit G-10)", () => {
  const policyOf = (res: Response) => res.headers.get("content-security-policy") ?? "";
  const nonceOf = (policy: string) => /'nonce-([^']+)'/.exec(policy)?.[1];

  it.each([
    ["a page", "/", { cookie: `pf_session=${"s".repeat(43)}` }],
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
      // SEC-017 (TASK-203): no inline style but the response's own nonce — nowhere in the policy.
      expect(policy).not.toContain("'unsafe-inline'");
      const nonce = nonceOf(policy);
      expect(policy).toContain(`style-src 'self' 'nonce-${nonce}'`);
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
