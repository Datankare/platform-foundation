/**
 * __tests__/contract/auth-provider-contract.ts
 *
 * AuthProvider conformance kit (TCK) — ADR-027.
 *
 * Provider-agnostic behavioral contract for any AuthProvider implementation.
 * PF ships this; PF runs it against the mock and its reference Cognito impl;
 * consumers run it against their own implementation by supplying fixtures.
 *
 * The kit is parametrized by a fixtures adapter, NOT just a provider factory:
 *   - AUTH_CONTRACT below holds the canonical INPUTS that select contract
 *     behavior (passwords, codes, SSO provider). Every implementation honors
 *     these — the mock by hardcoding, a real impl by routing its backend stub
 *     on the same values.
 *   - AuthContractFixtures holds the impl-specific OPAQUE values (tokens,
 *     sessions, guest tokens) that the implementation interprets without a
 *     contract-defined shape. The mock supplies its magic strings; the Cognito
 *     arm supplies fakeJwt-based tokens and the sessions its fetch router
 *     accepts.
 *
 * This is the executable form of "any real provider implementation must pass
 * these same tests" — replacing the manual swap instruction the old
 * auth-provider.test.ts only described in a docstring.
 *
 * This file is NOT a *.test.ts, so Jest never runs it standalone.
 *
 * GenAI principles: P1, P6, P10.
 */

import type { AuthProvider } from "@/platform/auth/provider";

/** Canonical inputs every AuthProvider implementation must honor. */
export const AUTH_CONTRACT = {
  email: "test@example.com",
  newEmail: "new@example.com",
  correctPassword: "correct-password",
  wrongPassword: "wrong-password",
  mfaPassword: "mfa-required",
  newPasswordTrigger: "new-password-required",
  strongPassword: "SecurePass123!",
  newStrongPassword: "NewStrongPass123!",
  weakPassword: "weak",
  currentPassword: "current-password",
  resetCode: "123456",
  totpCode: "123456",
  invalidTotp: "000000",
  deviceId: "device-001",
  ssoProvider: "google" as const,
  redirectUri: "http://localhost:3000/api/auth/callback",
  ssoCode: "auth-code-123",
} as const;

/** Impl-specific opaque values supplied by each arm. */
export interface AuthContractFixtures {
  makeProvider: () => AuthProvider | Promise<AuthProvider>;
  validAccessToken: string;
  invalidAccessToken: string;
  validRefreshToken: string;
  mfaSession: string;
  newPasswordSession: string;
  validGuestToken: string;
  invalidGuestToken: string;
}

/**
 * Run the full AuthProvider behavioral contract against an implementation.
 */
