/**
 * @jest-environment node
 */
/**
 * __tests__/auth-route-body-types.test.ts — the auth routes take text, and only text (PF v5.1.0)
 *
 * The routes typed their body by cast (`body as { email?: string }`) and passed whatever came to
 * the provider or the password rules. The v5.1.0 promotion's monkey run found sign-up answering
 * an uncoded 500 — the password-policy read threw without a database, and a non-text password
 * would have reached the rules. Every auth route now refuses a non-text field with a coded 400,
 * sign-up applies the built-in policy when the stored one cannot be read, and a provider that
 * throws is a coded 500 (`internal.error`), never an uncoded one.
 */

import { NextRequest } from "next/server";
import { resetRateLimiter } from "@/platform/rate-limit";

// hostile:role n/a: the auth routes are called signed out and take no role, so there is none to forge
// hostile:self n/a: each call is about the address it names; no account acts on another account here
// hostile:id-spelling n/a: no account id is read or compared: the routes take an address, which the provider compares

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-test",
}));

const provider = {
  signUp: jest.fn().mockResolvedValue({ success: true, userId: "u" }),
  signIn: jest.fn().mockResolvedValue({
    success: false,
    error: "x",
    errorCode: "auth.invalid_credentials",
  }),
  forgotPassword: jest.fn().mockResolvedValue({ success: true }),
  confirmForgotPassword: jest.fn().mockResolvedValue({ success: true }),
  confirmEmailVerification: jest.fn().mockResolvedValue({ success: true }),
  resendEmailVerification: jest.fn().mockResolvedValue({ success: true }),
  respondToMfaChallenge: jest.fn().mockResolvedValue({ success: true }),
  respondToNewPasswordChallenge: jest.fn().mockResolvedValue({ success: true }),
};
jest.mock("@/platform/auth/config", () => ({
  getAuthProvider: () => provider,
  hasAuthProvider: () => true,
  registerAuthProvider: jest.fn(),
}));
jest.mock("@/platform/auth/auth-init", () => ({ initAuth: jest.fn() }));
// No database, as in the monkey run: creating the client throws.

const ROUTES: [string, string[]][] = [
  ["sign-up", ["email", "password", "dateOfBirth"]],
  ["sign-in", ["email", "password"]],
  ["forgot-password", ["email"]],
  ["confirm-forgot-password", ["email", "code", "newPassword"]],
  ["verify-email", ["email", "code"]],
  ["resend-verification", ["email"]],
  ["mfa-challenge", ["session", "code", "username"]],
  ["new-password-challenge", ["session", "newPassword", "username"]],
];

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/auth/x", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify(body),
  });
}

async function handler(route: string) {
  return (
    (await import(`@/app/api/auth/${route}/route`)) as {
      POST: (r: NextRequest) => Promise<Response>;
    }
  ).POST;
}

const good: Record<string, string> = {
  email: "a@b.c",
  password: "Correct-Horse-Battery-9",
  code: "123456",
  newPassword: "Correct-Horse-Battery-9",
  session: "s",
  username: "a@b.c",
  dateOfBirth: "1990-01-01",
};

beforeEach(() => {
  resetRateLimiter();
  jest.clearAllMocks();
});

