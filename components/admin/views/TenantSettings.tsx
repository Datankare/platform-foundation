"use client";

/**
 * components/admin/views/TenantSettings.tsx — a tenant's own settings, edited by type and
 * confirmed (TASK-221; SF-admin-110, E-91)
 *
 * Both tenancy screens list a tenant's settings: its administrators (Tenant, the keys a tenant may
 * set) and the operators (Tenants, one tenant's every key). Each setting was edited as free text
 * whatever its type — on/off, numbers and lists typed by hand, JSON guessed — and Save and Use
 * default were offered on every key, whatever its tier. Here, one list for both:
 *
 *   - each setting opens its panel at the row (beside the list when wide, in its place on a
 *     phone), its heading focused and focus given back on Close;
 *   - its value is edited with Platform config's own control for its type (on/off, a number within
 *     its range, one of a list by name, a list checked before it is sent), and the change is
 *     confirmed — its value now → after, and why (the record's comment);
 *   - Edit and Use the default are offered only to an admin holding the setting's tier permission
 *     (the route's own rule: config_manage_standard, or config_manage_safety for a safety
 *     setting); anyone else sees them disabled and why, by the permission's name;
 *   - what became of a change is said as the governed path answers it: done, held for approval
 *     (nothing changed yet), or not done and why.
 *
 * Display only: the route checks the tier permission and governs the change itself.
 *
 * @module components/admin/views
 */

