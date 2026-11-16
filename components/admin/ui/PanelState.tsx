"use client";

/**
 * components/admin/ui/PanelState.tsx — what a panel shows while it reads, when the read failed,
 * and when there is nothing to show (TASK-216, SCREEN-FINDINGS P2, E-4)
 *
 * Each view decided this for itself, and most decided wrongly: a read refused 403, 404 or 500
 * was the same `undefined` as "not read yet", so the view said "No items" or "Loading…" for
 * ever; a request that never got an answer rejected unhandled; only a 503 was said. One wrapper,
 * so a failed read can never be read as an empty list:
 *
 *   loading    "Reading Roles…" (role="status");
 *   failed     for EVERY status and for no answer at all: what could not be read, why (the
 *              refusal's own sentence), that nothing is shown and
 *              nothing was changed, and Try again. Never the list, never "No items";
 *   ready      the panel, with when it was read and a Refresh; "Reading again…" while it is
 *              read again;
 *   empty      the panel's own "nothing here" sentence — only after a read that succeeded.
 *
 * usePanelRead is the read itself, through the one call helper.
 *
 * @module components/admin/ui
 */

import React, { useCallback, useEffect, useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import type { Refusal } from "@/platform/errors/refusal";
import { RefusalExtras } from "./RefusalExtras";
import { formatTime } from "@/components/admin/admin-format";
import { adminCall, type CallBody, type CallResult } from "./admin-call";
import { BUTTON, TEXT, TONE } from "./tokens";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.ui.${key}`, values);

export type PanelRead =
  | { readonly phase: "loading" }
  | {
      readonly phase: "ready";
      readonly body: CallBody;
      readonly readAt: Date;
      /** Being read again: what is shown is the last answer, and the panel says so. */
      readonly refreshing: boolean;
    }
  | { readonly phase: "failed"; readonly refusal: Refusal };

/**
 * One panel's read of `url`, again whenever `url` or `again` changes or reload() is called. A
 * new answer replaces the old one whole: a failed re-read never leaves the earlier data on
 * screen as if it were current. `url` null: nothing to read (the panel reads elsewhere).
 */
export function usePanelRead(
  url: string | null,
  again: unknown = 0
): { readonly read: PanelRead; readonly reload: () => void } {
  const send = useCallback(() => (url === null ? null : adminCall(url)), [url]);
  return usePanelAnswer(send, again);
}

/**
 * One panel's read sent as a POST with `body` (JSON text) — a search whose text must never travel
 * in a URL, where every proxy and access log keeps it (TASK-215, audit A-17: the Users list's
 * POST /api/admin/users/search). Read again whenever `url`, `body` or `again` changes, as
 * usePanelRead.
 */
export function usePanelSearch(
  url: string,
  body: string,
  again: unknown = 0
): { readonly read: PanelRead; readonly reload: () => void } {
  const send = useCallback(
    () => adminCall(url, { method: "POST", json: JSON.parse(body) as unknown }),
    [url, body]
  );
  return usePanelAnswer(send, again);
}

/** The read `send` makes, and its answer: shared by usePanelRead and usePanelSearch. */
function usePanelAnswer(
  send: () => Promise<CallResult> | null,
  again: unknown
): { readonly read: PanelRead; readonly reload: () => void } {
  // The last answer, and the read it answered; what the panel shows is derived from the two, so
  // "reading again" needs no state of its own.
  const [answered, setAnswered] = useState<{
    send: () => Promise<CallResult> | null;
    key: string;
    read: PanelRead;
  } | null>(null);
  const [reloads, setReloads] = useState(0);
  const want = JSON.stringify([again, reloads]);
  useEffect(() => {
    const sent = send();
    if (sent === null) return;
    let current = true;
    void sent.then((answer) => {
      if (!current) return;
      setAnswered({
        send,
        key: want,
        read: answer.ok
          ? { phase: "ready", body: answer.body, readAt: new Date(), refreshing: false }
          : { phase: "failed", refusal: answer.refusal },
      });
    });
    return () => {
      current = false;
    };
  }, [send, want]);
  const reload = useCallback(() => setReloads((n) => n + 1), []);
  const read: PanelRead =
    answered === null
      ? { phase: "loading" }
      : answered.send === send && answered.key === want
        ? answered.read
        : answered.read.phase === "ready"
          ? { ...answered.read, refreshing: true }
          : { phase: "loading" };
  return { read, reload };
}

/** "Reading…": a status a screen reader hears. */
export function Reading({ text }: { readonly text: string }) {
  return (
    <p role="status" data-panel-state="loading" className={`text-sm ${TEXT.quiet}`}>
      {text}
    </p>
  );
}

/** A read that failed: said as what it is, for every status and for no answer. */
export function ReadFailed({
  panel,
  refusal,
  onRetry,
}: {
  readonly panel: string;
  readonly refusal: Refusal;
  readonly onRetry?: () => void;
}) {
  // The store down or its value malformed (503): the words review 14 L-1 settled.
  const unavailable =
    refusal.status === 503 && refusal.code === "service.unavailable"
      ? renderMessage("screens.admin_console.unavailable_title")
      : t("read_failed_title", { panel });
  return (
    <div
      role="alert"
      data-read-failed="true"
      className={`rounded-xl border p-4 text-sm ${TONE.refused}`}
    >
      <p className="font-semibold">{unavailable}</p>
      <p className="mt-1" data-read-failed-reason="true">
        {refusal.message}
      </p>
      <RefusalExtras refusal={refusal} />
      <p className="mt-1">
        {renderMessage("screens.admin_console.unavailable_body", { panel })}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          aria-label={renderMessage("screens.admin_console.retry_label", { panel })}
          className={`mt-3 ${BUTTON.quiet}`}
        >
          {renderMessage("screens.admin_console.retry")}
        </button>
      )}
    </div>
  );
}

export function PanelState({
  read,
  panel,
  onReload,
  empty,
  children,
}: {
  readonly read: PanelRead;
  /** The panel's name, as its heading shows it. */
  readonly panel: string;
  /** Read again: Try again after a failure, Refresh otherwise. */
  readonly onReload: () => void;
  /** The panel's "nothing here" sentence for this answer, or null when it has something. */
  readonly empty?: (body: CallBody) => string | null;
  readonly children: (body: CallBody) => React.ReactNode;
}) {
  if (read.phase === "loading") return <Reading text={t("reading", { panel })} />;
  if (read.phase === "failed")
    return <ReadFailed panel={panel} refusal={read.refusal} onRetry={onReload} />;
  const nothing = empty?.(read.body) ?? null;
  return (
    <div data-panel-state="ready" className="min-w-0 space-y-3">
      <div
        className={`flex flex-wrap items-center justify-end gap-3 text-xs ${TEXT.faint}`}
      >
        <span role="status">
          {read.refreshing
            ? t("reading_again", { panel })
            : t("read_at", { time: formatTime(read.readAt) })}
        </span>
        <button
          type="button"
          onClick={onReload}
          disabled={read.refreshing}
          aria-label={t("refresh_label", { panel })}
          className={BUTTON.quiet}
        >
          {t("refresh")}
        </button>
      </div>
      {nothing !== null ? (
        <p
          data-panel-state="empty"
          className={`rounded-xl border border-gray-800 bg-[#111827] px-4 py-8 text-center text-sm ${TEXT.quiet}`}
        >
          {nothing}
        </p>
      ) : (
        children(read.body)
      )}
    </div>
  );
}
