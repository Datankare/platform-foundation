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

export const DEFAULT_POLICY: PasswordPolicy = {
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
    rotationDays: (row.rotation_days as number | null) ?? DEFAULT_POLICY.rotationDays,
    minLength: (row.min_length as number | null) ?? DEFAULT_POLICY.minLength,
    requireUppercase: row.require_uppercase as boolean,
    requireLowercase: row.require_lowercase as boolean,
    requireNumber: row.require_number as boolean,
    requireSpecial: row.require_special as boolean,
    passwordHistoryCount:
      (row.password_history_count as number | null) ??
      DEFAULT_POLICY.passwordHistoryCount,
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
// Global policy — read by sign-up, changed by admins (Sprint 7X)
// ============================================================

/**
 * The bounds an admin's change must stay within. The floor follows NIST SP 800-63B (at least 8
 * characters); a policy below it is refused, not clamped.
 */
export const PASSWORD_POLICY_LIMITS = {
  minLength: { min: 8, max: 128 },
  rotationDays: { min: 0, max: 3650 },
  passwordHistoryCount: { min: 0, max: 24 },
} as const;

const NUMERIC = ["minLength", "rotationDays", "passwordHistoryCount"] as const;
const BOOLEAN = [
  "requireUppercase",
  "requireLowercase",
  "requireNumber",
  "requireSpecial",
] as const;

export type PasswordPolicyChange =
  | { readonly policy: PasswordPolicy }
  | { readonly field: string; readonly allowed: string };

/**
 * Apply an admin's change to the current policy. Only the fields present change; each must be
 * an integer within PASSWORD_POLICY_LIMITS or a boolean. Unknown fields are refused, so a typo
 * is not silently ignored.
 */
export function applyPasswordPolicyChange(
  current: PasswordPolicy,
  change: Readonly<Record<string, unknown>>
): PasswordPolicyChange {
  const next: Record<string, unknown> = { ...current };
  for (const [field, value] of Object.entries(change)) {
    if ((NUMERIC as readonly string[]).includes(field)) {
      const { min, max } = PASSWORD_POLICY_LIMITS[field as (typeof NUMERIC)[number]];
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < min ||
        value > max
      ) {
        return { field, allowed: `an integer from ${min} to ${max}` };
      }
    } else if ((BOOLEAN as readonly string[]).includes(field)) {
      if (typeof value !== "boolean") return { field, allowed: "true or false" };
    } else {
      return { field, allowed: [...NUMERIC, ...BOOLEAN].join(", ") };
    }
    next[field] = value;
  }
  return { policy: next as unknown as PasswordPolicy };
}

function toRow(policy: PasswordPolicy): Record<string, unknown> {
  return {
    min_length: policy.minLength,
    rotation_days: policy.rotationDays,
    require_uppercase: policy.requireUppercase,
    require_lowercase: policy.requireLowercase,
    require_number: policy.requireNumber,
    require_special: policy.requireSpecial,
    password_history_count: policy.passwordHistoryCount,
  };
}

/** The global policy (no role, no user), or the defaults when none is stored. */
export async function getGlobalPasswordPolicy(): Promise<PasswordPolicy> {
  let data: Record<string, unknown> | null;
  let error: { message: string } | null;
  try {
    // An unconfigured or unreachable store is the same case as an unreadable row: the defaults
    // (the strict built-in policy) apply — sign-up never fails open, and never answers a 500.
    const supabase = getSupabaseServiceClient();
    ({ data, error } = await supabase
      .from("password_policy")
      .select("*")
      .is("role_id", null)
      .is("user_id", null)
      .maybeSingle());
  } catch (err) {
    error = { message: err instanceof Error ? err.message : String(err) };
    data = null;
  }
  if (error) {
    logger.error("Global password policy unreadable, using the defaults", {
      error: error.message,
      route: "platform/auth/password-policy",
    });
    return DEFAULT_POLICY;
  }
  return data ? toPolicy(data) : DEFAULT_POLICY;
}

/**
 * Store the global policy: update the global row, or create it when there is none. (The table
 * has no unique key the upsert could use; migration 042 adds one so two globals cannot exist.)
 */
export async function saveGlobalPasswordPolicy(
  policy: PasswordPolicy
): Promise<{ success: true } | { success: false; error: string }> {
  let supabase: ReturnType<typeof getSupabaseServiceClient>;
  try {
    supabase = getSupabaseServiceClient();
  } catch (err) {
    // As the read: a client that cannot be created is a failed save, reported, never thrown.
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  const { data: existing, error: readError } = await supabase
    .from("password_policy")
    .select("id")
    .is("role_id", null)
    .is("user_id", null)
    .maybeSingle();
  if (readError) return { success: false, error: readError.message };
  const { error } = existing
    ? await supabase.from("password_policy").update(toRow(policy)).eq("id", existing.id)
    : await supabase
        .from("password_policy")
        .insert({ role_id: null, user_id: null, ...toRow(policy) });
  return error ? { success: false, error: error.message } : { success: true };
}

// ============================================================
// Validation (Phase 1 API preserved, Sprint 4 enhanced)
// ============================================================

/** Stable ids of password rules (ADR-051) — the `rules` param of `auth.password_policy`. */
export type PasswordRuleId =
  | "min_length"
  | "uppercase"
  | "lowercase"
  | "number"
  | "special"
  | "breached"
  | "repeated"
  | "sequential";

/** The rules a password fails, as stable ids (empty = valid). */
export function passwordRuleViolations(
  password: string,
  policy: PasswordPolicy
): PasswordRuleId[] {
  const failed: PasswordRuleId[] = [];
  if (password.length < policy.minLength) failed.push("min_length");
  if (policy.requireUppercase && !/[A-Z]/.test(password)) failed.push("uppercase");
  if (policy.requireLowercase && !/[a-z]/.test(password)) failed.push("lowercase");
  // eslint-disable-next-line regexp/prefer-d -- ASCII digits only, \d matches Unicode
  if (policy.requireNumber && !/[0-9]/.test(password)) failed.push("number");
  // eslint-disable-next-line regexp/use-ignore-case -- ASCII-only special char detection
  if (policy.requireSpecial && !/[^A-Za-z0-9]/.test(password)) failed.push("special");
  if (isBreachedPassword(password)) failed.push("breached");
  // ReDoS-safe: iterative check instead of /^(.)\1+$/ which has exponential backtracking
  if (password.length > 0 && password.split("").every((c) => c === password[0])) {
    failed.push("repeated");
  }
  if (isSequential(password)) failed.push("sequential");
  return failed;
}

/**
 * Validate a password against a policy.
 * Returns a list of violations (empty = valid) — English, for logs and legacy callers; API
 * responses use {@link passwordRuleViolations}.
 *
 * Phase 1 API — signature unchanged. Sprint 4: breached, sequential and repetition checks.
 */
export function validatePassword(password: string, policy: PasswordPolicy): string[] {
  const text: Record<PasswordRuleId, string> = {
    min_length: `Must be at least ${policy.minLength} characters`,
    uppercase: "Must contain an uppercase letter",
    lowercase: "Must contain a lowercase letter",
    number: "Must contain a number",
    special: "Must contain a special character",
    breached: "This password has appeared in data breaches. Choose a different password.",
    repeated: "Password cannot be a single repeated character",
    sequential: "Password cannot be a simple sequential pattern",
  };
  return passwordRuleViolations(password, policy).map((id) => text[id]);
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
