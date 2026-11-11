"use client";

import React, { useState } from "react";
import {
  evaluateAge,
  isUnder13Unavailable,
  type AgeVerificationResult,
} from "@/platform/auth/age";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.auth.age_gate.${key}`, values);

interface AgeGateProps {
  onVerified: (result: AgeVerificationResult, dateOfBirth: string) => void;
  onCancel: () => void;
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
 */
export default function AgeGate({ onVerified, onCancel }: AgeGateProps) {
  const [month, setMonth] = useState("");
  const [day, setDay] = useState("");
  const [year, setYear] = useState("");
  const [error, setError] = useState<string | null>(null);

  const currentYear = new Date().getFullYear();
  const minYear = currentYear - 120;
  const maxYear = currentYear;

  const isComplete = month !== "" && day !== "" && year !== "" && year.length === 4;

  const handleSubmit = () => {
    setError(null);

    const m = parseInt(month, 10);
    const d = parseInt(day, 10);
    const y = parseInt(year, 10);

    if (isNaN(m) || isNaN(d) || isNaN(y)) {
      setError(t("please_enter_a_valid_date"));
      return;
    }

    if (m < 1 || m > 12) {
      setError(t("month_must_be_between_1"));
      return;
    }

    if (d < 1 || d > 31) {
      setError(t("day_must_be_between_1"));
      return;
    }

    if (y < minYear || y > maxYear) {
      setError(t("please_enter_a_valid_year"));
      return;
    }

    const dateOfBirth = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

    // The one age calculation the server also uses (platform/auth/age.ts, TASK-144).
    let result: AgeVerificationResult;
    try {
      result = evaluateAge(dateOfBirth);
    } catch (err) {
      setError(
        err instanceof RangeError && /future/.test(err.message)
          ? t("date_of_birth_cannot_be")
          : t("please_enter_a_valid_date")
      );
      return;
    }

    if (isUnder13Unavailable(result)) {
      setError(renderMessage("errors.account.child_accounts_unavailable"));
      return;
    }

    onVerified(result, dateOfBirth);
  };

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-xl font-bold text-white text-center">{t("verify_your_age")}</h2>
      <p className="text-sm text-gray-400 text-center">
        {t("please_enter_your_date_of")}
      </p>

      <div className="flex gap-3">
        <div className="flex-1">
          <label htmlFor="age-month" className="block text-sm text-gray-400 mb-1.5">
            {t("month")}
          </label>
          <input
            id="age-month"
            type="text"
            inputMode="numeric"
            maxLength={2}
            placeholder={t("mm")}
            value={month}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, "").slice(0, 2);
              setMonth(v);
            }}
            className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-3 text-white text-center text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
          />
        </div>
        <div className="flex-1">
          <label htmlFor="age-day" className="block text-sm text-gray-400 mb-1.5">
            {t("day")}
          </label>
          <input
            id="age-day"
            type="text"
            inputMode="numeric"
            maxLength={2}
            placeholder={t("dd")}
            value={day}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, "").slice(0, 2);
              setDay(v);
            }}
            className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-3 text-white text-center text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
          />
        </div>
        <div className="flex-1">
          <label htmlFor="age-year" className="block text-sm text-gray-400 mb-1.5">
            {t("year")}
          </label>
          <input
            id="age-year"
            type="text"
            inputMode="numeric"
            maxLength={4}
            placeholder={t("yyyy")}
            value={year}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, "").slice(0, 4);
              setYear(v);
            }}
            className="w-full bg-[#0a0f1e] border border-gray-700 rounded-xl px-4 py-3 text-white text-center text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
          />
        </div>
      </div>

      {error && (
        <div
          role="alert"
          aria-live="assertive"
          className="bg-red-900/30 border border-red-700 text-red-300 rounded-xl px-4 py-3 text-sm"
        >
          {error}
        </div>
      )}

      <button
        onClick={handleSubmit}
        disabled={!isComplete}
        className="w-full bg-blue-700 hover:bg-blue-800 text-white font-semibold py-3 rounded-xl text-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {t("continue")}
      </button>

      <p className="text-center text-sm text-gray-400">
        <button
          onClick={onCancel}
          className="text-blue-400 hover:text-blue-300 transition"
        >
          {t("back_to_sign_in")}
        </button>
      </p>
    </div>
  );
}
