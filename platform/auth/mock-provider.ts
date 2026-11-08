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

import type { ErrorCode } from "@/platform/errors/registry";
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

const MOCK_USER_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const MOCK_EMAIL = "test@example.com";
const MOCK_ACCESS_TOKEN = "mock-access-token";
const MOCK_REFRESH_TOKEN = "mock-refresh-token";
const MOCK_SESSION_ID = "mock-session";
const MOCK_GUEST_ID = "mock-guest-001";

/**
 * Further test-double identities, by token (TASK-202): the E2E admin journeys need two
 * administrators — one asks for a change, a different one approves it (dual control never lets
 * the requester approve). Each signs in with a second factor, as staff must (audit A-9). Only the
 * test double knows them: a deployment never runs it (ADR-050 D1 — the environment contract
 * refuses the mock provider off the ci and local hosts).
 */
export const MOCK_EXTRA_IDENTITIES: Readonly<
  Record<string, { readonly sub: string; readonly email: string }>
> = {
  "mock-access-token:admin-a": {
    sub: "e2e00000-0000-4000-8000-00000000000a",
    email: "admin-a@e2e.test",
  },
  "mock-access-token:admin-b": {
    sub: "e2e00000-0000-4000-8000-00000000000b",
    email: "admin-b@e2e.test",
  },
};

export function createMockAuthProvider(overrides?: Partial<AuthProvider>): AuthProvider {
  // ADR-053 D2: the tenant each user is assigned, as a provider attribute would hold it.
  const tenants = new Map<string, string>();
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
        return {
          success: false,
          error: "Incorrect email or password",
          errorCode: "auth.invalid_credentials",
        };
      }
      if (password === "mfa-required") {
        return {
          success: false,
          mfaRequired: true,
          mfaSession: "mock-mfa-session",
        };
      }
      if (password === "new-password-required") {
        return {
          success: false,
          newPasswordRequired: true,
          challengeSession: "mock-new-password-session",
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
      const extra = Object.prototype.hasOwnProperty.call(
        MOCK_EXTRA_IDENTITIES,
        accessToken
      )
        ? MOCK_EXTRA_IDENTITIES[accessToken]
        : undefined;
      if (extra) {
        return {
          sub: extra.sub,
          email: extra.email,
          emailVerified: true,
          identityProviders: [],
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
          sessionId: `${MOCK_SESSION_ID}:${extra.sub}`,
          mfaEnabled: true,
          ...(tenants.has(extra.sub) ? { tenantId: tenants.get(extra.sub) } : {}),
        };
      }
      if (accessToken === MOCK_ACCESS_TOKEN) {
        return {
          sub: MOCK_USER_ID,
          email: MOCK_EMAIL,
          emailVerified: true,
          // Verified by the (mock) pool itself: a native user (review 16 L8).
          identityProviders: [],
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
          // One sign-in session for the one mock token (TokenPayload.sessionId).
          sessionId: MOCK_SESSION_ID,
          // The mock user signs in with a second factor (audit A-9: staff must).
          mfaEnabled: true,
          ...(tenants.has(MOCK_USER_ID) ? { tenantId: tenants.get(MOCK_USER_ID) } : {}),
        };
      }
      return null;
    },

    async refreshToken(): Promise<AuthSession | null> {
      return {
        userId: MOCK_USER_ID,
        accessToken: "mock-refreshed-token",
        refreshToken: MOCK_REFRESH_TOKEN,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
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
        return {
          success: false,
          error: "Incorrect current password",
          errorCode: "auth.invalid_credentials",
        };
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
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      };
    },

    async respondToMfaChallenge(
      _mfaSession: string,
      totpCode: string,
      _username: string
    ): Promise<AuthResult> {
      if (totpCode === "000000") {
        return {
          success: false,
          error: "Invalid TOTP code",
          errorCode: "auth.code_invalid",
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

    async respondToNewPasswordChallenge(
      _challengeSession: string,
      newPassword: string,
      _username: string
    ): Promise<AuthResult> {
      if (newPassword === "weak") {
        return {
          success: false,
          error: "Password does not meet requirements",
          errorCode: "auth.password_policy",
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

    async disableMfa(): Promise<{ success: boolean; error?: string }> {
      return { success: true };
    },

    // Step-up (audit C-3): "wrong-password" and the code 000000 are refused, as elsewhere here;
    // the mock account has no second factor, so a password alone (code null) proves it.
    async confirmCurrentFactor(
      _accessToken: AuthToken,
      password: string,
      totpCode: string | null
    ): Promise<{ success: boolean; error?: string; errorCode?: ErrorCode }> {
      if (password === "wrong-password") {
        return {
          success: false,
          error: "Incorrect password",
          errorCode: "auth.invalid_credentials",
        };
      }
      if (totpCode === "000000") {
        return {
          success: false,
          error: "Invalid TOTP code",
          errorCode: "auth.code_invalid",
        };
      }
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
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
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

    async assignTenant(userId: string, tenantId: string) {
      tenants.set(userId, tenantId);
      return { success: true };
    },

    async getUserTenant(userId: string) {
      return tenants.get(userId) ?? null;
    },

    async checkTenantAttribute() {
      return { state: "ready" as const };
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

    async adminDeleteUser(): Promise<{
      success: boolean;
      notFound?: boolean;
      error?: string;
    }> {
      return { success: true };
    },

    identityPoolId(): string {
      return "mock-pool";
    },

    async confirmIdentityPool(): Promise<boolean> {
      return true;
    },

    async identityInPool(): Promise<boolean | undefined> {
      return true;
    },
  };

  return { ...base, ...overrides };
}
