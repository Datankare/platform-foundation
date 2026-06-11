/**
 * Auth provider interface contract — mock arm.
 *
 * Runs the synced AuthProvider conformance kit (ADR-027) against the mock
 * implementation. The same kit is run against concrete implementations in
 * their own arms:
 *   - PF reference impl:  cognito-provider-contract.test.ts (this repo)
 *   - Consumers:          their own repo-owned arm (e.g. Playform/Cognito)
 *
 * The behavioral assertions live in __tests__/contract/auth-provider-contract.ts
 * so every implementation is verified against one shared source of truth. This
 * arm supplies the mock's opaque fixture values.
 */

import {
  runAuthProviderContract,
  type AuthContractFixtures,
} from "./contract/auth-provider-contract";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";

const mockFixtures: AuthContractFixtures = {
  makeProvider: () => createMockAuthProvider(),
  validAccessToken: "mock-access-token",
  invalidAccessToken: "invalid-token",
  validRefreshToken: "mock-refresh-token",
  mfaSession: "mock-mfa-session",
  newPasswordSession: "mock-new-password-session",
  validGuestToken: "mock-guest-token",
  invalidGuestToken: "invalid-guest-token",
};

describe("AuthProvider contract — mock provider", () => {
  runAuthProviderContract(mockFixtures);
});
