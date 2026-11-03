#!/usr/bin/env node
// scripts/check-model-ids.mjs — every model the platform calls still resolves, and accepts the
// request the platform sends it (TASK-186)
//
// Sonnet 4 was retired on 2026-06-15 and nothing noticed until calls failed (PR #461); Sonnet 5.5
// then rejects `temperature` and forced tool_choice with a 400. For each MODEL_REGISTRY entry
// (platform/ai/types.ts), this:
//   1. asks the Models API for it (GET /v1/models/{id}): an ID that does not resolve, answers for
//      another model, or reports `lifecycle: "retired"` fails the run; so does `deprecated` (or a
//      set `deprecated_at`), and a `retires_at` (an ISO date) within MODEL_RETIRE_LEAD_DAYS
//      (default 30) or past — TASK-197, audit D-3: a warning in a weekly scheduled run notified
//      nobody, so a retirement arrived with no lead time; a failed scheduled run notifies;
//   2. sends one minimal Messages call with the registry's own settings — `thinking` when the
//      entry has one, `temperature` only when it accepts one, max_tokens 1 — so the API checks
//      the request shape the provider sends. Any answer but 200 fails the run.
//
//   3. TASK-197 (audit D-3): with GOOGLE_API_KEY set, lists Google's text-to-speech voices
//      (voices.list, free) and fails when a voice the platform names (platform/voice/voices.ts,
//      and lib/tts.ts where an app keeps its own) is no longer offered. Speech-to-text's
//      `latest_long` cannot be checked — Speech v1 has no models list — and the run says so.
//      Without the key the Google check is skipped with a notice.
//
//   4. TASK-197 (the 2026-10-28 incident): the models named in .github/workflows/** — an action's
//      `claude-model:` input, any `model:` set to a claude-* id — must be MODEL_REGISTRY ids, so
//      steps 1–2 check them; and a third-party action pinned here that hard-codes a model we
//      cannot override is listed in KNOWN_ACTION_MODELS with what it degrades, its upstream issue
//      and a review-by date: until that date the run passes with a loud ::warning:: and a step
//      summary line (a check that is always red gets ignored); after it, the run fails — so the
//      exception is visible, never silent, and cannot outlive its review. Static: these checks
//      run with or without a key. MODEL_CHECK_WORKFLOWS_DIR overrides the directory and
//      MODEL_CHECK_NOW the date the review-by is compared with, and MODEL_CHECK_ACTION_SOURCE_BASE
//      where an action's source is read from (raw.githubusercontent.com; the tests). Every source
//      file of the action at its pinned ref is scanned (round 2; the file list from
//      MODEL_CHECK_ACTION_API_BASE, api.github.com), bounded at 150 files and 2 MB: what was not
//      scanned is said as a warning, and without the file list only the recorded file is.
//
// The deployed keys are checked at readiness, not here (platform/ai/readiness-probe.ts,
// platform/voice/google-tts-health.ts): this run uses the repository's secrets.
//
// The key comes from ANTHROPIC_API_KEY and is only ever sent as a header: never printed, and no
// response body is printed (only HTTP statuses). Without a key the check is skipped with a notice
// and a step summary — and fails when MODEL_CHECK_REQUIRED is "true", so a missing key cannot
// pass where the check is required. ANTHROPIC_BASE_URL overrides the API's address (the tests).
// Run by .github/workflows/model-registry-check.yml (weekly, by hand, and on a PR changing it).
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = join(ROOT, "platform/ai/types.ts");
const VOICE_SOURCES = ["platform/voice/voices.ts", "lib/tts.ts"].map((f) =>
  join(ROOT, f)
);
const DAY_MS = 86_400_000;
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

/**
 * Models third-party actions hard-code, which no input overrides (TASK-197). Keyed by the action
 * (owner/repo), whatever ref a workflow pins: at each pinned ref the action's own source (`file`)
 * is read and the hard-coded model re-verified (review round 1, L2). While the source still holds
 * `model`, the entry is a documented exception: a loud warning until `reviewBy`, a failure after
 * it. `verifiedAt` is the commit the string was confirmed at, by reading the source.
 */
