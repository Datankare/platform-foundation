/**
 * ADR-051 / TASK-109: auth-provider results → HTTP responses (no more 200-on-failure).
 */
import { authResultResponse, isChallenge } from "@/platform/auth/auth-response";
import {
  passwordRuleViolations,
  validatePassword,
} from "@/platform/auth/password-policy";

jest.mock("@/lib/logger", () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

describe("authResultResponse", () => {
  it("success → 200 without the provider's error text", async () => {
    const res = authResultResponse({ success: true, error: "ignored" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it.each([
    [{ mfaRequired: true }],
    [{ newPasswordRequired: true }],
    [{ emailVerificationRequired: true, errorCode: "auth.email_not_verified" as const }],
  ])("challenge %p → 200", async (flags) => {
    const result = { success: false, error: "provider text", ...flags };
    expect(isChallenge(result)).toBe(true);
    const res = authResultResponse(result);
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain("provider text");
  });

  it.each([
    ["auth.invalid_credentials", 401],
    ["auth.account_exists", 409],
    ["auth.too_many_attempts", 429],
    ["auth.code_expired", 400],
    ["request.invalid_body", 400],
  ] as const)("failure %s → %i", async (errorCode, status) => {
    const res = authResultResponse({ success: false, error: "provider text", errorCode });
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.code).toBe(errorCode);
    expect(JSON.stringify(body)).not.toContain("provider text");
  });
});

describe("passwordRuleViolations", () => {
  const policy = {
    rotationDays: 90,
    minLength: 12,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSpecial: true,
    passwordHistoryCount: 5,
  };

  it("returns stable ids, and validatePassword keeps its English messages", () => {
    expect(passwordRuleViolations("aaa", policy)).toEqual([
      "min_length",
      "uppercase",
      "number",
      "special",
      "repeated",
    ]);
    expect(validatePassword("aaa", policy)).toEqual([
      "Must be at least 12 characters",
      "Must contain an uppercase letter",
      "Must contain a number",
      "Must contain a special character",
      "Password cannot be a single repeated character",
    ]);
    expect(passwordRuleViolations("Str0ng!Passphrase#42", policy)).toEqual([]);
  });
});
