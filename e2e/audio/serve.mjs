#!/usr/bin/env node
/**
 * e2e/audio/serve.mjs — the browser-audio gate's page and files (TASK-234; DESIGN-56f1 §7.1, §9)
 *
 * Serves, on 127.0.0.1 only and every path under /audio-gate/:
 *   /audio-gate/                 the gate page (a Start button; the click is the gesture audio needs)
 *   /audio-gate/m/<module>.js    the SHIPPED modules platform/voice/{canonical-wav,browser-audio,
 *                                browser-recorder}.ts, transpiled with the repository's TypeScript
 *                                and loaded through an import map that resolves their
 *                                "@/platform/voice/…" imports
 *   /audio-gate/runner.mjs       the in-page gate logic (shared by the Playwright spec and Safari)
 *   /audio-gate/expect.json      the per-engine expectation table
 *   /audio-gate/fx/<name>        the committed fixtures (__tests__/fixtures/audio) and the ones
 *                                __tests__/fixtures/audio/generate.ts makes
 *
 * Used by e2e/audio/browser-audio.spec.ts and e2e/audio/safari-check.mjs (import startServer), or
 * from a terminal: `node e2e/audio/serve.mjs` prints the address. `--lan` is the alternative D-3
 * branch only (a pre-18.4 device on the local network): it needs HTTPS, because a page served as
 * http://<LAN address> is not a secure context and has no microphone API, so it refuses to start
 * without `--cert <file> --key <file>`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const FIXTURES = join(ROOT, "__tests__", "fixtures", "audio");
const MODULES = ["canonical-wav", "browser-audio", "browser-recorder"];
export const BASE = "/audio-gate/";

function transpile(file) {
  return ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true,
    },
    fileName: file,
  }).outputText;
}

/** The generated fixtures (and those derived from a committed one), made by generate.ts. */
async function generatedFixtures(committed) {
  const js = transpile(join(FIXTURES, "generate.ts"));
  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
  );
  const out = {};
  for (const [name, make] of Object.entries(mod.GENERATED_FIXTURES))
    out[name] = Buffer.from(make());
  for (const [name, make] of Object.entries(mod.DERIVED_FIXTURES))
    out[name] = Buffer.from(make(committed));
  return out;
}

function committedFixtures() {
  const out = {};
  for (const f of readdirSync(FIXTURES)) {
    if (f === "generate.ts" || f === "README.md" || f === "SHA256SUMS") continue;
    out[f] = readFileSync(join(FIXTURES, f));
  }
  return out;
}

function page() {
  const imports = Object.fromEntries(
    MODULES.map((m) => [`@/platform/voice/${m}`, `${BASE}m/${m}.js`])
  );
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Browser audio gate</title>
<script type="importmap">${JSON.stringify({ imports })}</script></head>
<body><main><h1>Browser audio gate</h1>
<p>Converts test audio with the shipped modules and compares every result with the table.</p>
<button id="start" type="button">Start</button><p id="status" role="status">waiting</p></main>
<script type="module">
import { runGate } from "${BASE}runner.mjs";
const status = document.getElementById("status");
document.getElementById("start").addEventListener("click", () => {
  status.textContent = "running";
  runGate({ base: "${BASE}" })
    .then((r) => { window.__gateResult = r; })
    .catch((e) => { window.__gateResult = { fatal: "runner threw: " + (e && e.stack || e) }; })
    .finally(() => { window.__gateDone = true; status.textContent = "done"; });
}, { once: true });
window.__gateReady = true;
</script></body></html>`;
}

/**
 * Starts the server. Resolves { url, close }. `lan` (with `cert` and `key`) listens on every
 * interface over HTTPS; otherwise 127.0.0.1 over HTTP.
 */
export async function startServer({ port = 0, lan = false, cert, key } = {}) {
  if (lan && (!cert || !key)) {
    throw new Error(
      "--lan needs --cert and --key: a page served as http://<LAN address> is not a secure context, so it has no microphone API"
    );
  }
  // A Map, not an object: a request for /audio-gate/constructor or /audio-gate/__proto__ must find
  // nothing (an object's inherited keys did, and the server crashed on them).
  const files = new Map();
  const add = (key, value) => files.set(key, value);
  const base = {
    "": { type: "text/html; charset=utf-8", body: Buffer.from(page()) },
    "runner.mjs": {
      type: "text/javascript",
      body: readFileSync(join(HERE, "runner.mjs")),
    },
    "expect.json": {
      type: "application/json",
      body: readFileSync(join(HERE, "expect.json")),
    },
  };
  for (const [k, v] of Object.entries(base)) add(k, v);
  for (const m of MODULES) {
    add(`m/${m}.js`, {
      type: "text/javascript",
      body: Buffer.from(transpile(join(ROOT, "platform", "voice", `${m}.ts`))),
    });
  }
  const committed = committedFixtures();
  const fixtures = { ...committed, ...(await generatedFixtures(committed)) };
  for (const [name, body] of Object.entries(fixtures)) {
    add(`fx/${name}`, { type: "application/octet-stream", body });
  }
  const handler = (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const file = path.startsWith(BASE) ? files.get(path.slice(BASE.length)) : undefined;
      if (req.method !== "GET" || !file) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": file.type,
        "content-length": file.body.length,
        "cache-control": "no-store",
      });
      res.end(file.body);
    } catch {
      // One bad request never stops the gate's server.
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("error");
    }
  };
  const server = lan
    ? createHttps({ cert: readFileSync(cert), key: readFileSync(key) }, handler)
    : createHttp(handler);
  const host = lan ? "0.0.0.0" : "127.0.0.1";
  await new Promise((r, j) => {
    server.once("error", j);
    server.listen(port, host, r);
  });
  const addr = server.address();
  const url = `${lan ? "https" : "http"}://${lan ? "<this Mac's LAN address>" : "127.0.0.1"}:${addr.port}${BASE}`;
  return {
    url,
    fixtureNames: Object.keys(fixtures).sort(),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  startServer({
    lan: process.argv.includes("--lan"),
    cert: arg("--cert"),
    key: arg("--key"),
    port: Number(arg("--port") ?? 0),
  }).then(
    (s) => console.log(`browser-audio gate: ${s.url}`),
    (e) => {
      console.error(String(e.message ?? e));
      process.exitCode = 1;
    }
  );
}