export const KNOWN_ACTION_MODELS = Object.freeze({
  "anthropics/claude-code-security-review": {
    model: "claude-3-5-haiku-20241022",
    file: "claudecode/claude_api_client.py",
    where:
      "validate_api_access (claude_api_client.py:62 at 0c6a49f), called by findings_filter.py:188",
    verifiedAt: "0c6a49f1fa56a1d472575da86a94dbc1edb78eda",
    status: "retired (Anthropic's notice, 2026-10-28)",
    effect:
      "the pinned security-review action validates with a retired model; its false-positive filter is disabled (the scan itself uses the claude-model input)",
    degraded:
      "the action's false-positive filter is off: every finding is reported unfiltered",
    upstream:
      "anthropics/claude-code-security-review: hard-coded retired validation model (issue to be filed by the owner — TASK-197)",
    reviewBy: "2026-12-31",
  },
});

/** A YYYY-MM-DD that is a real calendar day (Date.parse rolls 2026-02-31 over into March). */
export function isCalendarDate(text) {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const at = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === text;
}

/** The key names a model is set under: claude-model, model, CLAUDE_MODEL, ANTHROPIC_MODEL. */
const MODEL_KEY =
  /^[ \t]*(?:-[ \t]*)?["']?(?:claude[-_]model|model|anthropic_model)["']?[ \t]*:(.*)$/i;

/**
 * The models a workflow names: `claude-model:` / `model:` values set to claude-* ids, and
 * `--model` flags. A model key set from an expression (`${{ vars.X }}`, `${{ env.Y }}`) or a
 * shell variable cannot be checked here: it is reported as unverifiable (review round 1, L3).
 */
export function workflowModels(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    for (const m of line.matchAll(
      /(?:\bclaude-model:|\bmodel:|--model[ =])\s*["']?(claude-[A-Za-z0-9.-]+)["']?/g
    )) {
      out.push({ line: i + 1, model: m[1] });
    }
    const key = line.match(MODEL_KEY);
    const value = key?.[1].trim() ?? "";
    if (key && /\$\{\{|^\$/.test(value))
      out.push({ line: i + 1, model: value, unverifiable: true });
    const flag = line.match(/--model[ =]["']?(\$[\w{}]+)/);
    if (flag) out.push({ line: i + 1, model: flag[1], unverifiable: true });
  });
  return out;
}

/** The `uses:` references of a workflow (owner/repo@ref). */
export function workflowActions(text) {
  return [...text.matchAll(/^[ \t-]*uses:[ \t]*([\w.-]+\/[\w./-]+@[\w.-]+)/gm)].map(
    (m) => m[1]
  );
}

/** Read an action's source file at a ref (null when it cannot be read). */
async function actionSource(action, ref, file) {
  const base = (
    process.env.MODEL_CHECK_ACTION_SOURCE_BASE || "https://raw.githubusercontent.com"
  ).replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/${action}/${ref}/${file}`, {
      signal: AbortSignal.timeout(20_000),
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** An action's source files worth scanning for a hard-coded model, and the bounds (round 2). */
const ACTION_SOURCE_FILE = /\.(?:py|js|mjs|cjs|ts|sh|ya?ml)$/;
const MAX_ACTION_FILES = 150;
const MAX_ACTION_BYTES = 2_000_000;

/**
 * The paths of an action's files at a ref, from the GitHub API's recursive tree (null when it
 * cannot be read). MODEL_CHECK_ACTION_API_BASE overrides the API's address (the tests); with
 * GITHUB_TOKEN set (the workflow's token) the call is authenticated, so the unauthenticated rate
 * limit cannot make the scan fall back (review round 3, N5). The token is only sent as a header.
 */
async function actionTree(action, ref) {
  const base = (
    process.env.MODEL_CHECK_ACTION_API_BASE || "https://api.github.com"
  ).replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/repos/${action}/git/trees/${ref}?recursive=1`, {
      headers: {
        accept: "application/vnd.github+json",
        ...(process.env.GITHUB_TOKEN
          ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!Array.isArray(body?.tree)) return null;
    return {
      paths: body.tree
        .filter((t) => t?.type === "blob" && typeof t.path === "string")
        .map((t) => t.path),
      truncated: body.truncated === true,
    };
  } catch {
    return null;
  }
}

/**
 * Every claude-* model an action's source hard-codes at a ref (round 2: every source file, not
 * only the one recorded): { models: Map<model, files[]>, recorded: text of known.file | null,
 * notes: [] }. Bounded — at most MAX_ACTION_FILES files and MAX_ACTION_BYTES; what was not
 * scanned is said in a note. Without the file list only the recorded file is scanned (a note).
 */
async function actionModels(action, ref, recordedFile) {
  const notes = [];
  const tree = await actionTree(action, ref);
  let files;
  if (tree) {
    const sources = tree.paths.filter((p) => ACTION_SOURCE_FILE.test(p));
    files = sources.slice(0, MAX_ACTION_FILES);
    if (!files.includes(recordedFile)) files.unshift(recordedFile);
    if (tree.truncated || sources.length > MAX_ACTION_FILES) {
      notes.push(
        `${action}@${ref}: scanned ${files.length} of ${sources.length}${tree.truncated ? "+" : ""} source files (the bound)`
      );
    }
  } else {
    files = [recordedFile];
    notes.push(
      `${action}@${ref}: its file list could not be read — only ${recordedFile} was scanned for hard-coded models`
    );
  }
  const models = new Map();
  let recorded = null;
  let bytes = 0;
  for (const file of files) {
    if (bytes > MAX_ACTION_BYTES) {
      notes.push(`${action}@${ref}: stopped after ${MAX_ACTION_BYTES} bytes of source`);
      break;
    }
    const text = await actionSource(action, ref, file);
    if (text === null) continue;
    bytes += text.length;
    if (file === recordedFile) recorded = text;
    for (const m of text.matchAll(/["'](claude-[A-Za-z0-9.-]+)["']/g)) {
      models.set(m[1], [...new Set([...(models.get(m[1]) ?? []), file])]);
    }
  }
  return { models, recorded, notes };
}

/**
 * The static checks of the workflows (no key needed): every model they name is a registry model
 * (or is reported unverifiable), and an action that hard-codes a model we cannot override is
 * re-verified in its source at the pinned ref — a documented exception warns until its review-by
 * date and fails after it; a hard-coded model nobody recorded fails. Returns { problems, warnings }.
 */
export async function workflowProblems(dir, registryIds, now = Date.now()) {
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    return { problems: [], warnings: [] };
  }
  const problems = [];
  const warnings = [];
  for (const f of files.sort()) {
    const text = readFileSync(join(dir, f), "utf8");
    for (const { line, model, unverifiable } of workflowModels(text)) {
      if (unverifiable) {
        problems.push(
          `${f}:${line} sets a model from ${model}: an unverifiable model reference — write the registry model's id`
        );
      } else if (!registryIds.includes(model)) {
        problems.push(
          `${f}:${line} names ${model}, which is not a MODEL_REGISTRY model — use a registry model so this check covers it`
        );
      }
    }
    for (const uses of new Set(workflowActions(text))) {
      const [action, ref] = uses.split("@");
      const known = KNOWN_ACTION_MODELS[action];
      if (!known) continue;
      const scanned = await actionModels(action, ref, known.file);
      warnings.push(...scanned.notes.map((n) => `${f}: ${n}`));
      if (scanned.recorded === null && ref !== known.verifiedAt) {
        problems.push(
          `${f}: ${action}@${ref} — its source (${known.file}) could not be read to re-verify the hard-coded model: unverifiable`
        );
        continue;
      }
      // The models its files hard-code: the recorded one is the exception; any other that is not
      // a registry model was never recorded.
      const hardCoded =
        scanned.recorded === null ? [known.model] : [...scanned.models.keys()];
      for (const other of hardCoded.filter(
        (m) => m !== known.model && !registryIds.includes(m)
      )) {
        problems.push(
          `${f}: ${action}@${ref} hard-codes ${other} in ${(scanned.models.get(other) ?? [known.file]).join(", ")}, which no exception records — re-verify and record it`
        );
      }
      if (!hardCoded.includes(known.model)) {
        warnings.push(
          `${f}: ${action}@${ref} no longer hard-codes ${known.model} in ${known.file}: remove its exception from KNOWN_ACTION_MODELS`
        );
        continue;
      }
      const msg = `${f}: ${known.effect} — ${action}@${ref} hard-codes ${known.model} (${known.status}) in ${known.where}; degraded: ${known.degraded}; upstream: ${known.upstream}`;
      const due = isCalendarDate(known.reviewBy)
        ? Date.parse(`${known.reviewBy}T23:59:59Z`)
        : Number.NaN;
      if (Number.isFinite(due) && now <= due) {
        warnings.push(`${msg} — a documented exception until ${known.reviewBy}`);
      } else {
        problems.push(
          `${msg} — its review-by date ${known.reviewBy} has passed (or is not a date): re-pin or replace the action`
        );
      }
    }
  }
  return { problems, warnings };
}

/** Google voice names written in a source file ("en-US-Neural2-F"), each once. */
export function voiceNames(source) {
  return [
    ...new Set(
      [...source.matchAll(/"([a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+-[A-Z])"/g)].map((m) => m[1])
    ),
  ];
}

/** Whether `retiresAt` (an ISO date) is within `leadDays` of `now`, or past. */
export function retiresSoon(retiresAt, leadDays, now = Date.now()) {
  const at = Date.parse(retiresAt);
  return Number.isFinite(at) && at - now <= leadDays * DAY_MS;
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
  // The workflows' models and the pinned actions' hard-coded ones: static, so checked first and
  // with or without a key (TASK-197).
  const workflowDir =
    process.env.MODEL_CHECK_WORKFLOWS_DIR || join(ROOT, ".github", "workflows");
  const nowOverride = Date.parse(process.env.MODEL_CHECK_NOW ?? "");
  const { problems: staticProblems, warnings: staticWarnings } = await workflowProblems(
    workflowDir,
    registryModelIds(readFileSync(REGISTRY, "utf8")),
    Number.isFinite(nowOverride) ? nowOverride : Date.now()
  );
  for (const p of staticProblems) console.log(`::error::${p}`);
  for (const w of staticWarnings) console.log(`::warning::${w}`);
  if (staticProblems.length || staticWarnings.length) {
    summary(
      `### Model check: workflows\n\n${[
        ...staticProblems.map((p) => `- ✗ ${p}`),
        ...staticWarnings.map((w) => `- ⚠ ${w}`),
      ].join("\n")}`
    );
  }
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
    return required || staticProblems.length ? 1 : 0;
  }
  const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(
    /\/+$/,
    ""
  );
  // An unset repository variable reaches the script as "": the default.
  const leadDays = Number((process.env.MODEL_RETIRE_LEAD_DAYS ?? "").trim() || 30);
  if (!Number.isFinite(leadDays) || leadDays < 0) {
    console.log("::error::MODEL_RETIRE_LEAD_DAYS must be a non-negative number of days");
    return 1;
  }
  const entries = registryEntries(readFileSync(REGISTRY, "utf8"));
  const lines = staticProblems.map((p) => `- ✗ ${p}`);
  let failed = staticProblems.length;
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
      fail(`${id} is deprecated: move its tier to a current model (TASK-188)`);
      continue;
    }
    if (typeof body.retires_at === "string" && ISO_DATE.test(body.retires_at)) {
      if (retiresSoon(body.retires_at, leadDays)) {
        fail(
          `${id} retires at ${body.retires_at}, within ${leadDays} days: move its tier now`
        );
        continue;
      }
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

  await checkGoogleVoices(lines, fail);

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

/**
 * The Google voices the platform names are still offered; each failure goes through fail().
 * Skipped, with a notice, without GOOGLE_API_KEY.
 */
async function checkGoogleVoices(lines, fail) {
  console.log(
    "::notice::Google speech-to-text model latest_long is not checked: Speech v1 offers no list of models"
  );
  const key = process.env.GOOGLE_API_KEY ?? "";
  if (!key) {
    console.log(
      "::notice::GOOGLE_API_KEY is not set: the Google voice check was skipped."
    );
    lines.push("- – Google voices: skipped (no GOOGLE_API_KEY)");
    return;
  }
  const wanted = [
    ...new Set(
      VOICE_SOURCES.flatMap((f) => {
        try {
          return voiceNames(readFileSync(f, "utf8"));
        } catch {
          return [];
        }
      })
    ),
  ];
  const base = (
    process.env.GOOGLE_TTS_BASE_URL || "https://texttospeech.googleapis.com"
  ).replace(/\/+$/, "");
  let status = 0;
  let body = {};
  try {
    const res = await fetch(`${base}/v1/voices`, {
      headers: { "X-Goog-Api-Key": key },
      signal: AbortSignal.timeout(20_000),
    });
    status = res.status;
    body = res.ok ? await res.json().catch(() => ({})) : {};
  } catch {
    status = 0;
  }
  if (status !== 200) {
    fail(
      `Google voices could not be listed (${why(status)}): the key or the API is refused`
    );
    return;
  }
  const offered = new Set(
    (Array.isArray(body.voices) ? body.voices : [])
      .map((v) => v?.name)
      .filter((n) => typeof n === "string")
  );
  for (const name of wanted) {
    if (offered.has(name)) {
      lines.push(`- ✓ voice ${name} offered`);
    } else {
      fail(
        `Google voice ${name} is no longer offered: choose another in platform/voice/voices.ts`
      );
    }
  }
  console.log(
    `ok ${wanted.filter((n) => offered.has(n)).length}/${wanted.length} Google voices offered`
  );
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
