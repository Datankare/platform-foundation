/**
 * Auth API Routes — integrity tests.
 *
 * Tests all 9 auth routes: sign-in, sign-up, sign-out, forgot-password,
 * confirm-forgot-password, verify-email, resend-verification, mfa-challenge, guest.
 *
 * Each route is a thin server-side wrapper that calls AuthProvider.
 * Provider is mocked — these tests verify request validation, response
 * shape, cookie handling, and error paths.
 */

import { NextRequest } from "next/server";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  generateRequestId: () => "test-req-id",
}));

// Mock auth config to return our mock provider
const mockProvider = {
  signIn: jest.fn(),
  signUp: jest.fn(),
  signOut: jest.fn(),
  forgotPassword: jest.fn(),
  confirmForgotPassword: jest.fn(),
  confirmEmailVerification: jest.fn(),
  resendEmailVerification: jest.fn(),
  respondToMfaChallenge: jest.fn(),
  createGuestToken: jest.fn(),
  verifyToken: jest.fn(),
  refreshToken: jest.fn(),
  changePassword: jest.fn(),
  setupMfa: jest.fn(),
  verifyMfaSetup: jest.fn(),
  disableMfa: jest.fn(),
  initiateSso: jest.fn(),
  handleSsoCallback: jest.fn(),
  verifyGuestToken: jest.fn(),
  listDevices: jest.fn(),
  forgetDevice: jest.fn(),
  getUserInfo: jest.fn(),
  deleteUser: jest.fn(),
};

jest.mock("@/platform/auth/config", () => ({
  getAuthProvider: () => mockProvider,
  hasAuthProvider: () => true,
  registerAuthProvider: jest.fn(),
}));

jest.mock("@/platform/auth/auth-init", () => ({
  initAuth: jest.fn(),
}));

jest.mock("@/platform/auth/audit", () => ({
  writeAuditLog: jest.fn(),
}));

jest.mock("@/platform/auth/password-policy", () => ({
  validatePassword: jest.fn().mockReturnValue([]),
}));

function makeRequest(body: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost/api/auth/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function makeEmptyRequest(headers?: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost/api/auth/test", {
    method: "POST",
    headers: headers ?? {},
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ============================================================
// POST /api/auth/sign-in
// ============================================================
describe("POST /api/auth/sign-in", () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import("@/app/api/auth/sign-in/route");
    handler = mod.POST;
  });

  it("returns success with tokens on valid sign-in", async () => {
    mockProvider.signIn.mockResolvedValue({
      success: true,
      userId: "user-123",
      accessToken: "tok",
      refreshToken: "ref",
      expiresIn: 3600,
    });

    const res = await handler(
      makeRequest({ email: "test@example.com", password: "pass" })
    );
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.accessToken).toBe("tok");
  });

  it("sets session cookie on successful sign-in", async () => {
    mockProvider.signIn.mockResolvedValue({
      success: true,
      accessToken: "tok",
      expiresIn: 3600,
    });

    const res = await handler(
      makeRequest({ email: "test@example.com", password: "pass" })
    );
    const setCookie = res.headers.get("set-cookie");

    expect(setCookie).toContain("pf_has_session=true");
  });

  it("returns 400 when email missing", async () => {
    const res = await handler(makeRequest({ password: "pass" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when password missing", async () => {
    const res = await handler(makeRequest({ email: "test@example.com" }));
    expect(res.status).toBe(400);
  });

  it("returns error on failed sign-in", async () => {
    mockProvider.signIn.mockResolvedValue({
      success: false,
      error: "Invalid credentials",
    });

    const res = await handler(
      makeRequest({ email: "test@example.com", password: "wrong" })
    );
    const body = await res.json();

    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid credentials");
  });
});

// ============================================================
// POST /api/auth/sign-up
// ============================================================
describe("POST /api/auth/sign-up", () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import("@/app/api/auth/sign-up/route");
    handler = mod.POST;
  });

  it("returns success on valid sign-up", async () => {
    mockProvider.signUp.mockResolvedValue({
      success: true,
      userId: "new-user",
      emailVerificationRequired: true,
    });

    const res = await handler(
      makeRequest({ email: "new@example.com", password: "SecurePass1!" })
    );
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.emailVerificationRequired).toBe(true);
  });

  it("returns 400 when email missing", async () => {
    const res = await handler(makeRequest({ password: "pass" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when password violates policy", async () => {
    const { validatePassword } = await import("@/platform/auth/password-policy");
    (validatePassword as jest.Mock).mockReturnValueOnce([
      "Must be at least 12 characters",
    ]);

    const res = await handler(
      makeRequest({ email: "new@example.com", password: "short" })
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.violations).toContain("Must be at least 12 characters");
  });
});

// ============================================================
// POST /api/auth/sign-out
// ============================================================
describe("POST /api/auth/sign-out", () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import("@/app/api/auth/sign-out/route");
    handler = mod.POST;
  });

  it("clears session cookie", async () => {
    mockProvider.signOut.mockResolvedValue(undefined);

    const res = await handler(makeEmptyRequest({ authorization: "Bearer test-token" }));
    const body = await res.json();
    const setCookie = res.headers.get("set-cookie");

    expect(body.success).toBe(true);
    expect(setCookie).toContain("pf_has_session=");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("succeeds even without token", async () => {
    const res = await handler(makeEmptyRequest());
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

// ============================================================
// POST /api/auth/forgot-password
// ============================================================
describe("POST /api/auth/forgot-password", () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import("@/app/api/auth/forgot-password/route");
    handler = mod.POST;
  });

  it("returns success", async () => {
    mockProvider.forgotPassword.mockResolvedValue({
      success: true,
      deliveryMedium: "email",
    });

    const res = await handler(makeRequest({ email: "test@example.com" }));
    const body = await res.json();

    expect(body.success).toBe(true);
  });

  it("returns 400 when email missing", async () => {
    const res = await handler(makeRequest({}));
    expect(res.status).toBe(400);
  });
});

// ============================================================
// POST /api/auth/confirm-forgot-password
// ============================================================
describe("POST /api/auth/confirm-forgot-password", () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import("@/app/api/auth/confirm-forgot-password/route");
    handler = mod.POST;
  });

  it("resets password", async () => {
    mockProvider.confirmForgotPassword.mockResolvedValue({ success: true });

    const res = await handler(
      makeRequest({ email: "test@example.com", code: "123456", newPassword: "NewPass1!" })
    );
    const body = await res.json();

    expect(body.success).toBe(true);
  });

  it("returns 400 when fields missing", async () => {
    const res = await handler(makeRequest({ email: "test@example.com" }));
    expect(res.status).toBe(400);
  });
});

