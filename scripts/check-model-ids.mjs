#!/usr/bin/env node
// scripts/check-model-ids.mjs — every model the platform calls still resolves, and accepts the
// request the platform sends it (TASK-186)
//
// Sonnet 4 was retired on 2026-06-15 and nothing noticed until calls failed (PR #461); Sonnet 5.5
// then rejects `temperature` and forced tool_choice with a 400. For each MODEL_REGISTRY entry
// (platform/ai/types.ts), this:
//   1. asks the Models API for it (GET /v1/models/{id}): an ID that does not resolve, answers for
//      another model, or reports `lifecycle: "retired"` fails the run; `deprecated` (or a set
//      `deprecated_at`) is a warning; a `retires_at` that is an ISO date is printed as a notice;
//   2. sends one minimal Messages call with the registry's own settings — `thinking` when the
//      entry has one, `temperature` only when it accepts one, max_tokens 1 — so the API checks
//      the request shape the provider sends. Any answer but 200 fails the run.
//
// The key comes from ANTHROPIC_API_KEY and is only ever sent as a header: never printed, and no
// response body is printed (only HTTP statuses). Without a key the check is skipped with a notice
// and a step summary — and fails when MODEL_CHECK_REQUIRED is "true", so a missing key cannot
// pass where the check is required. ANTHROPIC_BASE_URL overrides the API's address (the tests).
// Run by .github/workflows/model-registry-check.yml (weekly, by hand, and on a PR changing it).
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = join(ROOT, "platform/ai/types.ts");
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/**
 * The entries of MODEL_REGISTRY as written in types.ts: each tier's model ID, whether it takes
 * `temperature`, and its `thinking` type. The tests hold this equal to the real registry.
 */
export function registryEntries(source) {
  const start = source.indexOf("export const MODEL_REGISTRY");
  if (start < 0) throw new Error("MODEL_REGISTRY not found in platform/ai/types.ts");
  const end = source.indexOf("\n};", start);
  const body = source.slice(start, end < 0 ? undefined : end);
  const heads = [...body.matchAll(/\n {2}(\w+): \{/g)];
  const entries = [];
  heads.forEach((h, i) => {
    const text = body.slice(h.index, heads[i + 1]?.index ?? body.length);
    const id = text.match(/\bmodelId:\s*"([^"]+)"/)?.[1];
    if (!id) return;
    const temp = text.match(/\bacceptsTemperature:\s*(true|false)/)?.[1];
    if (temp === undefined) throw new Error(`${h[1]}: no acceptsTemperature`);
    const thinking = text.match(/\bthinking:\s*\{\s*type:\s*"([^"]+)"/)?.[1];
    entries.push({
      tier: h[1],
      modelId: id,
      acceptsTemperature: temp === "true",
      ...(thinking ? { thinking } : {}),
    });
  });
  if (entries.length === 0) throw new Error("no modelId found in MODEL_REGISTRY");
  return entries;
}

/** The model IDs written in MODEL_REGISTRY, in order, each once. */
export function registryModelIds(source) {
  return [...new Set(registryEntries(source).map((e) => e.modelId))];
}

/** The minimal Messages request for an entry, with the settings the provider sends. */
export function probeRequest(entry) {
  return {
    model: entry.modelId,
    max_tokens: 1,
    messages: [{ role: "user", content: "ping" }],
    ...(entry.thinking ? { thinking: { type: entry.thinking } } : {}),
    ...(entry.acceptsTemperature ? { temperature: 0 } : {}),
  };
}

function summary(text) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    appendFileSync(file, `${text}\n`);
  } catch {
    // A summary that cannot be written is not a failure of the check.
  }
}

async function call(url, key, init = {}) {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    const body = res.ok ? await res.json().catch(() => ({})) : {};
    return { status: res.status, body: body && typeof body === "object" ? body : {} };
  } catch {
    return { status: 0, body: {} };
  }
}

const why = (status) => (status === 0 ? "unreachable" : `HTTP ${status}`);

async function main() {
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  if (!key) {
    const required = process.env.MODEL_CHECK_REQUIRED === "true";
    console.log(
      `::${required ? "error" : "notice"}::ANTHROPIC_API_KEY is not set: the model registry check was skipped.`
    );
    summary(
      "### Model registry check: skipped\n\nANTHROPIC_API_KEY is not available to this run " +
        "(not set, or a fork's or Dependabot's pull request)." +
        (required ? " MODEL_CHECK_REQUIRED is true, so this run fails." : "")
    );
    return required ? 1 : 0;
  }
  const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(
    /\/+$/,
    ""
  );
  const entries = registryEntries(readFileSync(REGISTRY, "utf8"));
  const lines = [];
  let failed = 0;
  const fail = (msg) => {
    failed++;
    lines.push(`- ✗ ${msg}`);
    console.log(`::error::${msg}`);
  };

  for (const id of [...new Set(entries.map((e) => e.modelId))]) {
    const { status, body } = await call(
      `${base}/v1/models/${encodeURIComponent(id)}`,
      key
    );
    if (status !== 200) {
      fail(`${id} does not resolve (${why(status)}): retired, renamed or mistyped`);
      continue;
    }
    if (body.id !== id) {
      fail(`${id} does not resolve (answered for another model)`);
      continue;
    }
    const lifecycle =
      typeof body.lifecycle === "string" ? body.lifecycle : body.lifecycle?.state;
    if (lifecycle === "retired") {
      fail(`${id} is retired`);
      continue;
    }
    if (
      lifecycle === "deprecated" ||
      (body.deprecated_at !== undefined &&
        body.deprecated_at !== null &&
        body.deprecated_at !== "")
    ) {
      console.log(`::warning::${id} is deprecated: plan its replacement`);
      lines.push(`- ⚠ ${id} is deprecated`);
    }
    if (typeof body.retires_at === "string" && ISO_DATE.test(body.retires_at)) {
      console.log(`::notice::${id} retires at ${body.retires_at}`);
    }
    console.log(`ok ${id}`);
    lines.push(`- ✓ ${id} resolves`);
  }

  for (const entry of entries) {
    const { status } = await call(`${base}/v1/messages`, key, {
      method: "POST",
      body: JSON.stringify(probeRequest(entry)),
    });
    if (status === 200) {
      console.log(`ok ${entry.tier}: ${entry.modelId} accepts the platform's request`);
      lines.push(`- ✓ ${entry.tier}: request accepted`);
    } else {
      fail(
        `${entry.tier}: ${entry.modelId} refused the platform's request (${why(status)})`
      );
    }
  }

  console.log(
    failed === 0
      ? "every registry model resolves and accepts its request"
      : `${failed} check(s) failed`
  );
  summary(
    `### Model registry check: ${failed === 0 ? "passed" : "failed"}\n\n${lines.join("\n")}`
  );
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.log(
        `::error::model registry check failed: ${err instanceof Error ? err.message : err}`
      );
      process.exit(1);
    }
  );
}
