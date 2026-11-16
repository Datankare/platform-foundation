"use client";

/**
 * components/admin/PlatformConfigPanel.tsx — the Platform config screen: every setting, and its
 * panel on the governed path (TASK-202, N-60, N-64, N-65; TASK-220)
 *
 * It lists every setting (GET /api/admin/config?enhanced=true, read by the console), filtered on
 * this screen only; a setting opens its panel — what it does, its tier, its type, its value and
 * the platform default — and, for an admin who holds the tier's permission (config_manage_standard
 * for a standard setting, config_manage_safety for a safety one: the route's own rule), an edit
 * form read by the setting's type (on/off, a number within its range, one of a list by name, a
 * list checked before it is sent). The change goes through the governed path — POST
 * /api/admin/config-ai/execute, update_config — which validates, records, and holds a
 * dual-controlled or two-person change.
 *
 * On the console's shared parts (TASK-220):
 *
 *   - the settings by category, each category's in the one table, sorted by name, each named in
 *     words (its key only with "Show details") (SF-admin-072);
 *   - a setting's panel opens beside the list (in its place on a phone), its heading focused, and
 *     Close gives focus back to the row (SF-admin-070: it opened at the top, off-screen);
 *   - a change is confirmed: its value now → after, and why (the record's comment, required)
 *     (SF-admin-071);
 *   - an admin without the permission sees the edit disabled and why, by the permission's name
 *     (SF-admin-073);
 *   - a value that cannot be sent is said at its field (aria-invalid, aria-describedby), in the
 *     catalogue's words — never the browser's parser message (SF-admin-074);
 *   - a list setting's allowed values by name (SF-admin-075).
 *
 * The permission shown is display only: the route checks the key's tier permission itself.
 *
 * @module components/admin
 */

