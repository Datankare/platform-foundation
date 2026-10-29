/**
 * TASK-186 — scripts/check-model-ids.mjs: every MODEL_REGISTRY model resolves, is not retired,
 * and accepts the request the provider sends it. Run against a local server standing in for the
 * API: a missing, retired or request-refusing model fails the run, a deprecated one warns, the
 * key and response bodies are never printed, and without a key the check is skipped (exit 0) —
 * unless MODEL_CHECK_REQUIRED is "true", when it fails.
 */
import { execFileSync, spawn } from "child_process";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MODEL_REGISTRY } from "@/platform/ai/types";

const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "scripts/check-model-ids.mjs");
const KEY = "sk-test-model-check-not-a-real-key";
const SECRET_BODY = "BODY-MUST-NOT-BE-PRINTED";

function run(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [SCRIPT], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (out += d));
    child.on("close", (code: number | null) => resolve({ code, out }));
  });
}

interface Api {
  /** Extra fields of a model's answer, by ID; absent → 404. */
  models: Record<string, Record<string, unknown>>;
  /** Model IDs whose Messages call answers 400. */
  refuseMessages?: Set<string>;
}
interface Seen {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

function api(spec: Api, seen: Seen[] = []): Promise<Server> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      seen.push({ method: req.method ?? "", url: req.url ?? "", body });
      if (req.headers["x-api-key"] !== KEY) return res.writeHead(401).end("{}");
      if (req.method === "POST" && req.url === "/v1/messages") {
        const model = String(body?.model);
        if (spec.refuseMessages?.has(model)) {
          return res
            .writeHead(400)
            .end(JSON.stringify({ error: { message: SECRET_BODY } }));
        }
        return res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ content: [{ type: "text", text: SECRET_BODY }] }));
      }
      const id = decodeURIComponent((req.url ?? "").replace(/^\/v1\/models\//, ""));
      const model = spec.models[id];
      if (!model) {
        return res
          .writeHead(404)
          .end(JSON.stringify({ error: { message: `echo ${KEY}` } }));
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ id, type: "model", ...model }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const base = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
const ids = [...new Set(Object.values(MODEL_REGISTRY).map((m) => m.modelId))];
const all = (extra: Record<string, unknown> = {}) =>
  Object.fromEntries(ids.map((id) => [id, { ...extra }]));

async function withApi(spec: Api, env: Record<string, string> = {}, seen: Seen[] = []) {
  const server = await api(spec, seen);
  try {
    return await run({
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_BASE_URL: base(server),
      ...env,
    });
  } finally {
    server.close();
  }
}

/** Run one of the script's exports through node itself (it is an ES module). */
function exported(expr: string): unknown {
  const out = execFileSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `import * as m from ${JSON.stringify(SCRIPT)};
       import { readFileSync } from "node:fs";
       const src = readFileSync(process.argv[1], "utf8");
       console.log(JSON.stringify(${expr}));`,
      join(ROOT, "platform/ai/types.ts"),
    ],
    { encoding: "utf8" }
  );
  return JSON.parse(out);
}

