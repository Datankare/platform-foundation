"use client";

/**
 * components/admin/PlatformConfigPanel.tsx — the Platform config screen: every setting, and an
 * edit panel on the governed path (TASK-202, N-60, N-64, N-65)
 *
 * The screen could only search: no screen changed a setting (the owner used the browser console).
 * Now it lists every setting (GET /api/admin/config?enhanced=true), filtered on this screen only;
 * a row opens its panel — the key, what it does, its tier, its type, its current value and the
 * platform default — and, for an admin who holds the tier's permission (config_manage_standard for
 * a standard setting, config_manage_safety for a safety one: the route's own rule), an edit form
 * read by the setting's type (on/off, a number within its range, one of a list, a JSON list
 * checked before it is sent) with a required comment. It submits through the governed path —
 * POST /api/admin/config-ai/execute, update_config, confirmed — which validates, records, and
 * holds a dual-controlled or two-person change; the screen says "Applied" or "Held for approval
 * by …", and the result stays until dismissed. An admin without the permission sees no edit
 * button, and why.
 *
 * The permission shown is display only: the route checks the key's tier permission itself.
 *
 * @module components/admin
 */

import React, { useMemo, useState } from "react";
import { apiFetch } from "@/platform/auth/api-fetch";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import {
  announceSessionEnd,
  networkRefusal,
  readRefusal,
} from "@/platform/errors/refusal";
import { isPending, readConfigAiResult } from "./DualControlKeysPanel";
import { ResultList, result, type ShownResult } from "./ResultList";
import { ExpandableText } from "./ExpandableText";
import {
  inputFor,
  readInput,
  sameValue,
  shownValue,
  type SettingRules,
  type SettingType,
} from "./config-value";
import { formatDateTime } from "./admin-format";
import { isShownText, renderShown, type ShownText } from "@/platform/errors/shown-text";

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
  /**
   * The setting's description: the catalog's key, which this screen renders (TASK-209, N-113 —
   * never the stored English, the definitional record).
   */
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

const th =
  "text-xs text-gray-400 uppercase tracking-wider py-2 px-3 border-b border-gray-800 text-left";
const td = "py-2 px-3 border-b border-gray-800/50 align-top text-gray-300";
const input =
  "w-full rounded border border-gray-700 bg-[#0a0f1e] px-3 py-2 text-sm text-gray-100";

