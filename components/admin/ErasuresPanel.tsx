"use client";

/**
 * components/admin/ErasuresPanel.tsx — the Erasures view: open erasures and the two-operator
 * attestation (TASK-202, S3-E19)
 *
 * No screen showed which erasures were open, nor offered the attestation that closes one whose
 * sign-in identity the system cannot prove erased: an operator learned of it from an alert and
 * called the route by hand. This lists every open erasure (GET /api/operator/erasures, operators
 * only) — the erased account by its id (its address was erased with it), who asked and when, its
 * data purge, and each external step: erased, pending, or not found in a pool the system cannot
 * prove was the account's (`poolUnverified`) — and offers the attestation on the existing route,
 * POST /api/operator/tenants/[id]/erasures/[userId]/attestation: ask (a reason and a note), then a
 * different operator approves, or either rejects.
 *
 * The rules are erasure-attestation.ts's and unchanged. When they make the approval impossible —
 * no operator other than the one who asks (a single-owner deployment) — the view says so plainly
 * instead of offering a request no one can approve.
 *
 * @module components/admin
 */

import React, { useState } from "react";
import { apiFetch } from "@/platform/auth/api-fetch";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { networkRefusal, readRefusal } from "@/platform/errors/refusal";
import { isPanelUnavailable, PanelUnavailable } from "./PanelUnavailable";
import { ResultList, result, type ShownResult } from "./ResultList";
import { formatDateTime } from "./admin-format";
import type {
  ActorView,
  ErasureOverview,
  ErasureStepView,
  ErasureView,
} from "@/platform/gdpr/erasure-status";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.erasures.${key}`, values);

/** A person who acted, by address (never an id). */
function actorText(a: ActorView | undefined): string {
  if (!a || a.kind === "unknown")
    return renderMessage("screens.admin_console.people.unknown");
  if (a.kind === "erased") return renderMessage("screens.admin_console.people.erased");
  return a.email ?? renderMessage("screens.admin_console.people.no_email");
}

/** An attestation reason in words. */
function reasonText(reason: string): string {
  const key = `screens.admin_console.erasures.reason_${reason}`;
  const text = renderMessage(key);
  return text === key ? t("reason_other", { reason }) : text;
}

/** A store's name in words. */
function storeText(store: string): string {
  return store === "identity-provider"
    ? t("step_identity-provider")
    : t("step_other", { store });
}

const btn = "rounded px-3 py-1.5 text-xs border disabled:opacity-50 whitespace-nowrap";
const field =
  "w-full rounded border border-gray-700 bg-[#0a0f1e] px-3 py-2 text-sm text-gray-100";

export function ErasuresPanel({ data }: { readonly data?: unknown }) {
  const [fresh, setFresh] = useState<ErasureOverview | null>(null);
  const [results, setResults] = useState<ShownResult[]>([]);
  const [busy, setBusy] = useState(false);

  const [shownData, setShownData] = useState(data);
  if (data !== shownData) {
    setShownData(data);
    setFresh(null);
  }

  if (data === undefined) return <p className="text-sm text-gray-400">{t("loading")}</p>;
  if (isPanelUnavailable(data) || !Array.isArray((data as ErasureOverview)?.erasures))
    return (
      <PanelUnavailable
        panel={renderMessage("screens.admin_console.sections.erasures")}
      />
    );
  const overview = fresh ?? (data as ErasureOverview);

  async function reread() {
    try {
      const res = await apiFetch("/api/operator/erasures");
      if (res.ok) setFresh((await res.json()) as ErasureOverview);
    } catch {
      // The list stays; the result says what happened.
    }
  }

  async function attest(
    e: ErasureView,
    step: ErasureStepView,
    body: Record<string, unknown>,
    done: string
  ) {
    setBusy(true);
    try {
      const res = await apiFetch(
        `/api/operator/tenants/${encodeURIComponent(e.tenantId)}/erasures/${encodeURIComponent(
          e.userId
        )}/attestation`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, store: step.store }),
        }
      );
      if (res.ok) {
        setResults((rs) => [result(body.decision ? "applied" : "held", done), ...rs]);
      } else {
        const refused = await readRefusal(res);
        setResults((rs) => [
          result("refused", t("refused", { id: e.userId, reason: refused.message })),
          ...rs,
        ]);
      }
    } catch {
      setResults((rs) => [
        result(
          "refused",
          t("refused", { id: e.userId, reason: networkRefusal().message })
        ),
        ...rs,
      ]);
    } finally {
      await reread();
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">{t("intro")}</p>
      <p className="text-xs text-gray-400">
        {t("operators", { operators: overview.operators })}
      </p>
      <ResultList
        results={results}
        label={t("results_label")}
        onDismiss={(id) => setResults((rs) => rs.filter((r) => r.id !== id))}
      />
      {overview.erasures.length === 0 ? (
        <p className="text-sm text-gray-400">{t("empty")}</p>
      ) : (
        <ul className="space-y-3">
          {overview.erasures.map((e) => (
            <li
              key={`${e.tenantId}:${e.userId}`}
              data-erasure={e.userId}
              className="rounded-xl border border-gray-800 bg-[#111827] p-4"
            >
              <p className="text-sm font-semibold text-white">{t("account")}</p>
              <p className="break-all text-xs text-gray-400">
                {t("account_detail", { id: e.userId })}
              </p>
              <ul className="mt-2 space-y-1 text-xs text-gray-300">
                <li>{t("tenant", { tenant: e.tenantSlug ?? e.tenantId })}</li>
                <li>{t("requested_by", { person: actorText(e.requestedBy) })}</li>
                <li>{t("erased_on", { date: formatDateTime(e.softDeletedAt) })}</li>
                <li>
                  {e.purgedAt
                    ? t("purge_done", { date: formatDateTime(e.purgedAt) })
                    : t("purge_due", { date: formatDateTime(e.purgeAfter) })}
                </li>
                {e.purgeFailing ? (
                  <li className="text-amber-300">
                    {t("purge_failing", {
                      attempts: e.purgeAttempts,
                      retry: e.purgeRetryAt ? formatDateTime(e.purgeRetryAt) : "none",
                    })}
                  </li>
                ) : null}
              </ul>
              <div className="mt-3 space-y-3">
                {e.steps.map((step) => (
                  <Step
                    key={step.store}
                    erasure={e}
                    step={step}
                    operators={overview.operators}
                    reasons={overview.reasons}
                    busy={busy}
                    onAttest={(body, done) => attest(e, step, body, done)}
                  />
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One external step: its state, and the attestation it allows. */
function Step({
  erasure,
  step,
  operators,
  reasons,
  busy,
  onAttest,
}: {
  readonly erasure: ErasureView;
  readonly step: ErasureStepView;
  readonly operators: number;
  readonly reasons: readonly string[];
  readonly busy: boolean;
  readonly onAttest: (body: Record<string, unknown>, done: string) => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState(reasons[0] ?? "");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"approve" | "reject" | null>(null);
  const id = erasure.userId;
  const open =
    step.attestationRequest && !step.attestationRequest.expired
      ? step.attestationRequest
      : undefined;
  const prefix = `att-${erasure.tenantId}-${id}-${step.store}`;

  return (
    <div
      className="rounded-lg border border-gray-800 bg-[#0f172a] p-3 text-xs"
      data-step={step.store}
    >
      <p className="text-sm text-gray-200">{storeText(step.store)}</p>
      {step.done ? (
        <p className="text-green-300">
          {t("step_done", { date: step.doneAt ? formatDateTime(step.doneAt) : "" })}
        </p>
      ) : (
        <p className="text-gray-300">{t("step_pending", { attempts: step.attempts })}</p>
      )}
      {!step.done && step.poolUnverified ? (
        <p className="mt-1 text-amber-300" data-pool-unverified="true">
          {t("step_unverified")}
        </p>
      ) : null}
      {step.attested ? (
        <p className="mt-1 text-gray-300">
          {t("step_attested", {
            asked: actorText(step.attested.requestedBy),
            approved: actorText(step.attested.by),
            date: formatDateTime(step.attested.at),
            reason: reasonText(step.attested.reason),
          })}
        </p>
      ) : null}
      {step.attestationRequest?.expired ? (
        <p className="mt-1 text-gray-400">
          {t("request_expired", {
            person: actorText(step.attestationRequest.by),
            expires: formatDateTime(step.attestationRequest.expiresAt),
          })}
        </p>
      ) : null}
      {open ? (
        <p className="mt-1 text-gray-200">
          {t("request_open", {
            person: actorText(open.by),
            date: formatDateTime(open.at),
            reason: reasonText(open.reason),
            expires: formatDateTime(open.expiresAt),
          })}
        </p>
      ) : null}

      {!step.done && step.poolUnverified && !erasure.secondOperator ? (
        <p
          className="mt-2 rounded border border-amber-700 bg-amber-900/20 p-2 text-amber-200"
          data-no-second-operator="true"
        >
          {t("no_second_operator", { operators })}
        </p>
      ) : null}

      {!step.done && open ? (
        <div className="mt-2 space-y-2">
          {open.byViewer ? <p className="text-gray-300">{t("own_request")}</p> : null}
          {confirming ? (
            <div role="group" data-confirm={confirming} className="space-y-2">
              <p className="text-gray-200">
                {confirming === "approve"
                  ? t("confirm_approve", { id, reason: reasonText(open.reason) })
                  : t("confirm_reject", { id })}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  className={`${btn} border-blue-600 bg-blue-600 text-white`}
                  onClick={async () => {
                    await onAttest(
                      { decision: confirming },
                      confirming === "approve"
                        ? t("approved", { id })
                        : t("rejected", { id })
                    );
                    setConfirming(null);
                  }}
                >
                  {t("confirm")}
                </button>
                <button
                  type="button"
                  className={`${btn} border-gray-700 bg-gray-800 text-gray-200`}
                  onClick={() => setConfirming(null)}
                >
                  {t("cancel")}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {!open.byViewer && erasure.secondOperator ? (
                <button
                  type="button"
                  disabled={busy}
                  className={`${btn} border-green-700 bg-green-900/40 text-green-200`}
                  onClick={() => setConfirming("approve")}
                >
                  {t("approve")}
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy}
                className={`${btn} border-gray-700 bg-gray-800 text-gray-200`}
                onClick={() => setConfirming("reject")}
              >
                {t("reject")}
              </button>
            </div>
          )}
        </div>
      ) : null}

      {!step.done && step.poolUnverified && !open && erasure.secondOperator ? (
        asking ? (
          <form
            noValidate
            className="mt-2 space-y-2"
            onSubmit={async (ev) => {
              ev.preventDefault();
              if (note.trim().length < 3) {
                setProblem(t("note_short"));
                return;
              }
              setProblem(null);
              await onAttest({ reason, note: note.trim() }, t("asked", { id }));
              setAsking(false);
            }}
          >
            <p className="text-gray-200">{t("ask_title")}</p>
            <label htmlFor={`${prefix}-reason`} className="block text-gray-300">
              {t("field_reason")}
            </label>
            <select
              id={`${prefix}-reason`}
              value={reason}
              onChange={(ev) => setReason(ev.target.value)}
              className={`${field} max-w-sm`}
            >
              {reasons.map((r) => (
                <option key={r} value={r}>
                  {reasonText(r)}
                </option>
              ))}
            </select>
            <label htmlFor={`${prefix}-note`} className="block text-gray-300">
              {t("field_note")}
            </label>
            <textarea
              id={`${prefix}-note`}
              value={note}
              maxLength={500}
              onChange={(ev) => setNote(ev.target.value)}
              rows={2}
              className={field}
            />
            {problem ? (
              <p role="alert" className="text-amber-300">
                {problem}
              </p>
            ) : null}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={busy}
                className={`${btn} border-blue-600 bg-blue-600 text-white`}
              >
                {t("submit_ask")}
              </button>
              <button
                type="button"
                className={`${btn} border-gray-700 bg-gray-800 text-gray-200`}
                onClick={() => setAsking(false)}
              >
                {t("cancel")}
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            disabled={busy}
            className={`mt-2 ${btn} border-blue-700 bg-blue-900/40 text-blue-200`}
            onClick={() => setAsking(true)}
          >
            {t("ask")}
          </button>
        )
      ) : null}
    </div>
  );
}
