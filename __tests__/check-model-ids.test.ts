/**
 * TASK-186 — scripts/check-model-ids.mjs: every MODEL_REGISTRY model resolves, is not retired,
 * and accepts the request the provider sends it. Run against a local server standing in for the
 * API: a missing, retired, deprecated (TASK-197) or soon-retiring or request-refusing model fails
 * the run, a Google voice no longer offered fails it (TASK-197), the
 * key and response bodies are never printed, and without a key the check is skipped (exit 0) —
 * unless MODEL_CHECK_REQUIRED is "true", when it fails.
 */
import { execFileSync, spawn } from "child_process";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MODEL_REGISTRY } from "@/platform/ai/types";

const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "scripts/check-model-ids.mjs");
const KEY = "sk-test-model-check-not-a-real-key";
const SECRET_BODY = "BODY-MUST-NOT-BE-PRINTED";
const NO_WORKFLOWS = mkdtempSync(join(tmpdir(), "model-check-wf-"));

function run(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [SCRIPT], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        // The repository's own workflows are checked in their own tests (TASK-197, below).
        MODEL_CHECK_WORKFLOWS_DIR: NO_WORKFLOWS,
        // No test reads an action's real source from GitHub: unreadable unless a test serves it.
        MODEL_CHECK_ACTION_SOURCE_BASE: "http://127.0.0.1:9",
        MODEL_CHECK_ACTION_API_BASE: "http://127.0.0.1:9",
        ...env,
      } as unknown as NodeJS.ProcessEnv,
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
       console.log(JSON.stringify(await (${expr})));`,
      join(ROOT, "platform/ai/types.ts"),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MODEL_CHECK_ACTION_SOURCE_BASE: "http://127.0.0.1:9",
        MODEL_CHECK_ACTION_API_BASE: "http://127.0.0.1:9",
      },
    }
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

  it("passes when every model resolves and accepts its request; a distant retires_at is printed", async () => {
    const seen: Seen[] = [];
    const distant = new Date(Date.now() + 200 * 86_400_000).toISOString();
    const r = await withApi({ models: all({ retires_at: distant }) }, {}, seen);
    expect(r.code).toBe(0);
    expect(r.out).toContain("every registry model resolves and accepts its request");
    expect(r.out).toContain(`retires at ${distant}`);
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

  // TASK-197 (audit D-3): this test asserted the defect — a deprecated model only warned, in a
  // weekly scheduled run whose warnings notify nobody, so a retirement arrived with no lead time.
  // A deprecated model now fails the run (a failed scheduled run notifies).
  it("fails on a deprecated model (lifecycle or deprecated_at)", async () => {
    const a = await withApi({
      models: { ...all(), [ids[0]]: { lifecycle: "deprecated" } },
    });
    expect(a.code).toBe(1);
    expect(a.out).toContain(`::error::${ids[0]} is deprecated`);
    const b = await withApi({
      models: { ...all(), [ids[0]]: { deprecated_at: "2026-10-01T00:00:00Z" } },
    });
    expect(b.code).toBe(1);
    expect(b.out).toContain(`::error::${ids[0]} is deprecated`);
  });

  it("fails on a model that retires within the lead time (default 30 days, configurable), or is past it", async () => {
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const a = await withApi({ models: { ...all(), [ids[0]]: { retires_at: soon } } });
    expect(a.code).toBe(1);
    expect(a.out).toContain(`::error::${ids[0]} retires at ${soon}, within 30 days`);
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect(
      (await withApi({ models: { ...all(), [ids[0]]: { retires_at: past } } })).code
    ).toBe(1);
    const b = await withApi(
      { models: { ...all(), [ids[0]]: { retires_at: soon } } },
      { MODEL_RETIRE_LEAD_DAYS: "5" }
    );
    expect(b.code).toBe(0);
    expect(
      (await withApi({ models: all() }, { MODEL_RETIRE_LEAD_DAYS: "soon" })).code
    ).toBe(1);
    // An unset repository variable arrives as "": the default, not zero days.
    expect(
      (
        await withApi(
          { models: { ...all(), [ids[0]]: { retires_at: soon } } },
          { MODEL_RETIRE_LEAD_DAYS: "" }
        )
      ).code
    ).toBe(1);
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

  describe("Google voices (TASK-197, audit D-3)", () => {
    const voices = exported(
      `[...new Set([...m.voiceNames(src), ...m.voiceNames(readFileSync(${JSON.stringify(
        join(ROOT, "platform/voice/voices.ts")
      )}, "utf8"))])]`
    ) as string[];

    function google(offered: string[], status = 200): Promise<Server> {
      const server = createServer((req, res) => {
        if (req.headers["x-goog-api-key"] !== "g-key")
          return res.writeHead(403).end("{}");
        res
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify({ voices: offered.map((name) => ({ name })) }));
      });
      return new Promise((resolve) =>
        server.listen(0, "127.0.0.1", () => resolve(server))
      );
    }

    async function withGoogle(offered: string[], status = 200, key = "g-key") {
      const g = await google(offered, status);
      try {
        return await withApi(
          { models: all() },
          { GOOGLE_API_KEY: key, GOOGLE_TTS_BASE_URL: base(g) }
        );
      } finally {
        g.close();
      }
    }

    it("reads the voices the platform names", () => {
      expect(voices).toContain("en-US-Neural2-F");
    });

    it("passes when every named voice is offered", async () => {
      const r = await withGoogle(voices);
      expect(r.code).toBe(0);
      expect(r.out).toContain(
        `ok ${voices.length}/${voices.length} Google voices offered`
      );
    });

    it("fails, naming it, when a voice is withdrawn — and never prints the key", async () => {
      const r = await withGoogle(voices.filter((v) => v !== "en-US-Neural2-F"));
      expect(r.code).toBe(1);
      expect(r.out).toContain(
        "::error::Google voice en-US-Neural2-F is no longer offered"
      );
      expect(r.out).not.toContain("g-key");
    });

    it("fails when the key is refused", async () => {
      const r = await withGoogle(voices, 200, "wrong");
      expect(r.code).toBe(1);
      expect(r.out).toContain("Google voices could not be listed (HTTP 403)");
    });

    it("says what it cannot check (speech-to-text) and skips without a key", async () => {
      const r = await withApi({ models: all() });
      expect(r.code).toBe(0);
      expect(r.out).toContain("latest_long is not checked");
      expect(r.out).toContain("::notice::GOOGLE_API_KEY is not set");
    });
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

describe("the workflows' models and the pinned actions' (TASK-197, the 2026-10-28 incident)", () => {
  function workflows(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "model-check-wf-"));
    for (const [name, text] of Object.entries(files))
      writeFileSync(join(dir, name), text);
    return dir;
  }
  const standard = MODEL_REGISTRY.standard.modelId;

  it("passes a workflow that names a registry model", async () => {
    const dir = workflows({
      "a.yml": `jobs:\n  x:\n    steps:\n      - uses: some/action@abc\n        with:\n          claude-model: ${standard}\n`,
    });
    const r = await withApi({ models: all() }, { MODEL_CHECK_WORKFLOWS_DIR: dir });
    expect(r.code).toBe(0);
  });

  it("fails a workflow model that is not a registry model, with or without a key", async () => {
    const dir = workflows({
      "a.yml": "    with:\n      claude-model: claude-opus-4-1-20250805\n",
      "b.yml": '      run: claude --model "claude-3-5-haiku-20241022" -p x\n',
    });
    const r = await withApi({ models: all() }, { MODEL_CHECK_WORKFLOWS_DIR: dir });
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "a.yml:2 names claude-opus-4-1-20250805, which is not a MODEL_REGISTRY model"
    );
    expect(r.out).toContain("b.yml:1 names claude-3-5-haiku-20241022");
    const keyless = await run({ MODEL_CHECK_WORKFLOWS_DIR: dir });
    expect(keyless.code).toBe(1);
  });

  const pinned = () =>
    workflows({
      "security-review.yml":
        "      - uses: anthropics/claude-code-security-review@0c6a49f1fa56a1d472575da86a94dbc1edb78eda # main\n",
    });

  it("the pinned security-review action's retired validation model: a loud warning until its review-by date", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "model-check-")), "summary.md");
    const r = await run({
      MODEL_CHECK_WORKFLOWS_DIR: pinned(),
      MODEL_CHECK_NOW: "2026-12-31T12:00:00Z",
      GITHUB_STEP_SUMMARY: file,
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "::warning::security-review.yml: the pinned security-review action validates with a retired model; its false-positive filter is disabled"
    );
    expect(r.out).toContain("claude-3-5-haiku-20241022");
    expect(r.out).toContain("degraded: the action's false-positive filter is off");
    expect(r.out).toContain("upstream: anthropics/claude-code-security-review");
    expect(r.out).toContain("a documented exception until 2026-12-31");
    expect(r.out).not.toContain("::error::");
    expect(readFileSync(file, "utf8")).toContain("⚠ security-review.yml");
  });

  it("…and fails after it", async () => {
    const r = await run({
      MODEL_CHECK_WORKFLOWS_DIR: pinned(),
      MODEL_CHECK_NOW: "2027-01-01T00:00:01Z",
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "::error::security-review.yml: the pinned security-review action validates with a retired model"
    );
    expect(r.out).toContain("its review-by date 2026-12-31 has passed");
  });

  /**
   * Serve an action's source at refs: { "<ref>": "<recorded file's text>" }, and its file list
   * (round 2) with `extra` files: { "<path>": "<text>" } — no list when `extra` is null.
   */
  const treeAuth: string[] = [];
  function actionSourceServer(
    files: Record<string, string>,
    extra: Record<string, string> | null = {}
  ): Promise<Server> {
    const RECORDED = "claudecode/claude_api_client.py";
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      const tree = url.match(
        /^\/repos\/anthropics\/claude-code-security-review\/git\/trees\/([^/?]+)/
      );
      if (tree) {
        treeAuth.push(String(req.headers.authorization ?? ""));
        if (extra === null || files[tree[1]] === undefined)
          return res.writeHead(404).end("");
        return res.writeHead(200).end(
          JSON.stringify({
            tree: [RECORDED, "README.md", ...Object.keys(extra)].map((path) => ({
              path,
              type: "blob",
            })),
          })
        );
      }
      const m = url.match(/^\/anthropics\/claude-code-security-review\/([^/]+)\/(.+)$/);
      const text = !m
        ? undefined
        : m[2] === RECORDED
          ? files[m[1]]
          : files[m[1]] !== undefined
            ? extra?.[m[2]]
            : undefined;
      if (text === undefined) return res.writeHead(404).end("");
      res.writeHead(200).end(text);
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
  }
  const repinned = (ref: string) =>
    workflows({
      "security-review.yml": `      - uses: anthropics/claude-code-security-review@${ref}\n`,
    });
  async function withSource(
    ref: string,
    files: Record<string, string>,
    extra: Record<string, string> | null = {},
    env: Record<string, string> = {}
  ) {
    const server = await actionSourceServer(files, extra);
    try {
      return await run({
        ...env,
        MODEL_CHECK_WORKFLOWS_DIR: repinned(ref),
        MODEL_CHECK_NOW: "2026-11-01T00:00:00Z",
        MODEL_CHECK_ACTION_SOURCE_BASE: base(server),
        MODEL_CHECK_ACTION_API_BASE: base(server),
      });
    } finally {
      server.close();
    }
  }
  const NEW = "1".repeat(40);

  it("re-pinned: the exception follows the action, re-verified in its source at the new ref (L2)", async () => {
    const still = await withSource(NEW, {
      [NEW]: '            model="claude-3-5-haiku-20241022",\n',
    });
    expect(still.code).toBe(0);
    expect(still.out).toContain(
      `claude-code-security-review@${NEW} hard-codes claude-3-5-haiku-20241022`
    );
    const gone = await withSource(NEW, { [NEW]: "model=self.model\n" });
    expect(gone.code).toBe(0);
    expect(gone.out).toContain("no longer hard-codes claude-3-5-haiku-20241022");
    const other = await withSource(NEW, { [NEW]: 'model="claude-2.1"\n' });
    expect(other.code).toBe(1);
    expect(other.out).toContain("hard-codes claude-2.1");
    const unreadable = await withSource(NEW, {});
    expect(unreadable.code).toBe(1);
    expect(unreadable.out).toContain("unverifiable");
  });

  // Round 2: every source file of the action at the pin, not only the one recorded.
  it("scans every source file of the action at the pinned ref; says when it could not", async () => {
    const haiku = '            model="claude-3-5-haiku-20241022",\n';
    const elsewhere = await withSource(
      NEW,
      { [NEW]: haiku },
      { "claudecode/findings_filter.py": 'MODEL = "claude-instant-1.2"\n' }
    );
    expect(elsewhere.code).toBe(1);
    expect(elsewhere.out).toContain(
      "hard-codes claude-instant-1.2 in claudecode/findings_filter.py"
    );
    const clean = await withSource(
      NEW,
      { [NEW]: haiku },
      { "claudecode/other.py": "x = 1\n" }
    );
    expect(clean.code).toBe(0);
    expect(clean.out).not.toContain("only claudecode/claude_api_client.py was scanned");
    // Round 3 (N5): the file list is asked for with GITHUB_TOKEN when it is set.
    treeAuth.length = 0;
    await withSource(NEW, { [NEW]: haiku }, {}, { GITHUB_TOKEN: "ghs_test" });
    expect(treeAuth).toEqual(["Bearer ghs_test"]);
    const noList = await withSource(NEW, { [NEW]: haiku }, null);
    expect(noList.code).toBe(0);
    expect(noList.out).toContain(
      "its file list could not be read — only claudecode/claude_api_client.py was scanned"
    );
  });

  it("a model set from an expression or a variable is an unverifiable model reference (L3)", async () => {
    const dir = workflows({
      "a.yml":
        "    with:\n      claude-model: ${{ vars.CLAUDE_MODEL }}\n    env:\n      CLAUDE_MODEL: ${{ secrets.M }}\n      MODEL_CHECK_REQUIRED: ${{ vars.MODEL_CHECK_REQUIRED }}\n",
      "b.yml": "      run: claude --model $MODEL -p x\n",
    });
    const r = await run({ MODEL_CHECK_WORKFLOWS_DIR: dir });
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "a.yml:2 sets a model from ${{ vars.CLAUDE_MODEL }}: an unverifiable model reference"
    );
    expect(r.out).toContain("a.yml:4 sets a model from ${{ secrets.M }}");
    expect(r.out).not.toContain("a.yml:5");
    expect(r.out).toContain("b.yml:1 sets a model from $MODEL");
  });

  it("a review-by date must be a real calendar day (no rollover)", () => {
    expect(
      exported('["2026-12-31","2026-02-31","2026-13-01","x"].map(m.isCalendarDate)')
    ).toEqual([true, false, false, false]);
  });

  it("this repository: every model its workflows name is a registry model; the known exception is a warning before its date", () => {
    const { problems, warnings } = exported(
      `m.workflowProblems(${JSON.stringify(join(ROOT, ".github/workflows"))}, m.registryModelIds(src), Date.parse("2026-11-01T00:00:00Z"))`
    ) as { problems: string[]; warnings: string[] };
    expect(problems).toEqual([]);
    expect(warnings.filter((p) => /validates with a retired model/.test(p)).length).toBe(
      1
    );
  });
});
