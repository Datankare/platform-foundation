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
 * Mounted on the account page, under the decision it appeals (components/account/
 * ModerationDecisions.tsx, TASK-210, N-117: no page mounted it before). The page passes the
 * server's own reason limits (GET /api/moderation/appeals); the field's id is unique on the page,
 * so a page with several decisions keeps each label on its own field.
 *
 * @module components/AppealForm
 */

"use client";

import { useCallback, useId, useState } from "react";
import { apiFetch } from "@/platform/auth/api-fetch";
import { readRefusal } from "@/platform/errors/refusal";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const msg = (key: string, values?: MessageValues) =>
  renderMessage(`screens.appeal.${key}`, values);

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
  /** Minimum reason length — the server's (GET /api/moderation/appeals; default 20) */
  readonly minReasonLength?: number;
  /** Longest reason the server accepts (default 2000) */
  readonly maxReasonLength?: number;
  /** Theme variant (default light) */
  readonly variant?: Variant;
  /** Called with the created review item on a successful submission */
  readonly onSubmitted?: (item: unknown) => void;
}

export default function AppealForm({
  originalDecisionId,
  minReasonLength = 20,
  maxReasonLength = 2000,
  variant = "light",
  onSubmitted,
}: AppealFormProps) {
  const t = THEMES[variant];
  const fieldId = useId();
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
      const res = await apiFetch("/api/moderation/appeals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ originalDecisionId, appealReason: reason.trim() }),
      });
      if (!res.ok) {
        // TASK-181: the refusal's own message (shared handler, platform/errors/refusal.ts).
        setError((await readRefusal(res)).message);
        return;
      }
      const data = await res.json();
      setSubmitted(true);
      onSubmitted?.(data.item);
    } catch {
      setError(msg("could_not_connect_to_the"));
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
          {msg("your_appeal_has_been_submitted")}
        </div>
      </div>
    );
  }

  return (
    <div className={`w-full max-w-lg mx-auto ${t.container}`} data-testid="appeal-form">
      <label htmlFor={fieldId} className={`block text-sm font-medium mb-1 ${t.label}`}>
        {msg("why_should_this_decision_be")}
      </label>
      <textarea
        id={fieldId}
        value={reason}
        maxLength={maxReasonLength}
        onChange={(e) => setReason(e.target.value)}
        disabled={submitting}
        rows={5}
        placeholder={msg("explain_the_context_the_automated")}
        className={`w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:border-blue-400 disabled:opacity-50 ${t.input}`}
        data-testid="af-reason"
      />

      <div className={`mt-1 text-xs ${t.muted}`} data-testid="af-counter">
        {tooShort
          ? msg("more_characters_needed", {
              count: String(minReasonLength - trimmedLength),
            })
          : msg("characters", { count: String(trimmedLength) })}
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
        {submitting ? msg("submitting") : msg("submit_appeal")}
      </button>
    </div>
  );
}