export function runAuthProviderContract(fx: AuthContractFixtures): void {
  const C = AUTH_CONTRACT;
  let auth: AuthProvider;

  beforeEach(async () => {
    auth = await fx.makeProvider();
  });

  describe("signUp", () => {
    it("returns success with userId and emailVerificationRequired", async () => {
      const result = await auth.signUp(C.newEmail, C.strongPassword);
      expect(result.success).toBe(true);
      expect(result.userId).toBeDefined();
      expect(result.emailVerificationRequired).toBe(true);
    });
  });

  describe("signIn", () => {
    it("returns tokens on successful sign-in", async () => {
      const result = await auth.signIn(C.email, C.correctPassword);
      expect(result.success).toBe(true);
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.userId).toBeDefined();
      expect(result.expiresIn).toBeGreaterThan(0);
    });

    it("returns error on wrong password", async () => {
      const result = await auth.signIn(C.email, C.wrongPassword);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("returns mfaRequired when MFA is enabled", async () => {
      const result = await auth.signIn(C.email, C.mfaPassword);
      // An in-progress challenge means sign-in is NOT complete: success is false
      // (consistent with the newPasswordRequired case and with Cognito). The
      // contract pins the challenge signal, the session, and success === false.
      expect(result.success).toBe(false);
      expect(result.mfaRequired).toBe(true);
      expect(result.mfaSession).toBeDefined();
    });

    it("returns newPasswordRequired when a temporary password must be reset", async () => {
      const result = await auth.signIn(C.email, C.newPasswordTrigger);
      expect(result.success).toBe(false);
      expect(result.newPasswordRequired).toBe(true);
      expect(result.challengeSession).toBeDefined();
    });
  });

  describe("signOut", () => {
    it("completes without error", async () => {
      await expect(auth.signOut(fx.validAccessToken)).resolves.toBeUndefined();
    });
  });

  describe("verifyToken", () => {
    it("returns payload for valid token", async () => {
      const payload = await auth.verifyToken(fx.validAccessToken);
      expect(payload).not.toBeNull();
      expect(payload!.sub).toBeDefined();
      expect(payload!.email).toBeDefined();
      expect(payload!.emailVerified).toBe(true);
      expect(payload!.exp).toBeGreaterThan(payload!.iat);
    });

    it("returns null for invalid token", async () => {
      const payload = await auth.verifyToken(fx.invalidAccessToken);
      expect(payload).toBeNull();
    });
  });

  describe("refreshToken", () => {
    it("returns new session with fresh tokens", async () => {
      const session = await auth.refreshToken(fx.validRefreshToken);
      expect(session).not.toBeNull();
      expect(session!.accessToken).toBeDefined();
      expect(session!.refreshToken).toBeDefined();
      // expiresAt is a UNIX timestamp in epoch SECONDS (contract unit). The
      // upper bound also rejects a milliseconds value (which would land far
      // beyond a year out), so a wrong-unit implementation fails here.
      const nowSec = Math.floor(Date.now() / 1000);
      expect(session!.expiresAt).toBeGreaterThan(nowSec);
      expect(session!.expiresAt).toBeLessThan(nowSec + 365 * 24 * 3600);
    });
  });

  describe("password recovery", () => {
    it("forgotPassword initiates recovery", async () => {
      const result = await auth.forgotPassword(C.email);
      expect(result.success).toBe(true);
    });

    it("confirmForgotPassword completes reset", async () => {
      const result = await auth.confirmForgotPassword(
        C.email,
        C.resetCode,
        C.newStrongPassword
      );
      expect(result.success).toBe(true);
    });
  });

  describe("changePassword", () => {
    it("succeeds with correct current password", async () => {
      const result = await auth.changePassword(
        fx.validAccessToken,
        C.currentPassword,
        C.newStrongPassword
      );
      expect(result.success).toBe(true);
    });

    it("fails with wrong current password", async () => {
      const result = await auth.changePassword(
        fx.validAccessToken,
        C.wrongPassword,
        C.newStrongPassword
      );
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("email verification", () => {
    it("confirms email verification", async () => {
      const result = await auth.confirmEmailVerification(C.email, C.resetCode);
      expect(result.success).toBe(true);
    });

    it("resends verification email", async () => {
      const result = await auth.resendEmailVerification(C.email);
      expect(result.success).toBe(true);
    });
  });

  describe("MFA", () => {
    it("sets up TOTP MFA", async () => {
      const result = await auth.setupMfa(fx.validAccessToken);
      expect(result.success).toBe(true);
      expect(result.secretCode).toBeDefined();
      expect(result.qrCodeUri).toBeDefined();
    });

    it("verifies MFA setup with TOTP code", async () => {
      const result = await auth.verifyMfaSetup(fx.validAccessToken, C.totpCode);
      expect(result.success).toBe(true);
    });

    it("responds to MFA challenge with valid code", async () => {
      const result = await auth.respondToMfaChallenge(fx.mfaSession, C.totpCode);
      expect(result.success).toBe(true);
      expect(result.accessToken).toBeDefined();
    });

    it("rejects invalid MFA code", async () => {
      const result = await auth.respondToMfaChallenge(fx.mfaSession, C.invalidTotp);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("responds to new-password challenge and returns tokens", async () => {
      const result = await auth.respondToNewPasswordChallenge(
        fx.newPasswordSession,
        C.newStrongPassword,
        C.email
      );
      expect(result.success).toBe(true);
      expect(result.accessToken).toBeDefined();
    });

    it("rejects a weak new password", async () => {
      const result = await auth.respondToNewPasswordChallenge(
        fx.newPasswordSession,
        C.weakPassword,
        C.email
      );
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("disables MFA", async () => {
      const result = await auth.disableMfa(fx.validAccessToken);
      expect(result.success).toBe(true);
    });
  });

  describe("SSO", () => {
    it("initiates SSO with redirect URL", async () => {
      const result = await auth.initiateSso(C.ssoProvider, C.redirectUri);
      expect(result.success).toBe(true);
      // Case-insensitive: providers may capitalize the IdP name (e.g. "Google").
      expect((result.redirectUrl ?? "").toLowerCase()).toContain(C.ssoProvider);
    });

    it("handles SSO callback and returns tokens", async () => {
      const result = await auth.handleSsoCallback(
        C.ssoProvider,
        C.ssoCode,
        C.redirectUri
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
      // expiresAt is a UNIX timestamp in epoch SECONDS (contract unit).
      const nowSec = Math.floor(Date.now() / 1000);
      expect(result.expiresAt).toBeGreaterThan(nowSec);
      expect(result.expiresAt).toBeLessThan(nowSec + 365 * 24 * 3600);
    });

    it("verifies a valid guest token", async () => {
      const result = await auth.verifyGuestToken(fx.validGuestToken);
      expect(result.valid).toBe(true);
      expect(result.guestId).toBeDefined();
    });

    it("rejects an invalid guest token", async () => {
      const result = await auth.verifyGuestToken(fx.invalidGuestToken);
      expect(result.valid).toBe(false);
    });
  });

  describe("device management", () => {
    it("lists devices", async () => {
      const devices = await auth.listDevices(fx.validAccessToken);
      expect(devices.length).toBeGreaterThan(0);
      expect(devices[0].deviceId).toBeDefined();
      expect(devices[0].lastUsedAt).toBeDefined();
    });

    it("forgets a device", async () => {
      const result = await auth.forgetDevice(fx.validAccessToken, C.deviceId);
      expect(result.success).toBe(true);
    });
  });

  describe("user info", () => {
    it("returns user info for valid token", async () => {
      const info = await auth.getUserInfo(fx.validAccessToken);
      expect(info).not.toBeNull();
      expect(info!.userId).toBeDefined();
      expect(info!.email).toBeDefined();
      expect(info!.emailVerified).toBe(true);
    });
  });

  describe("account deletion", () => {
    it("deletes user account", async () => {
      const result = await auth.deleteUser(fx.validAccessToken);
      expect(result.success).toBe(true);
    });
  });
}
