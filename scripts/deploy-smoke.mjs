#!/usr/bin/env node
/**
 * scripts/deploy-smoke.mjs — the deployed smoke test (ADR-050 D5/D6, TASK-102/105)
 *
 * Runs against a DEPLOYED address after every deploy, so the layer no unit or E2E test can see —
 * the deployment's own configuration — is exercised. Each step prints one line; any failure
 * exits 1 after naming the step.
 *
 *   1. ready     GET  /api/health/ready — 200 and ready: boot completed, the database and the
 *                                        selected cache answer (ADR-056 D4; "degraded" — an
 *                                        optional dependency such as realtime down — still
 *                                        passes, and is printed); and (when
 *                                        SMOKE_EXPECTED_COMMIT is set) the deployed commit equals
 *                                        it. Polls until both hold, because the address may
 *                                        switch to the new build a little after the deploy
 *                                        reports success (D6: proves which code is live)
 *      live      GET  /api/health/live  — 200: the process answers (checked first)
 *   2. features  GET  /api/features    — 200, a feature list
 *   3. refused   POST translate path   — no credentials → 401 with a registered error code
 *                                        (the error contract, ADR-051, is live)
 *   4. guest     POST /api/auth/guest  — a signed guest token (ADR-050 D4)
 *   5. translate POST translate path   — as that guest, a real translation comes back (D5);
 *                                        uses one unit of a fresh guest's allowance. Skipped,
 *                                        and said so, with SMOKE_SKIP_TRANSLATE=1 — for a CI run
 *                                        of the image that has no AI credentials (Guardian
 *                                        classifies every input with the real model and fails
 *                                        closed without it); never on a deployment
 *
 * Settings (environment):
 *   SMOKE_BASE_URL         required — https://… (http only for localhost)
 *   SMOKE_EXPECTED_COMMIT  optional — the commit this deploy should be running (hex)
 *   SMOKE_WAIT_SECONDS     optional — how long to wait for that commit (default 300)
 *   SMOKE_TRANSLATE_PATH   optional — default /api/process
 *   SMOKE_TRANSLATION_FIELD optional — the field of each `translations[]` item that holds the
 *                          translated text; default `text` (PF's /api/process). An app whose
 *                          translate route answers in its own shape names its field here.
 *   SMOKE_TIMEOUT_MS       optional — per request (default 30000)
 *   SMOKE_SKIP_TRANSLATE   optional — "1": stop after the guest token (CI without AI credentials)
 *
 * Read by the consumer's deployment workflow (Playform: .github/workflows/deploy-smoke.yml).
 * No dependencies; Node 20+.
 */

import { fileURLToPath } from "node:url";

/** Parse and check the settings. Throws with every problem named. */
export function readSettings(env) {
  const problems = [];
  const base = (env.SMOKE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(base);
  } catch {
    problems.push("SMOKE_BASE_URL is required and must be a URL");
  }
  if (url) {
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      problems.push("SMOKE_BASE_URL must be https (http is allowed only for localhost)");
    }
    if (url.pathname !== "/" || url.search || url.hash) {
      problems.push("SMOKE_BASE_URL must be an origin only — no path, query or fragment");
    }
  }
  const expected = (env.SMOKE_EXPECTED_COMMIT ?? "").trim().toLowerCase();
  if (expected && !/^[0-9a-f]{7,40}$/.test(expected)) {
    problems.push("SMOKE_EXPECTED_COMMIT must be a commit hash (7–40 hex characters)");
  }
  const wait = Number(env.SMOKE_WAIT_SECONDS ?? 300);
  if (!Number.isFinite(wait) || wait < 0) {
    problems.push("SMOKE_WAIT_SECONDS must be a non-negative number");
  }
  const timeout = Number(env.SMOKE_TIMEOUT_MS ?? 30000);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    problems.push("SMOKE_TIMEOUT_MS must be a positive number");
  }
  const translatePath = (env.SMOKE_TRANSLATE_PATH ?? "/api/process").trim();
  if (!/^\/[\w\-/]+$/.test(translatePath)) {
    problems.push("SMOKE_TRANSLATE_PATH must be a path such as /api/process");
  }
  const translationField = (env.SMOKE_TRANSLATION_FIELD ?? "text").trim();
  if (!/^[a-z_]\w*$/i.test(translationField)) {
    problems.push("SMOKE_TRANSLATION_FIELD must be a field name such as text");
  }
  const skip = env.SMOKE_SKIP_TRANSLATE ?? "";
  if (skip !== "" && skip !== "1") {
    problems.push('SMOKE_SKIP_TRANSLATE must be "1" or unset');
  }
  if (problems.length) throw new Error(problems.join("; "));
  return {
    skipTranslate: skip === "1",
    base: url.origin,
    expected: expected || null,
    waitMs: wait * 1000,
    timeoutMs: timeout,
    translatePath,
    translationField,
  };
}

/** Does the commit the deployment reports match the one expected? (Either may be shortened.) */
export function commitMatches(reported, expected) {
  if (!expected) return true;
  if (typeof reported !== "string" || reported.length < 7) return false;
  const r = reported.toLowerCase();
  return expected.startsWith(r) || r.startsWith(expected);
}

