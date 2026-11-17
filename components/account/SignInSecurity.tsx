"use client";

/**
 * components/account/SignInSecurity.tsx — change the password, and turn two-step verification on
 * or off, from the account page (TASK-225, E-126)
 *
 * The account page offered neither: the routes existed (password reset, MFA set-up, confirm and
 * removal) but only the sign-in screen and the staff console used them. Here, through those same
 * governed routes — nothing new is trusted, no check is skipped:
 *
 *   How the account signs in   GET /api/account/security: whether two-step verification is on,
 *                              and whether this session signed in through a provider. A read
 *                              that fails is said and offered again — never shown as "off".
 *   Change password            the reset path the sign-in page uses: a code to the account's
 *                              own address (POST /api/auth/forgot-password), then the code and
 *                              the new password, held to the server's rules (POST
 *                              /api/auth/confirm-forgot-password; the rules shown are the
 *                              server's, components/auth/ui). Asked first, saying that every
 *                              device — this one too — is then signed out (the route ends every
 *                              session of the account, ADR-057 D6). A provider's account has no
 *                              password here: said, nothing offered.
 *   Two-step verification on   POST /api/auth/mfa/setup → the authenticator's secret (a QR
 *                              code, the key behind "Can't scan?") → the first code (POST
 *                              /api/auth/mfa/verify). When the server asks for proof first (it
 *                              cannot tell that no factor exists), the password is asked.
 *   … off                      asked first, saying what changes; the password and a current
 *                              code (the server's step-up, audit C-3) → POST /api/auth/mfa/disable.
 *
 * A change of factor moves this session to a new id and ends the account's other sessions: the
 * session's new forgery token is taken from the answer (noteCsrfToken), so the page carries on.
 * Nothing is kept in the browser's storage; the password and codes live only in this component's
 * state while their form is open, and are cleared when it closes.
 *
 * @module components/account
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { noteCsrfToken, useAuth } from "@/platform/auth/context";
import { signInPath } from "@/platform/auth/return-path";
import { adminCall } from "@/components/admin/ui/admin-call";
import { ConfirmDialog } from "@/components/admin/ui/ConfirmDialog";
import { Field, TextInput } from "@/components/admin/ui/Field";
import {
  OutcomeList,
  outcome,
  refusedOutcome,
  type OutcomeEntry,
} from "@/components/admin/ui/Outcome";
import { BUTTON, TEXT } from "@/components/admin/ui/tokens";
import { AuthenticatorKey } from "@/components/app/ui/AuthenticatorKey";
import {
  NewPasswordFields,
  newPasswordReady,
} from "@/components/auth/ui/NewPasswordFields";
import { usePasswordPolicy } from "@/components/auth/ui/usePasswordPolicy";
import { RefusalNotice } from "@/components/refusal/RefusalNotice";
import type { Refusal } from "@/platform/errors/refusal";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.account.security.${key}`, values);

const TOTP = /^\d{6}$/;

/** What the account page knows of how the account signs in. */
export interface SecurityState {
  /** null: the provider did not say — shown as unknown, never as off. */
  readonly mfaEnabled: boolean | null;
  readonly signInMethod: "password" | "sso";
}

type Read =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly refusal: Refusal }
  | { readonly kind: "ready"; readonly state: SecurityState };

/** The account's sign-in state, read once; a refusal or no answer is its own state. */
export async function readSecurity(): Promise<Read> {
  const answer = await adminCall("/api/account/security");
  if (!answer.ok) return { kind: "failed", refusal: answer.refusal };
  const { mfaEnabled, signInMethod } = answer.body;
  return {
    kind: "ready",
    state: {
      mfaEnabled: typeof mfaEnabled === "boolean" ? mfaEnabled : null,
      signInMethod: signInMethod === "sso" ? "sso" : "password",
    },
  };
}

/** A section's own heading level, inside the account page's "Sign-in and security". */
function Part({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="space-y-3 border-t border-gray-800 pt-4 first:border-0 first:pt-0">
      <h3 className="text-base font-semibold text-white">{title}</h3>
      {children}
    </div>
  );
}

