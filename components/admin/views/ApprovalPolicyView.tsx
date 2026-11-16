"use client";

/**
 * components/admin/views/ApprovalPolicyView.tsx — the Approval policy screen (TASK-220;
 * SF-admin-053, 057, 059, 063)
 *
 * The screen showed raw `maxRisk`, effect and approver codes (Approvals words the same values from
 * the catalogue), a second heading under the section's, and could not be changed except through
 * the command bar. Now:
 *
 *   - one heading; the version and the default approver in words; each rule in order — "Up to
 *     consequential risk", its effects by name ("Any effect" when it names none), who approves —
 *     in the one table;
 *   - for an administrator who holds admin_manage_approval_policy, the rules edited in place: add,
 *     remove and reorder rules (the first match wins), each a risk, its effects and who approves;
 *     a confirm step reads the new policy back in words before it is sent (set_approval_policy,
 *     on the governed path). What the rules cannot change is said: every action held today is
 *     restricted, so a person approves it whatever the rules say.
 *
 * @module components/admin/views
 */

import React, { useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { AdminTable, type Column } from "@/components/admin/ui/AdminTable";
import { ConfirmStep } from "@/components/admin/ui/ConfirmStep";
import { GatedButton, needsPermission } from "@/components/admin/ui/PermissionGate";
import { Checkbox, Field, Select } from "@/components/admin/ui/Field";
import {
  effectLabel,
  policyApproverLabel,
  riskLabel,
} from "@/components/admin/ui/labels";
import { runAdminAction } from "@/components/admin/ui/governed";
import { BUTTON, SURFACE, TEXT } from "@/components/admin/ui/tokens";
import { useChange, useOutcomes } from "./kit";
import type { SectionViewProps } from "@/components/admin/section-views";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.views.approval_policy.${key}`, values);

/** The permission a change needs (the tool's own). */
export const APPROVAL_POLICY_PERMISSION = "admin_manage_approval_policy";

/** What the tool accepts (its schema's enums), in order. */
const RISKS = ["ordinary", "consequential", "restricted"] as const;
const EFFECTS = ["stateWrite", "externalCall", "sendMessage", "restricted"] as const;
const APPROVERS = ["user", "agent", "system"] as const;

export interface PolicyRule {
  readonly maxRisk: string;
  readonly effects?: readonly string[];
  readonly requiredApprover: string;
}

/** A rule in words: "Up to consequential risk, writes state: a person approves". */
export function ruleText(rule: PolicyRule): string {
  return t("rule", {
    risk: riskLabel(rule.maxRisk),
    effects: rule.effects?.length
      ? rule.effects.map((e) => effectLabel(e))
      : t("any_effect"),
    approver: policyApproverLabel(rule.requiredApprover),
  });
}

type Draft = { maxRisk: string; effects: string[]; requiredApprover: string };

function RuleEditor({
  rule,
  index,
  count,
  busy,
  onChange,
  onMove,
  onRemove,
}: {
  readonly rule: Draft;
  readonly index: number;
  readonly count: number;
  readonly busy: boolean;
  readonly onChange: (next: Draft) => void;
  readonly onMove: (by: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const n = index + 1;
  return (
    <fieldset className={`${SURFACE.inset} min-w-0 space-y-3 p-3`} data-rule-editor={n}>
      <legend className={`px-1 text-xs font-semibold ${TEXT.quiet}`}>
        {t("rule_n", { n })}
      </legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("field_risk")}>
          {(control) => (
            <Select
              {...control}
              value={rule.maxRisk}
              disabled={busy}
              onChange={(e) => onChange({ ...rule, maxRisk: e.target.value })}
            >
              {RISKS.map((r) => (
                <option key={r} value={r}>
                  {riskLabel(r)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("field_approver")}>
          {(control) => (
            <Select
              {...control}
              value={rule.requiredApprover}
              disabled={busy}
              onChange={(e) => onChange({ ...rule, requiredApprover: e.target.value })}
            >
              {APPROVERS.map((a) => (
                <option key={a} value={a}>
                  {policyApproverLabel(a)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <fieldset className="space-y-1">
        <legend className={`text-xs ${TEXT.faint}`}>{t("field_effects")}</legend>
        {EFFECTS.map((e) => (
          <Checkbox
            key={e}
            label={effectLabel(e)}
            checked={rule.effects.includes(e)}
            disabled={busy}
            onChange={(ev) =>
              onChange({
                ...rule,
                effects: ev.target.checked
                  ? [...rule.effects, e]
                  : rule.effects.filter((x) => x !== e),
              })
            }
            className={`text-sm ${TEXT.body}`}
          />
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={BUTTON.quiet}
          disabled={busy || index === 0}
          aria-label={t("move_up_label", { n })}
          onClick={() => onMove(-1)}
        >
          {t("move_up")}
        </button>
        <button
          type="button"
          className={BUTTON.quiet}
          disabled={busy || index === count - 1}
          aria-label={t("move_down_label", { n })}
          onClick={() => onMove(1)}
        >
          {t("move_down")}
        </button>
        <button
          type="button"
          className={BUTTON.quiet}
          disabled={busy}
          aria-label={t("remove_label", { n })}
          onClick={onRemove}
        >
          {t("remove")}
        </button>
      </div>
    </fieldset>
  );
}

function PolicyEditor({
  rules,
  run,
  busy,
  onDone,
}: {
  readonly rules: readonly PolicyRule[];
  readonly run: ReturnType<typeof useChange>["run"];
  readonly busy: boolean;
  readonly onDone: () => void;
}) {
  const [draft, setDraft] = useState<Draft[]>(() =>
    rules.map((r) => ({
      maxRisk: r.maxRisk,
      effects: [...(r.effects ?? [])],
      requiredApprover: r.requiredApprover,
    }))
  );
  const [asking, setAsking] = useState(false);
  const move = (i: number, by: -1 | 1) =>
    setDraft((d) => {
      const next = [...d];
      const [r] = next.splice(i, 1);
      next.splice(i + by, 0, r!);
      return next;
    });
  if (asking)
    return (
      <ConfirmStep
        action="set_approval_policy"
        title={t("confirm_title")}
        confirmLabel={t("save")}
        busy={busy}
        onCancel={() => setAsking(false)}
        onConfirm={() =>
          void run(
            () =>
              runAdminAction("set_approval_policy", {
                rules: draft.map((r) => ({
                  max_risk: r.maxRisk,
                  ...(r.effects.length ? { effects: r.effects } : {}),
                  required_approver: r.requiredApprover,
                })),
              }),
            t("what")
          ).then((answer) => {
            setAsking(false);
            if (answer.standing !== "refused") onDone();
          })
        }
      >
        {draft.length === 0 ? <p>{t("no_rules")}</p> : null}
        <ol className="list-decimal space-y-1 pl-5" data-policy-rules="true">
          {draft.map((r, i) => (
            <li key={i}>{ruleText(r)}</li>
          ))}
        </ol>
        <p>{t("restricted_note")}</p>
      </ConfirmStep>
    );
  return (
    <form
      noValidate
      aria-label={t("edit_title")}
      className={`${SURFACE.panel} space-y-3 p-4`}
      onSubmit={(e) => {
        e.preventDefault();
        setAsking(true);
      }}
    >
      <h3 className={`text-sm font-semibold ${TEXT.strong}`}>{t("edit_title")}</h3>
      <p className={`text-xs ${TEXT.faint}`}>{t("order_note")}</p>
      {draft.map((r, i) => (
        <RuleEditor
          key={i}
          rule={r}
          index={i}
          count={draft.length}
          busy={busy}
          onChange={(next) => setDraft((d) => d.map((x, j) => (j === i ? next : x)))}
          onMove={(by) => move(i, by)}
          onRemove={() => setDraft((d) => d.filter((_, j) => j !== i))}
        />
      ))}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={BUTTON.quiet}
          disabled={busy}
          onClick={() =>
            setDraft((d) => [
              ...d,
              { maxRisk: "ordinary", effects: [], requiredApprover: "user" },
            ])
          }
        >
          {t("add_rule")}
        </button>
        <button type="submit" className={BUTTON.primary} disabled={busy}>
          {t("review")}
        </button>
        <button type="button" className={BUTTON.quiet} onClick={onDone}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

export function ApprovalPolicyDataView({
  data,
  hasPermission = () => false,
  onReload,
}: SectionViewProps) {
  const policy = data?.policy as
    { version?: unknown; default?: unknown; rules?: unknown } | null | undefined;
  const rules: PolicyRule[] = Array.isArray(policy?.rules)
    ? (policy.rules as PolicyRule[])
    : [];
  const { add, list } = useOutcomes(t("results_label"));
  const { busy, run } = useChange(add, onReload);
  const [editing, setEditing] = useState(false);
  const columns: Column<PolicyRule & { n: number }>[] = [
    { id: "n", header: t("col_order"), value: (r) => String(r.n) },
    {
      id: "risk",
      header: t("col_risk"),
      value: (r) => t("up_to", { risk: riskLabel(r.maxRisk) }),
    },
    {
      id: "effects",
      header: t("col_effects"),
      value: (r) =>
        r.effects?.length
          ? t("effects", { effects: r.effects.map((e) => effectLabel(e)) })
          : t("any_effect"),
    },
    {
      id: "approver",
      header: t("col_approver"),
      value: (r) => policyApproverLabel(r.requiredApprover),
    },
  ];
  return (
    <div className="space-y-4">
      {list}
      {policy ? (
        <p className={`text-sm ${TEXT.quiet}`} data-policy-version="true">
          {t("version", {
            version: String(policy.version ?? ""),
            approver: policyApproverLabel(String(policy.default ?? "")),
          })}
        </p>
      ) : (
        <p className={`text-sm ${TEXT.quiet}`}>{t("none")}</p>
      )}
      <p className={`text-sm ${TEXT.faint}`}>{t("restricted_note")}</p>
      <AdminTable
        caption={t("caption")}
        columns={columns}
        rows={rules.map((r, i) => ({ ...r, n: i + 1 }))}
        rowKey={(r) => String(r.n)}
        empty={t("no_rules")}
      />
      {editing ? (
        <PolicyEditor
          rules={rules}
          run={run}
          busy={busy}
          onDone={() => setEditing(false)}
        />
      ) : (
        <GatedButton
          allowed={hasPermission(APPROVAL_POLICY_PERMISSION)}
          reason={needsPermission(APPROVAL_POLICY_PERMISSION)}
          className={BUTTON.primary}
          onClick={() => setEditing(true)}
        >
          {t("edit")}
        </GatedButton>
      )}
    </div>
  );
}
