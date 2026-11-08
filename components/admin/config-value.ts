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
      } catch (err) {
        return {
          ok: false,
          problem: t("json_invalid", {
            reason: err instanceof Error ? err.message : String(err),
          }),
        };
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

/** What a list change does: the items it adds and those it removes (each as JSON text). */
export function listChange(
  before: unknown,
  after: unknown
): { readonly added: string[]; readonly removed: string[] } | undefined {
  if (!Array.isArray(before) || !Array.isArray(after)) return undefined;
  const text = (x: unknown) => shownValue(x);
  const was = before.map(text);
  const now = after.map(text);
  return {
    added: now.filter((x) => !was.includes(x)),
    removed: was.filter((x) => !now.includes(x)),
  };
}