function ChangePassword({
  email,
  say,
}: {
  readonly email: string;
  readonly say: (entry: OutcomeEntry) => void;
}) {
  const [step, setStep] = useState<"idle" | "confirm" | "code" | "done">("idle");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const policy = usePasswordPolicy();

  const close = () => {
    setStep("idle");
    setCode("");
    setPassword("");
    setConfirm("");
    setProblem(null);
  };

  const sendCode = async () => {
    setBusy(true);
    const answer = await adminCall("/api/auth/forgot-password", {
      method: "POST",
      json: { email },
    });
    setBusy(false);
    if (!answer.ok) {
      say(refusedOutcome(answer.refusal, { action: t("password_change") }));
      setStep("idle");
      return;
    }
    setStep("code");
  };

  const change = async () => {
    if (!TOTP.test(code)) return setProblem(t("code_short"));
    if (!newPasswordReady(password, confirm, policy))
      return setProblem(t("password_not_ready"));
    setProblem(null);
    setBusy(true);
    const answer = await adminCall("/api/auth/confirm-forgot-password", {
      method: "POST",
      json: { email, code, newPassword: password },
    });
    setBusy(false);
    if (!answer.ok) {
      say(refusedOutcome(answer.refusal, { action: t("password_change") }));
      return;
    }
    setCode("");
    setPassword("");
    setConfirm("");
    setStep("done");
    say(outcome("applied", t("password_changed"), { next: t("password_changed_next") }));
  };

  if (step === "done") {
    return (
      <p className={`text-sm ${TEXT.quiet}`}>
        {t("password_changed_next")}{" "}
        <a href={signInPath("/account")} className={BUTTON.link}>
          {t("sign_in_again")}
        </a>
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className={`text-sm ${TEXT.quiet}`}>{t("password_explainer")}</p>
      {step === "idle" && (
        <button
          ref={opener}
          type="button"
          onClick={() => setStep("confirm")}
          className={BUTTON.quiet}
        >
          {t("password_change")}
        </button>
      )}
      {step === "confirm" && (
        <ConfirmDialog
          id="account.password_change"
          risk="consequential"
          title={t("password_confirm_title")}
          consequence={t("password_confirm_consequence", { email })}
          confirmLabel={t("password_send_code")}
          busy={busy}
          returnFocus={opener}
          onConfirm={() => void sendCode()}
          onCancel={close}
        />
      )}
      {step === "code" && (
        <form
          noValidate
          aria-label={t("password_form")}
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void change();
          }}
        >
          <p className={`text-sm ${TEXT.quiet}`}>{t("password_code_sent", { email })}</p>
          <Field label={t("code_label")} help={t("code_help")}>
            {(control) => (
              <TextInput
                {...control}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              />
            )}
          </Field>
          <NewPasswordFields
            passwordId="account-new-password"
            confirmId="account-confirm-password"
            passwordLabel={t("new_password")}
            confirmLabel={t("confirm_password")}
            password={password}
            confirm={confirm}
            onPassword={setPassword}
            onConfirm={setConfirm}
            policy={policy}
            disabled={busy}
          />
          {problem ? (
            <p role="alert" className="text-xs text-red-300">
              {problem}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={BUTTON.primary}>
              {busy ? t("working") : t("password_change")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={close}
              className={BUTTON.quiet}
            >
              {t("cancel")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** The password and current code a factor change asks for (the server's step-up). */
function StepUpFields({
  password,
  code,
  onPassword,
  onCode,
  needsCode,
}: {
  readonly password: string;
  readonly code: string;
  readonly onPassword: (v: string) => void;
  readonly onCode: (v: string) => void;
  readonly needsCode: boolean;
}) {
  return (
    <div className="space-y-3">
      <Field label={t("step_up_password")}>
        {(control) => (
          <TextInput
            {...control}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => onPassword(e.target.value)}
          />
        )}
      </Field>
      {needsCode && (
        <Field label={t("step_up_code")} help={t("code_help")}>
          {(control) => (
            <TextInput
              {...control}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => onCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            />
          )}
        </Field>
      )}
    </div>
  );
}

function TwoStep({
  state,
  say,
  onChanged,
}: {
  readonly state: SecurityState;
  readonly say: (entry: OutcomeEntry) => void;
  readonly onChanged: () => void;
}) {
  type Step =
    | { kind: "idle" }
    | { kind: "proof" }
    | { kind: "code"; secret: string; uri?: string }
    | { kind: "off" };
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [current, setCurrent] = useState("");
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);

  const close = () => {
    setStep({ kind: "idle" });
    setPassword("");
    setCurrent("");
    setCode("");
    setProblem(null);
  };

  /** A change of factor moved this session to a new id: carry on with its new token. */
  const moved = (body: Record<string, unknown>) => {
    if (typeof body.csrfToken === "string") noteCsrfToken(body.csrfToken);
  };

  const start = async (withProof: boolean) => {
    if (withProof && password === "") return setProblem(t("password_needed"));
    setProblem(null);
    setBusy(true);
    const answer = withProof
      ? await adminCall("/api/auth/mfa/setup", {
          method: "POST",
          json: { password, ...(current ? { currentCode: current } : {}) },
        })
      : await adminCall("/api/auth/mfa/setup", { method: "POST" });
    setBusy(false);
    if (!answer.ok) {
      // The server cannot tell that no factor exists: it asks for proof first (audit C-3).
      if (answer.refusal.code === "auth.step_up_required" && !withProof) {
        setStep({ kind: "proof" });
        return;
      }
      say(refusedOutcome(answer.refusal, { action: t("mfa_turn_on") }));
      return;
    }
    if (typeof answer.body.secretCode !== "string") {
      say(outcome("refused", t("mfa_setup_failed"), { action: t("mfa_turn_on") }));
      return;
    }
    setPassword("");
    setCurrent("");
    setStep({
      kind: "code",
      secret: answer.body.secretCode,
      ...(typeof answer.body.qrCodeUri === "string"
        ? { uri: answer.body.qrCodeUri }
        : {}),
    });
  };

  const verify = async () => {
    if (!TOTP.test(code)) return setProblem(t("code_short"));
    setProblem(null);
    setBusy(true);
    const answer = await adminCall("/api/auth/mfa/verify", {
      method: "POST",
      json: { code },
    });
    setBusy(false);
    if (!answer.ok) {
      say(refusedOutcome(answer.refusal, { action: t("mfa_turn_on") }));
      return;
    }
    moved(answer.body);
    close();
    say(outcome("applied", t("mfa_on_done"), { next: t("mfa_others_signed_out") }));
    onChanged();
  };

  const turnOff = async () => {
    if (password === "" || !TOTP.test(current)) return setProblem(t("step_up_missing"));
    setProblem(null);
    setBusy(true);
    const answer = await adminCall("/api/auth/mfa/disable", {
      method: "POST",
      json: { password, currentCode: current },
    });
    setBusy(false);
    if (!answer.ok) {
      say(refusedOutcome(answer.refusal, { action: t("mfa_turn_off") }));
      return;
    }
    moved(answer.body);
    close();
    say(outcome("applied", t("mfa_off_done"), { next: t("mfa_others_signed_out") }));
    onChanged();
  };

  if (state.signInMethod === "sso") {
    return <p className={`text-sm ${TEXT.quiet}`}>{t("mfa_sso")}</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-100" data-testid="mfa-state">
        {state.mfaEnabled === true
          ? t("mfa_is_on")
          : state.mfaEnabled === false
            ? t("mfa_is_off")
            : t("mfa_unknown")}
      </p>
      <p className={`text-sm ${TEXT.quiet}`}>{t("mfa_explainer")}</p>
      {step.kind === "idle" && state.mfaEnabled !== true && (
        <button
          ref={opener}
          type="button"
          disabled={busy}
          onClick={() => void start(false)}
          className={BUTTON.primary}
        >
          {busy ? t("working") : t("mfa_turn_on")}
        </button>
      )}
      {step.kind === "idle" && state.mfaEnabled !== false && (
        <button
          ref={state.mfaEnabled === true ? opener : undefined}
          type="button"
          onClick={() => setStep({ kind: "off" })}
          className={BUTTON.quiet}
        >
          {t("mfa_turn_off")}
        </button>
      )}
      {step.kind === "proof" && (
        <form
          noValidate
          aria-label={t("proof_form")}
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void start(true);
          }}
        >
          <p className={`text-sm ${TEXT.quiet}`}>{t("proof_intro")}</p>
          <StepUpFields
            password={password}
            code={current}
            onPassword={setPassword}
            onCode={setCurrent}
            needsCode
          />
          {problem ? (
            <p role="alert" className="text-xs text-red-300">
              {problem}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={BUTTON.primary}>
              {busy ? t("working") : t("continue")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={close}
              className={BUTTON.quiet}
            >
              {t("cancel")}
            </button>
          </div>
        </form>
      )}
      {step.kind === "code" && (
        <form
          noValidate
          aria-label={t("mfa_code_form")}
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
        >
          <AuthenticatorKey
            secret={step.secret}
            idPrefix="account-mfa"
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
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              />
            )}
          </Field>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={BUTTON.primary}>
              {busy ? t("working") : t("mfa_confirm")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={close}
              className={BUTTON.quiet}
            >
              {t("cancel")}
            </button>
          </div>
        </form>
      )}
      {step.kind === "off" && (
        <ConfirmDialog
          id="account.mfa_disable"
          risk="consequential"
          title={t("mfa_off_title")}
          consequence={t("mfa_off_consequence")}
          confirmLabel={t("mfa_turn_off")}
          busy={busy}
          returnFocus={opener}
          onConfirm={() => void turnOff()}
          onCancel={close}
          fields={
            <>
              <StepUpFields
                password={password}
                code={current}
                onPassword={setPassword}
                onCode={setCurrent}
                needsCode
              />
              {problem ? (
                <p role="alert" className="text-xs text-red-300">
                  {problem}
                </p>
              ) : null}
            </>
          }
        />
      )}
    </div>
  );
}

export default function SignInSecurity() {
  const { user } = useAuth();
  const [read, setRead] = useState<Read>({ kind: "loading" });
  const [outcomes, setOutcomes] = useState<OutcomeEntry[]>([]);
  const say = useCallback(
    (entry: OutcomeEntry) => setOutcomes((list) => [...list, entry]),
    []
  );

  const load = useCallback(async () => {
    setRead({ kind: "loading" });
    setRead(await readSecurity());
  }, []);

  useEffect(() => {
    let current = true;
    void readSecurity().then((next) => {
      if (current) setRead(next);
    });
    return () => {
      current = false;
    };
  }, []);

  return (
    <div className="space-y-4">
      <OutcomeList
        outcomes={outcomes}
        label={t("results_label")}
        onDismiss={(id) => setOutcomes((list) => list.filter((o) => o.id !== id))}
      />
      {read.kind === "loading" && (
        <p role="status" className={`text-sm ${TEXT.faint}`}>
          {t("loading")}
        </p>
      )}
      {read.kind === "failed" && (
        <div className="space-y-2">
          <p className="text-sm text-gray-100">{t("unreadable")}</p>
          {/* Its own "Try again" below: the notice offers none, so there is one, not two. */}
          <RefusalNotice refusal={read.refusal} offerAppeal={false} />
          <button type="button" onClick={() => void load()} className={BUTTON.quiet}>
            {t("retry")}
          </button>
        </div>
      )}
      {read.kind === "ready" && (
        <>
          <Part title={t("password_title")}>
            {read.state.signInMethod === "sso" ? (
              <p className={`text-sm ${TEXT.quiet}`}>{t("password_sso")}</p>
            ) : (
              <ChangePassword email={user?.email ?? ""} say={say} />
            )}
          </Part>
          <Part title={t("mfa_title")}>
            <TwoStep state={read.state} say={say} onChanged={() => void load()} />
          </Part>
        </>
      )}
    </div>
  );
}
