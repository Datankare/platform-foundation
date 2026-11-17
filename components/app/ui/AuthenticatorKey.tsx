"use client";

/**
 * components/app/ui/AuthenticatorKey.tsx — an authenticator app's secret, drawn as a QR code with
 * the key behind "Can't scan? Show key" (audit A-9, TASK-180; one part since TASK-224)
 *
 * Staff enrol in two-step verification before the console opens (components/admin/
 * MfaEnrollment.tsx), and every account can now turn it on from its account page
 * (components/account/SignInSecurity.tsx): both show the secret this way. The otpauth:// URI is
 * drawn in the browser as one SVG path of the code's dark squares — nothing about the secret
 * leaves the page, and no markup is built from it. The key and the URI are the fallback, hidden
 * until asked for so the secret is not on screen by default.
 *
 * @module components/app/ui
 */

import React, { useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { renderMessage } from "@/platform/errors/messages";
import { SecretText } from "@/components/admin/ui/Stored";
import { BUTTON, TEXT } from "@/components/admin/ui/tokens";

const t = (key: string) => renderMessage(`screens.mfa.${key}`);

/** One SVG path for a QR code's dark modules (no markup injection), or null if it cannot encode. */
export function qrPath(text: string): { size: number; d: string } | null {
  try {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 4;
    let d = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
      }
    }
    return { size: n + 2 * quiet, d };
  } catch {
    return null;
  }
}

function QrCode({ text }: { readonly text: string }) {
  const qr = useMemo(() => qrPath(text), [text]);
  if (!qr) return <p className="text-sm text-amber-300">{t("qr_failed")}</p>;
  return (
    <svg
      role="img"
      aria-label={t("qr_label")}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      width={200}
      height={200}
      shapeRendering="crispEdges"
      className="self-center rounded bg-white"
    >
      <path d={qr.d} fill="#000" />
    </svg>
  );
}

export function AuthenticatorKey({
  secret,
  uri,
  idPrefix = "mfa",
}: {
  readonly secret: string;
  readonly uri?: string;
  /** Unique on the page: the key's region is `${idPrefix}-key`. */
  readonly idPrefix?: string;
}) {
  const [showKey, setShowKey] = useState(false);
  const keyId = `${idPrefix}-key`;
  return (
    <div className="flex flex-col gap-3">
      {uri && (
        <>
          <p className="text-sm">{t("scan")}</p>
          <QrCode text={uri} />
        </>
      )}
      <button
        type="button"
        aria-expanded={showKey}
        aria-controls={keyId}
        onClick={() => setShowKey((v) => !v)}
        className={`self-start text-sm ${BUTTON.link}`}
      >
        {showKey ? t("hide_key") : t("show_key")}
      </button>
      {showKey && (
        <div id={keyId} className="flex flex-col gap-2">
          <p className="text-sm">
            {t("add_key")} <SecretText value={secret} />
          </p>
          {uri && (
            <p className={`text-xs ${TEXT.faint}`}>
              {t("or_open")} <SecretText value={uri} />
            </p>
          )}
        </div>
      )}
    </div>
  );
}
