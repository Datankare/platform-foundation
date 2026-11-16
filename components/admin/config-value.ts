/**
 * components/admin/config-value.ts — a setting's value as a person reads and types it
 * (TASK-202, N-60, N-61)
 *
 * One reader for the Platform config screen (show, edit) and the Approvals screen (a held
 * change's before → after): a value shown in words, an input read by the setting's type, and
 * what a list change adds and removes. Text is the catalog's (messages/en.json).
 *
 * @module components/admin
 */

import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import {
  agentStatusLabel,
  capabilityLabel,
  featureLabel,
  ownerLabel,
  settingLabel,
} from "@/components/admin/ui/labels";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.config.${key}`, values);

/** A value as one line: text as itself, on/off for a boolean, anything else as JSON. */
export function shownValue(value: unknown): string {
  if (value === undefined) return renderMessage("screens.held.diff_unknown");
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? t("boolean_on") : t("boolean_off");
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** The value types the platform's settings have (platform/admin/types.ts ConfigValueType). */
export type SettingType = "string" | "number" | "boolean" | "string_enum" | "json_array";

/** What a setting allows, as the edit panel needs it. */
export interface SettingRules {
  readonly valueType: SettingType;
  readonly minValue: number | null;
  readonly maxValue: number | null;
  readonly allowedValues: readonly string[] | null;
}

/** What an input reads as: a value to send, or why it cannot be sent. */
export type ReadInput =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly problem: string };

/**
 * The value `raw` (what the input holds) means for a setting of these rules: a number checked
 * against its range, a list parsed as JSON and checked to be a list, text not empty. The server
 * checks again (validateConfigValue); this only says why before anything is sent.
 */
export function readInput(rules: SettingRules, raw: string | boolean): ReadInput {
  switch (rules.valueType) {
    case "boolean":
      return { ok: true, value: raw === true || raw === "true" };
    case "number": {
      const text = String(raw).trim();
      const n = text === "" ? Number.NaN : Number(text);
      if (!Number.isFinite(n)) return { ok: false, problem: t("number_invalid") };
      if (rules.minValue !== null && n < rules.minValue)
        return { ok: false, problem: t("number_below", { min: rules.minValue }) };
      if (rules.maxValue !== null && n > rules.maxValue)
        return { ok: false, problem: t("number_above", { max: rules.maxValue }) };
      return { ok: true, value: n };
    }
    case "json_array": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        // In the catalogue's words (SF-admin-074): the parser's own message is the browser's
        // English ("Unexpected token…"), whatever the reader's language.
        return { ok: false, problem: t("json_invalid") };
      }
      return Array.isArray(parsed)
        ? { ok: true, value: parsed }
        : { ok: false, problem: t("json_not_array") };
    }
    case "string_enum":
    case "string": {
      const text = String(raw);
      if (text.trim() === "") return { ok: false, problem: t("string_empty") };
      return { ok: true, value: text };
    }
  }
}

/** What an input starts with for a value: JSON laid out for a list, the value's text otherwise. */
export function inputFor(rules: SettingRules, value: unknown): string | boolean {
  if (rules.valueType === "boolean") return value === true;
  if (rules.valueType === "json_array") return JSON.stringify(value ?? [], null, 2);
  return value === undefined || value === null ? "" : String(value);
}

/** Whether two values are the same setting value (JSON-equal). */
export function sameValue(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** The settings whose value is a list of settings, of agents, or of capabilities' features. */
const SETTINGS_LIST = "config.dual_control_keys";
const AGENTS = "agent.trusted_agents";
const CAPABILITY_FEATURES = "agent.capability_features";

const words = (list: readonly string[]) =>
  list.length ? list.join(", ") : t("list_empty");

/**
 * One item of a list setting in words (the walk: a held change showed
 * `+ agent.budget.default_tokens_per_month` and an agent as JSON): a setting by its name, an agent
 * by what it may do, a capability by the features it needs; text as itself; anything else JSON.
 */
export function itemText(key: string | undefined, item: unknown): string {
  if (key === SETTINGS_LIST && typeof item === "string") return settingLabel(item);
  if (
    key === AGENTS &&
    Array.isArray(item) &&
    typeof item[0] === "string" &&
    item[1] &&
    typeof item[1] === "object"
  ) {
    const rec = item[1] as {
      owner?: unknown;
      scopes?: unknown;
      status?: unknown;
      maxTokenTtl?: unknown;
    };
    const scopes = Array.isArray(rec.scopes) ? rec.scopes.map(String) : [];
    return t("item_agent", {
      agent: item[0],
      owner: ownerLabel(typeof rec.owner === "string" ? rec.owner : "first-party"),
      scopes: scopes.length ? words(scopes.map(capabilityLabel)) : t("item_no_scope"),
      status: agentStatusLabel(rec.status),
      ttl:
        typeof rec.maxTokenTtl === "number"
          ? t("item_ttl", { seconds: rec.maxTokenTtl })
          : t("item_ttl_default"),
    });
  }
  if (
    key === CAPABILITY_FEATURES &&
    Array.isArray(item) &&
    typeof item[0] === "string" &&
    Array.isArray(item[1])
  )
    return t("item_capability", {
      capability: capabilityLabel(item[0]),
      features: words((item[1] as unknown[]).map((f) => featureLabel(String(f)))),
    });
  return shownValue(item);
}

/**
 * What a list change does: the items it adds and those it removes, each in words (`itemText`,
 * by the setting's key when given).
 */
export function listChange(
  before: unknown,
  after: unknown,
  key?: string
): { readonly added: string[]; readonly removed: string[] } | undefined {
  if (!Array.isArray(before) || !Array.isArray(after)) return undefined;
  const text = (x: unknown) => itemText(key, x);
  const was = before.map(text);
  const now = after.map(text);
  return {
    added: now.filter((x) => !was.includes(x)),
    removed: was.filter((x) => !now.includes(x)),
  };
}

/**
 * A setting's value in a held change's before → after: an allowed value by its name where the
 * catalogue has one, a list of words as a list (each item in words: a setting by its name), else
 * as `shownValue`.
 */
export function changeValueText(key: string | undefined, value: unknown): string {
  if (key && typeof value === "string") {
    const named = [
      "screens.admin_console.labels.setting_values",
      key.replace(/[.-]/g, "_"),
      value,
    ].join(".");
    const text = renderMessage(named);
    return text === named ? value : text;
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "string"))
    return words(value.map((v) => itemText(key, v)));
  return shownValue(value);
}
