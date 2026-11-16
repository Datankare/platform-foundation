/**
 * platform/auth/password-rules.ts — a password policy's shape and the rules a password is judged
 * by: pure, with no store and no server dependency (TASK-222, E-112)
 *
 * The sign-up, password-reset and new-password routes refuse a password with
 * `passwordRuleViolations` against the tenant's policy (platform/auth/auth-response.ts). The
 * screens used to state three rules of their own — 12 characters and four kinds on sign-up, 12
 * on reset, 8 on the new-password step — none read from the policy. Here the rules are one
 * function the screens import too (components/auth/ui/PasswordRules.tsx): a screen shows, item by
 * item, exactly what the route will check, given the policy the route reads
 * (GET /api/auth/password-policy). platform/auth/password-policy.ts re-exports all of it.
 *
 * @module platform/auth
 */

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

/**
 * The bounds an admin's change must stay within. The floor follows NIST SP 800-63B (at least 8
 * characters); a policy below it is refused, not clamped.
 */
export const PASSWORD_POLICY_LIMITS = {
  minLength: { min: 8, max: 128 },
  rotationDays: { min: 0, max: 3650 },
  passwordHistoryCount: { min: 0, max: 24 },
} as const;

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

/** What of a policy a password is judged by (what a screen is told: GET /api/auth/password-policy). */
export type PasswordRulesPolicy = Pick<
  PasswordPolicy,
  | "minLength"
  | "requireUppercase"
  | "requireLowercase"
  | "requireNumber"
  | "requireSpecial"
>;

/** The rules a password fails, as stable ids (empty = valid). */
export function passwordRuleViolations(
  password: string,
  policy: PasswordRulesPolicy
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
 * Check if password is in the breached list.
 */
export function isBreachedPassword(password: string): boolean {
  return BREACHED_PASSWORDS.has(password.toLowerCase());
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
