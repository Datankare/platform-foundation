"use client";

/**
 * components/admin/AgentKillSwitchPanel.tsx — the agent kill switch in the consoles (TASK-172)
 *
 *   AgentKillSwitch          one tenant's kill switch, for the route it is given:
 *                              POST /api/admin/agents/suspend — the current tenant, any deployment
 *                              mode (config_manage_safety; review 12 L7)
 *                              POST /api/operator/tenants/[id]/agents/suspend — a tenant, for
 *                              operators (platform_operate; review 11 M-2)
 *   AdminKillSwitchView      the admin console's section (shown to config_manage_safety holders)
 *
 * Suspending every agent takes power away only, so one person may do it (no second approval); a
 * reason is required and an explicit confirmation step comes before anything is sent — inline,
 * never window.prompt or window.confirm. The answer is shown as the server gives it: the agents
 * suspended, the pending holds withdrawn, and, when nothing was active, whether the registry's
 * invalidation was published again (review 13 L2). A 503 is "unavailable": nothing was suspended.
 *
 * Display decides nothing: the route checks the permission itself. Every word comes from the
 * catalog (screens.kill_switch, ADR-051): no literals.
 */

import React, { useEffect, useId, useRef, useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { apiFetch } from "@/platform/auth/api-fetch";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.kill_switch.${key}`, values);

const card = "bg-[#111827] rounded-xl border border-red-900/60 p-5";
const danger =
  "px-4 py-2 rounded-md text-sm font-medium bg-red-700 hover:bg-red-600 text-white disabled:opacity-50";
const quiet =
  "px-3 py-2 rounded-md text-sm border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-50";

/** What the route answers on success. */
interface Suspension {
  readonly suspended: readonly string[];
  readonly withdrawn: readonly string[];
  /** Present only when nothing was active: whether the invalidation was published again. */
  readonly republished?: boolean;
}

type Outcome =
  | { readonly kind: "done"; readonly result: Suspension }
  | { readonly kind: "error"; readonly text: string };

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Send the suspension; what it answered, never an unhandled rejection. */
async function suspend(endpoint: string, reason: string): Promise<Outcome> {
  try {
    const res = await apiFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) {
      return {
        kind: "done",
        result: {
          suspended: strings(body.suspended),
          withdrawn: strings(body.withdrawn),
          ...(typeof body.republished === "boolean"
            ? { republished: body.republished }
            : {}),
        },
      };
    }
    if (res.status === 503) return { kind: "error", text: t("unavailable") };
    const why = body.message ?? body.error ?? body.code;
    return {
      kind: "error",
      text: t("failed", { reason: typeof why === "string" && why ? why : t("refused") }),
    };
  } catch {
    return { kind: "error", text: t("unavailable") };
  }
}

function Result({ result }: { result: Suspension }) {
  return (
    <div role="status" className="mt-4 rounded-lg bg-green-950/40 px-3 py-2 text-sm">
      {result.suspended.length > 0 ? (
        <p className="text-green-300">
          {t("suspended", {
            count: result.suspended.length,
            agents: result.suspended,
          })}
        </p>
      ) : (
        <>
          <p className="text-green-300">{t("none_active")}</p>
          {result.republished === true && (
            <p className="text-gray-300">{t("republished")}</p>
          )}
          {result.republished === false && (
            <p className="text-amber-300">{t("unpublished")}</p>
          )}
        </>
      )}
      <p className="text-gray-300 mt-1">
        {t("withdrawn", { count: result.withdrawn.length })}
      </p>
      {result.withdrawn.length > 0 && (
        <ul className="font-mono text-xs text-gray-400 mt-1 space-y-0.5">
          {result.withdrawn.map((id) => (
            <li key={id}>{id}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface AgentKillSwitchProps {
  /** The suspension route: the admin one, or the operators' for a tenant. */
  readonly endpoint: string;
  /** The tenant's name, on the operators' console (absent: the current deployment). */
  readonly tenant?: string;
  /** Close the panel (the operators' console opens it per tenant). */
  readonly onClose?: () => void;
}

/** One tenant's kill switch: a reason, a confirmation, then the suspension and what it did. */
export function AgentKillSwitch({ endpoint, tenant, onClose }: AgentKillSwitchProps) {
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const reasonId = useId();
  const hintId = useId();
  const headingId = useId();
  const confirmId = useId();
  const confirmButton = useRef<HTMLButtonElement>(null);
  const trimmed = reason.trim();
  const named = tenant !== undefined ? { tenant } : undefined;

  // The confirmation takes the focus when it opens, so a keyboard user lands on the decision.
  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);

  const run = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(await suspend(endpoint, trimmed.slice(0, 500)));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <section className={card} aria-labelledby={headingId}>
      <div className="flex items-start justify-between gap-4">
        <h3 id={headingId} className="text-base font-semibold text-white">
          {named ? t("form_label_tenant", named) : t("title")}
        </h3>
        {onClose && (
          <button type="button" className={quiet} onClick={onClose} disabled={busy}>
            {t("close")}
          </button>
        )}
      </div>
      <p className="mt-1 mb-4 text-sm text-gray-400">
        {named ? t("intro_tenant", named) : t("intro")}
      </p>

      <form
        aria-label={named ? t("form_label_tenant", named) : t("form_label")}
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed && !busy) setConfirming(true);
        }}
      >
        <label htmlFor={reasonId} className="block text-sm text-gray-300 mb-1">
          {t("reason")}
        </label>
        <textarea
          id={reasonId}
          aria-describedby={hintId}
          required
          rows={3}
          maxLength={500}
          value={reason}
          disabled={busy || confirming}
          onChange={(e) => {
            setReason(e.target.value);
            setOutcome(null);
          }}
          className="w-full rounded-md border border-gray-700 bg-[#0a0f1e] px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-red-500 disabled:opacity-60"
        />
        <p id={hintId} className="mt-1 text-xs text-gray-400">
          {t("reason_hint")}
        </p>
        {!confirming && (
          <button type="submit" className={`${danger} mt-3`} disabled={busy || !trimmed}>
            {t("suspend")}
          </button>
        )}
      </form>

      {confirming && (
        <div
          role="group"
          aria-labelledby={confirmId}
          className="mt-4 rounded-lg border border-red-800 bg-red-950/40 p-4"
        >
          <p id={confirmId} className="text-sm font-semibold text-red-200">
            {named ? t("confirm_heading_tenant", named) : t("confirm_heading")}
          </p>
          <p className="mt-1 text-sm text-gray-300">{t("confirm_body")}</p>
          <p className="mt-1 text-sm text-gray-400 break-words">
            {t("confirm_reason", { reason: trimmed })}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              ref={confirmButton}
              type="button"
              className={danger}
              disabled={busy}
              onClick={() => void run()}
            >
              {busy ? t("busy") : t("confirm_yes")}
            </button>
            <button
              type="button"
              className={quiet}
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}

      {outcome?.kind === "done" && <Result result={outcome.result} />}
      {outcome?.kind === "error" && (
        <p
          role="alert"
          className="mt-4 rounded-lg bg-red-950/40 px-3 py-2 text-sm text-red-300"
        >
          {outcome.text}
        </p>
      )}
    </section>
  );
}

/** The admin console's section: the current tenant's kill switch (config_manage_safety). */
export function AdminKillSwitchView() {
  return <AgentKillSwitch endpoint="/api/admin/agents/suspend" />;
}