import React, { useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { isShownText, renderShown, type ShownText } from "@/platform/errors/shown-text";
import { inputFor, readInput, sameValue, type SettingRules } from "../config-value";
import {
  editPermission,
  rangeText,
  TYPE_KEYS,
  ValueInput,
  valueText,
} from "../PlatformConfigPanel";
import { ChangeDiff } from "../HeldActionsPanel";
import { ExpandableText } from "../ExpandableText";
import { AdminTable, type Column } from "@/components/admin/ui/AdminTable";
import {
  DetailFacts,
  DetailLayout,
  DetailPanel,
} from "@/components/admin/ui/DetailPanel";
import { ConfirmStep } from "@/components/admin/ui/ConfirmStep";
import { Field, FormProblem, TextInput } from "@/components/admin/ui/Field";
import { GatedButton, needsPermission } from "@/components/admin/ui/PermissionGate";
import { IdDetail } from "@/components/admin/ui/Ref";
import { settingLabel } from "@/components/admin/ui/labels";
import { runRouteChange } from "@/components/admin/ui/governed";
import type { OutcomeEntry } from "@/components/admin/ui/Outcome";
import { BUTTON, TEXT } from "@/components/admin/ui/tokens";
import { elementWith, useChange } from "./kit";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.tenant_settings.${key}`, values);

/** A tenant's setting, as GET /api/admin/tenant and GET …/tenants/[id]/config list it. */
export interface TenantSettingEntry extends SettingRules {
  readonly key: string;
  readonly description: ShownText | null;
  readonly value: unknown;
  readonly platformValue: unknown;
  readonly overridden: boolean;
  readonly permissionTier: "standard" | "safety";
  /** The operators' list only: whether the tenant's own administrators may set it. */
  readonly tenantOverridable?: boolean;
}

const describe = (e: TenantSettingEntry) =>
  isShownText(e.description) ? renderShown(e.description) : "";

/** A setting's value change, typed and checked, then confirmed with its comment. */
function EditValue({
  entry,
  url,
  tenant,
  run,
  busy,
  onDone,
}: {
  readonly entry: TenantSettingEntry;
  readonly url: string;
  readonly tenant: string;
  readonly run: ReturnType<typeof useChange>["run"];
  readonly busy: boolean;
  readonly onDone: () => void;
}) {
  const [raw, setRaw] = useState<string | boolean>(() => inputFor(entry, entry.value));
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ value: unknown } | null>(null);
  const name = settingLabel(entry.key);
  if (asking)
    return (
      <ConfirmStep
        action="tenant_settings.update"
        title={t("confirm_title", { setting: name, tenant })}
        confirmLabel={t("save")}
        busy={busy}
        onCancel={() => setAsking(null)}
        onConfirm={(given) =>
          void run(
            () =>
              runRouteChange(url, "PUT", {
                key: entry.key,
                value: asking.value,
                changeComment: given.reason,
              }),
            t("what_set", { setting: name, value: valueText(entry, asking.value) }),
            { who: tenant }
          ).then((answer) => {
            setAsking(null);
            if (answer.standing !== "refused") onDone();
          })
        }
      >
        <ChangeDiff
          change={{
            key: entry.key,
            action: "set",
            before: entry.value,
            after: asking.value,
            scope: "tenant",
          }}
        />
      </ConfirmStep>
    );
  const read = readInput(entry, raw);
  return (
    <form
      noValidate
      aria-label={t("edit_title", { setting: name })}
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!read.ok) return setProblem(read.problem);
        if (sameValue(read.value, entry.value)) return setProblem(t("unchanged"));
        setProblem(null);
        setAsking({ value: read.value });
      }}
    >
      <ValueInput
        entry={entry}
        raw={raw}
        problem={problem}
        onChange={(v) => {
          setRaw(v);
          setProblem(null);
        }}
      />
      {entry.valueType === "boolean" ? <FormProblem problem={problem} /> : null}
      <div className="flex flex-wrap gap-3">
        <button type="submit" className={BUTTON.primary} disabled={busy}>
          {t("review")}
        </button>
        <button type="button" className={BUTTON.quiet} disabled={busy} onClick={onDone}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

/** One setting's panel: what it is, its value and default, and the changes this admin may make. */
function SettingDetail({
  entry,
  url,
  tenant,
  mayReset,
  hasPermission,
  showIds,
  run,
  busy,
  onClose,
}: {
  readonly entry: TenantSettingEntry;
  readonly url: string;
  readonly tenant: string;
  readonly mayReset: boolean;
  readonly hasPermission: (code: string) => boolean;
  readonly showIds: boolean;
  readonly run: ReturnType<typeof useChange>["run"];
  readonly busy: boolean;
  readonly onClose: () => void;
}) {
  const [step, setStep] = useState<"view" | "edit" | "reset">("view");
  const permission = editPermission(entry.permissionTier);
  const allowed = hasPermission(permission);
  const name = settingLabel(entry.key);
  const facts: [string, React.ReactNode][] = [
    ...(showIds
      ? ([[t("field_key"), <IdDetail key="k" id={entry.key} show />]] as [
          string,
          React.ReactNode,
        ][])
      : []),
    [t("field_description"), describe(entry) || t("no_description")],
    [
      t("field_tier"),
      entry.permissionTier === "safety" ? t("tier_safety") : t("tier_standard"),
    ],
    ...(entry.tenantOverridable === undefined
      ? []
      : ([
          [
            t("field_who"),
            entry.tenantOverridable ? t("who_tenant") : t("who_operators"),
          ],
        ] as [string, React.ReactNode][])),
    [
      t("field_type"),
      renderMessage(`screens.admin_console.config.${TYPE_KEYS[entry.valueType]}`),
    ],
    [
      t("field_value"),
      <span key="v">
        <ExpandableText text={valueText(entry, entry.value)} column={t("field_value")} />
        {entry.overridden ? (
          <span className={`mt-1 block text-xs ${TEXT.faint}`}>{t("own_value")}</span>
        ) : (
          <span className={`mt-1 block text-xs ${TEXT.faint}`}>
            {t("follows_default")}
          </span>
        )}
      </span>,
    ],
    [
      t("field_default"),
      <ExpandableText
        key="d"
        text={valueText(entry, entry.platformValue)}
        column={t("field_default")}
      />,
    ],
    ...(entry.valueType === "number"
      ? ([[t("field_range"), rangeText(entry)]] as [string, React.ReactNode][])
      : []),
  ];
  return (
    <DetailPanel
      title={name}
      onClose={onClose}
      returnFocus={() => elementWith("data-tenant-setting-open", entry.key)}
    >
      <div className="space-y-4">
        <DetailFacts facts={facts} />
        {step === "edit" ? (
          <EditValue
            entry={entry}
            url={url}
            tenant={tenant}
            run={run}
            busy={busy}
            onDone={() => setStep("view")}
          />
        ) : step === "reset" ? (
          <ConfirmStep
            action="tenant_settings.reset"
            title={t("reset_title", { setting: name, tenant })}
            confirmLabel={t("use_default")}
            busy={busy}
            onCancel={() => setStep("view")}
            onConfirm={() =>
              void run(
                () =>
                  runRouteChange(
                    `${url}?key=${encodeURIComponent(entry.key)}`,
                    "DELETE",
                    undefined
                  ),
                t("what_reset", { setting: name }),
                { who: tenant }
              ).then(() => setStep("view"))
            }
          >
            <ChangeDiff
              change={{
                key: entry.key,
                action: "reset",
                before: entry.value,
                after: entry.platformValue,
                scope: "tenant",
              }}
            />
          </ConfirmStep>
        ) : (
          <div className="flex flex-wrap gap-2">
            <GatedButton
              allowed={allowed}
              reason={needsPermission(permission)}
              data-tenant-setting-edit={entry.key}
              className={BUTTON.primary}
              disabled={busy}
              onClick={() => setStep("edit")}
            >
              {t("edit")}
            </GatedButton>
            {mayReset && entry.overridden ? (
              <GatedButton
                allowed={allowed}
                reason={needsPermission(permission)}
                className={BUTTON.quiet}
                disabled={busy}
                onClick={() => setStep("reset")}
              >
                {t("use_default")}
              </GatedButton>
            ) : null}
          </div>
        )}
      </div>
    </DetailPanel>
  );
}

export function TenantSettingsList({
  entries,
  url,
  tenant,
  caption,
  mayReset,
  hasPermission,
  showIds,
  add,
  onChanged,
}: {
  readonly entries: readonly TenantSettingEntry[];
  /** Where a change goes: PUT {key, value, changeComment}; DELETE ?key=… for the default. */
  readonly url: string;
  /** The tenant's name, for the outcome and the confirm step. */
  readonly tenant: string;
  readonly caption: string;
  /** Whether "Use the default" is offered (a tenant of a single deployment has no default). */
  readonly mayReset: boolean;
  readonly hasPermission: (code: string) => boolean;
  readonly showIds: boolean;
  readonly add: (entry: OutcomeEntry) => void;
  /** After a change that may have changed something: read the settings again. */
  readonly onChanged?: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const change = useChange(add, onChanged);
  const busy = change.busy;
  // A held change is listed among the tenant's changes waiting for approval: read them again too
  // (the governed path's own reader re-reads only what was applied).
  const run: typeof change.run = (send, what, more) =>
    change.run(send, what, more).then((answer) => {
      if (answer.standing === "held") onChanged?.();
      return answer;
    });
  const needle = filter.trim().toLowerCase();
  const sorted = [...entries].sort((a, b) =>
    settingLabel(a.key).localeCompare(settingLabel(b.key))
  );
  const shown = needle
    ? sorted.filter(
        (e) =>
          e.key.toLowerCase().includes(needle) ||
          settingLabel(e.key).toLowerCase().includes(needle) ||
          describe(e).toLowerCase().includes(needle)
      )
    : sorted;
  const selected = entries.find((e) => e.key === selectedKey) ?? null;
  const columns: Column<TenantSettingEntry>[] = [
    {
      id: "setting",
      header: t("col_setting"),
      cell: (e) => (
        <span className="min-w-0 break-words">
          <button
            type="button"
            data-tenant-setting-open={e.key}
            aria-label={t("open_label", { setting: settingLabel(e.key) })}
            className={BUTTON.link}
            onClick={(ev) => {
              ev.stopPropagation();
              setSelectedKey(e.key);
            }}
          >
            {settingLabel(e.key)}
          </button>
          {describe(e) ? (
            <span className={`mt-1 block text-xs ${TEXT.faint}`}>
              <ExpandableText text={describe(e)} column={t("field_description")} />
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "value",
      header: t("col_value"),
      cell: (e) => (
        <span>
          <ExpandableText
            text={valueText(e, e.value)}
            column={t("col_value")}
            limit={60}
          />
          {e.overridden ? (
            <span className={`mt-1 block text-xs ${TEXT.faint}`}>{t("own_value")}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: "default",
      header: t("col_default"),
      secondary: true,
      value: (e) => valueText(e, e.platformValue),
    },
    { id: "key", header: t("field_key"), kind: "id", value: (e) => e.key },
  ];
  return (
    <div className="space-y-3">
      <Field
        label={t("filter_label")}
        help={t("count", { shown: shown.length, total: entries.length })}
        className="sm:max-w-md"
      >
        {(control) => (
          <TextInput
            {...control}
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
      </Field>
      <DetailLayout
        detail={
          selected ? (
            <SettingDetail
              key={selected.key}
              entry={selected}
              url={url}
              tenant={tenant}
              mayReset={mayReset}
              hasPermission={hasPermission}
              showIds={showIds}
              run={run}
              busy={busy}
              onClose={() => setSelectedKey(null)}
            />
          ) : null
        }
      >
        <AdminTable
          caption={caption}
          columns={columns}
          rows={shown}
          rowKey={(e) => e.key}
          showIds={showIds}
          compact={selected !== null}
          selectedKey={selectedKey}
          onRowClick={(e) => setSelectedKey(e.key)}
          empty={entries.length === 0 ? t("empty") : t("none_match", { filter })}
        />
      </DetailLayout>
    </div>
  );
}
