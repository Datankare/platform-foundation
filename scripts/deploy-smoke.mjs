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
 *   4. guest     POST /api/auth/guest  — a guest session (ADR-050 D4, ADR-057): the answer
 *                                        carries no token; the session cookie is HttpOnly (and,
 *                                        on https, `__Host-pf_session`, Secure, SameSite=Lax);
 *                                        GET /api/auth/session then names the guest and gives
 *                                        the session's forgery token. A state-changing request
 *                                        without that token is refused (auth.csrf_failed)
 *   5. translate POST translate path   — as that guest (the cookie, this origin and the
 *                                        token — what a browser sends), a real translation
 *                                        comes back (D5);
 *                                        uses one unit of a fresh guest's allowance. Skipped,
 *                                        and said so, with SMOKE_SKIP_TRANSLATE=1 — for a CI run
 *                                        of the image that has no AI credentials (Guardian
 *                                        classifies every input with the real model and fails
 *                                        closed without it); never on a deployment
 *   6. session   POST session path, then POST dispatch path — as a second fresh guest (so it
 *                holds when the allowance is 1), the screen's
 *                own path when the app runs translation as a persisted session (TASK-181):
 *                opens a session (200, a sessionId), dispatches one intent into it, and a real
 *                translation must come back in the returned view's `state.translations[]`.
 *                Only when SMOKE_SESSION_PATH and SMOKE_DISPATCH_PATH are set; skipped with
 *                the translate step
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
 *   SMOKE_SKIP_TRANSLATE   optional — "1": stop after the guest session (CI without AI credentials)
 *   SMOKE_SESSION_PATH     optional — with SMOKE_DISPATCH_PATH: the session-open route (step 6)
 *   SMOKE_DISPATCH_PATH    optional — with SMOKE_SESSION_PATH: the route an intent is sent to
 *   SMOKE_HEALTHY_PROBES   optional — comma-separated readiness checks that must be healthy, not
 *                          merely present (TASK-197): e.g. "ai-provider,google-translate" — a
 *                          revoked key or a retired model degrades readiness, and this fails the
 *                          deploy on it. A named check that is missing fails too
 *                          A probe still pending (a paid probe's first call, answered "degraded:
 *                          check pending" — TASK-197 round 1, M-1) is polled like the commit
 *   SMOKE_POLL_MS          optional — the wait between readiness polls (default 10000)
 *   SMOKE_DISPATCH_INTENT  optional — the intent, JSON; default
 *                          {"type":"translate","text":"Good morning","additionalLanguages":[]}
 *
 * Read by the consumer's deployment workflow (Playform: .github/workflows/deploy-smoke.yml).
 * No dependencies; Node 20+.
 */

import { fileURLToPath } from "node:url";

const DEFAULT_DISPATCH_INTENT = Object.freeze({
  type: "translate",
  text: "Good morning",
  additionalLanguages: [],
});

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
  const sessionPath = (env.SMOKE_SESSION_PATH ?? "").trim();
  const dispatchPath = (env.SMOKE_DISPATCH_PATH ?? "").trim();
  if (Boolean(sessionPath) !== Boolean(dispatchPath)) {
    problems.push(
      "SMOKE_SESSION_PATH and SMOKE_DISPATCH_PATH are set together or not at all"
    );
  }
  for (const [name, path] of [
    ["SMOKE_SESSION_PATH", sessionPath],
    ["SMOKE_DISPATCH_PATH", dispatchPath],
  ]) {
    if (path && !/^\/[\w\-/]+$/.test(path)) {
      problems.push(`${name} must be a path such as /api/translate/session`);
    }
  }
  const healthyProbes = (env.SMOKE_HEALTHY_PROBES ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  for (const p of healthyProbes) {
    if (!/^[a-z][a-z0-9-]*$/.test(p)) {
      problems.push("SMOKE_HEALTHY_PROBES must be probe names such as ai-provider");
      break;
    }
  }
  let dispatchIntent = DEFAULT_DISPATCH_INTENT;
  if ((env.SMOKE_DISPATCH_INTENT ?? "").trim() !== "") {
    try {
      dispatchIntent = JSON.parse(env.SMOKE_DISPATCH_INTENT);
    } catch {
      dispatchIntent = null;
    }
    if (
      !dispatchIntent ||
      typeof dispatchIntent !== "object" ||
      Array.isArray(dispatchIntent)
    ) {
      problems.push("SMOKE_DISPATCH_INTENT must be a JSON object");
    }
  }
  const poll = Number(env.SMOKE_POLL_MS ?? 10000);
  if (!Number.isFinite(poll) || poll < 0)
    problems.push("SMOKE_POLL_MS must be a non-negative number");
  if (problems.length) throw new Error(problems.join("; "));
  return {
    session: sessionPath ? { sessionPath, dispatchPath, intent: dispatchIntent } : null,
    healthyProbes,
    pollMs: poll,
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

/**
 * One request. `session` — a guest session this run started — is sent as a browser sends it: the
 * session cookie, this origin, and the session's forgery token (ADR-057 D4). No credential is
 * ever sent as an Authorization header: a user route would not read it.
 */
async function call(settings, method, path, { session, body } = {}) {
  const headers = { accept: "application/json" };
  if (method !== "GET") headers.origin = settings.base;
  if (session) {
    headers.cookie = session.cookie;
    if (method !== "GET" && session.csrfToken)
      headers["x-csrf-token"] = session.csrfToken;
  }
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
  return { status: res.status, json, setCookies: res.headers.getSetCookie?.() ?? [] };
}

export const SESSION_COOKIE_NAMES = ["__Host-pf_session", "pf_session"];

/** The session cookie among a response's Set-Cookie lines: its `name=value` and attributes. */
export function sessionCookieFrom(setCookies) {
  for (const line of setCookies ?? []) {
    const [pair, ...attributes] = String(line).split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!SESSION_COOKIE_NAMES.includes(name) || value === "") continue;
    const flags = new Map(
      attributes.map((a) => {
        const [k, ...v] = a.trim().split("=");
        return [k.toLowerCase(), v.join("=").toLowerCase()];
      })
    );
    return {
      name,
      pair: `${name}=${value}`,
      httpOnly: flags.has("httponly"),
      secure: flags.has("secure"),
      sameSite: flags.get("samesite") ?? "",
      path: flags.get("path") ?? "",
      domain: flags.has("domain"),
    };
  }
  return null;
}

/** The property names of a JSON answer, at any depth, that look like a token (ADR-057 D1). */
export function tokenFields(json, path = "") {
  if (json === null || typeof json !== "object") return [];
  return Object.entries(json).flatMap(([k, v]) => {
    const here = path ? `${path}.${k}` : k;
    const named = /^(?:token|bearer|(?:access|refresh|id)_?token)$/i.test(k);
    return [...(named ? [here] : []), ...tokenFields(v, here)];
  });
}

/** What is wrong with a deployed session cookie; none when it is as ADR-057 D1 requires. */
export function cookieProblems(cookie, base) {
  const problems = [];
  if (!cookie.httpOnly) problems.push("not HttpOnly");
  if (cookie.domain) problems.push("has a Domain");
  if (cookie.path !== "/") problems.push("Path is not /");
  if (cookie.sameSite !== "lax" && cookie.sameSite !== "strict")
    problems.push("no SameSite=Lax");
  // Over https — every deployment — the cookie is the __Host- one, Secure.
  if (base.startsWith("https://")) {
    if (cookie.name !== "__Host-pf_session") problems.push("not __Host-pf_session");
    if (!cookie.secure) problems.push("not Secure");
  }
  return problems;
}

class StepFailure extends Error {}
const fail = (msg) => {
  throw new StepFailure(msg);
};

/**
 * Start a guest session as a browser does: no token in the answer, an HttpOnly session cookie,
 * and the session's own status naming a guest with its forgery token.
 */
async function guestSession(settings, step) {
  const started = await call(settings, "POST", "/api/auth/guest");
  if (started.status !== 200) fail(`${step}: ${started.status}, no guest session`);
  const leaked = tokenFields(started.json);
  if (leaked.length) {
    fail(
      `${step}: the answer carries a token (${leaked.join(", ")}) — none may reach the browser`
    );
  }
  const cookie = sessionCookieFrom(started.setCookies);
  if (!cookie) fail(`${step}: 200, no session cookie`);
  const problems = cookieProblems(cookie, settings.base);
  if (problems.length) fail(`${step}: the session cookie is ${problems.join(", ")}`);
  const status = await call(settings, "GET", "/api/auth/session", {
    session: { cookie: cookie.pair },
  });
  const csrfToken = status.json?.csrfToken;
  if (
    status.status !== 200 ||
    status.json?.authenticated !== true ||
    status.json?.user?.isGuest !== true ||
    typeof csrfToken !== "string" ||
    csrfToken === ""
  ) {
    fail(`${step}: the session is not a guest's (${status.status})`);
  }
  return { cookie: cookie.pair, csrfToken };
}

/** The names among `required` that the readiness answer does not report healthy. */
export function unhealthyRequired(res, required) {
  const checks = Array.isArray(res?.json?.checks) ? res.json.checks : [];
  return required.filter(
    (name) => !checks.some((c) => c?.name === name && c.status === "healthy")
  );
}

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
    await sleep(settings.pollMs ?? 10_000);
  }
  if (live.error) fail(`live: request failed (${live.error.message})`);
  if (live.status !== 200) fail(`live: ${live.status}`);
  log("✓ live 200");

  let ready;
  for (;;) {
    ready = await call(settings, "GET", "/api/health/ready").catch((e) => ({ error: e }));
    // A named probe may answer "timed out" on the first, cold, readiness call while its billed
    // check completes (it is cached): it is polled like the commit.
    const ok =
      isReady(ready) &&
      commitMatches(ready.json?.commit, settings.expected) &&
      unhealthyRequired(ready, settings.healthyProbes ?? []).length === 0;
    if (ok || Date.now() >= deadline) break;
    await sleep(settings.pollMs ?? 10_000);
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
  const notHealthy = (ready.json?.checks ?? []).filter((c) => c?.status !== "healthy");
  if (notHealthy.length) {
    log(`  degraded: ${notHealthy.map((c) => `${c.name} ${c.status}`).join(", ")}`);
  }
  // TASK-197: the probes this deployment requires healthy (a revoked key, a retired model).
  const required = settings.healthyProbes ?? [];
  const failing = unhealthyRequired(ready, required);
  if (failing.length) fail(`ready: not healthy: ${failing.join(", ")}`);
  if (required.length) log(`✓ healthy: ${required.join(", ")}`);

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

  // 4 — a guest session: an HttpOnly cookie, no token in the answer
  const guest = await guestSession(settings, "guest");
  log("✓ guest session started (HttpOnly cookie, no token in the answer)");

  // A state-changing request with the cookie but without the session's token is refused: the
  // forgery defence is live (ADR-057 D4).
  const forged = await call(settings, "POST", "/api/auth/session", {
    session: { cookie: guest.cookie },
  });
  if (forged.status !== 403 || forged.json?.code !== "auth.csrf_failed") {
    fail(
      `forgery: expected 403 auth.csrf_failed without the session's token, got ${forged.status}`
    );
  }
  log("✓ a request without the session's token refused (auth.csrf_failed)");

  // 5 — a real translation, as that guest (one retry on a transient 503/429)
  if (settings.skipTranslate) {
    log("– translate: skipped (SMOKE_SKIP_TRANSLATE=1 — no AI credentials in this run)");
    log(
      `✓ smoke passed (translate skipped): ${settings.base} @ ${commit ?? "unknown commit"}`
    );
    return;
  }
  let tr = await call(settings, "POST", settings.translatePath, {
    session: guest,
    body: { text: "Good morning" },
  });
  if (tr.status === 503 || tr.status === 429) {
    await sleep(5_000);
    tr = await call(settings, "POST", settings.translatePath, {
      session: guest,
      body: { text: "Good morning" },
    });
  }
  if (tr.status !== 200 || !hasRealTranslation(tr.json, settings.translationField)) {
    fail(
      `translate: ${tr.status}${tr.json?.code ? ` ${tr.json.code}` : ""}, no translation`
    );
  }
  log(`✓ translate: ${tr.json.translations.length} translation(s)`);

  // 6 — the screen's own path: a session, then one intent dispatched into it (TASK-181)
  if (settings.session) {
    const { sessionPath, dispatchPath, intent } = settings.session;
    // A fresh guest, so this step holds even when the governed allowance is 1.
    const second = await guestSession(settings, "session: guest");
    const opened = await call(settings, "POST", sessionPath, {
      session: second,
      body: {},
    });
    const sessionId = opened.json?.sessionId;
    if (opened.status !== 200 || typeof sessionId !== "string") {
      fail(
        `session: ${opened.status}${opened.json?.code ? ` ${opened.json.code}` : ""}, no session`
      );
    }
    log(`✓ session opened (${sessionPath})`);
    let sent = await call(settings, "POST", dispatchPath, {
      session: second,
      body: { sessionId, intent },
    });
    if (sent.status === 503 || sent.status === 429) {
      await sleep(5_000);
      sent = await call(settings, "POST", dispatchPath, {
        session: second,
        body: { sessionId, intent },
      });
    }
    if (
      sent.status !== 200 ||
      !hasRealTranslation(sent.json?.state, settings.translationField)
    ) {
      fail(
        `dispatch: ${sent.status}${sent.json?.code ? ` ${sent.json.code}` : ""}, no translation`
      );
    }
    log(
      `✓ dispatch: ${sent.json.state.translations.length} translation(s) in the session`
    );
  }

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
