"use client";

/**
 * components/admin/views/PasswordPolicyView.tsx — the Password policy screen (TASK-220;
 * SF-admin-053, 056)
 *
 * The policy was shown with ✓ and ✕ glyphs and no words, a rotation of 0 as "0", and changed only
 * through the command bar. Now each rule is said in words — "Yes" or "No", "Never" for no rotation
 * — and an administrator who holds admin_manage_config changes it here: a form with every rule,
 * then a confirm step that says each change "from → to" before anything is sent (the command
 * bar's update_password_policy, on the governed path).
 *
 * @module components/admin/views
 */

import React, { useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { DetailFacts } from "@/components/admin/ui/DetailPanel";
import { ConfirmStep } from "@/components/admin/ui/ConfirmStep";
import { GatedButton, needsPermission } from "@/components/admin/ui/PermissionGate";
import { Checkbox, Field, TextInput } from "@/components/admin/ui/Field";
import { runAdminAction } from "@/components/admin/ui/governed";
import { BUTTON, SURFACE, TEXT } from "@/components/admin/ui/tokens";
import { useChange, useOutcomes } from "./kit";
import type { SectionViewProps } from "@/components/admin/section-views";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.views.password_policy.${key}`, values);

/** The permission a change needs (the tool's own). */
export const POLICY_PERMISSION = "admin_manage_config";

export interface Policy {
  readonly minLength: number;
  readonly rotationDays: number;
  readonly passwordHistoryCount: number;
  readonly requireUppercase: boolean;
  readonly requireLowercase: boolean;
  readonly requireNumber: boolean;
  readonly requireSpecial: boolean;
}

/** Each rule: its field, the tool's input name, and whether it is a number or yes/no. */
const RULES = [
  { field: "minLength", input: "min_length", number: true },
  { field: "rotationDays", input: "rotation_days", number: true },
  { field: "passwordHistoryCount", input: "password_history_count", number: true },
  { field: "requireUppercase", input: "require_uppercase", number: false },
  { field: "requireLowercase", input: "require_lowercase", number: false },
  { field: "requireNumber", input: "require_number", number: false },
  { field: "requireSpecial", input: "require_special", number: false },
] as const;

type RuleField = (typeof RULES)[number]["field"];

/** A rule's value in words: Yes/No, "Never" for no rotation, else the number. */
export function ruleValue(field: RuleField, value: number | boolean): string {
  if (typeof value === "boolean") return value ? t("yes") : t("no");
  if (field === "rotationDays")
    return value === 0 ? t("never") : t("days", { count: value });
  if (field === "passwordHistoryCount")
    return value === 0 ? t("history_none") : t("passwords", { count: value });
  return t("characters", { count: value });
}

const ruleLabel = (field: RuleField) => t(`rule_${field}`);

function PolicyForm({
  policy,
  run,
  busy,
  onDone,
}: {
  readonly policy: Policy;
  readonly run: ReturnType<typeof useChange>["run"];
  readonly busy: boolean;
  readonly onDone: () => void;
}) {
  const [draft, setDraft] = useState<Record<RuleField, string | boolean>>(() => {
    const d = {} as Record<RuleField, string | boolean>;
    for (const r of RULES)
      d[r.field] = r.number ? String(policy[r.field]) : Boolean(policy[r.field]);
    return d;
  });
  const [problems, setProblems] = useState<Partial<Record<RuleField, string>>>({});
  const [asking, setAsking] = useState<Record<string, number | boolean> | null>(null);
  const review = () => {
    const bad: Partial<Record<RuleField, string>> = {};
    const changes: Record<string, number | boolean> = {};
    for (const r of RULES) {
      const raw = draft[r.field];
      const value = r.number ? Number(String(raw).trim()) : raw === true;
      if (
        r.number &&
        (String(raw).trim() === "" || !Number.isInteger(value) || (value as number) < 0)
      ) {
        bad[r.field] = t("whole_number");
        continue;
      }
      if (value !== policy[r.field]) changes[r.input] = value;
    }
    setProblems(bad);
    if (Object.keys(bad).length) return;
    if (Object.keys(changes).length === 0)
      return setProblems({ minLength: t("unchanged") });
    setAsking(changes);
  };
  if (asking)
    return (
      <ConfirmStep
        action="update_password_policy"
        title={t("confirm_title")}
        confirmLabel={t("save")}
        busy={busy}
        onCancel={() => setAsking(null)}
        onConfirm={() =>
          void run(
            () => runAdminAction("update_password_policy", asking),
            t("what")
          ).then((answer) => {
            setAsking(null);
            if (answer.standing !== "refused") onDone();
          })
        }
      >
        <ul className="list-disc space-y-1 pl-5" data-policy-changes="true">
          {RULES.filter((r) => r.input in asking).map((r) => (
            <li key={r.field}>
              {t("change", {
                rule: ruleLabel(r.field),
                from: ruleValue(r.field, policy[r.field]),
                to: ruleValue(r.field, asking[r.input]!),
              })}
            </li>
          ))}
        </ul>
      </ConfirmStep>
    );
  return (
    <form
      noValidate
      aria-label={t("edit_title")}
      className={`${SURFACE.inset} max-w-lg space-y-3 p-4`}
      onSubmit={(e) => {
        e.preventDefault();
        review();
      }}
    >
      {RULES.map((r) =>
        r.number ? (
          <Field
            key={r.field}
            label={ruleLabel(r.field)}
            help={t(`help_${r.field}`)}
            error={problems[r.field]}
          >
            {(control) => (
              <TextInput
                {...control}
                inputMode="numeric"
                value={String(draft[r.field])}
                disabled={busy}
                onChange={(e) => setDraft((d) => ({ ...d, [r.field]: e.target.value }))}
                className="max-w-[10rem]"
              />
            )}
          </Field>
        ) : (
          <Checkbox
            key={r.field}
            label={ruleLabel(r.field)}
            checked={draft[r.field] === true}
            disabled={busy}
            onChange={(e) => setDraft((d) => ({ ...d, [r.field]: e.target.checked }))}
            className={`text-sm ${TEXT.body}`}
          />
        )
      )}
      <div className="flex flex-wrap gap-2">
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

export function PasswordPolicyDataView({
  data,
  hasPermission = () => false,
  onReload,
}: SectionViewProps) {
  const policy = (data?.policy ?? null) as Policy | null;
  const { add, list } = useOutcomes(t("results_label"));
  const { busy, run } = useChange(add, onReload);
  const [editing, setEditing] = useState(false);
  if (!policy)
    return (
      <div className="space-y-4">
        {list}
        <p className={`text-sm ${TEXT.quiet}`}>{t("none")}</p>
      </div>
    );
  return (
    <div className="space-y-4">
      {list}
      <div className={`${SURFACE.panel} max-w-lg p-5`} data-policy="true">
        <DetailFacts
          facts={RULES.map((r) => [
            ruleLabel(r.field),
            ruleValue(r.field, policy[r.field]),
          ])}
        />
      </div>
      {editing ? (
        <PolicyForm
          policy={policy}
          run={run}
          busy={busy}
          onDone={() => setEditing(false)}
        />
      ) : (
        <GatedButton
          allowed={hasPermission(POLICY_PERMISSION)}
          reason={needsPermission(POLICY_PERMISSION)}
          className={BUTTON.primary}
          onClick={() => setEditing(true)}
        >
          {t("edit")}
        </GatedButton>
      )}
    </div>
  );
}
