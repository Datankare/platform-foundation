/**
 * Password Policy Tests — Sprint 4 enhancements.
 *
 * Tests validatePassword (Phase 1 API + Sprint 4 breach/pattern checks),
 * validatePasswordEnhanced (strength scoring), and isBreachedPassword.
 *
 * getEffectivePasswordPolicy is Supabase-dependent → integration tests.
 */

// Mock dependencies before imports
jest.mock("@/lib/supabase/server", () => ({
  getSupabaseServiceClient: jest.fn(),
}));
jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import {
  validatePassword,
  validatePasswordEnhanced,
  isBreachedPassword,
} from "@/platform/auth/password-policy";
import type { PasswordPolicy } from "@/platform/auth/password-policy";

/** Standard test policy matching DEFAULT_POLICY */
const STRICT_POLICY: PasswordPolicy = {
  rotationDays: 90,
  minLength: 12,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSpecial: true,
  passwordHistoryCount: 5,
};

/** Lenient policy for testing Sprint 4 enhancements in isolation */
const LENIENT_POLICY: PasswordPolicy = {
  rotationDays: 0,
  minLength: 8,
  requireUppercase: false,
  requireLowercase: false,
  requireNumber: false,
  requireSpecial: false,
  passwordHistoryCount: 0,
};

describe("validatePassword — Phase 1 rules", () => {
  it("returns empty array for valid password", () => {
    const result = validatePassword("MyS3cure!Pass", STRICT_POLICY);
    expect(result).toEqual([]);
  });

  it("rejects short passwords", () => {
    const result = validatePassword("Sh0rt!", STRICT_POLICY);
    expect(result).toContainEqual(expect.stringContaining("at least 12 characters"));
  });

  it("rejects missing uppercase", () => {
    const result = validatePassword("nouppercase1!", STRICT_POLICY);
    expect(result).toContainEqual(expect.stringContaining("uppercase letter"));
  });

  it("rejects missing lowercase", () => {
    const result = validatePassword("NOLOWERCASE1!", STRICT_POLICY);
    expect(result).toContainEqual(expect.stringContaining("lowercase letter"));
  });

  it("rejects missing number", () => {
    const result = validatePassword("NoNumberHere!", STRICT_POLICY);
    expect(result).toContainEqual(expect.stringContaining("number"));
  });

  it("rejects missing special character", () => {
    const result = validatePassword("NoSpecialChar1", STRICT_POLICY);
    expect(result).toContainEqual(expect.stringContaining("special character"));
  });

  it("accumulates multiple violations", () => {
    const result = validatePassword("short", STRICT_POLICY);
    expect(result.length).toBeGreaterThan(1);
  });

  it("skips character class checks when policy disables them", () => {
    const result = validatePassword("simplepw", LENIENT_POLICY);
    // With lenient policy, only Sprint 4 checks apply
    expect(result).not.toContainEqual(expect.stringContaining("uppercase"));
    expect(result).not.toContainEqual(expect.stringContaining("lowercase"));
    expect(result).not.toContainEqual(expect.stringContaining("number"));
    expect(result).not.toContainEqual(expect.stringContaining("special"));
  });
});

describe("validatePassword — Sprint 4 breach detection", () => {
  it("rejects common breached password 'password'", () => {
    const result = validatePassword("password", LENIENT_POLICY);
    expect(result).toContainEqual(expect.stringContaining("data breaches"));
  });

  it("rejects '123456789' as breached", () => {
    const result = validatePassword("123456789", LENIENT_POLICY);
    expect(result).toContainEqual(expect.stringContaining("data breaches"));
  });

  it("rejects breached passwords case-insensitively", () => {
    const result = validatePassword("PASSWORD", LENIENT_POLICY);
    expect(result).toContainEqual(expect.stringContaining("data breaches"));
  });

  it("accepts non-breached passwords", () => {
    const result = validatePassword("xK7mQ2pR!unique", LENIENT_POLICY);
    expect(result.some((v) => v.includes("data breaches"))).toBe(false);
  });
});

describe("validatePassword — Sprint 4 pattern detection", () => {
  it("rejects single repeated character", () => {
    const result = validatePassword("aaaaaaaa", LENIENT_POLICY);
    expect(result).toContainEqual(expect.stringContaining("repeated character"));
  });

  it("rejects ascending sequential pattern", () => {
    const result = validatePassword("abcdefgh", LENIENT_POLICY);
    expect(result).toContainEqual(expect.stringContaining("sequential"));
  });

  it("rejects descending sequential pattern", () => {
    const result = validatePassword("hgfedcba", LENIENT_POLICY);
    expect(result).toContainEqual(expect.stringContaining("sequential"));
  });

  it("accepts non-sequential passwords", () => {
    const result = validatePassword("xK7mQ2pR", LENIENT_POLICY);
    expect(result).not.toContainEqual(expect.stringContaining("sequential"));
  });
});

describe("validatePasswordEnhanced", () => {
  it("returns structured result with strength scoring", () => {
    const result = validatePasswordEnhanced("MyS3cure!Pass", STRICT_POLICY);
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.strengthScore).toBeGreaterThanOrEqual(0);
    expect(result.strengthScore).toBeLessThanOrEqual(4);
    expect(["very-weak", "weak", "fair", "strong", "very-strong"]).toContain(
      result.strengthLabel
    );
  });

  it("scores breached passwords as very-weak", () => {
    const result = validatePasswordEnhanced("password", LENIENT_POLICY);
    expect(result.valid).toBe(false);
    expect(result.strengthScore).toBe(0);
    expect(result.strengthLabel).toBe("very-weak");
  });

  it("scores long diverse passwords higher", () => {
    const result = validatePasswordEnhanced("MyS3cure!P@ssphrase2024", LENIENT_POLICY);
    expect(result.strengthScore).toBeGreaterThanOrEqual(3);
  });

  it("violations array matches validatePassword output", () => {
    const enhanced = validatePasswordEnhanced("short", STRICT_POLICY);
    const basic = validatePassword("short", STRICT_POLICY);
    expect(enhanced.violations).toEqual(basic);
    expect(enhanced.valid).toBe(basic.length === 0);
  });
});

describe("isBreachedPassword", () => {
  it("returns true for breached passwords", () => {
    expect(isBreachedPassword("password")).toBe(true);
    expect(isBreachedPassword("123456")).toBe(true);
    expect(isBreachedPassword("admin")).toBe(true);
    expect(isBreachedPassword("qwerty")).toBe(true);
  });

  it("returns false for non-breached passwords", () => {
    expect(isBreachedPassword("xK7mQ2pR!unique")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isBreachedPassword("PASSWORD")).toBe(true);
    expect(isBreachedPassword("Admin")).toBe(true);
  });
});
