/**
 * platform/auth/password-policy.ts — Password policy service
 *
 * Resolves the effective password policy for a user using a
 * three-level cascade: individual → role → global default.
 *
 * Phase 1: Schema + cascading resolution + basic validation.
 * Phase 2 Sprint 4: Enhanced with breached password list, strength
 * scoring, sequential/repetition detection, NIST SP 800-63B alignment.
 *
 * @module platform/auth
 * @see ROADMAP.md Phase 2 Sprint 4 — password enforcement
 */

import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

// ============================================================
// Types (existing Phase 1 API — do not change)
// ============================================================

export interface PasswordPolicy {
  rotationDays: number;
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSpecial: boolean;
  passwordHistoryCount: number;
}

const DEFAULT_POLICY: PasswordPolicy = {
  rotationDays: 90,
  minLength: 12,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSpecial: true,
  passwordHistoryCount: 5,
};

// ============================================================
// Sprint 4 enhancements — strength scoring + breach detection
// ============================================================

/** Extended validation result with strength scoring */
export interface PasswordValidationResult {
  valid: boolean;
  violations: string[];
  /** Password strength score 0-4 (0=very weak, 4=very strong) */
  strengthScore: number;
  /** Human-readable strength label */
  strengthLabel: "very-weak" | "weak" | "fair" | "strong" | "very-strong";
}

/**
 * Top 100 most common breached passwords.
 * Sourced from Have I Been Pwned aggregated lists.
 */
const BREACHED_PASSWORDS = new Set([
  "123456",
  "password",
  "12345678",
  "qwerty",
  "123456789",
  "12345",
  "1234",
  "111111",
  "1234567",
  "dragon",
  "123123",
  "baseball",
  "abc123",
  "football",
  "monkey",
  "letmein",
  "696969",
  "shadow",
  "master",
  "666666",
  "qwertyuiop",
  "123321",
  "mustang",
  "1234567890",
  "michael",
  "654321",
  "superman",
  "1qaz2wsx",
  "7777777",
  "121212",
  "000000",
  "qazwsx",
  "123qwe",
  "killer",
  "trustno1",
  "jordan",
  "jennifer",
  "zxcvbnm",
  "asdfgh",
  "hunter",
  "buster",
  "soccer",
  "harley",
  "batman",
  "andrew",
  "tigger",
  "sunshine",
  "iloveyou",
  "charlie",
  "robert",
  "thomas",
  "hockey",
  "ranger",
  "daniel",
  "starwars",
  "112233",
  "george",
  "computer",
  "michelle",
  "jessica",
  "pepper",
  "1111",
  "zxcvbn",
  "555555",
  "11111111",
  "131313",
  "freedom",
  "777777",
  "pass",
  "maggie",
  "159753",
  "aaaaaa",
  "ginger",
  "princess",
  "joshua",
  "cheese",
  "amanda",
  "summer",
  "love",
  "ashley",
  "6969",
  "nicole",
  "chelsea",
  "matthew",
  "access",
  "yankees",
  "987654321",
  "dallas",
  "austin",
  "thunder",
  "taylor",
  "matrix",
  "password1",
  "admin",
]);

// ============================================================
// Supabase policy resolution (existing Phase 1 API)
// ============================================================

function toPolicy(row: Record<string, unknown>): PasswordPolicy {
  return {
    rotationDays: (row.rotation_days as number) || DEFAULT_POLICY.rotationDays,
    minLength: (row.min_length as number) || DEFAULT_POLICY.minLength,
    requireUppercase: row.require_uppercase as boolean,
    requireLowercase: row.require_lowercase as boolean,
    requireNumber: row.require_number as boolean,
    requireSpecial: row.require_special as boolean,
    passwordHistoryCount:
      (row.password_history_count as number) || DEFAULT_POLICY.passwordHistoryCount,
  };
}

/**
 * Resolve the effective password policy for a user.
 * Cascade: individual override → role override → global default.
 */
export async function getEffectivePasswordPolicy(
  userId: string,
  roleId: string
): Promise<PasswordPolicy> {
  const supabase = getSupabaseServiceClient();

  // 1. Check for individual override
  const { data: individual } = await supabase
    .from("password_policy")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (individual) return toPolicy(individual);

  // 2. Check for role override
  const { data: rolePolicy } = await supabase
    .from("password_policy")
    .select("*")
    .eq("role_id", roleId)
    .single();

  if (rolePolicy) return toPolicy(rolePolicy);

  // 3. Check for global default (both role_id and user_id are null)
  const { data: global } = await supabase
    .from("password_policy")
    .select("*")
    .is("role_id", null)
    .is("user_id", null)
    .single();

  if (global) return toPolicy(global);

  // 4. Hardcoded fallback
  logger.warn("No password policy found, using hardcoded default", {
    userId,
    roleId,
    route: "platform/auth/password-policy",
  });
  return DEFAULT_POLICY;
}

