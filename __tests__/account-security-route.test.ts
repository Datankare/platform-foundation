/**
 * @jest-environment node
 */
/**
 * __tests__/account-security-route.test.ts — GET /api/account/security answers how the session's
 * own account signs in, and nothing else (TASK-224)
 *
 * The account page and the authorization page read it (E-126, SF-app-083). It answers from the
 * session's own verification: whether the identity provider said a second factor exists, and how
 * this session signed in. "Not said" is null — never false. A guest, or no session, is refused; it
 * is limited per address before any work, and never cached.
 *
 * hostile:role a guest's session is refused (auth.sign_in_required); no session is auth.required
 * hostile:self n/a: the route reads only the session's own account; it takes no id
 * hostile:store-down the identity provider not saying: null, never "off"
 * hostile:id-spelling n/a: no id is read
 */
import { NextRequest } from "next/server";

const mockLimited: { response: Response | null } = { response: null };
jest.mock("@/platform/rate-limit", () => ({
  ...jest.requireActual("@/platform/rate-limit"),
  enforceRateLimit: jest.fn(async () => mockLimited.response),
}));
const mockAuth: { result: unknown } = { result: null };
jest.mock("@/platform/auth/middleware", () => ({
  ...jest.requireActual("@/platform/auth/middleware"),
  requireAuth: jest.fn(async () => mockAuth.result),
}));

import { GET } from "@/app/api/account/security/route";
import { apiError } from "@/platform/errors";

const get = () => GET(new NextRequest("http://localhost/api/account/security"));
const signedIn = (mfaEnabled: unknown, method: string) => ({
  user: {
    sub: "s1",
    email: "a@b.c",
    ...(mfaEnabled === undefined ? {} : { mfaEnabled }),
  },
  session: { method },
});

beforeEach(() => {
  mockLimited.response = null;
});

describe("GET /api/account/security (TASK-224)", () => {
  it.each([
    [true, "password", { mfaEnabled: true, signInMethod: "password" }],
    [false, "password", { mfaEnabled: false, signInMethod: "password" }],
    [undefined, "password", { mfaEnabled: null, signInMethod: "password" }],
    [true, "sso", { mfaEnabled: true, signInMethod: "sso" }],
  ] as const)("mfaEnabled %s, signed in by %s → %j", async (mfa, method, body) => {
    mockAuth.result = signedIn(mfa, method);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(body);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("[hostile:role] a refused caller (a guest, no session) gets the guard's refusal, nothing else", async () => {
    const request = new NextRequest("http://localhost/api/account/security");
    mockAuth.result = { error: apiError("auth.sign_in_required", { request }) };
    const res = await get();
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth.sign_in_required");
  });

  it('[hostile:store-down] the session that cannot be verified now is refused as unavailable — never an answer of "off"', async () => {
    const request = new NextRequest("http://localhost/api/account/security");
    mockAuth.result = {
      error: apiError("service.unavailable", { params: { service: "auth" }, request }),
    };
    const res = await get();
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("service.unavailable");
    expect(body).not.toHaveProperty("mfaEnabled");
  });

  it("limited before any work", async () => {
    const request = new NextRequest("http://localhost/api/account/security");
    mockLimited.response = apiError("rate.limited", {
      params: { retryAfterSeconds: 30 },
      request,
    });
    mockAuth.result = signedIn(true, "password");
    const res = await get();
    expect(res.status).toBe(429);
  });
});
