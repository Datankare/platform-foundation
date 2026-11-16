"use client";

/**
 * components/auth/ui/usePasswordPolicy.ts — the password rules a screen states, read from the
 * server (TASK-222, E-112)
 *
 * GET /api/auth/password-policy answers the policy the routes that set a password check against
 * (the tenant's, set by its administrators). Until it answers, or if it cannot, the strict
 * built-in policy (platform/auth/password-rules.ts DEFAULT_POLICY) is shown — the one the routes
 * themselves fall back to — so a screen never states a rule looser than the server's. An answer
 * outside the bounds an administrator may set (PASSWORD_POLICY_LIMITS) is not believed.
 *
 * @module components/auth/ui
 */

import { useEffect, useState } from "react";
import { apiFetch } from "@/platform/auth/api-fetch";
import {
  DEFAULT_POLICY,
  PASSWORD_POLICY_LIMITS,
  type PasswordRulesPolicy,
} from "@/platform/auth/password-rules";

/**
 * Every refusal of the policy read is handled the same way: the built-in policy stays, and the
 * password-setting route the form then calls judges with the tenant's own (refusal coverage,
 * TASK-181). None is shown: the screen still works.
 */
export const HANDLED_CODES = [
  "rate.limited",
  "service.unavailable",
  "tenant.mismatch",
  "tenant.missing",
  "tenant.suspended",
  "tenant.unknown_host",
] as const;

/** The policy a screen judges with: what the server said, or the built-in one. */
export const BUILT_IN_RULES: PasswordRulesPolicy = {
  minLength: DEFAULT_POLICY.minLength,
  requireUppercase: DEFAULT_POLICY.requireUppercase,
  requireLowercase: DEFAULT_POLICY.requireLowercase,
  requireNumber: DEFAULT_POLICY.requireNumber,
  requireSpecial: DEFAULT_POLICY.requireSpecial,
};

/** The answer's policy, if it is one an administrator could have set; otherwise null. */
export function readPolicyAnswer(body: unknown): PasswordRulesPolicy | null {
  const p = (body as { policy?: Record<string, unknown> } | null)?.policy;
  if (!p || typeof p !== "object") return null;
  const { minLength } = p;
  if (
    typeof minLength !== "number" ||
    !Number.isInteger(minLength) ||
    minLength < PASSWORD_POLICY_LIMITS.minLength.min ||
    minLength > PASSWORD_POLICY_LIMITS.minLength.max
  )
    return null;
  const flags = [
    "requireUppercase",
    "requireLowercase",
    "requireNumber",
    "requireSpecial",
  ] as const;
  if (flags.some((f) => typeof p[f] !== "boolean")) return null;
  return {
    minLength,
    requireUppercase: p.requireUppercase as boolean,
    requireLowercase: p.requireLowercase as boolean,
    requireNumber: p.requireNumber as boolean,
    requireSpecial: p.requireSpecial as boolean,
  };
}

export function usePasswordPolicy(): PasswordRulesPolicy {
  const [policy, setPolicy] = useState<PasswordRulesPolicy>(BUILT_IN_RULES);
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/auth/password-policy")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: unknown) => {
        const read = readPolicyAnswer(body);
        if (!cancelled && read) setPolicy(read);
      })
      .catch(() => {
        /* justified */
        // No answer: the built-in policy stays (the routes fall back to it too).
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return policy;
}