describe.each(ROUTES)("POST /api/auth/%s", (route, fields) => {
  // An object with keys is refused first by the body's schema (TASK-203, N-31): no key is named
  // under a text field — request.unknown_input_none, naming the key's path.
  it.each([
    ["a number", 7, "request.invalid_body"],
    ["a list", ["a@b.c"], "request.invalid_body"],
    ["an object", { a: 1 }, "request.unknown_input_none"],
    ["a boolean", true, "request.invalid_body"],
  ])("refuses %s in a text field with %s", async (_label, value, code) => {
    for (const field of fields) {
      const body = {
        ...Object.fromEntries(fields.map((f) => [f, good[f]])),
        [field]: value,
      };
      const res = await (await handler(route))(post(body));
      expect(res.status).toBe(400);
      const answer = await res.json();
      expect(answer.code).toBe(code);
      if (code === "request.unknown_input_none")
        expect(answer.params).toEqual({ field: `${field}.a` });
    }
    for (const fn of Object.values(provider)) expect(fn).not.toHaveBeenCalled();
  });

  it("answers a missing or empty field with request.missing_fields naming them all", async () => {
    const res = await (await handler(route))(post({ [fields[0]]: "" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "request.missing_fields",
      params: { fields },
    });
  });
});

describe("sign-up without a readable password policy", () => {
  it("[hostile:store-down] applies the built-in policy — never a 500 (the database client cannot be created)", async () => {
    const signUp = await handler("sign-up");
    const weak = await signUp(
      post({ email: "a@b.c", password: "short", dateOfBirth: good.dateOfBirth })
    );
    expect(weak.status).toBe(400);
    expect((await weak.json()).code).toBe("auth.password_policy");
    const strong = await signUp(
      post({ email: "a@b.c", password: good.password, dateOfBirth: good.dateOfBirth })
    );
    expect(strong.status).toBeLessThan(500);
    expect(provider.signUp).toHaveBeenCalledTimes(1);
  });
});

const CALLS: Record<string, keyof typeof provider> = {
  "sign-up": "signUp",
  "sign-in": "signIn",
  "forgot-password": "forgotPassword",
  "confirm-forgot-password": "confirmForgotPassword",
  "verify-email": "confirmEmailVerification",
  "resend-verification": "resendEmailVerification",
  "mfa-challenge": "respondToMfaChallenge",
  "new-password-challenge": "respondToNewPasswordChallenge",
};

describe.each(ROUTES)(
  "POST /api/auth/%s with a provider that throws",
  (route, fields) => {
    it("answers a coded 500 (internal.error with a request id)", async () => {
      provider[CALLS[route]].mockRejectedValueOnce(new Error("provider down"));
      const res = await (
        await handler(route)
      )(post(Object.fromEntries(fields.map((f) => [f, good[f]]))));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe("internal.error");
      expect(body.params.requestId).toEqual(expect.any(String));
    });
  }
);

describe("a server whose providers cannot be initialised", () => {
  it("answers every auth route with a coded 500", async () => {
    const { initAuth } = jest.requireMock("@/platform/auth/auth-init") as {
      initAuth: jest.Mock;
    };
    for (const [route, fields] of ROUTES) {
      initAuth.mockImplementationOnce(() => {
        throw new Error("environment contract");
      });
      const res = await (
        await handler(route)
      )(post(Object.fromEntries(fields.map((f) => [f, good[f]]))));
      expect(res.status).toBe(500);
      expect((await res.json()).code).toBe("internal.error");
    }
  });
});

describe("POST /api/auth/sign-out with a provider that throws", () => {
  it("ends the session in its record all the same: the record, not the provider, refuses the id from then on (ADR-057 D6)", async () => {
    const signOut = jest.fn().mockRejectedValue(new Error("provider down"));
    Object.assign(provider, { signOut });
    const { POST } = (await import("@/app/api/auth/sign-out/route")) as {
      POST: (r: NextRequest) => Promise<Response>;
    };
    const { startTestSession } = await import("./helpers/session");
    const { getSessionStore } = await import("@/platform/auth/session-store");
    const { DEFAULT_TENANT_ID, runWithTenant } =
      await import("@/platform/tenancy/context");
    const session = await startTestSession({ refreshToken: "refresh-1" });
    const res = await POST(
      new NextRequest("http://localhost/api/auth/sign-out", {
        method: "POST",
        headers: { ...session.headers, "x-forwarded-for": "203.0.113.9" },
      })
    );
    expect(res.status).toBe(200);
    expect(signOut).toHaveBeenCalledWith("", "refresh-1");
    const record = await runWithTenant(
      { tenantId: DEFAULT_TENANT_ID, mode: "single" },
      () => getSessionStore().find(session.idHash)
    );
    expect(record?.revokedReason).toBe("sign_out");
    // The browser stops claiming a session.
    expect(res.headers.get("set-cookie")).toMatch(/pf_session=;.*Max-Age=0/i);
  });
});
