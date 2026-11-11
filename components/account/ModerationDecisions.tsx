/**
 * components/account/ModerationDecisions.tsx — the decisions about a user's own content, and their
 * appeals (TASK-210, N-117)
 *
 * The account page's list (app/account/page.tsx): every block of the user's own content the
 * platform recorded, newest first (GET /api/moderation/appeals — the server takes the account from
 * the session, never from this screen), each with where it stands:
 *
 *   appealable    until the window closes: "Appeal" opens the appeal form under it (AppealForm,
 *                 with the server's reason limits); once filed, the list is read again;
 *   appealed      the appeal's status — waiting for a moderator, being reviewed, or decided
 *                 (the decision upheld, overturned or changed);
 *   closed        the window passed with no appeal.
 *
 * Before TASK-210 no page mounted the appeal form, and no screen showed a user the id of a decision
 * against them: an appeal could not be filed by anyone using the product. Every word is the
 * catalog's (screens.account.decisions); a refused read shows the refusal's own message.
 *
 * @module components/account
 */

"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import AppealForm from "@/components/AppealForm/AppealForm";
import { formatDateTime, fullTimestamp } from "@/components/admin/admin-format";
import { apiFetch } from "@/platform/auth/api-fetch";
import {
  CATALOGS,
  DEFAULT_LOCALE,
  lookup,
  renderMessage,
  type MessageValues,
} from "@/platform/errors/messages";
import { readRefusal } from "@/platform/errors/refusal";
import type { OwnDecision, OwnDecisions } from "@/platform/moderation/review-service";

/** This screen's text, from the message catalog (ADR-051 D4). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.account.decisions.${key}`, values);

/** Whether the catalog has `suffix` (<group>_<code>) — a newer server's code may be unknown. */
function codeKnown(suffix: string): boolean {
  return (
    lookup(CATALOGS[DEFAULT_LOCALE], `screens.account.decisions.${suffix}`) !== undefined
  );
}

/** A content type's words; one the catalog does not know reads as "content you submitted". */
function contentLabel(contentType: string): string {
  const code = contentType.replace(/-/g, "_");
  return t(codeKnown(`content_${code}`) ? `content_${code}` : "content_other");
}

/** The line for an appeal's outcome; a decision the catalog does not know reads as decided. */
function outcomeKey(decision: string | undefined): string {
  return decision && codeKnown(`outcome_${decision}`)
    ? `outcome_${decision}`
    : "outcome_unknown";
}

/** Where a decision stands, for its line under the date. */
export function decisionStanding(
  d: OwnDecision,
  now: number
): "appealable" | "pending" | "claimed" | "resolved" | "closed" {
  if (d.appeal) return d.appeal.status;
  return Date.parse(d.appealableUntil) > now ? "appealable" : "closed";
}

type Read =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: OwnDecisions };

/** One read of the user's decisions; never throws (an outage is its refusal's message). */
async function readDecisions(): Promise<Read> {
  try {
    const res = await apiFetch("/api/moderation/appeals");
    if (!res.ok) return { kind: "error", message: (await readRefusal(res)).message };
    const data = (await res.json()) as OwnDecisions;
    return Array.isArray(data?.decisions)
      ? { kind: "ready", data }
      : { kind: "error", message: t("unreadable") };
  } catch {
    return { kind: "error", message: t("unreachable") };
  }
}

/** A time as the line around it reads it ("9 Nov 2026, 14:05"), its whole UTC value in a tooltip. */
function dated(key: string, iso: string): { text: string; title: string } {
  return { text: t(key, { date: formatDateTime(iso) }), title: fullTimestamp(iso) };
}

