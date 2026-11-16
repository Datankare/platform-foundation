"use client";

/**
 * components/admin/views/CapabilitiesView.tsx — the Capabilities screen (TASK-220; SF-admin-057,
 * 060, 063)
 *
 * Capabilities were developer data: goal codes, API endpoint paths, step intents, a cost written
 * as a literal "$0.0040", raw capability codes and a literal dash — under a second heading. Now
 * one heading, and the one table: each goal by name, what it does, its steps by name in order,
 * its estimated cost in the console's currency format, and the capability it needs by name
 * ("Nothing beyond signing in" when none); the endpoint only with "Show details".
 *
 * Read-only by design: capabilities come from the registered workflows (ADR-030 D8, ADR-035).
 *
 * @module components/admin/views
 */

import React from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { AdminTable, type Column } from "@/components/admin/ui/AdminTable";
import {
  capabilityLabel,
  goalLabel,
  intentLabel,
  usdText,
} from "@/components/admin/ui/labels";
import { TEXT } from "@/components/admin/ui/tokens";
import type { SectionViewProps } from "@/components/admin/section-views";
import { sectionTitle } from "@/components/admin/ui/sections";
import { ListUnreadable } from "./kit";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.views.capabilities.${key}`, values);

export interface GoalRow {
  readonly goal: string;
  readonly description?: string;
  readonly endpoint?: string;
  readonly estimatedCostUSD?: number;
  readonly requiredCapability?: string | null;
  readonly steps?: readonly { readonly intent: string }[];
}

/** A goal's description: the catalogue's, else what its workflow declares. */
function goalDescription(g: GoalRow): string {
  const key = `screens.admin_console.labels.goal_descriptions.${g.goal}`;
  const text = renderMessage(key);
  return text === key ? (g.description ?? "") : text;
}

export function CapabilitiesDataView({
  data,
  onReload,
  showIds = false,
}: SectionViewProps) {
  const goals: GoalRow[] = Array.isArray(data?.goals) ? data.goals : [];
  const columns: Column<GoalRow>[] = [
    {
      id: "goal",
      header: t("col_goal"),
      sortBy: (g) => goalLabel(g.goal),
      cell: (g) => (
        <span className="min-w-0 break-words">
          <span className={`block font-medium ${TEXT.body}`}>{goalLabel(g.goal)}</span>
          {goalDescription(g) ? (
            <span className={`block text-xs ${TEXT.faint}`}>{goalDescription(g)}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: "steps",
      header: t("col_steps"),
      secondary: true,
      cell: (g) =>
        g.steps?.length ? (
          <ol className="list-decimal space-y-0.5 pl-4">
            {g.steps.map((s, i) => (
              <li key={i}>{intentLabel(s.intent)}</li>
            ))}
          </ol>
        ) : (
          t("no_steps")
        ),
    },
    {
      id: "cost",
      header: t("col_cost"),
      sortBy: (g) => g.estimatedCostUSD ?? 0,
      value: (g) => usdText(g.estimatedCostUSD ?? 0),
    },
    {
      id: "needs",
      header: t("col_needs"),
      value: (g) =>
        g.requiredCapability ? capabilityLabel(g.requiredCapability) : t("needs_nothing"),
    },
    { id: "endpoint", header: t("col_endpoint"), kind: "id", value: (g) => g.endpoint },
  ];
  // A body without its list is not an empty list (review 14 L-1): said as a failed read.
  if (!Array.isArray(data?.goals))
    return <ListUnreadable panel={sectionTitle("capabilities")} onRetry={onReload} />;
  return (
    <div className="space-y-4">
      <p className={`text-sm ${TEXT.faint}`}>{t("intro")}</p>
      <AdminTable
        caption={t("caption")}
        columns={columns}
        rows={goals}
        rowKey={(g) => g.goal}
        empty={t("empty")}
        showIds={showIds}
      />
    </div>
  );
}
