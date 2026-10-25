"use client";

/**
 * components/admin/MfaEnrollment.tsx — Set up two-step verification (audit A-9)
 *
 * Shown in place of the admin console when the server answers auth.mfa_required: staff sign in
 * with a second factor. Starts enrolment (POST /api/auth/mfa/setup — the authenticator app's
 * secret), confirms it with the first code (POST /api/auth/mfa/verify), then asks the user to
 * sign in again so the new session carries the factor.
 */

import React, { useState } from "react";
import { apiFetch } from "@/platform/auth/api-fetch";
import { renderMessage } from "@/platform/errors/messages";

const t = (key: string) => renderMessage(`screens.mfa.${key}`);

type Step =
  { kind: "start" } | { kind: "code"; secret: string; uri?: string } | { kind: "done" };

export default function MfaEnrollment({ onSignOut }: { onSignOut: () => void }) {
  const [step, setStep] = useState<Step>({ kind: "start" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/auth/mfa/setup", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        secretCode?: unknown;
        qrCodeUri?: unknown;
        message?: unknown;
      };
      if (!res.ok || typeof body.secretCode !== "string") {
        setError(typeof body.message === "string" ? body.message : t("setup_failed"));
        return;
      }
      setStep({
        kind: "code",
        secret: body.secretCode,
        ...(typeof body.qrCodeUri === "string" ? { uri: body.qrCodeUri } : {}),
      });
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/auth/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: unknown };
      if (!res.ok) {
        setError(typeof body.message === "string" ? body.message : t("code_refused"));
        return;
      }
      setStep({ kind: "done" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="mfa-title"
      className="mx-auto mt-16 max-w-md rounded-xl border border-gray-700 bg-[#0a0f1e] p-6 text-gray-200"
    >
      <h1 id="mfa-title" className="mb-3 text-xl font-bold text-white">
        {t("title")}
      </h1>
      <p className="mb-4 text-sm text-gray-400">{t("intro")}</p>
      {error && (
        <p role="alert" className="mb-3 text-sm text-red-400">
          {error}
        </p>
      )}
      {step.kind === "start" && (
        <button
          type="button"
          onClick={start}
          disabled={busy}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {t("start")}
        </button>
      )}
      {step.kind === "code" && (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            {t("add_key")}{" "}
            <code className="break-all rounded bg-gray-800 px-1">{step.secret}</code>
          </p>
          {step.uri && (
            <p className="text-xs text-gray-500 break-all">
              {t("or_open")} <code>{step.uri}</code>
            </p>
          )}
          <label htmlFor="mfa-code" className="text-sm text-gray-400">
            {t("code_label")}
          </label>
          <input
            id="mfa-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className="rounded-lg border border-gray-700 bg-black/30 px-3 py-2 text-white"
          />
          <button
            type="button"
            onClick={verify}
            disabled={busy || code.length !== 6}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {t("confirm")}
          </button>
        </div>
      )}
      {step.kind === "done" && (
        <div className="flex flex-col gap-3">
          <p className="text-sm">{t("done")}</p>
          <button
            type="button"
            onClick={onSignOut}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          >
            {t("sign_in_again")}
          </button>
        </div>
      )}
    </section>
  );
}
