/**
 * @jest-environment node
 */
/**
 * __tests__/config-value-refusal.test.ts — why a config value is refused, structured and worded
 * (TASK-194 round 14, item 2)
 *
 * The config page, the command bar and the config assistant answered a refused value three ways
 * (a bare key; request.invalid_value with the entry's English; a 500). All three now answer
 * `admin.config_invalid_value { key, reason, min?, max?, expected?, allowed? }` (`allowed`: an
 * enum's list, round 15 I-8): validateConfigValue gives
 * the reason, and the message words it with an ICU select whose `other` says it generally.
 */

import { validateConfigValue } from "@/platform/auth/platform-config";
import { renderMessage } from "@/platform/errors/messages";
import type { EnhancedConfigEntry } from "@/platform/admin/types";

const entry = (o: Partial<EnhancedConfigEntry>): EnhancedConfigEntry =>
  ({
    key: "k",
    value: 1,
    valueType: "number",
    minValue: null,
    maxValue: null,
    allowedValues: null,
    ...o,
  }) as unknown as EnhancedConfigEntry;

it.each([
  [entry({ valueType: "number" }), "ten", { reason: "type", expected: "number" }],
  [entry({ minValue: 5 }), 1, { reason: "below_min", min: 5 }],
  [entry({ maxValue: 10 }), 99, { reason: "above_max", max: 10 }],
  [entry({ valueType: "boolean" }), "maybe", { reason: "type", expected: "boolean" }],
  [entry({ valueType: "json_array" }), 3, { reason: "type", expected: "json_array" }],
  [
    entry({ valueType: "string_enum", allowedValues: ["a", "b"] }),
    "c",
    // Its list (round 15, I-8).
    { reason: "not_allowed", allowed: ["a", "b"] },
  ],
  [
    entry({ valueType: "string_enum", allowedValues: ["a", "b"] }),
    7,
    { reason: "type", expected: "string_enum", allowed: ["a", "b"] },
  ],
  // An enum with no list takes any text: refused as not text.
  [entry({ valueType: "string_enum" }), 7, { reason: "type", expected: "string" }],
  [
    entry({ valueType: "string" }),
    "x".repeat(70_000),
    { reason: "too_large", max: 65_536 },
  ],
  [entry({ valueType: "string" }), BigInt(10), { reason: "not_serializable" }],
] as const)("refuses %#: %j", (e, value, refusal) => {
  const r = validateConfigValue(e, value);
  expect(r.valid).toBe(false);
  expect(r.refusal).toEqual(refusal);
});

it.each([
  [{ reason: "type", expected: "number" }, "k takes a number."],
  [{ reason: "type", expected: "json_array" }, "k takes a list."],
  [{ reason: "below_min", min: 5 }, "k must be at least 5."],
  [{ reason: "above_max", max: 10 }, "k must be at most 10."],
  [{ reason: "not_allowed", allowed: ["a", "b"] }, "The values k takes are a and b."],
  [
    { reason: "type", expected: "string_enum", allowed: ["low", "high"] },
    "k takes text: the values it takes are low and high.",
  ],
  [{ reason: "not_serializable" }, "That value cannot be stored for k."],
  [
    { reason: "too_large", max: 65_536 },
    "That value is too large to store for k (at most 65,536 bytes).",
  ],
  [{ reason: "other" }, "That value is not allowed for k."],
  [{ reason: "something new" }, "That value is not allowed for k."],
])("words %j", (params, text) => {
  expect(
    renderMessage("errors.admin.config_invalid_value", { key: "k", ...params })
  ).toBe(text);
});
