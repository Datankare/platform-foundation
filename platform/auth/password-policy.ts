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
 * Policies are the tenant's: password_policy rows are read and written in the request's tenant
 * (platform/data, ADR-053 D4), so "global" means the tenant-wide row (no role, no user).
 *
 * @module platform/auth
 * @see ROADMAP.md Phase 2 Sprint 4 — password enforcement
 */

import { withTenantTx } from "@/platform/data";
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
// Policy resolution (existing Phase 1 API)
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
  // 1–3 in one read: the individual row first, then the role's, then the global one. Ids are
  // compared as text, so an id that is not a UUID matches nothing rather than failing the read.
  // An unreadable store falls through to the built-in policy (the strict one), as no row does.
  try {
    const { rows } = await withTenantTx((tx) =>
      tx.query(
        `select * from password_policy
          where user_id::text = $1
             or (role_id::text = $2 and user_id is null)
             or (role_id is null and user_id is null)
          order by case when user_id is not null then 0 when role_id is not null then 1 else 2 end
          limit 1`,
        [userId, roleId]
      )
    );
    if (rows[0]) return toPolicy(rows[0]);
  } catch (err) {
    logger.error("Password policy unreadable, using the defaults", {
      error: err instanceof Error ? err.message : String(err),
      route: "platform/auth/password-policy",
    });
    return DEFAULT_POLICY;
  }

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
  let data: Record<string, unknown> | undefined;
  try {
    // An unconfigured or unreachable store is the same case as an unreadable row: the defaults
    // (the strict built-in policy) apply — sign-up never fails open, and never answers a 500.
    const { rows } = await withTenantTx((tx) =>
      tx.query("select * from password_policy where role_id is null and user_id is null")
    );
    data = rows[0];
  } catch (err) {
    logger.error("Global password policy unreadable, using the defaults", {
      error: err instanceof Error ? err.message : String(err),
      route: "platform/auth/password-policy",
    });
    return DEFAULT_POLICY;
  }
  return data ? toPolicy(data) : DEFAULT_POLICY;
}

/**
 * Store the global policy: one upsert on the per-tenant scope key (tenant, role, user — nulls
 * not distinct, migration 049), so two saves at once cannot create two globals. A failure is
 * reported, never thrown.
 */
export async function saveGlobalPasswordPolicy(
  policy: PasswordPolicy
): Promise<{ success: true } | { success: false; error: string }> {
  const row = toRow(policy);
  try {
    await withTenantTx((tx) =>
      tx.query(
        `insert into password_policy
           (role_id, user_id, min_length, rotation_days, require_uppercase, require_lowercase,
            require_number, require_special, password_history_count)
         values (null, null, $1, $2, $3, $4, $5, $6, $7)
         on conflict (tenant_id, role_id, user_id) do update
           set min_length = excluded.min_length,
               rotation_days = excluded.rotation_days,
               require_uppercase = excluded.require_uppercase,
               require_lowercase = excluded.require_lowercase,
               require_number = excluded.require_number,
               require_special = excluded.require_special,
               password_history_count = excluded.password_history_count,
               updated_at = now()`,
        [
          row.min_length,
          row.rotation_days,
          row.require_uppercase,
          row.require_lowercase,
          row.require_number,
          row.require_special,
          row.password_history_count,
        ]
      )
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
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
