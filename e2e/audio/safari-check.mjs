#!/usr/bin/env node
/**
 * e2e/audio/safari-check.mjs — the browser-audio gate in REAL Safari (TASK-234; DESIGN-56f1 §9.2,
 * test T22)
 *
 *   node e2e/audio/safari-check.mjs --out <directory> [--driver /usr/bin/safaridriver]
 *
 * A W3C WebDriver client (fetch to safaridriver): starts safaridriver on a free 127.0.0.1 port,
 * creates a session, opens the gate page from serve.mjs (127.0.0.1), clicks Start with a WebDriver
 * element click (the gesture that lets the page's AudioContext start), waits for the run, compares
 * every result with the table's "safari" column, requires Safari 18.4 or later, and writes Safari's
 * two recordings and the run's facts into --out with their sha256 printed.
 *
 * It FAILS, it never skips: no safaridriver, a session that cannot be created (automation not
 * enabled: run `safaridriver --enable`, or `sudo safaridriver --enable` only if that refuses; a
 * session request that gets no answer in 90 s: open Safari once and allow automation in its
 * menus — the message says how), a
 * click that does not start audio ("audio clock not running"), an older Safari or any mismatch
 * exits 1 with the reason.
 *
 * Credits: "WebDriver" (W3C; S. Stewart, D. Burns) — the protocol; Apple, "Testing with WebDriver
 * in Safari" — safaridriver and its one-time enabling.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const MIN_SAFARI = [18, 4];
// Ten minutes: an engine that leaves the length probe without an answer makes each such case wait
// out its budget (30 s; 10 s per diagnostic), and the run must still end with every fact reported.
const RUN_BUDGET_MS = 600_000;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function fail(message) {
  console.error(`safari-check: FAIL — ${message}`);
  process.exitCode = 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

/** True when `version` ("18.4", "26.1.2") is at least MIN_SAFARI. */
export function safariVersionOk(version) {
  const m = /^(\d+)\.(\d+)/.exec(String(version ?? ""));
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > MIN_SAFARI[0] || (maj === MIN_SAFARI[0] && min >= MIN_SAFARI[1]);
}

/** File name for a recording of `mimeType` in Safari `version`. */
export function recordingName(version, mimeType) {
  const v = String(version).replace(/[^0-9.]/g, "");
  if (/mp4/.test(mimeType)) return `safari-${v}-mp4.m4a`;
  if (/ogg/.test(mimeType)) return `safari-${v}-ogg.ogg`;
  return `safari-${v}-webm.webm`;
}

/**
 * Why no session came, and what to do. A session request that timed out (seen on the owner's
 * Mac: safaridriver answers, the session never comes) needs Safari opened once and automation
 * allowed in its own menus; any other refusal needs `safaridriver --enable`.
 */
export function noSessionMessage(reason) {
  const text = String(reason ?? "");
  const what = /timed? ?out/i.test(text)
    ? "open Safari once by hand, then Settings → Advanced → Show features for web developers, then Developer → Allow remote automation"
    : "run: safaridriver --enable (sudo safaridriver --enable only if that refuses)";
  return `no Safari session (${text}) — ${what}`;
}

const SESSION_BUDGET_MS = 90_000;

async function main() {
  const out = arg("--out");
  const driver = arg("--driver", "/usr/bin/safaridriver");
  if (!out)
    return fail(
      "usage: node e2e/audio/safari-check.mjs --out <directory> [--driver <path>]"
    );
  if (!existsSync(driver)) {
    return fail(`safaridriver not found at ${driver} — this check fails, it never skips`);
  }
  const { startServer } = await import("./serve.mjs");
  const { compare, information } = await import("./compare.mjs");
  const table = JSON.parse(readFileSync(join(HERE, "expect.json"), "utf8"));
  mkdirSync(resolve(out), { recursive: true });

  const port = await freePort();
  const proc = spawn(driver, ["-p", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  let driverLog = "";
  proc.stdout.on("data", (d) => (driverLog += d));
  proc.stderr.on("data", (d) => (driverLog += d));
  const server = await startServer();
  const wd = `http://127.0.0.1:${port}`;
  const call = async (method, path, body, budgetMs) => {
    let res;
    try {
      res = await fetch(`${wd}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(budgetMs ? { signal: AbortSignal.timeout(budgetMs) } : {}),
      });
    } catch (e) {
      if (budgetMs && e?.name === "TimeoutError")
        throw new Error(`${method} ${path}: timed out after ${budgetMs / 1000} s`);
      throw e;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const v = json.value ?? {};
      throw new Error(
        `${method} ${path}: HTTP ${res.status} ${v.error ?? ""} ${v.message ?? ""}`.trim()
      );
    }
    return json.value;
  };
  let session;
  try {
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) {
      try {
        ready = (await call("GET", "/status"))?.ready !== undefined;
      } catch {
        await sleep(200);
      }
    }
    if (!ready)
      return fail(`safaridriver did not start on port ${port}: ${driverLog.trim()}`);
    let created;
    try {
      created = await call(
        "POST",
        "/session",
        { capabilities: { alwaysMatch: { browserName: "safari" } } },
        SESSION_BUDGET_MS
      );
    } catch (e) {
      return fail(noSessionMessage(e.message));
    }
    session = created.sessionId;
    const version = created.capabilities?.browserVersion;
    console.log(`safaridriver session created; Safari ${version}`);
    if (!safariVersionOk(version))
      return fail(`Safari ${version} is older than 18.4 (not claimed, D-3)`);

    const s = `/session/${session}`;
    await call("POST", `${s}/url`, { url: server.url });
    const exec = (script) => call("POST", `${s}/execute/sync`, { script, args: [] });
    for (
      let i = 0;
      i < 100 && (await exec("return window.__gateReady === true;")) !== true;
      i++
    ) {
      await sleep(100);
    }
    const el = await call("POST", `${s}/element`, {
      using: "css selector",
      value: "#start",
    });
    await call("POST", `${s}/element/${encodeURIComponent(el[ELEMENT])}/click`, {});
    const until = Date.now() + RUN_BUDGET_MS;
    while ((await exec("return window.__gateDone === true;")) !== true) {
      if (Date.now() > until)
        return fail(`the gate run did not finish within ${RUN_BUDGET_MS / 1000} s`);
      await sleep(1000);
    }
    const result = JSON.parse(await exec("return JSON.stringify(window.__gateResult);"));

    for (const [key, r] of Object.entries(result.recordings ?? {})) {
      if (!r.base64) continue;
      const bytes = Buffer.from(r.base64, "base64");
      const name = recordingName(version, r.mimeType ?? key);
      writeFileSync(join(out, name), bytes);
      console.log(
        `recording ${key}: ${name} ${bytes.length} bytes sha256 ${createHash("sha256").update(bytes).digest("hex")}`
      );
      delete r.base64;
    }
    writeFileSync(
      join(out, "safari-result.json"),
      JSON.stringify({ version, result }, null, 2)
    );
    console.log(`information: ${JSON.stringify(information(result))}`);
    const mismatches = compare(table, "safari", result);
    if (mismatches.length)
      return fail(
        `${mismatches.length} cell(s) of the safari column do not hold:\n  ${mismatches.join("\n  ")}`
      );
    console.log(
      `safari-check: PASS — every cell of the safari column holds (Safari ${version})`
    );
  } finally {
    if (session) await call("DELETE", `/session/${session}`).catch(() => undefined);
    proc.kill();
    await server.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => fail(e?.stack ?? String(e)));
}
