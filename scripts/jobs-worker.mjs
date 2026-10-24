#!/usr/bin/env node
/**
 * scripts/jobs-worker.mjs — the job tick for hosts without a scheduler (ADR-056 D2, ADR-055)
 *
 * On Vercel, Vercel Cron calls the tick (vercel.json). On a container host (R6) or any server
 * without a cron service, run this beside the app:
 *
 *   JOBS_WORKER_URL=http://localhost:3000 CRON_SECRET=… npm run jobs:worker
 *
 * It calls POST /api/internal/jobs/tick with `Authorization: Bearer $CRON_SECRET` every
 * JOBS_WORKER_INTERVAL_SECONDS — at once again when the last tick ran out of budget with work
 * left — and prints one line per tick. The app does the work (claims, runs, settles); this only
 * keeps time, so it needs no database access and no code of the app's, and any number of
 * workers may run (claims never overlap). SIGTERM or SIGINT stops it at once and exits 0: a tick
 * in flight is the app's to finish (its runner does not watch this caller), so the worker does
 * not wait for one — it stops inside any host's grace period (Docker's 10 s) whatever the tick's
 * 45-second budget.
 *
 * Settings (environment):
 *   JOBS_WORKER_URL               required — the app's origin (https; http only for localhost)
 *   CRON_SECRET                   required — the secret the app's tick verifies (≥ 32 characters)
 *   JOBS_WORKER_INTERVAL_SECONDS  optional — between ticks (default 60, 5–3600)
 *   JOBS_WORKER_TIMEOUT_MS        optional — per tick request (default 70000)
 *   JOBS_WORKER_ONCE              optional — "1": one tick, exit 0 if it succeeded, 1 if not
 *
 * Exit: 0 stopped by a signal (or one successful tick); 1 a tick failed (JOBS_WORKER_ONCE);
 * 2 the settings are wrong, or the app refused the secret (no tick can succeed until fixed).
 * No dependencies; Node 20+.
 */

import { fileURLToPath } from "node:url";

/** Parse and check the settings. Throws with every problem named. */
export function readSettings(env) {
  const problems = [];
  const base = (env.JOBS_WORKER_URL ?? "").trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(base);
  } catch {
    problems.push("JOBS_WORKER_URL is required and must be a URL");
  }
  if (url) {
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      problems.push("JOBS_WORKER_URL must be https (http is allowed only for localhost)");
    }
    if (url.pathname !== "/" || url.search || url.hash) {
      problems.push(
        "JOBS_WORKER_URL must be an origin only — no path, query or fragment"
      );
    }
  }
  const secret = env.CRON_SECRET ?? "";
  if (secret.length < 32 || !/^[\w+/=.~-]+$/.test(secret)) {
    problems.push(
      "CRON_SECRET is required: at least 32 characters (letters, digits, + / = . ~ _ -)"
    );
  }
  const interval = Number(env.JOBS_WORKER_INTERVAL_SECONDS ?? 60);
  if (!Number.isInteger(interval) || interval < 5 || interval > 3600) {
    problems.push("JOBS_WORKER_INTERVAL_SECONDS must be a whole number, 5–3600");
  }
  const timeout = Number(env.JOBS_WORKER_TIMEOUT_MS ?? 70000);
  if (!Number.isInteger(timeout) || timeout < 1000) {
    problems.push("JOBS_WORKER_TIMEOUT_MS must be a whole number of at least 1000");
  }
  if (problems.length) throw new Error(problems.join("; "));
  return {
    tickUrl: `${url.origin}/api/internal/jobs/tick`,
    secret,
    intervalMs: interval * 1000,
    timeoutMs: timeout,
    once: env.JOBS_WORKER_ONCE === "1",
  };
}

/**
 * One tick. Resolves { ok, status, result?, fatal, stopped? } — never throws. `stop` aborts the
 * request (stopped: true); the app still finishes the tick it began.
 */
export async function tickOnce(settings, fetchImpl = fetch, stop) {
  const timeout = AbortSignal.timeout(settings.timeoutMs);
  try {
    const res = await fetchImpl(settings.tickUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${settings.secret}`, accept: "application/json" },
      redirect: "manual",
      signal: stop ? AbortSignal.any([timeout, stop]) : timeout,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      // Not JSON — reported by status.
    }
    // A refused secret, or a tick route that does not exist, cannot start working by retrying.
    const fatal = res.status === 401 || res.status === 403 || res.status === 404;
    return {
      ok: res.status === 200,
      status: res.status,
      result: body?.result,
      code: body?.code,
      fatal,
    };
  } catch (e) {
    if (stop?.aborted) return { ok: false, status: 0, stopped: true, fatal: false };
    return { ok: false, status: 0, error: e?.name ?? "Error", fatal: false };
  }
}

/** One line describing a tick, for the log. */
export function describeTick(t) {
  if (!t.ok) {
    return `✗ tick ${t.status || "unreachable"}${t.code ? ` ${t.code}` : ""}${t.error ? ` (${t.error})` : ""}`;
  }
  const r = t.result ?? {};
  const scheduled = Array.isArray(r.scheduled) ? r.scheduled.length : 0;
  return (
    `✓ tick: scheduled ${scheduled}, claimed ${r.claimed ?? 0}, succeeded ${r.succeeded ?? 0}, ` +
    `retried ${r.retried ?? 0}, dead ${r.dead ?? 0}, stopped by ${r.stoppedBy ?? "?"}`
  );
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

export async function runWorker(
  settings,
  { log = console.log, signal, fetchImpl = fetch } = {}
) {
  const stop = signal ?? new AbortController().signal;
  for (;;) {
    const t = await tickOnce(settings, fetchImpl, stop);
    if (t.stopped) {
      log("■ stopped — the tick in flight is the app's to finish");
      return 0;
    }
    log(describeTick(t));
    if (t.fatal) return 2;
    if (settings.once) return t.ok ? 0 : 1;
    if (stop.aborted) return 0;
    // Out of budget with work left: tick again at once; else wait for the interval.
    const again = t.ok && t.result?.stoppedBy === "budget";
    if (!again) await sleep(settings.intervalMs, stop);
    if (stop.aborted) return 0;
  }
}

async function main() {
  let settings;
  try {
    settings = readSettings(process.env);
  } catch (e) {
    console.error(`✗ settings: ${e.message}`);
    process.exit(2);
  }
  const controller = new AbortController();
  for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => controller.abort());
  console.log(`▸ jobs worker: ${settings.tickUrl} every ${settings.intervalMs / 1000} s`);
  process.exit(await runWorker(settings, { signal: controller.signal }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