export function PlatformConfigPanel({
  data,
  hasPermission,
}: {
  readonly data?: { entries?: SettingEntry[] } | undefined;
  readonly hasPermission: (code: string) => boolean;
}) {
  const [filter, setFilter] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Values read again after a change (applied, or a lost commit): they replace the page's.
  const [fresh, setFresh] = useState<Record<string, SettingEntry>>({});
  const [results, setResults] = useState<ShownResult[]>([]);

  const entries = useMemo(
    () =>
      (Array.isArray(data?.entries) ? data.entries : []).map((e) => fresh[e.key] ?? e),
    [data, fresh]
  );
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? entries.filter(
        (e) =>
          e.key.toLowerCase().includes(needle) ||
          describe(e).toLowerCase().includes(needle)
      )
    : entries;
  const selected = entries.find((e) => e.key === selectedKey) ?? null;

  /** The setting as the server has it now (after a change, or a lost commit). */
  async function reread(key: string) {
    try {
      const res = await apiFetch("/api/admin/config?enhanced=true");
      if (!res.ok) {
        // Through the shared handler: its message, and an erased session ends.
        const refused = await readRefusal(res);
        if (refused.kind === "signed-out-erased") announceSessionEnd(refused.code);
        setResults((rs) => [
          result("refused", t("reread_failed", { key, reason: refused.message })),
          ...rs,
        ]);
        return;
      }
      const body = (await res.json()) as { entries?: SettingEntry[] };
      const found = body.entries?.find((e) => e.key === key);
      if (found) setFresh((f) => ({ ...f, [key]: found }));
    } catch {
      setResults((rs) => [
        result("refused", t("reread_failed", { key, reason: networkRefusal().message })),
        ...rs,
      ]);
    }
  }

  if (data === undefined) return <p className="text-sm text-gray-400">{t("loading")}</p>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">{t("intro")}</p>
      <ResultList
        results={results}
        label={t("results_label")}
        onDismiss={(id) => setResults((rs) => rs.filter((r) => r.id !== id))}
      />
      {selected && (
        <SettingPanel
          key={selected.key}
          entry={selected}
          hasPermission={hasPermission}
          onClose={() => setSelectedKey(null)}
          onResult={(r, changed) => {
            setResults((rs) => [r, ...rs]);
            if (changed) void reread(selected.key);
          }}
        />
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="sr-only" htmlFor="config-filter">
          {t("filter_label")}
        </label>
        <input
          id="config-filter"
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("filter_placeholder")}
          className={`${input} sm:max-w-md`}
        />
        <span className="text-xs text-gray-400">
          {t("count", { shown: shown.length, total: entries.length })}
        </span>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-gray-400">{t("empty")}</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-gray-400">{t("none_match", { filter })}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-800 bg-[#111827]">
          <table className="w-full table-fixed border-collapse text-sm">
            <colgroup>
              <col className="w-1/2" />
              <col className="w-1/3" />
              <col className="w-1/6" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col" className={th}>
                  {t("col_key")}
                </th>
                <th scope="col" className={th}>
                  {t("col_value")}
                </th>
                <th scope="col" className={th}>
                  {t("col_tier")}
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <tr
                  key={e.key}
                  onClick={() => setSelectedKey(e.key)}
                  aria-current={e.key === selectedKey ? "true" : undefined}
                  className={`cursor-pointer hover:bg-gray-800/40 ${
                    e.key === selectedKey ? "bg-blue-900/20" : ""
                  }`}
                >
                  <td className={td}>
                    <button
                      type="button"
                      aria-label={t("open_label", { key: e.key })}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setSelectedKey(e.key);
                      }}
                      className="break-all text-left font-mono text-xs text-blue-300 hover:underline"
                    >
                      {e.key}
                    </button>
                    {describe(e) ? (
                      <span className="mt-1 block text-xs text-gray-400">
                        <ExpandableText
                          text={describe(e)}
                          column={t("field_description")}
                        />
                      </span>
                    ) : null}
                  </td>
                  <td className={td}>
                    <ExpandableText
                      text={shownValue(e.value)}
                      column={t("col_value")}
                      mono
                      limit={60}
                    />
                    {e.overridden ? (
                      <span className="mt-1 block text-xs text-amber-300">
                        {t("overridden")}
                      </span>
                    ) : null}
                  </td>
                  <td className={td}>
                    <span className="text-xs">
                      {e.permissionTier === "standard"
                        ? t("tier_standard")
                        : t("tier_safety")}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
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

/** One setting: what it is, and — for an admin who may — its edit form. */
export function SettingPanel({
  entry,
  hasPermission,
  onClose,
  onResult,
}: {
  readonly entry: SettingEntry;
  readonly hasPermission: (code: string) => boolean;
  readonly onClose: () => void;
  /** A result to show; `changed`: the value may have changed (read it again). */
  readonly onResult: (r: ShownResult, changed: boolean) => void;
}) {
  const permission = editPermission(entry.permissionTier);
  const mayEdit = hasPermission(permission);
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState<string | boolean>(() => inputFor(entry, entry.value));
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const read = readInput(entry, raw);
  const fields: [string, React.ReactNode][] = [
    [
      t("field_key"),
      <code key="k" className="break-all text-xs">
        {entry.key}
      </code>,
    ],
    [t("field_description"), describe(entry) || t("no_description")],
    [
      t("field_tier"),
      `${entry.permissionTier === "standard" ? t("tier_standard") : t("tier_safety")} — ${
        entry.permissionTier === "standard"
          ? t("tier_help_standard")
          : t("tier_help_safety")
      }`,
    ],
    [t("field_type"), t(TYPE_KEYS[entry.valueType] ?? "type_string")],
    [
      t("field_current"),
      <ExpandableText
        key="c"
        text={shownValue(entry.value)}
        column={t("field_current")}
        mono
      />,
    ],
    [
      t("field_default"),
      <ExpandableText
        key="d"
        text={shownValue(entry.defaultValue)}
        column={t("field_default")}
        mono
      />,
    ],
    ...(entry.valueType === "number"
      ? ([[t("field_range"), rangeText(entry)]] as [string, React.ReactNode][])
      : []),
    ...(entry.valueType === "string_enum" && entry.allowedValues
      ? ([[t("field_allowed"), entry.allowedValues.join(", ")]] as [
          string,
          React.ReactNode,
        ][])
      : []),
    [t("field_updated"), formatDateTime(entry.updatedAt)],
  ];

  async function submit() {
    setProblem(null);
    if (!read.ok) {
      setProblem(read.problem);
      return;
    }
    if (sameValue(read.value, entry.value)) {
      setProblem(t("unchanged"));
      return;
    }
    if (comment.trim() === "") {
      setProblem(t("comment_missing"));
      return;
    }
    setBusy(true);
    const shownNew = shownValue(read.value);
    try {
      const res = await apiFetch("/api/admin/config-ai/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toolId: "update_config",
          input: {
            key: entry.key,
            value: read.value,
            changeComment: comment.trim(),
            confirmed: true,
          },
        }),
      });
      const answer = await readConfigAiResult(res);
      if (isPending(answer)) {
        onResult(
          result(
            "held",
            t("held", {
              key: entry.key,
              value: shownNew,
              approver:
                entry.permissionTier === "standard"
                  ? t("approver_standard")
                  : t("approver_safety"),
            })
          ),
          false
        );
        setEditing(false);
      } else if (answer.success === false || answer.error) {
        const reason = answer.error ?? "";
        const lost = answer.code === "admin.write_indeterminate";
        onResult(
          result(
            "refused",
            lost
              ? t("indeterminate", { key: entry.key, reason })
              : t("refused", { key: entry.key, reason })
          ),
          lost
        );
      } else {
        onResult(
          result("applied", t("applied", { key: entry.key, value: shownNew })),
          true
        );
        setEditing(false);
      }
    } catch {
      onResult(
        result(
          "refused",
          t("refused", { key: entry.key, reason: networkRefusal().message })
        ),
        false
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="setting-title"
      className="rounded-xl border border-blue-900 bg-[#0f172a] p-4"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <h3
          id="setting-title"
          className="min-w-0 break-all text-base font-semibold text-white"
        >
          {t("panel_title")}: <span className="font-mono text-sm">{entry.key}</span>
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-xs text-gray-300 underline"
        >
          {t("close")}
        </button>
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
        {fields.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className="text-gray-400">{label}</dt>
            <dd className="min-w-0 break-words text-gray-200">{value}</dd>
          </React.Fragment>
        ))}
      </dl>

      {!mayEdit ? (
        <p className="mt-4 text-sm text-amber-200" data-cannot-edit="true">
          {t("cannot_edit", { permission })}
        </p>
      ) : !editing ? (
        <button
          type="button"
          onClick={() => {
            setEditing(true);
            setRaw(inputFor(entry, entry.value));
            setProblem(null);
          }}
          className="mt-4 rounded bg-blue-700 px-4 py-2 text-sm text-white"
        >
          {t("edit")}
        </button>
      ) : (
        <form
          // The panel's own checks say why, in the catalog's words (not the browser's bubble).
          noValidate
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <ValueInput entry={entry} raw={raw} onChange={setRaw} />
          {!read.ok && entry.valueType === "json_array" ? (
            <p className="text-xs text-amber-300" role="alert">
              {read.problem}
            </p>
          ) : null}
          <div>
            <label htmlFor="config-comment" className="mb-1 block text-sm text-gray-300">
              {t("comment")}
            </label>
            <textarea
              id="config-comment"
              required
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              className={input}
              aria-describedby="config-comment-help"
            />
            <p id="config-comment-help" className="mt-1 text-xs text-gray-400">
              {t("comment_help")}
            </p>
          </div>
          {problem ? (
            <p className="text-sm text-amber-300" role="alert">
              {problem}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={busy}
              className="rounded bg-blue-700 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {busy ? t("submitting") : t("submit")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditing(false)}
              className="text-sm text-gray-300 underline"
            >
              {t("cancel")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** The input for a setting's type. */
function ValueInput({
  entry,
  raw,
  onChange,
}: {
  readonly entry: SettingEntry;
  readonly raw: string | boolean;
  readonly onChange: (v: string | boolean) => void;
}) {
  const label = (
    <label htmlFor="config-value" className="mb-1 block text-sm text-gray-300">
      {t("new_value")}
    </label>
  );
  switch (entry.valueType) {
    case "boolean":
      return (
        <div>
          {label}
          <button
            id="config-value"
            type="button"
            role="switch"
            aria-checked={raw === true}
            onClick={() => onChange(raw !== true)}
            className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm ${
              raw === true ? "bg-green-700 text-white" : "bg-gray-700 text-gray-200"
            }`}
          >
            {raw === true ? t("boolean_on") : t("boolean_off")}
          </button>
        </div>
      );
    case "number":
      return (
        <div>
          {label}
          <input
            id="config-value"
            type="number"
            inputMode="decimal"
            value={String(raw)}
            min={entry.minValue ?? undefined}
            max={entry.maxValue ?? undefined}
            onChange={(e) => onChange(e.target.value)}
            className={`${input} max-w-xs`}
          />
          <p className="mt-1 text-xs text-gray-400">{rangeText(entry)}</p>
        </div>
      );
    case "string_enum":
      return (
        <div>
          {label}
          <select
            id="config-value"
            value={String(raw)}
            onChange={(e) => onChange(e.target.value)}
            className={`${input} max-w-xs`}
          >
            {(entry.allowedValues ?? []).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
      );
    case "json_array":
      return (
        <div>
          {label}
          <textarea
            id="config-value"
            value={String(raw)}
            onChange={(e) => onChange(e.target.value)}
            rows={Math.min(14, Math.max(4, String(raw).split("\n").length + 1))}
            spellCheck={false}
            className={`${input} font-mono text-xs`}
            aria-describedby="config-value-help"
          />
          <p id="config-value-help" className="mt-1 text-xs text-gray-400">
            {t("json_help")}
          </p>
        </div>
      );
    default:
      return (
        <div>
          {label}
          <input
            id="config-value"
            type="text"
            value={String(raw)}
            onChange={(e) => onChange(e.target.value)}
            className={input}
          />
        </div>
      );
  }
}
