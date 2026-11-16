"use client";

/**
 * components/admin/ErasuresPanel.tsx — the Erasures view: open erasures and the two-operator
 * attestation (TASK-202, S3-E19), on the console's shared parts (TASK-221)
 *
 * It lists every open erasure (GET /api/operator/erasures, read by the console: a failed read is
 * said, never "no erasure is open") — who asked and when, its data purge, and each external step:
 * erased, pending, or not found in a pool the system cannot prove was the account's
 * (`poolUnverified`) — and offers the attestation on the existing route, POST
 * /api/operator/tenants/[id]/erasures/[userId]/attestation: ask (a kind of reason and a note),
 * then a different operator approves, or either rejects.
 *
 * What the review found and how each is done (SF-admin-090 to 093):
 *
 *   - the erased account has no address left: it is named by a short reference (its id's first
 *     characters) and the day it was erased — the whole id only with "Show details" — and its
 *     tenant by name;
 *   - asking, approving and rejecting are the one confirm step: it takes focus and gives it back,
 *     says what happens (approving closes the step on the attesters' word and cannot be undone),
 *     and its button names the action; asking takes the kind of reason and the note in the step;
 *   - a store is named in words, a step done on no recorded date says only that it is done;
 *   - with no second operator, the sentence says what to do here — not a document to look up.
 *
 * The rules are erasure-attestation.ts's and unchanged.
 *
 * @module components/admin
 */

import React, { useRef, useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { formatDate, formatDateTime } from "./admin-format";
import { ConfirmStep } from "@/components/admin/ui/ConfirmStep";
import { GatedButton } from "@/components/admin/ui/PermissionGate";
import { IdDetail } from "@/components/admin/ui/Ref";
import { SHORT_ID, storeLabel } from "@/components/admin/ui/labels";
import { runOperatorAction } from "@/components/admin/ui/governed";
import { BUTTON, SURFACE, TEXT, TONE } from "@/components/admin/ui/tokens";
import { sectionTitle } from "@/components/admin/ui/sections";
import { ListUnreadable, useChange, useOutcomes } from "./views/kit";
import type { SectionViewProps } from "./section-views";
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

/** An attestation reason in words; one the catalogue does not know, made readable. */
function reasonText(reason: string): string {
  const key = `screens.admin_console.erasures.reason_${reason}`;
  const text = renderMessage(key);
  return text === key ? t("reason_other") : text;
}

/**
 * The erased account as an operator can tell it apart (SF-admin-090): its address was erased with
 * it, so a short reference — its id's first characters — and the day it was erased.
 */
export function erasedAccountText(
  e: Pick<ErasureView, "userId" | "softDeletedAt">
): string {
  return t("account_ref", {
    ref: e.userId.slice(0, SHORT_ID),
    date: e.softDeletedAt ? formatDate(e.softDeletedAt) : t("date_unknown"),
  });
}

/** The tenant by name; else its short name; else that it is not in the directory. */
function tenantText(e: ErasureView & { readonly tenantName?: string | null }): string {
  return e.tenantName ?? e.tenantSlug ?? t("tenant_unlisted");
}

/** Whether a value is a list (without narrowing a typed list to `any[]`). */
const isList = (value: unknown): boolean => Array.isArray(value);

type Asking = "ask" | "approve" | "reject";

/** One external step: its state, and the attestation it allows. */
function Step({
  erasure,
  step,
  operators,
  reasons,
  busy,
  run,
  onReload,
}: {
  readonly erasure: ErasureView;
  readonly step: ErasureStepView;
  readonly operators: number;
  readonly reasons: readonly string[];
  readonly busy: boolean;
  readonly run: ReturnType<typeof useChange>["run"];
  readonly onReload?: () => void;
}) {
  const [asking, setAsking] = useState<Asking | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const account = erasedAccountText(erasure);
  const store = storeLabel(step.store);
  const open =
    step.attestationRequest && !step.attestationRequest.expired
      ? step.attestationRequest
      : undefined;
  const url = `/api/operator/tenants/${encodeURIComponent(
    erasure.tenantId
  )}/erasures/${encodeURIComponent(erasure.userId)}/attestation`;
  const decide = (decision: "approve" | "reject") =>
    run(
      () => runOperatorAction(url, "POST", { decision, store: step.store }),
      t(decision === "approve" ? "what_approve" : "what_reject", { account, store }),
      { who: tenantText(erasure) }
    ).then(() => setAsking(null));

  return (
    <div
      className={`${SURFACE.inset} min-w-0 space-y-1 p-3 text-sm`}
      data-step={step.store}
    >
      <p className={`font-semibold ${TEXT.body}`}>{store}</p>
      {step.done ? (
        <p className="text-green-300">
          {step.doneAt
            ? t("step_done", { date: formatDateTime(step.doneAt) })
            : t("step_done_undated")}
        </p>
      ) : (
        <p className={TEXT.quiet}>{t("step_pending", { attempts: step.attempts })}</p>
      )}
      {!step.done && step.poolUnverified ? (
        <p className="text-amber-300" data-pool-unverified="true">
          {t("step_unverified")}
        </p>
      ) : null}
      {step.attested ? (
        <p className={TEXT.quiet}>
          {t("step_attested", {
            asked: actorText(step.attested.requestedBy),
            approved: actorText(step.attested.by),
            date: formatDateTime(step.attested.at),
            reason: reasonText(step.attested.reason),
          })}
        </p>
      ) : null}
      {step.attestationRequest?.expired ? (
        <p className={TEXT.faint}>
          {t("request_expired", {
            person: actorText(step.attestationRequest.by),
            expires: formatDateTime(step.attestationRequest.expiresAt),
          })}
        </p>
      ) : null}
      {open ? (
        <p className={TEXT.body}>
          {t("request_open", {
            person: open.byViewer ? t("you") : actorText(open.by),
            date: formatDateTime(open.at),
            reason: reasonText(open.reason),
            expires: formatDateTime(open.expiresAt),
          })}
        </p>
      ) : null}

      {!step.done && step.poolUnverified && !erasure.secondOperator ? (
        <p className={`rounded border p-2 ${TONE.held}`} data-no-second-operator="true">
          {t("no_second_operator", { operators })}
        </p>
      ) : null}

      {asking === "ask" ? (
        <ConfirmStep
          action="erasures.ask"
          title={t("ask_title", { account, store })}
          confirmLabel={t("submit_ask")}
          choices={reasons.map((r) => ({ value: r, label: reasonText(r) }))}
          choiceLabel={t("field_reason")}
          returnFocus={opener}
          busy={busy}
          onCancel={() => setAsking(null)}
          onConfirm={(given) =>
            void run(
              () =>
                runOperatorAction(
                  url,
                  "POST",
                  { reason: given.choice, note: given.reason, store: step.store },
                  { asks: true }
                ),
              t("what_ask", { account, store }),
              { who: tenantText(erasure), heldNext: t("ask_next") }
            ).then((answer) => {
              setAsking(null);
              // Asked: the request now shows on its step — read the list again.
              if (answer.standing === "held") onReload?.();
            })
          }
        >
          <p>{t("ask_body")}</p>
        </ConfirmStep>
      ) : asking && open ? (
        <ConfirmStep
          action={asking === "approve" ? "erasures.approve" : "erasures.reject"}
          title={t(asking === "approve" ? "confirm_approve" : "confirm_reject", {
            account,
            store,
          })}
          confirmLabel={t(asking === "approve" ? "approve" : "reject")}
          returnFocus={opener}
          busy={busy}
          onCancel={() => setAsking(null)}
          onConfirm={() => void decide(asking === "approve" ? "approve" : "reject")}
        >
          <p>{t("confirm_reason", { reason: reasonText(open.reason) })}</p>
        </ConfirmStep>
      ) : null}

      {!step.done && open && !asking ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {erasure.secondOperator ? (
            <GatedButton
              allowed={!open.byViewer}
              reason={t("own_request")}
              className={BUTTON.primary}
              disabled={busy}
              onClick={(e) => {
                opener.current = e.currentTarget;
                setAsking("approve");
              }}
            >
              {t("approve")}
            </GatedButton>
          ) : null}
          <button
            type="button"
            className={BUTTON.quiet}
            disabled={busy}
            onClick={(e) => {
              opener.current = e.currentTarget;
              setAsking("reject");
            }}
          >
            {t("reject")}
          </button>
        </div>
      ) : null}

      {!step.done && step.poolUnverified && !open && erasure.secondOperator && !asking ? (
        <button
          type="button"
          className={`mt-1 ${BUTTON.quiet}`}
          disabled={busy}
          onClick={(e) => {
            opener.current = e.currentTarget;
            setAsking("ask");
          }}
        >
          {t("ask")}
        </button>
      ) : null}
    </div>
  );
}

