// scripts/anthropic-messages.mjs — one Messages API call for the repository's CI scripts
// (TASK-204: the security review, N-86; the reviewer's eval set, N-44)
//
// The scripts run in CI with Node's own fetch: no install, no SDK. The model is a MODEL_REGISTRY
// tier read from platform/ai/types.ts (registryEntries, the model check's reader), sent with the
// registry's own settings — `thinking` when the entry has one, `temperature` only when it accepts
// one — so the weekly model check (scripts/check-model-ids.mjs) covers it and no workflow names a
// model of its own.
//
// The key is only ever sent as a header: never printed, and no response body is printed by this
// module. ANTHROPIC_BASE_URL overrides the API's address (the tests).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registryEntries } from "./check-model-ids.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The registry entry of a tier ("standard", "fast") as types.ts holds it. */
export function registryTier(tier, root = ROOT) {
  const entry = registryEntries(
    readFileSync(join(root, "platform/ai/types.ts"), "utf8")
  ).find((e) => e.tier === tier);
  if (!entry) throw new Error(`no ${tier} tier in MODEL_REGISTRY`);
  return entry;
}

/**
 * Ask the model once. Returns { status, text, stopReason }: status 0 when the API could not be
 * reached; text is the reply's text blocks joined ("" on any failure).
 */
export async function askModel({
  key,
  entry,
  system,
  user,
  maxTokens = 4096,
  timeoutMs = 300_000,
  base = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
}) {
  const body = {
    model: entry.modelId,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
    ...(entry.thinking ? { thinking: { type: entry.thinking } } : {}),
    ...(entry.acceptsTemperature ? { temperature: 0 } : {}),
  };
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { status: res.status, text: "", stopReason: null };
    const data = await res.json().catch(() => ({}));
    const text = Array.isArray(data?.content)
      ? data.content
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("")
      : "";
    return {
      status: res.status,
      text,
      stopReason: typeof data?.stop_reason === "string" ? data.stop_reason : null,
    };
  } catch {
    return { status: 0, text: "", stopReason: null };
  }
}

/** The first JSON object in a model's reply (a fenced block or bare), or null. */
export function jsonOf(text) {
  if (typeof text !== "string") return null;
  // A fenced block's body when there is one (found by index, not a backtracking pattern).
  const open = text.indexOf("```");
  const close = open < 0 ? -1 : text.indexOf("```", open + 3);
  const candidate = (
    close > open ? text.slice(open + 3, close).replace(/^json/, "") : text
  ).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(candidate.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
