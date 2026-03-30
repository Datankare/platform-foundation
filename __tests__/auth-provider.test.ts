/**
 * Auth provider interface contract tests.
 *
 * These tests verify the AuthProvider interface contract using the mock
 * implementation. Any real provider implementation must pass these same
 * tests — swap createMockAuthProvider for createCognitoAuthProvider.
 */

import { createMockAuthProvider } from "@/platform/auth/mock-provider";
import type { AuthProvider } from "@/platform/auth/provider";

describe("AuthProvider interface contract", () => {
  let auth: AuthProvider;

  beforeEach(() => {
    auth = createMockAuthProvider();
  });

  describe("signUp", () => {
    it("returns success with userId and emailVerificationRequired", async () => {
      const result = await auth.signUp("new@example.com", "SecurePass123!");
      expect(result.success).toBe(true);
      expect(result.userId).toBeDefined();
      expect(result.emailVerificationRequired).toBe(true);
    });
  });

  describe("signIn", () => {
    it("returns tokens on successful sign-in", async () => {
      const result = await auth.signIn("test@example.com", "correct-password");
      expect(result.success).toBe(true);
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.userId).toBeDefined();
      expect(result.expiresIn).toBeGreaterThan(0);
    });

    it("returns error on wrong password", async () => {
      const result = await auth.signIn("test@example.com", "wrong-password");
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("returns mfaRequired when MFA is enabled", async () => {
      const result = await auth.signIn("test@example.com", "mfa-required");
      expect(result.success).toBe(true);
      expect(result.mfaRequired).toBe(true);
      expect(result.mfaSession).toBeDefined();
    });
  });

  describe("signOut", () => {
    it("completes without error", async () => {
      await expect(auth.signOut("mock-access-token")).resolves.toBeUndefined();
    });
  });

  describe("verifyToken", () => {
    it("returns payload for valid token", async () => {
      const payload = await auth.verifyToken("mock-access-token");
      expect(payload).not.toBeNull();
      expect(payload!.sub).toBeDefined();
      expect(payload!.email).toBeDefined();
      expect(payload!.emailVerified).toBe(true);
      expect(payload!.exp).toBeGreaterThan(payload!.iat);
    });

    it("returns null for invalid token", async () => {
      const payload = await auth.verifyToken("invalid-token");
      expect(payload).toBeNull();
    });
  });

  describe("refreshToken", () => {
    it("returns new session with fresh tokens", async () => {
      const session = await auth.refreshToken("mock-refresh-token");
      expect(session).not.toBeNull();
      expect(session!.accessToken).toBeDefined();
      expect(session!.refreshToken).toBeDefined();
      expect(session!.expiresAt).toBeGreaterThan(Date.now());
    });
  });

  describe("password recovery", () => {
    it("forgotPassword initiates recovery", async () => {
      const result = await auth.forgotPassword("test@example.com");
      expect(result.success).toBe(true);
    });

    it("confirmForgotPassword completes reset", async () => {
      const result = await auth.confirmForgotPassword(
        "test@example.com",
        "123456",
        "NewSecurePass123!"
      );
      expect(result.success).toBe(true);
    });
  });

  describe("changePassword", () => {
    it("succeeds with correct current password", async () => {
      const result = await auth.changePassword(
        "mock-access-token",
        "current-password",
        "NewSecurePass123!"
      );
      expect(result.success).toBe(true);
    });

    it("fails with wrong current password", async () => {
      const result = await auth.changePassword(
        "mock-access-token",
        "wrong-password",
        "NewSecurePass123!"
      );
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("email verification", () => {
    it("confirms email verification", async () => {
      const result = await auth.confirmEmailVerification("test@example.com", "123456");
      expect(result.success).toBe(true);
    });

    it("resends verification email", async () => {
      const result = await auth.resendEmailVerification("test@example.com");
      expect(result.success).toBe(true);
    });
  });

  describe("MFA", () => {
    it("sets up TOTP MFA", async () => {
      const result = await auth.setupMfa("mock-access-token");
      expect(result.success).toBe(true);
      expect(result.secretCode).toBeDefined();
      expect(result.qrCodeUri).toBeDefined();
    });

    it("verifies MFA setup with TOTP code", async () => {
      const result = await auth.verifyMfaSetup("mock-access-token", "123456");
      expect(result.success).toBe(true);
      expect(result.session).toBeDefined();
    });

    it("responds to MFA challenge with valid code", async () => {
      const result = await auth.respondToMfaChallenge("mock-mfa-session", "123456");
      expect(result.success).toBe(true);
      expect(result.accessToken).toBeDefined();
    });

    it("rejects invalid MFA code", async () => {
      const result = await auth.respondToMfaChallenge("mock-mfa-session", "000000");
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("disables MFA", async () => {
      const result = await auth.disableMfa("mock-access-token");
      expect(result.success).toBe(true);
    });
  });

  describe("SSO", () => {
    it("initiates Google SSO with redirect URL", async () => {
      const result = await auth.initiateSso(
        "google",
        "http://localhost:3000/api/auth/callback"
      );
      expect(result.success).toBe(true);
      expect(result.redirectUrl).toContain("google");
    });

    it("handles SSO callback and returns tokens", async () => {
      const result = await auth.handleSsoCallback(
        "google",
        "auth-code-123",
        "http://localhost:3000/api/auth/callback"
      );
      expect(result.success).toBe(true);
      expect(result.accessToken).toBeDefined();
      expect(result.userId).toBeDefined();
    });
  });

  describe("guest mode", () => {
    it("creates a guest token", async () => {
      const result = await auth.createGuestToken();
      expect(result.success).toBe(true);
      expect(result.guestId).toBeDefined();
      expect(result.token).toBeDefined();
      expect(result.expiresAt).toBeGreaterThan(Date.now());
    });

    it("verifies a valid guest token", async () => {
      const result = await auth.verifyGuestToken("mock-guest-token");
      expect(result.valid).toBe(true);
      expect(result.guestId).toBeDefined();
    });

    it("rejects an invalid guest token", async () => {
      const result = await auth.verifyGuestToken("invalid-guest-token");
      expect(result.valid).toBe(false);
    });
  });

  describe("device management", () => {
    it("lists devices", async () => {
      const devices = await auth.listDevices("mock-access-token");
      expect(devices.length).toBeGreaterThan(0);
      expect(devices[0].deviceId).toBeDefined();
      expect(devices[0].lastUsedAt).toBeDefined();
    });

    it("forgets a device", async () => {
      const result = await auth.forgetDevice("mock-access-token", "device-001");
      expect(result.success).toBe(true);
    });
  });

  describe("user info", () => {
    it("returns user info for valid token", async () => {
      const info = await auth.getUserInfo("mock-access-token");
      expect(info).not.toBeNull();
      expect(info!.userId).toBeDefined();
      expect(info!.email).toBeDefined();
      expect(info!.emailVerified).toBe(true);
    });
  });

  describe("account deletion", () => {
    it("deletes user account", async () => {
      const result = await auth.deleteUser("mock-access-token");
      expect(result.success).toBe(true);
    });
  });
});
