"use client";

/**
 * components/account/SignOutEverywhere.tsx — end every session of the account (ADR-057 D6,
 * TASK-214)
 *
 * On the account page. For someone who signed in on a device they no longer have, or fears
 * another person is in their account: one action ends every session — this one too — and the
 * identity provider's tokens with them (POST /api/auth/sign-out-everywhere). It asks once before
 * acting (the person will have to sign in again everywhere), says so plainly when the server
 * could not do it — the page then stays signed in, so they can try again — and goes to sign-in
 * when it has. Every string is from the catalog (messages/en.json, screens.account.sessions).
 */

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/platform/auth/context";
import { renderMessage } from "@/platform/errors/messages";

const t = (key: string) => renderMessage(`screens.account.sessions.${key}`);

const BUTTON = "rounded px-3 py-2 text-sm disabled:opacity-60";

export default function SignOutEverywhere() {
  const router = useRouter();
  const { signOutEverywhere } = useAuth();
  const [step, setStep] = useState<"idle" | "confirm" | "working" | "failed">("idle");
  const confirm = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (step === "confirm") confirm.current?.focus();
  }, [step]);

  const act = async () => {
    setStep("working");
    if (await signOutEverywhere()) router.replace("/auth");
    else setStep("failed");
  };

  return (
    <div>
      <p className="text-sm text-gray-300">{t("explainer")}</p>
      {step === "failed" && (
        <p role="alert" className="mt-3 text-sm text-red-300">
          {t("failed")}
        </p>
      )}
      {step === "idle" || step === "failed" ? (
        <button
          type="button"
          onClick={() => setStep("confirm")}
          className={`${BUTTON} mt-3 border border-gray-600 text-gray-100 hover:bg-gray-800`}
        >
          {t("action")}
        </button>
      ) : (
        <div className="mt-3" role="group" aria-label={t("confirm_question")}>
          <p className="text-sm text-gray-100">{t("confirm_question")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              ref={confirm}
              type="button"
              onClick={() => void act()}
              disabled={step === "working"}
              className={`${BUTTON} bg-red-700 text-white hover:bg-red-800`}
            >
              {step === "working" ? t("working") : t("confirm")}
            </button>
            <button
              type="button"
              onClick={() => setStep("idle")}
              disabled={step === "working"}
              className={`${BUTTON} border border-gray-600 text-gray-200 hover:bg-gray-800`}
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
