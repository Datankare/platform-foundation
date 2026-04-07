/**
 * Sprint 4 — User Profile & Privacy tests
 *
 * Tests pure functions that don't require Supabase:
 * - Password validation against policy
 * - Age calculation and evaluation
 * - Profile field mapping
 */

import { validatePassword, type PasswordPolicy } from "@/platform/auth/password-policy";
import { calculateAge, evaluateAge } from "@/platform/auth/coppa";

// ── Password Policy Tests ───────────────────────────────────────────────

describe("validatePassword", () => {
  const strictPolicy: PasswordPolicy = {
    rotationDays: 90,
    minLength: 12,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSpecial: true,
    passwordHistoryCount: 5,
  };

  it("returns empty array for valid password", () => {
    const violations = validatePassword("StrongPass123!", strictPolicy);
    expect(violations).toHaveLength(0);
  });

  it("catches too-short password", () => {
    const violations = validatePassword("Short1!", strictPolicy);
    expect(violations).toContain("Must be at least 12 characters");
  });

  it("catches missing uppercase", () => {
    const violations = validatePassword("nouppercase123!", strictPolicy);
    expect(violations).toContain("Must contain an uppercase letter");
  });

  it("catches missing lowercase", () => {
    const violations = validatePassword("NOLOWERCASE123!", strictPolicy);
    expect(violations).toContain("Must contain a lowercase letter");
  });

  it("catches missing number", () => {
    const violations = validatePassword("NoNumbersHere!!", strictPolicy);
    expect(violations).toContain("Must contain a number");
  });

  it("catches missing special character", () => {
    const violations = validatePassword("NoSpecialChar123", strictPolicy);
    expect(violations).toContain("Must contain a special character");
  });

  it("returns multiple violations for weak password", () => {
    const violations = validatePassword("abc", strictPolicy);
    expect(violations.length).toBeGreaterThan(1);
  });

  it("respects relaxed policy", () => {
    const relaxedPolicy: PasswordPolicy = {
      rotationDays: 0,
      minLength: 6,
      requireUppercase: false,
      requireLowercase: false,
      requireNumber: false,
      requireSpecial: false,
      passwordHistoryCount: 0,
    };
    const violations = validatePassword("simple", relaxedPolicy);
    expect(violations).toHaveLength(0);
  });
});

// ── COPPA Age Tests ─────────────────────────────────────────────────────

describe("calculateAge", () => {
  it("calculates age correctly for past birthday this year", () => {
    const year = new Date().getFullYear() - 25;
    const age = calculateAge(`${year}-01-01`);
    expect(age).toBe(25);
  });

  it("calculates age correctly when birthday has not occurred yet", () => {
    const year = new Date().getFullYear() - 25;
    const age = calculateAge(`${year}-12-31`);
    // If today is before Dec 31, age should be 24
    const now = new Date();
    if (now.getMonth() < 11 || (now.getMonth() === 11 && now.getDate() < 31)) {
      expect(age).toBe(24);
    } else {
      expect(age).toBe(25);
    }
  });

  it("returns 0 for someone born today", () => {
    const today = new Date().toISOString().split("T")[0];
    const age = calculateAge(today);
    expect(age).toBe(0);
  });
});

describe("evaluateAge", () => {
  it("flags under-13 as minor requiring parental consent", () => {
    const year = new Date().getFullYear() - 10;
    const result = evaluateAge(`${year}-01-01`);
    expect(result.isMinor).toBe(true);
    expect(result.requiresParentalConsent).toBe(true);
    expect(result.contentRatingLevel).toBe(1);
  });

  it("flags 13-17 as minor without parental consent", () => {
    const year = new Date().getFullYear() - 15;
    const result = evaluateAge(`${year}-01-01`);
    expect(result.isMinor).toBe(true);
    expect(result.requiresParentalConsent).toBe(false);
    expect(result.contentRatingLevel).toBe(2);
  });

  it("flags 18+ as adult", () => {
    const year = new Date().getFullYear() - 25;
    const result = evaluateAge(`${year}-01-01`);
    expect(result.isMinor).toBe(false);
    expect(result.requiresParentalConsent).toBe(false);
    expect(result.contentRatingLevel).toBe(3);
  });

  it("boundary: exactly 13 is not under-13", () => {
    const year = new Date().getFullYear() - 13;
    const result = evaluateAge(`${year}-01-01`);
    expect(result.requiresParentalConsent).toBe(false);
    expect(result.contentRatingLevel).toBe(2);
  });

  it("boundary: exactly 18 is adult", () => {
    const year = new Date().getFullYear() - 18;
    const result = evaluateAge(`${year}-01-01`);
    expect(result.isMinor).toBe(false);
    expect(result.contentRatingLevel).toBe(3);
  });
});
