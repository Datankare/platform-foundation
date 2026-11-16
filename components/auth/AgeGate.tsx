"use client";

import React, { useState } from "react";
import {
  evaluateAge,
  isUnder13Unavailable,
  type AgeVerificationResult,
} from "@/platform/auth/age";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { AuthField, AuthInput } from "@/components/auth/ui/AuthField";
import { AuthHeading } from "@/components/auth/ui/AuthHeading";
import { AUTH_LEAD, AUTH_LINK, AUTH_PRIMARY } from "@/components/auth/ui/styles";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.auth.age_gate.${key}`, values);

interface AgeGateProps {
  onVerified: (result: AgeVerificationResult, dateOfBirth: string) => void;
  onCancel: () => void;
}

/** The oldest date of birth taken (120 years before today), and today, as YYYY-MM-DD. */
export function dateBounds(now: Date = new Date()): { min: string; max: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const min = new Date(now);
  min.setUTCFullYear(now.getUTCFullYear() - 120);
  return { min: iso(min), max: iso(now) };
}

/**
 * Why a date of birth is not taken, or null when it is: the date as the field gives it
 * (YYYY-MM-DD from a date field; whatever was typed where the browser has none).
 */
export function dateProblem(value: string, now: Date = new Date()): string | null {
  if (value.trim() === "") return t("enter_your_date_of_birth");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return t("please_enter_a_valid_date");
  try {
    evaluateAge(value, now);
  } catch (err) {
    return err instanceof RangeError && /future/.test(err.message)
      ? t("date_of_birth_cannot_be")
      : t("please_enter_a_valid_date");
  }
  if (value < dateBounds(now).min) return t("please_enter_a_valid_date");
  return null;
}

/**
 * Age gate — collects DOB before account creation.
 * COPPA requires age collection before any data is stored for minors.
 *
 * Three outcomes:
 * 1. Adult (18+) → proceed to registration
 * 2. Teen (13-17) → proceed with restricted content rating
 * 3. Child (<13) → requires parental consent before proceeding — until that flow ships (Batch 4)
 *    the gate refuses the date with `account.child_accounts_unavailable` and nothing is created
 *    (TASK-181, platform/auth/age.ts UNDER_13_ACCOUNTS_AVAILABLE).
 *
 * One date field, in a form (TASK-222, SF-app-046): Enter continues, and the browser's own date
 * control puts day, month and year in the reader's order — three boxes fixed month-first did
 * not. The date it gives is always YYYY-MM-DD, whatever it shows. A refusal is the field's
 * error: announced, and the field marked.
 */
export default function AgeGate({ onVerified, onCancel }: AgeGateProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bounds = dateBounds();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const problem = dateProblem(value);
    if (problem) {
      setError(problem);
      return;
    }
    // The one age calculation the server also uses (platform/auth/age.ts, TASK-144).
    const result = evaluateAge(value);
    if (isUnder13Unavailable(result)) {
      setError(renderMessage("errors.account.child_accounts_unavailable"));
      return;
    }
    setError(null);
    onVerified(result, value);
  };

  return (
    <div className="flex flex-col gap-6">
      <AuthHeading>{t("verify_your_age")}</AuthHeading>
      <p className={AUTH_LEAD}>{t("please_enter_your_date_of")}</p>

      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <AuthField id="age-dob" label={t("date_of_birth")} error={error}>
          {(control) => (
            <AuthInput
              {...control}
              type="date"
              autoComplete="bday"
              min={bounds.min}
              max={bounds.max}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              required
              // The browser's own calendar control, drawn for a dark page.
              className="[color-scheme:dark]"
            />
          )}
        </AuthField>

        <button type="submit" className={AUTH_PRIMARY}>
          {t("continue")}
        </button>
      </form>

      <p className="text-center text-sm text-gray-300">
        <button type="button" onClick={onCancel} className={AUTH_LINK}>
          {t("back_to_sign_in")}
        </button>
      </p>
    </div>
  );
}
