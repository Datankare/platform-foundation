"use client";

/**
 * components/auth/ui/PasswordRules.tsx — the rules a new password must meet, each said met or not
 * met (TASK-222, E-112, SF-app-043)
 *
 * Three screens set a password and stated three different rules: account creation 12 characters
 * and four kinds of character, the password reset 12 characters and nothing else, the
 * new-password step 8 — and none was the policy the server enforces (E-112). And the one
 * checklist there was showed met or not met by colour and a glyph only, so a screen reader read
 * the list with no state (SF-app-043).
 *
 * This is the one list, for all three. Its items are the policy the server reads
 * (usePasswordPolicy → GET /api/auth/password-policy), judged by the very function the routes
 * refuse a password with (platform/auth/password-rules.ts passwordRuleViolations) — so a
 * password every item calls met is one the server accepts. "Not a common or easily guessed
 * password" stands for the three rules the server always adds (a breached password, one
 * repeated character, a run like 1234). Each item says "met" or "not met" in words a screen
 * reader reads; the glyph and colour only repeat it. The list is the field's help
 * (aria-describedby), read when the field is reached, and not a live region: it does not
 * announce every keystroke.
 *
 * @module components/auth/ui
 */

import React from "react";
import {
  passwordRuleViolations,
  type PasswordRuleId,
  type PasswordRulesPolicy,
} from "@/platform/auth/password-rules";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.auth.password_rules.${key}`, values);

/** One item of the list: the server rules it stands for. */
interface RuleItem {
  readonly key: string;
  readonly label: string;
  readonly rules: readonly PasswordRuleId[];
}

/** The items a policy asks for, in the order they are read. */
export function ruleItems(policy: PasswordRulesPolicy): RuleItem[] {
  const items: RuleItem[] = [
    {
      key: "length",
      label: t("at_least_characters", { count: policy.minLength }),
      rules: ["min_length"],
    },
  ];
  if (policy.requireUppercase)
    items.push({ key: "uppercase", label: t("uppercase"), rules: ["uppercase"] });
  if (policy.requireLowercase)
    items.push({ key: "lowercase", label: t("lowercase"), rules: ["lowercase"] });
  if (policy.requireNumber)
    items.push({ key: "number", label: t("number"), rules: ["number"] });
  if (policy.requireSpecial)
    items.push({ key: "special", label: t("special"), rules: ["special"] });
  items.push({
    key: "not_common",
    label: t("not_common"),
    rules: ["breached", "repeated", "sequential"],
  });
  return items;
}

/** Whether `password` meets every rule of `policy` (what the server will check). */
export function meetsPolicy(password: string, policy: PasswordRulesPolicy): boolean {
  return password.length > 0 && passwordRuleViolations(password, policy).length === 0;
}

export function PasswordRules({
  password,
  policy,
}: {
  readonly password: string;
  readonly policy: PasswordRulesPolicy;
}) {
  const failed = new Set(passwordRuleViolations(password, policy));
  const typed = password.length > 0;
  return (
    <div className="mt-1">
      <p className="mb-1">{t("title")}</p>
      <ul className="flex flex-col gap-1" data-password-rules="">
        {ruleItems(policy).map((item) => {
          const met = typed && item.rules.every((r) => !failed.has(r));
          return (
            <li key={item.key} className="flex items-center gap-2" data-met={met}>
              <span
                aria-hidden="true"
                className={met ? "text-green-400" : "text-gray-400"}
              >
                {met ? "✓" : "•"}
              </span>
              <span className={met ? "text-gray-200" : "text-gray-400"}>
                {item.label}
                <span className="sr-only">
                  {" — "}
                  {met ? t("met") : t("not_met")}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
