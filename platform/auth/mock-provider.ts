/**
 * platform/auth/mock-provider.ts — Mock AuthProvider for testing
 *
 * Use this in unit and integration tests. Provides predictable responses
 * without hitting any external auth service.
 *
 * Usage in tests:
 *   import { createMockAuthProvider } from "@/platform/auth/mock-provider";
 *   const auth = createMockAuthProvider();
 *   const result = await auth.signIn("test@example.com", "password");
 */

import type { AuthProvider } from "@/platform/auth/provider";
import type {
  AuthResult,
  AuthSession,
  AuthToken,
  ChangePasswordResult,
  DeviceInfo,
  EmailVerificationResult,
  GuestTokenResult,
  MfaSetupResult,
  MfaVerifyResult,
  PasswordRecoveryResult,
  PasswordResetResult,
  SsoCallbackResult,
  SsoInitResult,
  SsoProvider,
  TokenPayload,
} from "@/platform/auth/types";

const MOCK_USER_ID = "mock-user-001";
const MOCK_EMAIL = "test@example.com";
const MOCK_ACCESS_TOKEN = "mock-access-token";
const MOCK_REFRESH_TOKEN = "mock-refresh-token";
const MOCK_GUEST_ID = "mock-guest-001";

export function createMockAuthProvider(overrides?: Partial<AuthProvider>): AuthProvider {
  const base: AuthProvider = {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async signUp(email: string): Promise<AuthResult> {
      return {
        success: true,
        userId: MOCK_USER_ID,
        emailVerificationRequired: true,
      };
    },

    async signIn(email: string, password: string): Promise<AuthResult> {
      if (password === "wrong-password") {
        return { success: false, error: "Incorrect email or password" };
      }
      if (password === "mfa-required") {
        return {
          success: true,
          mfaRequired: true,
          mfaSession: "mock-mfa-session",
        };
      }
      return {
        success: true,
        userId: MOCK_USER_ID,
        accessToken: MOCK_ACCESS_TOKEN,
        refreshToken: MOCK_REFRESH_TOKEN,
        expiresIn: 3600,
      };
    },

    async signOut(): Promise<void> {
      // No-op for mock
    },

    async verifyToken(accessToken: AuthToken): Promise<TokenPayload | null> {
      if (accessToken === MOCK_ACCESS_TOKEN) {
        return {
          sub: MOCK_USER_ID,
          email: MOCK_EMAIL,
          emailVerified: true,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        };
      }
      return null;
    },

    async refreshToken(): Promise<AuthSession | null> {
      return {
        userId: MOCK_USER_ID,
        accessToken: "mock-refreshed-token",
        refreshToken: MOCK_REFRESH_TOKEN,
        expiresAt: Date.now() + 3600000,
      };
    },

    async forgotPassword(): Promise<PasswordRecoveryResult> {
      return { success: true, deliveryMedium: "EMAIL" };
    },

    async confirmForgotPassword(): Promise<PasswordResetResult> {
      return { success: true };
    },

    async changePassword(
      _accessToken: AuthToken,
      oldPassword: string
    ): Promise<ChangePasswordResult> {
      if (oldPassword === "wrong-password") {
        return { success: false, error: "Incorrect current password" };
      }
      return { success: true };
    },

    async confirmEmailVerification(): Promise<EmailVerificationResult> {
      return { success: true };
    },

    async resendEmailVerification(): Promise<EmailVerificationResult> {
      return { success: true };
    },

    async setupMfa(): Promise<MfaSetupResult> {
      return {
        success: true,
        secretCode: "MOCK-TOTP-SECRET",
        qrCodeUri: "otpauth://totp/Playform:test@example.com?secret=MOCK",
      };
    },

    async verifyMfaSetup(): Promise<MfaVerifyResult> {
      return {
        success: true,
        session: {
          userId: MOCK_USER_ID,
          accessToken: MOCK_ACCESS_TOKEN,
          refreshToken: MOCK_REFRESH_TOKEN,
          expiresAt: Date.now() + 3600000,
        },
      };
    },

    async respondToMfaChallenge(
      _mfaSession: string,
      totpCode: string
    ): Promise<AuthResult> {
      if (totpCode === "000000") {
        return { success: false, error: "Invalid TOTP code" };
      }
      return {
        success: true,
        userId: MOCK_USER_ID,
        accessToken: MOCK_ACCESS_TOKEN,
        refreshToken: MOCK_REFRESH_TOKEN,
        expiresIn: 3600,
      };
    },

    async disableMfa(): Promise<{ success: boolean; error?: string }> {
      return { success: true };
    },

    async initiateSso(
      provider: SsoProvider,
      redirectUri: string
    ): Promise<SsoInitResult> {
      return {
        success: true,
        redirectUrl: `https://mock-${provider}.example.com/auth?redirect=${encodeURIComponent(redirectUri)}`,
      };
    },

    async handleSsoCallback(): Promise<SsoCallbackResult> {
      return {
        success: true,
        userId: MOCK_USER_ID,
        accessToken: MOCK_ACCESS_TOKEN,
        refreshToken: MOCK_REFRESH_TOKEN,
        expiresIn: 3600,
      };
    },

    async createGuestToken(): Promise<GuestTokenResult> {
      return {
        success: true,
        guestId: MOCK_GUEST_ID,
        token: "mock-guest-token",
        expiresAt: Date.now() + 86400000,
      };
    },

    async verifyGuestToken(
      token: AuthToken
    ): Promise<{ valid: boolean; guestId?: string }> {
      if (token === "mock-guest-token") {
        return { valid: true, guestId: MOCK_GUEST_ID };
      }
      return { valid: false };
    },

    async listDevices(): Promise<DeviceInfo[]> {
      return [
        {
          deviceId: "device-001",
          deviceName: "Chrome on MacOS",
          lastUsedAt: new Date().toISOString(),
          isTrusted: true,
        },
      ];
    },

    async forgetDevice(): Promise<{ success: boolean; error?: string }> {
      return { success: true };
    },

    async getUserInfo() {
      return {
        userId: MOCK_USER_ID,
        email: MOCK_EMAIL,
        emailVerified: true,
      };
    },

    async deleteUser(): Promise<{ success: boolean; error?: string }> {
      return { success: true };
    },
  };

  return { ...base, ...overrides };
}
