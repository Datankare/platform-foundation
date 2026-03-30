# Integrating Your Own Auth Provider

This guide shows how to connect any authentication provider (Auth0, Firebase,
Clerk, Supabase Auth, or your own) to platform-foundation's auth system.

## How It Works

Platform-foundation uses an `AuthProvider` interface as the auth contract.
Every route, middleware, and component depends on this interface — never on
a specific provider. You implement the interface once, register it, and
everything works.

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Login Screen   │────▶│   AuthProvider    │────▶│  Your Auth  │
│   Auth Middleware │────▶│   (interface)     │     │  Service    │
│   Profile Page   │────▶│                  │     │  (Cognito,  │
│   Admin UI       │────▶│  verifyToken()   │     │   Auth0,    │
│                  │     │  signIn()        │     │   Firebase)  │
└─────────────────┘     └──────────────────┘     └─────────────┘
```

## Step-by-Step Integration

### Step 1: Create Your Provider File

Create a new file in `platform/auth/` for your provider:

```typescript
// platform/auth/my-provider.ts

import type { AuthProvider } from "@/platform/auth/provider";
import type {
  AuthResult,
  AuthSession,
  AuthToken,
  TokenPayload,
  // ... import other types you need
} from "@/platform/auth/types";

export function createMyAuthProvider(config: {
  apiKey: string;
  domain: string;
}): AuthProvider {
  return {
    async signUp(email: string, password: string): Promise<AuthResult> {
      // Call your auth service's sign-up API
      const response = await fetch(`https://${config.domain}/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        return { success: false, error: "Sign-up failed" };
      }

      const data = await response.json();
      return {
        success: true,
        userId: data.userId,
        emailVerificationRequired: true,
      };
    },

    async signIn(email: string, password: string): Promise<AuthResult> {
      // Call your auth service's sign-in API
      // Return tokens on success, error on failure
      // Set mfaRequired: true if MFA challenge is needed
      throw new Error("Not implemented");
    },

    async signOut(accessToken: AuthToken): Promise<void> {
      // Invalidate the session/refresh token
      throw new Error("Not implemented");
    },

    async verifyToken(accessToken: AuthToken): Promise<TokenPayload | null> {
      // Verify the JWT signature and expiry
      // Return decoded payload if valid, null if invalid
      // This is called on EVERY protected API request — keep it fast
      throw new Error("Not implemented");
    },

    async refreshToken(refreshToken: AuthToken): Promise<AuthSession | null> {
      // Exchange a refresh token for new access + refresh tokens
      throw new Error("Not implemented");
    },

    // ... implement all other methods from the AuthProvider interface
    // See platform/auth/provider.ts for the complete list with JSDoc
    // See platform/auth/mock-provider.ts for a reference implementation
  } as AuthProvider;
}
```

### Step 2: Register Your Provider

Create or update `platform/auth/config.ts` to export your provider:

```typescript
// platform/auth/config.ts

import { createMyAuthProvider } from "@/platform/auth/my-provider";
import type { AuthProvider } from "@/platform/auth/provider";

let authProvider: AuthProvider | null = null;

export function getAuthProvider(): AuthProvider {
  if (authProvider) return authProvider;

  authProvider = createMyAuthProvider({
    apiKey: process.env.MY_AUTH_API_KEY!,
    domain: process.env.MY_AUTH_DOMAIN!,
  });

  return authProvider;
}
```

### Step 3: Verify with Contract Tests

The existing contract tests in `__tests__/auth-provider.test.ts` verify
every method of the AuthProvider interface. Run them against your implementation:

```typescript
// __tests__/my-provider.test.ts

import { createMyAuthProvider } from "@/platform/auth/my-provider";
import type { AuthProvider } from "@/platform/auth/provider";

describe("MyAuthProvider contract", () => {
  let auth: AuthProvider;

  beforeEach(() => {
    auth = createMyAuthProvider({
      apiKey: "test-key",
      domain: "test.auth.example.com",
    });
  });

  // Copy the test cases from __tests__/auth-provider.test.ts
  // They verify the interface contract — every provider must pass them
});
```

### Step 4: Update Environment Variables

Add your provider's configuration to `.env.local`:

```bash
# Your auth provider
MY_AUTH_API_KEY=your-api-key
MY_AUTH_DOMAIN=your-auth-domain.example.com
```

And update `.env.example` to document the new variables.

## Provider Implementation Checklist

Every AuthProvider implementation must handle these correctly:

### Authentication

- [ ] `signUp` — registers user, returns userId, sets emailVerificationRequired
- [ ] `signIn` — returns tokens on success, error on failure, mfaRequired if MFA enabled
- [ ] `signOut` — invalidates refresh token
- [ ] `verifyToken` — fast JWT verification (called on every request)
- [ ] `refreshToken` — exchanges refresh token for new tokens

### Password Management

- [ ] `forgotPassword` — sends reset code to email
- [ ] `confirmForgotPassword` — verifies code + sets new password
- [ ] `changePassword` — requires current password verification

### Email Verification

- [ ] `confirmEmailVerification` — verifies code from sign-up email
- [ ] `resendEmailVerification` — resends the verification code

### Multi-Factor Authentication

- [ ] `setupMfa` — returns TOTP secret + QR code URI
- [ ] `verifyMfaSetup` — confirms first TOTP code
- [ ] `respondToMfaChallenge` — completes MFA during sign-in
- [ ] `disableMfa` — removes MFA requirement

### SSO (Social Sign-In)

- [ ] `initiateSso` — returns redirect URL for Google/Apple/Microsoft
- [ ] `handleSsoCallback` — exchanges auth code for tokens

### Guest Mode

- [ ] `createGuestToken` — generates persistent guest identity
- [ ] `verifyGuestToken` — validates guest token

### Device Management

- [ ] `listDevices` — returns devices user has signed in from
- [ ] `forgetDevice` — removes a specific device

### Account Management

- [ ] `getUserInfo` — returns email, userId, emailVerified
- [ ] `deleteUser` — removes user from auth provider (GDPR)

## Common Provider Examples

### Auth0

```typescript
import { AuthProvider } from "@/platform/auth/provider";
import { ManagementClient, AuthenticationClient } from "auth0";

export function createAuth0Provider(config: {
  domain: string;
  clientId: string;
  clientSecret: string;
}): AuthProvider {
  const authClient = new AuthenticationClient({
    domain: config.domain,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });

  return {
    async signIn(email, password) {
      const result = await authClient.oauth.passwordGrant({
        username: email,
        password,
        scope: "openid email profile",
      });
      return {
        success: true,
        accessToken: result.data.access_token,
        refreshToken: result.data.refresh_token,
        expiresIn: result.data.expires_in,
      };
    },
    // ... implement remaining methods
  } as AuthProvider;
}
```

### Firebase Auth

```typescript
import { AuthProvider } from "@/platform/auth/provider";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";

export function createFirebaseProvider(): AuthProvider {
  const auth = getAuth();

  return {
    async signIn(email, password) {
      const credential = await signInWithEmailAndPassword(auth, email, password);
      const token = await credential.user.getIdToken();
      return {
        success: true,
        userId: credential.user.uid,
        accessToken: token,
        refreshToken: credential.user.refreshToken,
      };
    },
    // ... implement remaining methods
  } as AuthProvider;
}
```

### Supabase Auth (using Supabase's built-in auth instead of Cognito)

```typescript
import { AuthProvider } from "@/platform/auth/provider";
import { createClient } from "@supabase/supabase-js";

export function createSupabaseAuthProvider(config: {
  url: string;
  anonKey: string;
}): AuthProvider {
  const supabase = createClient(config.url, config.anonKey);

  return {
    async signIn(email, password) {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) return { success: false, error: error.message };
      return {
        success: true,
        userId: data.user.id,
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresIn: data.session.expires_in,
      };
    },
    // ... implement remaining methods
  } as AuthProvider;
}
```

## Key Design Rules

1. **Never import your provider directly in routes or components.**
   Always go through `getAuthProvider()` from `platform/auth/config.ts`.

2. **verifyToken must be fast.**
   It runs on every protected API request. Use local JWT verification
   (check signature + expiry) — don't call an external API.

3. **Return result objects, never throw for auth failures.**
   `signIn` returns `{ success: false, error: "..." }`, not an exception.
   Exceptions are for infrastructure failures (network down, config missing).

4. **The mock provider is your test reference.**
   `platform/auth/mock-provider.ts` shows expected return shapes for every method.
   Your implementation should match these shapes exactly.

5. **Run the contract tests.**
   The 28 tests in `__tests__/auth-provider.test.ts` define the interface contract.
   If your provider passes them, it works with the platform.
