/**
 * __tests__/auth-enumeration.test.ts — The pre-sign-in routes do not reveal accounts (audit A-15)
 *
 * Sign-up answered 409 for an address that had an account, and password reset and resending a
 * code answered "no such user": anyone could list who has an account. Each route now answers a
 * known and an unknown address alike, and still answers rate limiting and server failures as
 * themselves.
 */

import { NextRequest } from "next/server";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

const provider = {
  signUp: jest.fn(),
  forgotPassword: jest.fn(),
  resendEmailVerification: jest.fn(),
  confirmEmailVerification: jest.fn(),
  confirmForgotPassword: jest.fn(),
};
jest.mock("@/platform/auth/config", () => ({
  getAuthProvider: () => provider,
  hasAuthProvider: () => true,
  registerAuthProvider: jest.fn(),
}));
jest.mock("@/platform/auth/auth-init", () => ({ initAuth: jest.fn() }));

import { resetRateLimiter } from "@/platform/rate-limit";
import { concealAccount } from "@/platform/auth/auth-response";

const STRONG = "Correct-Horse-Battery-9";

const ROUTES = {
  "sign-up": {
    body: { email: "a@b.c", password: STRONG, dateOfBirth: "1990-01-01" },
    call: "signUp",
  },
  "forgot-password": { body: { email: "a@b.c" }, call: "forgotPassword" },
  "resend-verification": { body: { email: "a@b.c" }, call: "resendEmailVerification" },
  "verify-email": {
    body: { email: "a@b.c", code: "123456" },
    call: "confirmEmailVerification",
  },
  "confirm-forgot-password": {
    body: { email: "a@b.c", code: "123456", newPassword: STRONG },
    call: "confirmForgotPassword",
  },
} as const;

async function send(
  route: keyof typeof ROUTES
): Promise<{ status: number; body: unknown }> {
  const { POST } = (await import(`@/app/api/auth/${route}/route`)) as {
    POST: (r: NextRequest) => Promise<Response>;
  };
  const res = await POST(
    new NextRequest(`http://localhost/api/auth/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.5" },
      body: JSON.stringify(ROUTES[route].body),
    })
  );
  return { status: res.status, body: await res.json() };
}

const known = { success: true, emailVerificationRequired: true };
const unknownUser = {
  success: false,
  error: "User does not exist",
  errorCode: "auth.invalid_credentials",
};

beforeEach(() => {
  jest.clearAllMocks();
  resetRateLimiter();
});

describe.each([
  ["forgot-password", { success: true, deliveryMedium: "email" }],
  ["resend-verification", { success: true }],
] as const)("%s", (route, success) => {
  it("answers an unknown address exactly as a known one", async () => {
    (provider[ROUTES[route].call] as jest.Mock).mockResolvedValueOnce(success);
    const a = await send(route);
    (provider[ROUTES[route].call] as jest.Mock).mockResolvedValueOnce(unknownUser);
    const b = await send(route);
    expect(b.status).toBe(a.status);
    expect(b.status).toBe(200);
    expect((b.body as { success: boolean }).success).toBe(true);
  });

  it.each([
    ["an unverified address", "auth.email_not_verified"],
    ["an address that exists", "auth.account_exists"],
  ])("does not reveal %s", async (_l, errorCode) => {
    (provider[ROUTES[route].call] as jest.Mock).mockResolvedValueOnce({
      success: false,
      errorCode,
    });
    expect((await send(route)).status).toBe(200);
  });

  it("still answers too many attempts as itself", async () => {
    (provider[ROUTES[route].call] as jest.Mock).mockResolvedValueOnce({
      success: false,
      errorCode: "auth.too_many_attempts",
    });
    expect((await send(route)).status).toBe(429);
  });
});

describe("sign-up", () => {
  it("answers an address that already has an account as a new one", async () => {
    provider.signUp.mockResolvedValueOnce({ ...known, userId: "u" });
    const a = await send("sign-up");
    provider.signUp.mockResolvedValueOnce({
      success: false,
      errorCode: "auth.account_exists",
    });
    const b = await send("sign-up");
    expect(b.status).toBe(a.status);
    expect(b.body).toEqual({ success: true, emailVerificationRequired: true });
  });

  it("still answers a weak password as itself", async () => {
    provider.signUp.mockResolvedValueOnce({
      success: false,
      errorCode: "auth.password_policy",
    });
    expect((await send("sign-up")).status).toBe(400);
  });
});

describe.each(["verify-email", "confirm-forgot-password"] as const)("%s", (route) => {
  it("answers an unknown address as a wrong code", async () => {
    (provider[ROUTES[route].call] as jest.Mock).mockResolvedValueOnce({
      success: false,
      errorCode: "auth.code_invalid",
    });
    const wrongCode = await send(route);
    (provider[ROUTES[route].call] as jest.Mock).mockResolvedValueOnce(unknownUser);
    const unknown = await send(route);
    expect(unknown.status).toBe(wrongCode.status);
    expect((unknown.body as { code: string }).code).toBe("auth.code_invalid");
  });
});

describe("concealAccount", () => {
  it("passes a success and an unrelated failure through unchanged", () => {
    expect(concealAccount({ success: true }, "request")).toEqual({ success: true });
    const failure = { success: false, errorCode: "internal.error" as const };
    expect(concealAccount(failure, "request")).toBe(failure);
  });
});