describe("check-model-ids", () => {
  it("reads MODEL_REGISTRY's entries from types.ts exactly as the registry holds them", () => {
    const expected = Object.entries(MODEL_REGISTRY).map(([tier, c]) => ({
      tier,
      modelId: c.modelId,
      acceptsTemperature: c.acceptsTemperature,
      ...(c.thinking ? { thinking: c.thinking.type } : {}),
    }));
    expect(exported("m.registryEntries(src)")).toEqual(expected);
    expect(exported("m.registryModelIds(src)")).toEqual(ids);
  });

  it("probes each tier with the registry's own settings (thinking; temperature only when accepted)", () => {
    const probes = exported("m.registryEntries(src).map(m.probeRequest)") as Record<
      string,
      unknown
    >[];
    Object.values(MODEL_REGISTRY).forEach((c, i) => {
      expect(probes[i]).toMatchObject({ model: c.modelId, max_tokens: 1 });
      if (c.thinking) expect(probes[i].thinking).toEqual(c.thinking);
      else expect(probes[i]).not.toHaveProperty("thinking");
      if (c.acceptsTemperature) expect(probes[i]).toHaveProperty("temperature");
      else expect(probes[i]).not.toHaveProperty("temperature");
    });
  });

  it("passes when every model resolves and accepts its request; a valid retires_at is printed", async () => {
    const seen: Seen[] = [];
    const r = await withApi(
      { models: all({ retires_at: "2027-10-07T00:00:00Z" }) },
      {},
      seen
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("every registry model resolves and accepts its request");
    expect(r.out).toContain("retires at 2027-10-07T00:00:00Z");
    expect(seen.filter((q) => q.method === "GET").map((q) => q.url)).toEqual(
      ids.map((id) => `/v1/models/${id}`)
    );
    expect(seen.filter((q) => q.method === "POST").map((q) => q.body?.model)).toEqual(
      Object.values(MODEL_REGISTRY).map((c) => c.modelId)
    );
    expect(r.out).not.toContain(KEY);
    expect(r.out).not.toContain(SECRET_BODY);
  });

  it("does not print a retires_at that is not an ISO date", async () => {
    const r = await withApi({ models: all({ retires_at: "::error::forged\nsoon" }) });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("retires at");
    expect(r.out).not.toContain("forged");
  });

  it("fails when one ID does not resolve, naming it, never printing the key or the body", async () => {
    const [first, ...rest] = ids;
    const r = await withApi({ models: Object.fromEntries(rest.map((id) => [id, {}])) });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`::error::${first} does not resolve (HTTP 404)`);
    expect(r.out).not.toContain(KEY);
  });

  it("fails on a model the API reports retired", async () => {
    const r = await withApi({ models: { ...all(), [ids[0]]: { lifecycle: "retired" } } });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`::error::${ids[0]} is retired`);
  });

  it("warns, and passes, on a deprecated model (lifecycle or deprecated_at)", async () => {
    const a = await withApi({
      models: { ...all(), [ids[0]]: { lifecycle: "deprecated" } },
    });
    expect(a.code).toBe(0);
    expect(a.out).toContain(`::warning::${ids[0]} is deprecated`);
    const b = await withApi({
      models: { ...all(), [ids[0]]: { deprecated_at: "2026-10-01T00:00:00Z" } },
    });
    expect(b.code).toBe(0);
    expect(b.out).toContain(`::warning::${ids[0]} is deprecated`);
  });

  it("fails when a model refuses the platform's request shape, printing only the status", async () => {
    const standard = MODEL_REGISTRY.standard.modelId;
    const r = await withApi({ models: all(), refuseMessages: new Set([standard]) });
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      `::error::standard: ${standard} refused the platform's request (HTTP 400)`
    );
    expect(r.out).not.toContain(SECRET_BODY);
  });

  it("fails when the API cannot be reached", async () => {
    const r = await run({
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("unreachable");
  });

  it("skips with a notice and a step summary, and passes, without a key", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "model-check-")), "summary.md");
    const r = await run({ GITHUB_STEP_SUMMARY: file });
    expect(r.code).toBe(0);
    expect(r.out).toContain("::notice::ANTHROPIC_API_KEY is not set");
    expect(readFileSync(file, "utf8")).toContain("Model registry check: skipped");
  });

  it("fails without a key when MODEL_CHECK_REQUIRED is true", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "model-check-")), "summary.md");
    const r = await run({ MODEL_CHECK_REQUIRED: "true", GITHUB_STEP_SUMMARY: file });
    expect(r.code).toBe(1);
    expect(r.out).toContain("::error::ANTHROPIC_API_KEY is not set");
    expect(readFileSync(file, "utf8")).toContain("MODEL_CHECK_REQUIRED is true");
  });

  it("the workflow passes the variable through env and runs on a registry change", () => {
    const wf = readFileSync(
      join(ROOT, ".github/workflows/model-registry-check.yml"),
      "utf8"
    );
    expect(wf).toMatch(/MODEL_CHECK_REQUIRED: \$\{\{ vars\.MODEL_CHECK_REQUIRED \}\}/);
    expect(wf).toMatch(/pull_request:\n\s+paths:\n\s+- platform\/ai\/types\.ts/);
    expect(wf).not.toMatch(/^\s*pull_request_target:/m);
  });
});