// ============================================================
// Validation (Phase 1 API preserved, Sprint 4 enhanced)
// ============================================================

/**
 * Validate a password against a policy.
 * Returns a list of violations (empty = valid).
 *
 * Phase 1 API — signature unchanged.
 * Sprint 4: Added breached password check, sequential/repetition detection.
 */
export function validatePassword(password: string, policy: PasswordPolicy): string[] {
  const violations: string[] = [];

  if (password.length < policy.minLength) {
    violations.push(`Must be at least ${policy.minLength} characters`);
  }
  if (policy.requireUppercase && !/[A-Z]/.test(password)) {
    violations.push("Must contain an uppercase letter");
  }
  if (policy.requireLowercase && !/[a-z]/.test(password)) {
    violations.push("Must contain a lowercase letter");
  }
  // eslint-disable-next-line regexp/prefer-d -- ASCII digits only, \d matches Unicode
  if (policy.requireNumber && !/[0-9]/.test(password)) {
    violations.push("Must contain a number");
  }
  // eslint-disable-next-line regexp/use-ignore-case -- ASCII-only special char detection
  if (policy.requireSpecial && !/[^A-Za-z0-9]/.test(password)) {
    violations.push("Must contain a special character");
  }

  // Sprint 4 enhancements
  if (isBreachedPassword(password)) {
    violations.push(
      "This password has appeared in data breaches. Choose a different password."
    );
  }
  // ReDoS-safe: iterative check instead of /^(.)\1+$/ which has exponential backtracking
  const allSameChar =
    password.length > 0 && password.split("").every((c) => c === password[0]);
  if (allSameChar) {
    violations.push("Password cannot be a single repeated character");
  }
  if (isSequential(password)) {
    violations.push("Password cannot be a simple sequential pattern");
  }

  return violations;
}

/**
 * Enhanced validation — returns structured result with strength scoring.
 * Sprint 4 addition. Does NOT replace validatePassword() — additive API.
 */
export function validatePasswordEnhanced(
  password: string,
  policy: PasswordPolicy
): PasswordValidationResult {
  const violations = validatePassword(password, policy);
  const strengthScore = calculateStrength(password);
  const strengthLabels: PasswordValidationResult["strengthLabel"][] = [
    "very-weak",
    "weak",
    "fair",
    "strong",
    "very-strong",
  ];

  return {
    valid: violations.length === 0,
    violations,
    strengthScore,
    strengthLabel: strengthLabels[strengthScore] ?? "very-weak",
  };
}

// ============================================================
// Sprint 4 helpers
// ============================================================

/**
 * Check if password is in the breached list.
 */
export function isBreachedPassword(password: string): boolean {
  return BREACHED_PASSWORDS.has(password.toLowerCase());
}

/**
 * Calculate password strength score (0-4).
 */
function calculateStrength(password: string): number {
  let score = 0;

  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;

  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /[0-9]/.test(password); // eslint-disable-line regexp/prefer-d -- ASCII digits only
  const hasSpecial = /[^a-zA-Z0-9]/.test(password); // eslint-disable-line regexp/use-ignore-case -- ASCII-only
  const classCount = [hasUpper, hasLower, hasDigit, hasSpecial].filter(Boolean).length;
  if (classCount >= 3) score++;

  if (BREACHED_PASSWORDS.has(password.toLowerCase())) {
    score = 0;
  }

  return Math.min(4, score);
}

/**
 * Detect sequential patterns (123456, abcdef, etc.)
 */
function isSequential(password: string): boolean {
  if (password.length < 4) return false;

  let ascending = 0;
  let descending = 0;

  for (let i = 1; i < password.length; i++) {
    const diff = password.charCodeAt(i) - password.charCodeAt(i - 1);
    if (diff === 1) ascending++;
    else ascending = 0;
    if (diff === -1) descending++;
    else descending = 0;

    if (ascending >= 3 || descending >= 3) return true;
  }

  return false;
}