// ============================================================
// POST /api/auth/verify-email
// ============================================================
describe("POST /api/auth/verify-email", () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import("@/app/api/auth/verify-email/route");
    handler = mod.POST;
  });

  it("verifies email", async () => {
    mockProvider.confirmEmailVerification.mockResolvedValue({ success: true });

    const res = await handler(makeRequest({ email: "test@example.com", code: "123456" }));
    const body = await res.json();

    expect(body.success).toBe(true);
  });

  it("returns 400 when fields missing", async () => {
    const res = await handler(makeRequest({ email: "test@example.com" }));
    expect(res.status).toBe(400);
  });
});

// ============================================================
// POST /api/auth/resend-verification
// ============================================================
describe("POST /api/auth/resend-verification", () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import("@/app/api/auth/resend-verification/route");
    handler = mod.POST;
  });

  it("resends code", async () => {
    mockProvider.resendEmailVerification.mockResolvedValue({ success: true });

    const res = await handler(makeRequest({ email: "test@example.com" }));
    const body = await res.json();

    expect(body.success).toBe(true);
  });

  it("returns 400 when email missing", async () => {
    const res = await handler(makeRequest({}));
    expect(res.status).toBe(400);
  });
});

// ============================================================
// POST /api/auth/mfa-challenge
// ============================================================
describe("POST /api/auth/mfa-challenge", () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import("@/app/api/auth/mfa-challenge/route");
    handler = mod.POST;
  });

  it("responds to MFA challenge", async () => {
    mockProvider.respondToMfaChallenge.mockResolvedValue({
      success: true,
      accessToken: "mfa-tok",
    });

    const res = await handler(makeRequest({ session: "mfa-session", code: "123456" }));
    const body = await res.json();

    expect(body.success).toBe(true);
  });

  it("returns 400 when fields missing", async () => {
    const res = await handler(makeRequest({ session: "mfa-session" }));
    expect(res.status).toBe(400);
  });
});

// ============================================================
// POST /api/auth/guest
// ============================================================
describe("POST /api/auth/guest", () => {
  let handler: () => Promise<Response>;

  beforeEach(async () => {
    const mod = await import("@/app/api/auth/guest/route");
    handler = mod.POST;
  });

  it("creates guest token and sets cookie", async () => {
    mockProvider.createGuestToken.mockResolvedValue({
      success: true,
      guestId: "guest-123",
      token: "guest.tok",
      expiresAt: 9999999999,
    });

    const res = await handler();
    const body = await res.json();
    const setCookie = res.headers.get("set-cookie");

    expect(body.success).toBe(true);
    expect(body.guestId).toBe("guest-123");
    expect(setCookie).toContain("pf_has_session=true");
  });
});