/** At least one translation with non-empty text — a real result, not an empty 200. */
export function hasRealTranslation(body, field = "text") {
  return (
    Array.isArray(body?.translations) &&
    body.translations.some(
      (t) => typeof t?.[field] === "string" && t[field].trim() !== ""
    )
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(settings, method, path, { token, body } = {}) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${settings.base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(settings.timeoutMs),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // Not JSON — reported by the step that expected JSON.
  }
  return { status: res.status, json };
}

class StepFailure extends Error {}
const fail = (msg) => {
  throw new StepFailure(msg);
};

/** A readiness answer that lets traffic in: 200, ready, and ready or degraded. */
export function isReady(res) {
  return (
    res?.status === 200 &&
    res.json?.ready === true &&
    (res.json?.status === "ready" || res.json?.status === "degraded")
  );
}

export async function runSmoke(settings, log = console.log) {
  // 1 — liveness, then readiness and the deployed commit
  const deadline = Date.now() + settings.waitMs;
  let live;
  for (;;) {
    live = await call(settings, "GET", "/api/health/live").catch((e) => ({ error: e }));
    if (live.status === 200 || Date.now() >= deadline) break;
    await sleep(10_000);
  }
  if (live.error) fail(`live: request failed (${live.error.message})`);
  if (live.status !== 200) fail(`live: ${live.status}`);
  log("✓ live 200");

  let ready;
  for (;;) {
    ready = await call(settings, "GET", "/api/health/ready").catch((e) => ({ error: e }));
    const ok = isReady(ready) && commitMatches(ready.json?.commit, settings.expected);
    if (ok || Date.now() >= deadline) break;
    await sleep(10_000);
  }
  if (ready.error) fail(`ready: request failed (${ready.error.message})`);
  if (!isReady(ready)) {
    const why = [
      ready.json?.status,
      ready.json?.boot && `boot ${ready.json.boot}`,
      ready.json?.draining === true && "draining",
    ]
      .filter(Boolean)
      .join(", ");
    const down = (ready.json?.checks ?? [])
      .filter((c) => c?.status === "unhealthy")
      .map((c) => c.name);
    fail(
      `ready: ${ready.status}${why ? ` (${why})` : ""}${down.length ? ` — unhealthy: ${down.join(", ")}` : ""}`
    );
  }
  const commit = ready.json?.commit ?? null;
  if (!commitMatches(commit, settings.expected)) {
    fail(`ready: deployed commit ${commit ?? "unknown"} is not ${settings.expected}`);
  }
  log(`✓ ready 200 (${ready.json?.status}), commit ${commit ?? "not reported"}`);

  // 2 — features
  const features = await call(settings, "GET", "/api/features");
  if (features.status !== 200 || typeof features.json?.features !== "object") {
    fail(`features: ${features.status}, no feature list`);
  }
  const available = Object.entries(features.json.features)
    .filter(([, f]) => f?.available)
    .map(([id]) => id);
  log(`✓ features: ${available.length ? available.join(", ") : "none optional"}`);

  // 3 — an anonymous request is refused with a code
  const anon = await call(settings, "POST", settings.translatePath, {
    body: { text: "Good morning" },
  });
  if (anon.status !== 401 || typeof anon.json?.code !== "string") {
    fail(`refused: expected 401 with an error code, got ${anon.status}`);
  }
  log(`✓ anonymous request refused (${anon.json.code})`);

  // 4 — a signed guest token
  const guest = await call(settings, "POST", "/api/auth/guest");
  const token = guest.json?.token;
  if (guest.status !== 200 || typeof token !== "string" || !token.startsWith("guest.")) {
    fail(`guest: ${guest.status}, no signed guest token`);
  }
  log("✓ guest token issued (signed)");

  // 5 — a real translation, as that guest (one retry on a transient 503/429)
  if (settings.skipTranslate) {
    log("– translate: skipped (SMOKE_SKIP_TRANSLATE=1 — no AI credentials in this run)");
    log(
      `✓ smoke passed (translate skipped): ${settings.base} @ ${commit ?? "unknown commit"}`
    );
    return;
  }
  let tr = await call(settings, "POST", settings.translatePath, {
    token,
    body: { text: "Good morning" },
  });
  if (tr.status === 503 || tr.status === 429) {
    await sleep(5_000);
    tr = await call(settings, "POST", settings.translatePath, {
      token,
      body: { text: "Good morning" },
    });
  }
  if (tr.status !== 200 || !hasRealTranslation(tr.json, settings.translationField)) {
    fail(
      `translate: ${tr.status}${tr.json?.code ? ` ${tr.json.code}` : ""}, no translation`
    );
  }
  log(`✓ translate: ${tr.json.translations.length} translation(s)`);

  log(`✓ smoke passed: ${settings.base} @ ${commit ?? "unknown commit"}`);
}

async function main() {
  let settings;
  try {
    settings = readSettings(process.env);
  } catch (e) {
    console.error(`✗ settings: ${e.message}`);
    process.exit(2);
  }
  try {
    await runSmoke(settings);
  } catch (e) {
    console.error(
      `✗ ${e instanceof StepFailure ? e.message : `unexpected: ${e.message}`}`
    );
    console.error(`✗ smoke FAILED: ${settings.base}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
