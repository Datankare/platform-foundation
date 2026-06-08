/**
 * components/AppealForm/AppealForm.tsx — User-facing appeal submission
 *
 * ADR-024 / P10. A user appeals a block/ban decision made against their own
 * content. Submits to /api/moderation/appeals, which derives the user's identity
 * from the session and verifies ownership server-side — this form never sends a
 * user id.
 *
 * Conventions match AdaptiveInput: "use client"; explicit THEMES map + variant;
 * Tailwind core utilities; data-testid per element and per visual state.
 *
 * L18 visual states: editing (with character counter), submitting, success, and
 * failure. UX rule: gray = informational (counter), green = success
 * confirmation, red = actual failure only.
 *
 * @module components/AppealForm
 */

"use client";

import { useCallback, useState } from "react";

type Variant = "light" | "dark";

interface ThemeClasses {
  container: string;
  label: string;
  muted: string;
  input: string;
}

const THEMES: Record<Variant, ThemeClasses> = {
  light: {
    container: "text-gray-900",
    label: "text-gray-700",
    muted: "text-gray-500",
    input: "border-gray-300 text-gray-900 placeholder-gray-400 bg-white",
  },
  dark: {
    container: "text-gray-100",
    label: "text-gray-300",
    muted: "text-gray-400",
    input: "border-gray-600 text-white placeholder-gray-500 bg-gray-900",
  },
};

export interface AppealFormProps {
  /** Trajectory id of the decision being appealed */
  readonly originalDecisionId: string;
  /** Minimum reason length — mirrors server config (default 20) */
  readonly minReasonLength?: number;
  /** Theme variant (default light) */
  readonly variant?: Variant;
  /** Called with the created review item on a successful submission */
  readonly onSubmitted?: (item: unknown) => void;
}

export default function AppealForm({
  originalDecisionId,
  minReasonLength = 20,
  variant = "light",
  onSubmitted,
}: AppealFormProps) {
  const t = THEMES[variant];
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const trimmedLength = reason.trim().length;
  const tooShort = trimmedLength < minReasonLength;

  const handleSubmit = useCallback(async () => {
    if (tooShort || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/moderation/appeals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ originalDecisionId, appealReason: reason.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Your appeal could not be submitted.");
        return;
      }
      const data = await res.json();
      setSubmitted(true);
      onSubmitted?.(data.item);
    } catch {
      setError("Could not connect to the appeals service.");
    } finally {
      setSubmitting(false);
    }
  }, [tooShort, submitting, originalDecisionId, reason, onSubmitted]);

  if (submitted) {
    return (
      <div className={`w-full max-w-lg mx-auto ${t.container}`} data-testid="appeal-form">
        <div
          className="rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-800"
          role="status"
          data-testid="af-success"
        >
          Your appeal has been submitted for review. You&apos;ll be notified once a
          moderator has reviewed it.
        </div>
      </div>
    );
  }

  return (
    <div className={`w-full max-w-lg mx-auto ${t.container}`} data-testid="appeal-form">
      <label
        htmlFor="appeal-reason"
        className={`block text-sm font-medium mb-1 ${t.label}`}
      >
        Why should this decision be reconsidered?
      </label>
      <textarea
        id="appeal-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={submitting}
        rows={5}
        placeholder="Explain the context the automated system may have missed…"
        className={`w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:border-blue-400 disabled:opacity-50 ${t.input}`}
        data-testid="af-reason"
      />

      <div className={`mt-1 text-xs ${t.muted}`} data-testid="af-counter">
        {tooShort
          ? `${minReasonLength - trimmedLength} more character(s) needed`
          : `${trimmedLength} characters`}
      </div>

      {error && (
        <div
          className="mt-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700"
          role="alert"
          data-testid="af-error"
        >
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={tooShort || submitting}
        className="mt-3 px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        data-testid="af-submit"
      >
        {submitting ? "Submitting…" : "Submit appeal"}
      </button>
    </div>
  );
}