export function ErasuresPanel({ data, onReload, showIds = false }: SectionViewProps) {
  const { add, list } = useOutcomes(t("results_label"));
  const { busy, run } = useChange(add, onReload);
  const overview = data as ErasureOverview | undefined;
  // A body without its list is not an empty list (review 14 L-1): said as a failed read.
  if (!overview || !isList(overview.erasures))
    return <ListUnreadable panel={sectionTitle("erasures")} onRetry={onReload} />;
  return (
    <div className="min-w-0 space-y-4">
      <p className={`text-sm ${TEXT.faint}`}>{t("intro")}</p>
      <p className={`text-xs ${TEXT.faint}`}>
        {t("operators", { operators: overview.operators })}
      </p>
      {list}
      {overview.erasures.length === 0 ? (
        <p
          data-panel-state="empty"
          className={`${SURFACE.panel} px-4 py-8 text-center text-sm ${TEXT.quiet}`}
        >
          {t("empty")}
        </p>
      ) : (
        <ul className="space-y-3" aria-label={t("caption")}>
          {overview.erasures.map((e) => (
            <li
              key={`${e.tenantId}:${e.userId}`}
              data-erasure={e.userId}
              className={`${SURFACE.panel} min-w-0 p-4`}
            >
              <p className={`text-sm font-semibold ${TEXT.strong}`}>
                {erasedAccountText(e)}
              </p>
              {showIds ? (
                <p className="text-xs">
                  <IdDetail id={e.userId} show />
                </p>
              ) : null}
              <ul className={`mt-2 space-y-1 text-xs ${TEXT.quiet}`}>
                <li>{t("tenant", { tenant: tenantText(e) })}</li>
                <li>{t("requested_by", { person: actorText(e.requestedBy) })}</li>
                <li>{t("erased_on", { date: formatDateTime(e.softDeletedAt) })}</li>
                <li>
                  {e.purgedAt
                    ? t("purge_done", { date: formatDateTime(e.purgedAt) })
                    : t("purge_due", { date: formatDateTime(e.purgeAfter) })}
                </li>
                {e.purgeFailing ? (
                  <li className="text-amber-300">
                    {e.purgeRetryAt
                      ? t("purge_failing_retry", {
                          attempts: e.purgeAttempts,
                          retry: formatDateTime(e.purgeRetryAt),
                        })
                      : t("purge_failing", { attempts: e.purgeAttempts })}
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
                    run={run}
                    onReload={onReload}
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
