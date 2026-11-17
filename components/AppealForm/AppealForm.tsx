/**
 * components/AppealForm/AppealForm.tsx — User-facing appeal submission
 *
 * ADR-024 / P10. A user appeals a block/ban decision made against their own
 * content. Submits to /api/moderation/appeals, which derives the user's identity
 * from the session and verifies ownership server-side — this form never sends a
 * user id.
 *
 * data-testid per element and per visual state. One dark look, from the app's tokens
 * (TASK-224, SF-app-061): its success and error boxes were light (bg-green-50, bg-red-50) on the
 * dark account page, and the count under the field was tied to nothing — it is now the field's
 * help (aria-describedby, the shared Field), and an error is tied to the field too.
 *
 * L18 visual states: editing (with character counter), submitting, success, and
 * failure. UX rule: gray = informational (counter), green = success
 * confirmation, red = actual failure only.
 *
 * Mounted on the account page, under the decision it appeals (components/account/
 * ModerationDecisions.tsx, TASK-210, N-117: no page mounted it before). The page passes the
 * server's own reason limits (GET /api/moderation/appeals).
 *
 * @module components/AppealForm
 */

"use client";

import { useCallback, useState } from "react";
import { adminCall } from "@/components/admin/ui/admin-call";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { Field, TextArea } from "@/components/admin/ui/Field";
import { BUTTON, TONE } from "@/components/admin/ui/tokens";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const msg = (key: string, values?: MessageValues) =>
  renderMessage(`screens.appeal.${key}`, values);

export interface AppealFormProps {
  /** Trajectory id of the decision being appealed */
  readonly originalDecisionId: string;
  /** Minimum reason length — the server's (GET /api/moderation/appeals; default 20) */
  readonly minReasonLength?: number;
  /** Longest reason the server accepts (default 2000) */
  readonly maxReasonLength?: number;
  /** Called with the created review item on a successful submission */
  readonly onSubmitted?: (item: unknown) => void;
}

export default function AppealForm({
  originalDecisionId,
  minReasonLength = 20,
  maxReasonLength = 2000,
  onSubmitted,
}: AppealFormProps) {
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
    // The one call path: the refusal's own message (TASK-181), the network sentence when no
    // answer came; it never throws.
    const answer = await adminCall("/api/moderation/appeals", {
      method: "POST",
      json: { originalDecisionId, appealReason: reason.trim() },
    });
    setSubmitting(false);
    if (!answer.ok) {
      setError(answer.refusal.message);
      return;
    }
    setSubmitted(true);
    onSubmitted?.(answer.body.item);
  }, [tooShort, submitting, originalDecisionId, reason, onSubmitted]);

  if (submitted) {
    return (
      <div className="w-full text-gray-100" data-testid="appeal-form">
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${TONE.applied}`}
          role="status"
          data-testid="af-success"
        >
          {msg("your_appeal_has_been_submitted")}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full space-y-3 text-gray-100" data-testid="appeal-form">
      <Field
        label={msg("why_should_this_decision_be")}
        help={
          <span data-testid="af-counter">
            {tooShort
              ? msg("more_characters_needed", {
                  count: minReasonLength - trimmedLength,
                })
              : msg("characters", { count: trimmedLength })}
          </span>
        }
        error={error}
      >
        {(control) => (
          <TextArea
            {...control}
            value={reason}
            maxLength={maxReasonLength}
            onChange={(e) => setReason(e.target.value)}
            disabled={submitting}
            rows={5}
            placeholder={msg("explain_the_context_the_automated")}
            data-testid="af-reason"
          />
        )}
      </Field>
      <button
        type="button"
        onClick={handleSubmit}
        disabled={tooShort || submitting}
        className={BUTTON.primary}
        data-testid="af-submit"
      >
        {submitting ? msg("submitting") : msg("submit_appeal")}
      </button>
    </div>
  );
}
