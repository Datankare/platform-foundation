#!/usr/bin/env node
// scripts/health-watch.mjs — a deployment's health, polled from outside (TASK-204, N-15; R-79)
//
//   node scripts/health-watch.mjs <base-url>
//
// The job-schedules probe (platform/jobs/schedule-probe.ts) marks /api/health "degraded" when the
// timed duties stop — no tick for twice a kind's interval: no GDPR retention purge, no escalation
// reaper, no erasure completion — and the error reporter hears of it when the state changes. Both
// happen only when something asks for /api/health; nothing did between deployments, so a stopped
// cron or worker went unnoticed. An app's scheduled workflow (Playform: health-watch.yml) runs
// this hourly and opens an issue on a problem, closing it on recovery.
//
// It reads the route's public answer only — probe NAMES and STATUSES, never detail (OWASP A05, the
// route's own rule) — and prints one line per key for $GITHUB_OUTPUT:
//
//   state=ok | problem
//   reason=<one line>   (with a problem)
//
// A problem: the deployment cannot be reached, answers anything but 200 or 503, says it is
// unhealthy, or a watched probe (WATCH_CHECKS, comma-separated; default "job-schedules") is not
// healthy or is missing. Other degraded probes are listed as a notice, not a problem (an optional
// provider is allowed to be degraded). Exit 0 either way, 2 on a usage error.
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The verdict on one /api/health answer: { state, reason, notices }. */
export function verdict(status, body, watched) {
  if (status === 0)
    return {
      state: "problem",
      reason: "the deployment could not be reached",
      notices: [],
    };
  if (status !== 200 && status !== 503) {
    return {
      state: "problem",
      reason: `/api/health answered HTTP ${status}`,
      notices: [],
    };
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.checks)) {
    return {
      state: "problem",
      reason: "/api/health answered without its checks",
      notices: [],
    };
  }
  const checks = body.checks
    .filter((c) => c && typeof c.name === "string" && typeof c.status === "string")
    .map((c) => ({ name: c.name, status: c.status }));
  if (body.status === "unhealthy" || status === 503) {
    const bad = checks.filter((c) => c.status === "unhealthy").map((c) => c.name);
    return {
      state: "problem",
      reason: `the deployment is unhealthy${bad.length ? ` (${bad.join(", ")})` : ""}`,
      notices: [],
    };
  }
  const problems = [];
  for (const name of watched) {
    const c = checks.find((x) => x.name === name);
    if (!c) problems.push(`${name}: not reported`);
    else if (c.status !== "healthy") {
      problems.push(
        name === "job-schedules"
          ? `job-schedules is ${c.status}: the timed duties have stopped (no tick — CRON_SECRET, the cron or the worker)`
          : `${name} is ${c.status}`
      );
    }
  }
  const notices = checks
    .filter((c) => c.status !== "healthy" && !watched.includes(c.name))
    .map((c) => `${c.name} is ${c.status}`);
  return problems.length
    ? { state: "problem", reason: problems.join("; "), notices }
    : { state: "ok", reason: "", notices };
}

async function main() {
  const base = (process.argv[2] ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+$/.test(base)) {
    console.log("usage: health-watch.mjs <base-url> (scheme and host only)");
    return 2;
  }
  const watched = (process.env.WATCH_CHECKS || "job-schedules")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let status = 0;
  let body = null;
  try {
    const res = await fetch(`${base}/api/health`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch {
    status = 0;
  }
  const v = verdict(status, body, watched);
  for (const n of v.notices) console.log(`::notice::${base}: ${n}`);
  const out = process.env.GITHUB_OUTPUT;
  const lines = [`state=${v.state}`, ...(v.reason ? [`reason=${v.reason}`] : [])];
  if (out) appendFileSync(out, `${lines.join("\n")}\n`);
  console.log(v.state === "ok" ? `${base}: ok` : `::warning::${base}: ${v.reason}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => process.exit(code));
}
