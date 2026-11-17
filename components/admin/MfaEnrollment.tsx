"use client";

/**
 * components/admin/MfaEnrollment.tsx — set up two-step verification (audit A-9), on the console's
 * shared parts (TASK-221)
 *
 * Shown in place of the admin console when the server answers auth.mfa_required: staff sign in
 * with a second step. Starts enrolment (POST /api/auth/mfa/setup — the authenticator app's
 * secret), confirms it with the first code (POST /api/auth/mfa/verify), then asks the user to
 * sign in again so the new session carries the second step.
 *
 * The otpauth:// URI is drawn as a QR code in the browser (TASK-180) — nothing about the secret
 * leaves the page beyond the setup call. The key and the URI text are the "can't scan" fallback,
 * hidden until asked for so the secret is not on screen by default: the one part
 * (components/app/ui/AuthenticatorKey.tsx) the account page's own enrolment uses too (TASK-224).
 *
 * What the review found and how each is done (SF-admin-150 to 152): every call goes through the
 * one call helper, so a request that never gets an answer is said (the confirm rejected unhandled
 * and said nothing); the page is a `main` landmark; the code is a form, so Enter sends it; the
 * person may sign out at any step; and the words are one plain name — "two-step verification" —
 * never "software-token MFA" or "user pool".
 *
 * @module components/admin
 */

import React, { useState } from "react";
import { renderMessage } from "@/platform/errors/messages";
import { adminCall } from "@/components/admin/ui/admin-call";
import { Field, TextInput } from "@/components/admin/ui/Field";
import { AuthenticatorKey } from "@/components/app/ui/AuthenticatorKey";
import {
  OutcomeList,
  outcome,
  refusedOutcome,
  type OutcomeEntry,
} from "@/components/admin/ui/Outcome";
import { BUTTON, TEXT } from "@/components/admin/ui/tokens";

const t = (key: string) => renderMessage(`screens.mfa.${key}`);

type Step =
  { kind: "start" } | { kind: "code"; secret: string; uri?: string } | { kind: "done" };

export default function MfaEnrollment({ onSignOut }: { readonly onSignOut: () => void }) {
  const [step, setStep] = useState<Step>({ kind: "start" });
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<OutcomeEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const say = (entry: OutcomeEntry) => setOutcomes([entry]);

  const start = async () => {
    setBusy(true);
    setOutcomes([]);
    const answer = await adminCall("/api/auth/mfa/setup", { method: "POST" });
    setBusy(false);
    // TASK-181: the sign-in service has authenticator apps turned off — said so, not "failed".
    if (!answer.ok && answer.refusal.code === "feature.not_configured")
      return say(outcome("refused", t("not_configured")));
    if (!answer.ok) return say(refusedOutcome(answer.refusal, { action: t("start") }));
    if (typeof answer.body.secretCode !== "string")
      return say(outcome("refused", t("setup_failed")));
    setStep({
      kind: "code",
      secret: answer.body.secretCode,
      ...(typeof answer.body.qrCodeUri === "string"
        ? { uri: answer.body.qrCodeUri }
        : {}),
    });
  };

  const verify = async () => {
    if (!/^\d{6}$/.test(code)) return setProblem(t("code_short"));
    setProblem(null);
    setBusy(true);
    setOutcomes([]);
    // Never an unhandled rejection: no answer at all is said as one (SF-admin-150).
    const answer = await adminCall("/api/auth/mfa/verify", {
      method: "POST",
      json: { code },
    });
    setBusy(false);
    if (!answer.ok) return say(refusedOutcome(answer.refusal, { action: t("confirm") }));
    setStep({ kind: "done" });
  };

  return (
    <main
      aria-labelledby="mfa-title"
      className="mx-auto mt-16 max-w-md space-y-4 rounded-xl border border-gray-700 bg-[#0a0f1e] p-6 text-gray-200"
    >
      <h1 id="mfa-title" className="text-xl font-bold text-white">
        {t("title")}
      </h1>
      <p className={`text-sm ${TEXT.quiet}`}>{t("intro")}</p>
      <OutcomeList
        outcomes={outcomes}
        label={t("results_label")}
        onDismiss={() => setOutcomes([])}
      />
      {step.kind === "start" && (
        <button
          type="button"
          onClick={() => void start()}
          disabled={busy}
          className={BUTTON.primary}
        >
          {busy ? t("starting") : t("start")}
        </button>
      )}
      {step.kind === "code" && (
        <form
          noValidate
          aria-label={t("code_form")}
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
        >
          <AuthenticatorKey
            secret={step.secret}
            {...(step.uri ? { uri: step.uri } : {})}
          />
          <Field label={t("code_label")} help={t("code_help")} error={problem}>
            {(control) => (
              <TextInput
                {...control}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                  setProblem(null);
                }}
              />
            )}
          </Field>
          <button type="submit" disabled={busy} className={BUTTON.primary}>
            {busy ? t("confirming") : t("confirm")}
          </button>
        </form>
      )}
      {step.kind === "done" && (
        <div className="flex flex-col gap-3">
          <p className="text-sm">{t("done")}</p>
          <button type="button" onClick={onSignOut} className={BUTTON.primary}>
            {t("sign_in_again")}
          </button>
        </div>
      )}
      {step.kind !== "done" && (
        <p className={`border-t border-gray-800 pt-3 text-sm ${TEXT.faint}`}>
          {t("leave")}{" "}
          <button type="button" onClick={onSignOut} className={BUTTON.link}>
            {t("sign_out")}
          </button>
        </p>
      )}
    </main>
  );
}
