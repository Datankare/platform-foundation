"use client";

/**
 * components/account/YourData.tsx — a copy of your data, and deleting your account, from the
 * account page (TASK-225, E-126; GDPR Articles 15 and 17)
 *
 * The routes existed (GET /api/account/export, POST /api/account/delete — audit X-15) but no
 * screen called either: a person could not get their data or erase their account by using the
 * product. Here, through those routes and nothing else — the erasure is the platform's one
 * governed path (platform/auth/gdpr-deletion.ts: recorded first, the account closed, every
 * module's data, the sign-in identity, then the purge after the retention period); no shortcut is
 * added and no check skipped:
 *
 *   Download a copy   the export, fetched through the call path (the cookie session) and saved
 *                     by the browser only when it arrived whole (components/admin/ui/download.ts)
 *                     — a refusal (too large, the limit of ten an hour, a store that could not
 *                     be read) is said in its own words, and nothing is saved. The route answers
 *                     all or nothing: a part is never offered as the whole.
 *   Delete account    asked first, in red: it cannot be undone; what happens — closed at once,
 *                     every device signed out, the data erased after the retention period — and
 *                     that a copy is the person's to download before. The person ticks that they
 *                     understand before the button acts. A refusal leaves the account as it was
 *                     and says why; success replaces the page with what was done
 *                     (`onDeleted`), including when the sign-in identity's removal is still
 *                     being retried (the account is closed either way).
 *
 * Nothing is kept in the browser's storage; the file is handed to the browser to save and the
 * page keeps nothing of it.
 *
 * @module components/account
 */

import React, { useCallback, useRef, useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { adminCall } from "@/components/admin/ui/admin-call";
import { adminDownload } from "@/components/admin/ui/download";
import { ConfirmDialog } from "@/components/admin/ui/ConfirmDialog";
import { Checkbox } from "@/components/admin/ui/Field";
import {
  OutcomeList,
  outcome,
  refusedOutcome,
  type OutcomeEntry,
} from "@/components/admin/ui/Outcome";
import { BUTTON, TEXT } from "@/components/admin/ui/tokens";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.account.data.${key}`, values);

/** Whether an export arrived whole: the JSON document's last character is its closing brace. */
export function wholeExport(tail: string): boolean {
  return tail.trimEnd().endsWith("}");
}

/** How the account page learns the account is gone: whether its sign-in identity is too. */
export interface Deleted {
  readonly identityDeleted: boolean;
}

export default function YourData({
  email,
  onDeleted,
}: {
  readonly email: string;
  readonly onDeleted: (deleted: Deleted) => void;
}) {
  const [outcomes, setOutcomes] = useState<OutcomeEntry[]>([]);
  const [exporting, setExporting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const say = useCallback(
    (entry: OutcomeEntry) => setOutcomes((list) => [...list, entry]),
    []
  );

  const download = async () => {
    setExporting(true);
    const result = await adminDownload("/api/account/export", "my-data.json", {
      whole: wholeExport,
    });
    setExporting(false);
    if (!result.ok) {
      say(refusedOutcome(result.refusal, { action: t("export") }));
      return;
    }
    say(outcome("applied", t("export_done", { file: result.filename })));
  };

  const close = () => {
    setAsking(false);
    setUnderstood(false);
    setProblem(null);
  };

  const erase = async () => {
    if (!understood) {
      setProblem(t("delete_tick_first"));
      return;
    }
    setProblem(null);
    setDeleting(true);
    const answer = await adminCall("/api/account/delete", {
      method: "POST",
      json: { confirm: "DELETE" },
    });
    setDeleting(false);
    if (!answer.ok) {
      say(refusedOutcome(answer.refusal, { action: t("delete") }));
      close();
      return;
    }
    onDeleted({ identityDeleted: answer.body.identityDeleted !== false });
  };

  return (
    <div className="space-y-4">
      <OutcomeList
        outcomes={outcomes}
        label={t("results_label")}
        onDismiss={(id) => setOutcomes((list) => list.filter((o) => o.id !== id))}
      />
      <div className="space-y-3">
        <h3 className="text-base font-semibold text-white">{t("export_title")}</h3>
        <p className={`text-sm ${TEXT.quiet}`}>{t("export_explainer")}</p>
        <button
          type="button"
          onClick={() => void download()}
          disabled={exporting}
          className={BUTTON.quiet}
        >
          {exporting ? t("exporting") : t("export")}
        </button>
        {exporting && (
          <p role="status" className={`text-sm ${TEXT.faint}`}>
            {t("exporting_status")}
          </p>
        )}
      </div>
      <div className="space-y-3 border-t border-gray-800 pt-4">
        <h3 className="text-base font-semibold text-white">{t("delete_title")}</h3>
        <p className={`text-sm ${TEXT.quiet}`}>{t("delete_explainer")}</p>
        {!asking ? (
          <button
            ref={deleteButton}
            type="button"
            onClick={() => setAsking(true)}
            className={BUTTON.danger}
          >
            {t("delete")}
          </button>
        ) : (
          <ConfirmDialog
            id="account.delete"
            risk="irreversible"
            title={t("delete_confirm_title", { email })}
            consequence={t("delete_consequence")}
            confirmLabel={t("delete_confirm")}
            busy={deleting}
            returnFocus={deleteButton}
            onConfirm={() => void erase()}
            onCancel={close}
            fields={
              <div className="space-y-2">
                <Checkbox
                  label={t("delete_understand")}
                  checked={understood}
                  disabled={deleting}
                  onChange={(e) => {
                    setUnderstood(e.target.checked);
                    setProblem(null);
                  }}
                />
                {problem ? (
                  <p role="alert" className="text-xs text-red-300">
                    {problem}
                  </p>
                ) : null}
              </div>
            }
          />
        )}
      </div>
    </div>
  );
}