function Standing({ d, now }: { readonly d: OwnDecision; readonly now: number }) {
  const standing = decisionStanding(d, now);
  if (standing === "closed") {
    return <p className="text-sm text-gray-400">{t("window_closed")}</p>;
  }
  const line =
    standing === "appealable"
      ? dated("appealable_until", d.appealableUntil)
      : standing === "resolved"
        ? dated(
            outcomeKey(d.appeal!.decision),
            d.appeal!.resolvedAt ?? d.appeal!.submittedAt
          )
        : dated(
            standing === "claimed" ? "appeal_in_review" : "appeal_waiting",
            d.appeal!.submittedAt
          );
  return (
    <p
      className={`text-sm ${standing === "appealable" ? "text-gray-300" : "text-gray-200"}`}
      title={line.title}
      data-testid={`decision-standing-${d.id}`}
    >
      {line.text}
    </p>
  );
}

export default function ModerationDecisions() {
  const [read, setRead] = useState<Read>({ kind: "loading" });
  const [open, setOpen] = useState<string | null>(null);
  // The decision whose appeal was just sent: its confirmation stays until another is opened.
  const [sent, setSent] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const latest = useRef(0);

  const load = useCallback(async () => {
    const n = ++latest.current;
    const next = await readDecisions();
    if (n === latest.current) {
      setNow(Date.now());
      setRead(next);
    }
  }, []);

  useEffect(() => {
    let current = true;
    const n = ++latest.current;
    void readDecisions().then((next) => {
      if (current && n === latest.current) setRead(next);
    });
    return () => {
      current = false;
    };
  }, []);

  if (read.kind === "loading") {
    return (
      <p role="status" className="text-sm text-gray-400">
        {t("loading")}
      </p>
    );
  }
  if (read.kind === "error") {
    return (
      <div
        role="alert"
        className="rounded-xl border border-red-700 bg-red-900/30 px-4 py-3 text-sm text-red-300"
      >
        <p>{read.message}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-2 rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-500"
        >
          {t("retry")}
        </button>
      </div>
    );
  }

  const { decisions, appealWindowHours, minReasonLength, maxReasonLength } = read.data;
  return (
    <div>
      <p className="mb-4 text-sm text-gray-400">
        {t("explainer", { hours: appealWindowHours })}
      </p>
      {decisions.length === 0 ? (
        <p className="text-sm text-gray-300" data-testid="decisions-empty">
          {t("none")}
        </p>
      ) : (
        <ul className="space-y-3" data-testid="decisions-list">
          {decisions.map((d) => {
            const standing = decisionStanding(d, now);
            return (
              <li
                key={d.id}
                className="rounded-xl border border-gray-700 bg-gray-900/60 p-4"
                data-testid={`decision-${d.id}`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium text-white">
                    {contentLabel(d.contentType)}
                  </p>
                  <p className="text-xs text-gray-400" title={fullTimestamp(d.decidedAt)}>
                    {t("blocked_on", { date: formatDateTime(d.decidedAt) })}
                  </p>
                </div>
                <div className="mt-1">
                  <Standing d={d} now={now} />
                </div>
                {sent === d.id && (
                  <p
                    role="status"
                    className="mt-2 rounded-lg border border-green-700 bg-green-900/30 px-3 py-2 text-sm text-green-300"
                  >
                    {t("appeal_sent")}
                  </p>
                )}
                {standing === "appealable" && open !== d.id && (
                  <button
                    type="button"
                    onClick={() => {
                      setSent(null);
                      setOpen(d.id);
                    }}
                    className="mt-3 rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-500"
                  >
                    {t("appeal")}
                  </button>
                )}
                {standing === "appealable" && open === d.id && (
                  <div className="mt-3">
                    <AppealForm
                      originalDecisionId={d.id}
                      minReasonLength={minReasonLength}
                      maxReasonLength={maxReasonLength}
                      variant="dark"
                      onSubmitted={() => {
                        setOpen(null);
                        setSent(d.id);
                        void load();
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setOpen(null)}
                      className="mt-2 rounded px-3 py-1 text-sm text-gray-300 hover:bg-gray-800"
                    >
                      {t("cancel")}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