import React, { useMemo, useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import {
  inputFor,
  readInput,
  sameValue,
  shownValue,
  type SettingRules,
  type SettingType,
} from "./config-value";
import { formatDateTime } from "./admin-format";
import { ExpandableText } from "./ExpandableText";
import { ChangeDiff } from "./HeldActionsPanel";
import { isShownText, renderShown, type ShownText } from "@/platform/errors/shown-text";
import { AdminTable, type Column } from "@/components/admin/ui/AdminTable";
import {
  DetailFacts,
  DetailLayout,
  DetailPanel,
} from "@/components/admin/ui/DetailPanel";
import { ConfirmStep } from "@/components/admin/ui/ConfirmStep";
import {
  Checkbox,
  Field,
  FormProblem,
  Select,
  TextArea,
  TextInput,
} from "@/components/admin/ui/Field";
import { GatedButton, needsPermission } from "@/components/admin/ui/PermissionGate";
import { IdDetail } from "@/components/admin/ui/Ref";
import {
  settingCategoryLabel,
  settingLabel,
  settingValueLabel,
} from "@/components/admin/ui/labels";
import { runConfigAction } from "@/components/admin/ui/governed";
import { BUTTON, TEXT } from "@/components/admin/ui/tokens";
import {
  useChange,
  useOutcomes,
  ListUnreadable,
  elementWith,
} from "@/components/admin/views/kit";
import type { SectionViewProps } from "@/components/admin/section-views";
import { sectionTitle } from "@/components/admin/ui/sections";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.config.${key}`, values);

/** A setting's description in words: the catalog's, as the answer names it (TASK-209). */
export function describe(entry: { readonly description: unknown }): string {
  return isShownText(entry.description) ? renderShown(entry.description) : "";
}

/** A setting as GET /api/admin/config?enhanced=true lists it (EnhancedConfigEntry). */
export interface SettingEntry extends SettingRules {
  readonly key: string;
  readonly value: unknown;
  /** The setting's description: the catalog's key, which this screen renders (TASK-209). */
  readonly description: ShownText | null;
  readonly category: string;
  readonly updatedAt: string;
  readonly defaultValue: unknown;
  readonly permissionTier: "standard" | "safety";
  readonly overridden?: boolean;
  readonly platformValue?: unknown;
}

/** The permission a setting's change needs (the execute route's rule: its tier's). */
export function editPermission(tier: SettingEntry["permissionTier"]): string {
  return tier === "standard" ? "config_manage_standard" : "config_manage_safety";
}

/**
 * A setting's value in words: on/off, an allowed value by name, a list of words as a list ("a,
 * b, c" — no brackets or quotation marks; "None" when empty), else as text. A list of lists stays
 * as written: its own screen (Capability map, Trusted agents) shows it in words.
 */
export function valueText(entry: SettingEntry, value: unknown): string {
  if (entry.valueType === "string_enum" && typeof value === "string")
    return settingValueLabel(entry.key, value);
  if (Array.isArray(value) && value.every((v) => typeof v === "string"))
    return value.length ? value.join(", ") : t("list_empty");
  return shownValue(value);
}

/** A setting's range, in words. */
function rangeText(e: SettingRules): string {
  if (e.minValue !== null && e.maxValue !== null)
    return t("range", { min: e.minValue, max: e.maxValue });
  if (e.minValue !== null) return t("range_min", { min: e.minValue });
  if (e.maxValue !== null) return t("range_max", { max: e.maxValue });
  return t("range_none");
}

const TYPE_KEYS: Record<SettingType, string> = {
  number: "type_number",
  boolean: "type_boolean",
  string: "type_string",
  string_enum: "type_string_enum",
  json_array: "type_json_array",
};

/** The control for a setting's type, inside its Field (label, help and error wired). */
function ValueInput({
  entry,
  raw,
  problem,
  onChange,
}: {
  readonly entry: SettingEntry;
  readonly raw: string | boolean;
  readonly problem: string | null;
  readonly onChange: (v: string | boolean) => void;
}) {
  if (entry.valueType === "boolean")
    return (
      <Checkbox
        label={t("boolean_label", { setting: settingLabel(entry.key) })}
        checked={raw === true}
        onChange={(e) => onChange(e.target.checked)}
        className={`text-sm ${TEXT.body}`}
      />
    );
  const help =
    entry.valueType === "number"
      ? rangeText(entry)
      : entry.valueType === "json_array"
        ? t("json_help")
        : undefined;
  return (
    <Field label={t("new_value")} help={help} error={problem}>
      {(control) =>
        entry.valueType === "string_enum" ? (
          <Select
            {...control}
            value={String(raw)}
            onChange={(e) => onChange(e.target.value)}
          >
            {(entry.allowedValues ?? []).map((v) => (
              <option key={v} value={v}>
                {settingValueLabel(entry.key, v)}
              </option>
            ))}
          </Select>
        ) : entry.valueType === "json_array" ? (
          <TextArea
            {...control}
            value={String(raw)}
            onChange={(e) => onChange(e.target.value)}
            rows={Math.min(14, Math.max(4, String(raw).split("\n").length + 1))}
            spellCheck={false}
          />
        ) : (
          <TextInput
            {...control}
            inputMode={entry.valueType === "number" ? "decimal" : undefined}
            value={String(raw)}
            onChange={(e) => onChange(e.target.value)}
            className={entry.valueType === "number" ? "max-w-xs" : ""}
          />
        )
      }
    </Field>
  );
}

/** A setting's edit form, then its confirm step (now → after, and why). */
function EditSetting({
  entry,
  run,
  busy,
  onDone,
}: {
  readonly entry: SettingEntry;
  readonly run: ReturnType<typeof useChange>["run"];
  readonly busy: boolean;
  readonly onDone: () => void;
}) {
  const [raw, setRaw] = useState<string | boolean>(() => inputFor(entry, entry.value));
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState<unknown>(undefined);
  const read = readInput(entry, raw);
  if (asking !== undefined)
    return (
      <ConfirmStep
        action="config.update"
        title={t("confirm_title", { setting: settingLabel(entry.key) })}
        confirmLabel={t("submit")}
        busy={busy}
        onCancel={() => setAsking(undefined)}
        onConfirm={(given) =>
          void run(
            () =>
              runConfigAction("update_config", {
                key: entry.key,
                value: asking,
                changeComment: given.reason,
                confirmed: true,
              }),
            t("what", {
              setting: settingLabel(entry.key),
              value: valueText(entry, asking),
            })
          ).then((answer) => {
            setAsking(undefined);
            if (answer.standing !== "refused") onDone();
          })
        }
      >
        <ChangeDiff
          change={{ key: entry.key, action: "set", before: entry.value, after: asking }}
        />
      </ConfirmStep>
    );
  return (
    <form
      // The panel's own checks say why, in the catalogue's words (not the browser's bubble).
      noValidate
      aria-label={t("edit_title", { setting: settingLabel(entry.key) })}
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!read.ok) return setProblem(read.problem);
        if (sameValue(read.value, entry.value)) return setProblem(t("unchanged"));
        setProblem(null);
        setAsking(read.value);
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

/** One setting: what it is, and — for an admin who may — its edit form. */
export function SettingPanel({
  entry,
  hasPermission,
  showIds = false,
  run,
  busy,
  onClose,
  opener,
}: {
  readonly entry: SettingEntry;
  readonly hasPermission: (code: string) => boolean;
  readonly showIds?: boolean;
  readonly run: ReturnType<typeof useChange>["run"];
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly opener?: () => HTMLElement | null;
}) {
  const permission = editPermission(entry.permissionTier);
  const [editing, setEditing] = useState(false);
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
      entry.permissionTier === "standard"
        ? t("tier_help_standard")
        : t("tier_help_safety"),
    ],
    [t("field_type"), t(TYPE_KEYS[entry.valueType] ?? "type_string")],
    [
      t("field_current"),
      <ExpandableText
        key="c"
        text={valueText(entry, entry.value)}
        column={t("field_current")}
      />,
    ],
    [
      t("field_default"),
      <ExpandableText
        key="d"
        text={valueText(entry, entry.defaultValue)}
        column={t("field_default")}
      />,
    ],
    ...(entry.valueType === "number"
      ? ([[t("field_range"), rangeText(entry)]] as [string, React.ReactNode][])
      : []),
    ...(entry.valueType === "string_enum" && entry.allowedValues
      ? ([
          [
            t("field_allowed"),
            entry.allowedValues.map((v) => settingValueLabel(entry.key, v)).join(", "),
          ],
        ] as [string, React.ReactNode][])
      : []),
    [t("field_updated"), formatDateTime(entry.updatedAt)],
  ];
  return (
    <DetailPanel title={settingLabel(entry.key)} onClose={onClose} returnFocus={opener}>
      <div className="space-y-4">
        <DetailFacts facts={facts} />
        {editing ? (
          <EditSetting
            entry={entry}
            run={run}
            busy={busy}
            onDone={() => setEditing(false)}
          />
        ) : (
          <GatedButton
            allowed={hasPermission(permission)}
            reason={needsPermission(permission)}
            data-cannot-edit={hasPermission(permission) ? undefined : "true"}
            className={BUTTON.primary}
            onClick={() => setEditing(true)}
          >
            {t("edit")}
          </GatedButton>
        )}
      </div>
    </DetailPanel>
  );
}

/** The settings by category (each category's name, sorted), each category's by name. */
export function byCategory(entries: readonly SettingEntry[]) {
  const groups = new Map<string, SettingEntry[]>();
  for (const e of entries) {
    const list = groups.get(e.category) ?? [];
    list.push(e);
    groups.set(e.category, list);
  }
  return [...groups]
    .map(([category, list]) => ({
      category,
      label: settingCategoryLabel(category),
      entries: [...list].sort((a, b) =>
        settingLabel(a.key).localeCompare(settingLabel(b.key))
      ),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function PlatformConfigPanel({
  data,
  hasPermission = () => false,
  onReload,
  showIds = false,
}: SectionViewProps) {
  const [filter, setFilter] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const { add, list } = useOutcomes(t("results_label"));
  const { busy, run } = useChange(add, onReload);
  const entries: SettingEntry[] = useMemo(
    () => (Array.isArray(data?.entries) ? (data.entries as SettingEntry[]) : []),
    [data]
  );
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? entries.filter(
        (e) =>
          e.key.toLowerCase().includes(needle) ||
          settingLabel(e.key).toLowerCase().includes(needle) ||
          describe(e).toLowerCase().includes(needle)
      )
    : entries;
  const selected = entries.find((e) => e.key === selectedKey) ?? null;
  const columns: Column<SettingEntry>[] = [
    {
      id: "setting",
      header: t("col_key"),
      cell: (e) => (
        <span className="min-w-0 break-words">
          <button
            type="button"
            data-setting-open={e.key}
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
            <span className="mt-1 block text-xs text-amber-300">{t("overridden")}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: "tier",
      header: t("col_tier"),
      secondary: true,
      value: (e) =>
        e.permissionTier === "standard" ? t("tier_standard") : t("tier_safety"),
    },
    { id: "key", header: t("field_key"), kind: "id", value: (e) => e.key },
  ];
  // A body without its list is not an empty list (review 14 L-1): said as a failed read.
  if (!Array.isArray(data?.entries))
    return <ListUnreadable panel={sectionTitle("platform-config")} onRetry={onReload} />;
  return (
    <div className="space-y-4">
      <p className={`text-sm ${TEXT.faint}`}>{t("intro")}</p>
      {list}
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
            <SettingPanel
              key={selected.key}
              entry={selected}
              hasPermission={hasPermission}
              showIds={showIds}
              run={run}
              busy={busy}
              onClose={() => setSelectedKey(null)}
              opener={() => elementWith("data-setting-open", selected.key)}
            />
          ) : null
        }
      >
        {entries.length === 0 ? (
          <p className={`text-sm ${TEXT.faint}`}>{t("empty")}</p>
        ) : shown.length === 0 ? (
          <p className={`text-sm ${TEXT.faint}`}>{t("none_match", { filter })}</p>
        ) : (
          <div className="space-y-6">
            {byCategory(shown).map((g) => (
              <section key={g.category} aria-label={g.label} className="space-y-2">
                <h3 className={`text-sm font-semibold ${TEXT.quiet}`}>{g.label}</h3>
                <AdminTable
                  caption={t("caption", { category: g.label })}
                  columns={columns}
                  rows={g.entries}
                  rowKey={(e) => e.key}
                  showIds={showIds}
                  compact={selected !== null}
                  selectedKey={selectedKey}
                  onRowClick={(e) => setSelectedKey(e.key)}
                />
              </section>
            ))}
          </div>
        )}
      </DetailLayout>
    </div>
  );
}
