"use client";

/**
 * components/admin/AgentKillSwitchPanel.tsx — the agent kill switch in the consoles (TASK-172), on
 * the console's shared parts (TASK-221)
 *
 *   AgentKillSwitch          one tenant's kill switch, for the route it is given:
 *                              POST /api/admin/agents/suspend — the current tenant, any deployment
 *                              mode (config_manage_safety; review 12 L7)
 *                              POST /api/operator/tenants/[id]/agents/suspend — a tenant, for
 *                              operators (platform_operate; review 11 M-2)
 *   AdminKillSwitchView      the admin console's section (shown to config_manage_safety holders)
 *
 * Suspending every agent takes power away only, so one person may do it (no second approval). It
 * is confirmed in the one confirm step, which says what happens and asks why (required, recorded
 * with the suspension). What it did is an outcome kept until dismissed (SF-admin-127: editing the
 * reason wiped it): the agents suspended, the held changes to the trusted agents list that were
 * withdrawn — named as what they are, their references only with "Show details" (SF-admin-125: a
 * list of ids) — and, when nothing was active, whether every instance was told again. A refusal
 * is the catalogue's sentence for its code (SF-admin-126: a raw code could show); a store that is
 * down (503) is said as unavailable — nothing was suspended.
 *
 * Display decides nothing: the route checks the permission itself.
 *
 * @module components/admin
 */

import React, { useRef, useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { adminCall } from "@/components/admin/ui/admin-call";
import { ConfirmStep } from "@/components/admin/ui/ConfirmStep";
import { outcome, refusedOutcome } from "@/components/admin/ui/Outcome";
import { IdDetail } from "@/components/admin/ui/Ref";
import { BUTTON, SURFACE, TEXT } from "@/components/admin/ui/tokens";
import { useOutcomes } from "./views/kit";
import type { SectionViewProps } from "./section-views";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.kill_switch.${key}`, values);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** What a suspension did, under its outcome: the holds withdrawn, and a registry not republished. */
function SuspensionDetail({
  withdrawn,
  republished,
  showIds,
}: {
  readonly withdrawn: readonly string[];
  readonly republished?: boolean;
  readonly showIds: boolean;
}) {
  return (
    <div className="space-y-1" data-kill-switch-detail="true">
      <p>{t("withdrawn", { count: withdrawn.length })}</p>
      {withdrawn.length > 0 && showIds ? (
        <ul className="space-y-0.5">
          {withdrawn.map((id) => (
            <li key={id}>
              <IdDetail id={id} show />
            </li>
          ))}
        </ul>
      ) : null}
      {republished === true ? <p>{t("republished")}</p> : null}
    </div>
  );
}

export interface AgentKillSwitchProps {
  /** The suspension route: the admin one, or the operators' for a tenant. */
  readonly endpoint: string;
  /** The tenant's name, on the operators' console (absent: the current deployment). */
  readonly tenant?: string;
  /** "Show details": the withdrawn holds' references are shown. */
  readonly showIds?: boolean;
}

/** One tenant's kill switch: what it does, its confirm step, and what it did. */
export function AgentKillSwitch({
  endpoint,
  tenant,
  showIds = false,
}: AgentKillSwitchProps) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const { add, list } = useOutcomes(t("results_label"));
  const named = tenant !== undefined ? { tenant } : undefined;
  const what = named ? t("form_label_tenant", named) : t("form_label");

  const suspend = async (reason: string) => {
    setBusy(true);
    const answer = await adminCall(endpoint, { method: "POST", json: { reason } });
    setBusy(false);
    setAsking(false);
    if (!answer.ok) {
      add(
        answer.status === 503
          ? outcome("refused", t("unavailable"), { action: what })
          : refusedOutcome(answer.refusal, { action: what })
      );
      return;
    }
    const suspended = strings(answer.body.suspended);
    const withdrawn = strings(answer.body.withdrawn);
    const republished =
      typeof answer.body.republished === "boolean" ? answer.body.republished : undefined;
    add(
      outcome(
        // Nothing was active and the instances could not be told again: done, with a warning.
        republished === false ? "unrecorded" : "applied",
        suspended.length > 0
          ? t("suspended", { count: suspended.length, agents: suspended })
          : t("none_active"),
        {
          action: what,
          ...(named ? { who: tenant } : {}),
          ...(republished === false ? { next: t("unpublished") } : {}),
          detail: (
            <SuspensionDetail
              withdrawn={withdrawn}
              republished={republished}
              showIds={showIds}
            />
          ),
        }
      )
    );
  };

  return (
    <section
      className={`${SURFACE.panel} min-w-0 space-y-3 border-red-900/60 p-4`}
      aria-label={what}
      data-kill-switch="true"
    >
      <p className={`text-sm ${TEXT.quiet}`}>
        {named ? t("intro_tenant", named) : t("intro")}
      </p>
      {list}
      {asking ? (
        <ConfirmStep
          action="kill_switch.suspend"
          title={named ? t("confirm_heading_tenant", named) : t("confirm_heading")}
          confirmLabel={t("confirm_yes")}
          returnFocus={opener}
          busy={busy}
          onCancel={() => setAsking(false)}
          onConfirm={(given) => void suspend(given.reason)}
        >
          <p>{t("confirm_body")}</p>
        </ConfirmStep>
      ) : (
        <button
          ref={opener}
          type="button"
          className={BUTTON.danger}
          data-kill-switch-open="true"
          onClick={() => setAsking(true)}
        >
          {t("suspend")}
        </button>
      )}
    </section>
  );
}

/** The admin console's section: the current tenant's kill switch (config_manage_safety). */
export function AdminKillSwitchView({ showIds = false }: Partial<SectionViewProps>) {
  return <AgentKillSwitch endpoint="/api/admin/agents/suspend" showIds={showIds} />;
}
