"use client";

import React, { useState } from "react";
import {
  evaluateAge,
  isUnder13Unavailable,
  type AgeVerificationResult,
} from "@/platform/auth/age";
import { renderMessage } from "@/platform/errors/messages";

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
      setError("Please enter a valid date");
      return;
    }

    if (m < 1 || m > 12) {
      setError("Month must be between 1 and 12");
      return;
    }

    if (d < 1 || d > 31) {
      setError("Day must be between 1 and 31");
      return;
    }

    if (y < minYear || y > maxYear) {
      setError("Please enter a valid year");
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
          ? "Date of birth cannot be in the future"
          : "Please enter a valid date"
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
      <h2 className="text-xl font-bold text-white text-center">Verify Your Age</h2>
      <p className="text-sm text-gray-400 text-center">
        Please enter your date of birth to continue.
      </p>

      <div className="flex gap-3">
        <div className="flex-1">
          <label htmlFor="age-month" className="block text-sm text-gray-400 mb-1.5">
            Month
          </label>
          <input
            id="age-month"
            type="text"
            inputMode="numeric"
            maxLength={2}
            placeholder="MM"
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
            Day
          </label>
          <input
            id="age-day"
            type="text"
            inputMode="numeric"
            maxLength={2}
            placeholder="DD"
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
            Year
          </label>
          <input
            id="age-year"
            type="text"
            inputMode="numeric"
            maxLength={4}
            placeholder="YYYY"
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
        className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl text-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Continue
      </button>

      <p className="text-center text-sm text-gray-400">
        <button
          onClick={onCancel}
          className="text-blue-400 hover:text-blue-300 transition"
        >
          Back to Sign In
        </button>
      </p>
    </div>
  );
}
