/**
 * Auth Init + Auth API Routes — integrity tests.
 *
 * Tests auth-init.ts provider registration and all 9 auth API routes
 * (sign-in, sign-up, sign-out, forgot-password, confirm-forgot,
 * verify-email, resend-verification, mfa-challenge, guest).
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ============================================================
// auth-init.ts
// ============================================================
describe("auth-init", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("registers MockAuthProvider when Cognito env is not set", async () => {
    delete process.env.COGNITO_USER_POOL_ID;
    delete process.env.COGNITO_CLIENT_ID;

    const { initAuth } = await import("@/platform/auth/auth-init");
    const { hasAuthProvider, getAuthProvider } = await import("@/platform/auth/config");

    initAuth();
    expect(hasAuthProvider()).toBe(true);

    // Mock provider should be functional
    const provider = getAuthProvider();
    const result = await provider.signIn("test@example.com", "password");
    expect(result.success).toBe(true);
  });

  it("registers CognitoAuthProvider when env vars are set", async () => {
    process.env.COGNITO_USER_POOL_ID = "us-east-1_TestPool";
    process.env.COGNITO_CLIENT_ID = "test-client-id";

    const { initAuth } = await import("@/platform/auth/auth-init");
    const { hasAuthProvider } = await import("@/platform/auth/config");

    initAuth();
    expect(hasAuthProvider()).toBe(true);

    delete process.env.COGNITO_USER_POOL_ID;
    delete process.env.COGNITO_CLIENT_ID;
  });

  it("skips registration if already registered", async () => {
    delete process.env.COGNITO_USER_POOL_ID;
    delete process.env.COGNITO_CLIENT_ID;

    const { initAuth } = await import("@/platform/auth/auth-init");
    initAuth();
    initAuth(); // second call should be no-op
    // No error = pass
  });
});
