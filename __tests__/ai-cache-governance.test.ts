/**
 * TASK-186 — prompt caching after review: the governed gate, cache tokens in persistent metrics,
 * and every cost-recording caller billing the whole usage.
 *
 *   - ai.prompt_cache_enabled (default off) and the request's promptCache must both be true;
 *     a setting that cannot be read is off.
 *   - obs.metrics.record carries cacheReadTokens and cacheWriteTokens (ai_metrics.values is
 *     jsonb: no column), and MetricsSummary reports the prompt's total, not input_tokens alone.
 *   - Each agent / classifier that prices its own call passes response.usage, so cache tokens
 *     are billed (the class of the #462 defect: nine callers dropped them).
 */

const getConfigBoolean = jest.fn();
jest.mock("@/platform/auth/platform-config", () => ({
  getConfigBoolean: (...a: unknown[]) => getConfigBoolean(...a),
}));

const record = jest.fn();
jest.mock("@/platform/observability", () => ({
  tryGetObservability: () => ({
    metrics: { record },
    errors: { captureMessage: jest.fn() },
  }),
}));

import { existsSync, readdirSync, readFileSync } from "fs";
import { join, relative } from "path";
import * as ts from "typescript";
import {
  AIProviderError,
  AIRefusalError,
  isAIRefusalError,
  MAX_REFUSAL_TOKENS,
  refusalUsage,
} from "@/platform/ai/provider";
import { buildAICacheKey } from "@/platform/cache/ai-cache";
import { createOrchestrator, PROMPT_CACHE_SETTING } from "@/platform/ai/orchestrator";
import {
  clearMetrics,
  estimateCost,
  summarizeMetrics,
} from "@/platform/ai/instrumentation";
import type {
  AICallMetrics,
  AIProvider,
  AIRequest,
  AIResponse,
} from "@/platform/ai/types";

const USAGE = {
  inputTokens: 40,
  outputTokens: 10,
  cacheReadTokens: 3_000,
  cacheWriteTokens: 500,
};

function provider(): AIProvider & { complete: jest.Mock } {
  const response: AIResponse = {
    content: [{ type: "text", text: "ok" }],
    model: "claude-sonnet-5-5",
    usage: USAGE,
    stopReason: "end_turn",
  };
  return {
    name: "mock",
    capabilities: { inputs: ["text"], outputs: ["text"] },
    complete: jest.fn().mockResolvedValue(response),
  };
}

const CACHED: AIRequest = {
  tier: "standard",
  cacheablePrefix: "fixed instructions",
  system: "per tenant",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 64,
  promptCache: true,
};
const OPTS = { useCase: "test", requestId: "r-1" };

beforeEach(() => {
  getConfigBoolean.mockReset();
  record.mockReset();
  clearMetrics();
});

describe("the prompt-cache gate", () => {
  it("setting off (its default): the provider never sees promptCache on", async () => {
    getConfigBoolean.mockImplementation(async (_k: string, d: boolean) => d);
    const p = provider();
    await createOrchestrator({ provider: p }).complete(CACHED, OPTS);
    expect(getConfigBoolean).toHaveBeenCalledWith(PROMPT_CACHE_SETTING, false);
    expect(PROMPT_CACHE_SETTING).toBe("ai.prompt_cache_enabled");
    expect(p.complete.mock.calls[0][0].promptCache).toBe(false);
  });

  it("setting on and the flag on: the request keeps it", async () => {
    getConfigBoolean.mockResolvedValue(true);
    const p = provider();
    await createOrchestrator({ provider: p }).complete(CACHED, OPTS);
    expect(p.complete.mock.calls[0][0].promptCache).toBe(true);
  });

  it("setting on, flag absent: off, and the setting is not even read", async () => {
    getConfigBoolean.mockResolvedValue(true);
    const p = provider();
    const { promptCache: _drop, ...plain } = CACHED;
    void _drop;
    await createOrchestrator({ provider: p }).complete(plain, OPTS);
    expect(getConfigBoolean).not.toHaveBeenCalled();
    expect(p.complete.mock.calls[0][0].promptCache).toBeUndefined();
  });

  it("an unreadable setting is off", async () => {
    getConfigBoolean.mockRejectedValue(new Error("db down"));
    const p = provider();
    await createOrchestrator({ provider: p }).complete(CACHED, OPTS);
    expect(p.complete.mock.calls[0][0].promptCache).toBe(false);
  });

  it("a non-boolean stored value is not taken as on", async () => {
    getConfigBoolean.mockResolvedValue("yes" as unknown as boolean);
    const p = provider();
    await createOrchestrator({ provider: p }).complete(CACHED, OPTS);
    expect(p.complete.mock.calls[0][0].promptCache).toBe(false);
  });
});

describe("cache tokens reach persistent metrics", () => {
  it("obs.metrics.record values carry both cache counts, and the cost bills them", async () => {
    getConfigBoolean.mockResolvedValue(false);
    await createOrchestrator({ provider: provider() }).complete(CACHED, OPTS);
    const event = record.mock.calls[0][0];
    expect(event.values).toMatchObject({
      inputTokens: 40,
      outputTokens: 10,
      cacheReadTokens: 3_000,
      cacheWriteTokens: 500,
      estimatedCostUsd: estimateCost("standard", USAGE),
    });
  });

  it("a call without cache usage records zeros, not missing values", async () => {
    const p = provider();
    p.complete.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      model: "m",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    });
    await createOrchestrator({ provider: p }).complete(
      { ...CACHED, promptCache: false },
      OPTS
    );
    expect(record.mock.calls[0][0].values).toMatchObject({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("MetricsSummary reports cache tokens and the prompt's total", () => {
    const m = (over: Partial<AICallMetrics>): AICallMetrics => ({
      useCase: "u",
      requestId: "r",
      cached: false,
      model: "m",
      tier: "standard",
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      latencyMs: 1,
      success: true,
      timestamp: new Date().toISOString(),
      ...over,
    });
    const s = summarizeMetrics([
      m({ inputTokens: 10, cacheReadTokens: 1_000, cacheWriteTokens: 200 }),
      m({ inputTokens: 5 }),
    ]);
    expect(s.totalInputTokens).toBe(15);
    expect(s.totalCacheReadTokens).toBe(1_000);
    expect(s.totalCacheWriteTokens).toBe(200);
    expect(s.totalPromptTokens).toBe(1_215);
    expect(summarizeMetrics([]).totalPromptTokens).toBe(0);
  });
});

describe("every caller that prices its own call passes the whole usage", () => {
  // The class of #462's defect: a caller passing input and output alone dropped the cache.
  // estimateCost(tier, usage) makes a token-count call a type error; this finds every call in
  // the source mechanically and refuses a hand-built usage that leaves the cache counts out.
  const ROOT = join(__dirname, "..");
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        return e.name === "__tests__" ||
          e.name === "node_modules" ||
          e.name.startsWith(".")
          ? []
          : sources(p);
      }
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });
  }
  const calls = ["platform", "app", "lib", "prompts"]
    .flatMap((d) => (existsSync(join(ROOT, d)) ? sources(join(ROOT, d)) : []))
    .flatMap((file) => {
      const text = readFileSync(file, "utf8");
      if (!text.includes("estimateCost(")) return [];
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const found: { file: string; line: number; node: ts.CallExpression }[] = [];
      const visit = (n: ts.Node) => {
        if (
          ts.isCallExpression(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === "estimateCost"
        ) {
          found.push({
            file: relative(ROOT, file),
            line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
            node: n,
          });
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
      return found;
    });

  it("finds the known callers (self-test)", () => {
    const files = new Set(calls.map((c) => c.file));
    for (const f of [
      "platform/social/agents/gatekeeper.ts",
      "platform/moderation/classifier.ts",
      "platform/input/agent-intent.ts",
      "platform/adaptive/loop.ts",
      "platform/ai/orchestrator.ts",
      "platform/cache/ai-cache.ts",
      "platform/content/loop.ts",
    ]) {
      expect(files).toContain(f);
    }
  });

  it("each call passes a tier and a usage; a usage built by hand names both cache counts", () => {
    const bad = calls.flatMap(({ file, line, node }) => {
      const where = `${file}:${line}`;
      if (node.arguments.length !== 2)
        return [`${where}: ${node.arguments.length} arguments`];
      const usage = node.arguments[1];
      if (ts.isObjectLiteralExpression(usage)) {
        const names = usage.properties.map((p) => p.name?.getText() ?? "");
        const missing = ["cacheReadTokens", "cacheWriteTokens"].filter(
          (k) => !names.includes(k)
        );
        return missing.length > 0
          ? [`${where}: usage without ${missing.join(", ")}`]
          : [];
      }
      return [];
    });
    expect(bad).toEqual([]);
  });
});

describe("a refusal is billed: its usage reaches the failure metrics (TASK-186 review)", () => {
  const BILLED = {
    inputTokens: 900,
    outputTokens: 3,
    cacheReadTokens: 100,
    cacheWriteTokens: 0,
  };

  it("complete(): the refusal's tokens and cost are recorded, not 0", async () => {
    const p = provider();
    p.complete.mockRejectedValue(new AIRefusalError(BILLED, "claude-sonnet-5-5"));
    await expect(
      createOrchestrator({ provider: p }).complete(
        { ...CACHED, promptCache: false },
        OPTS
      )
    ).rejects.toBeInstanceOf(AIRefusalError);
    expect(record.mock.calls[0][0].values).toMatchObject({
      inputTokens: 900,
      outputTokens: 3,
      cacheReadTokens: 100,
      estimatedCostUsd: estimateCost("standard", BILLED),
      success: 0,
    });
    expect(record.mock.calls[0][0].tags.model).toBe("claude-sonnet-5-5");
  });

  it("stream(): the same", async () => {
    const p: AIProvider = {
      ...provider(),
      stream: async function* () {
        throw new AIRefusalError(BILLED, "claude-sonnet-5-5");
      },
    };
    const drain = async () => {
      for await (const chunk of createOrchestrator({ provider: p }).stream(
        { ...CACHED, promptCache: false },
        OPTS
      )) {
        void chunk;
      }
    };
    await expect(drain()).rejects.toBeInstanceOf(AIRefusalError);
    expect(record.mock.calls[0][0].values).toMatchObject({
      inputTokens: 900,
      estimatedCostUsd: estimateCost("standard", BILLED),
    });
  });

  it("any other failure still records none", async () => {
    const p = provider();
    p.complete.mockRejectedValue(new Error("down"));
    await expect(
      createOrchestrator({ provider: p }).complete(CACHED, OPTS)
    ).rejects.toThrow();
    expect(record.mock.calls[0][0].values).toMatchObject({
      inputTokens: 0,
      estimatedCostUsd: 0,
    });
  });
});

describe("isAIRefusalError", () => {
  it("accepts an AIRefusalError from another bundled copy of the module (ADR-032)", () => {
    // A class of the same shape, as a second bundle's copy of provider.ts would define it.
    class ForeignProviderError extends Error {
      constructor(
        message: string,
        readonly kind: string
      ) {
        super(message);
      }
    }
    class ForeignRefusal extends ForeignProviderError {
      readonly usage = { inputTokens: 7, outputTokens: 1 };
      constructor() {
        super("declined", "permanent");
        this.name = "AIRefusalError";
      }
    }
    const foreign = new ForeignRefusal();
    expect(foreign instanceof AIRefusalError).toBe(false);
    expect(isAIRefusalError(foreign)).toBe(true);
    expect(refusalUsage(foreign)).toEqual({
      inputTokens: 7,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("refuses look-alikes: another name, another kind, a plain object", () => {
    const named = Object.assign(new Error("x"), {
      name: "AIRefusalError",
      kind: "transient",
    });
    expect(isAIRefusalError(named)).toBe(false);
    expect(isAIRefusalError(Object.assign(new Error("x"), { kind: "permanent" }))).toBe(
      false
    );
    expect(isAIRefusalError({ name: "AIRefusalError", kind: "permanent" })).toBe(false);
    expect(isAIRefusalError(new AIProviderError("x", "permanent"))).toBe(false);
    expect(isAIRefusalError(new AIRefusalError())).toBe(true);
  });

  it("a huge count is capped, so the recorded cost stays finite", () => {
    const e = Object.assign(new AIRefusalError(), {
      usage: { inputTokens: Number.MAX_VALUE, outputTokens: 1e300, cacheReadTokens: 2.5 },
    });
    const u = refusalUsage(e)!;
    expect(u).toEqual({
      inputTokens: MAX_REFUSAL_TOKENS,
      outputTokens: MAX_REFUSAL_TOKENS,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
    });
    expect(Number.isFinite(estimateCost("standard", u))).toBe(true);
  });

  it("hostile usage on a refusal is read as numbers or 0", () => {
    const e = Object.assign(new AIRefusalError(), {
      usage: { inputTokens: -5, outputTokens: "9", cacheReadTokens: Infinity },
    });
    expect(refusalUsage(e)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("every route and module that checks for a refusal uses the helper, not instanceof", () => {
    const ROOT = join(__dirname, "..");
    const offenders = ["app", "platform", "lib"].flatMap((d) =>
      walk(join(ROOT, d))
        .filter((f) => !f.endsWith("platform/ai/provider.ts"))
        .filter((f) => /instanceof AIRefusalError/.test(readFileSync(f, "utf8")))
        .map((f) => relative(ROOT, f))
    );
    expect(offenders).toEqual([]);
  });
});

describe("the model registry is the only source of a model ID", () => {
  it("no source file outside platform/ai/types.ts names a claude- model ID", () => {
    const ROOT = join(__dirname, "..");
    const offenders = ["app", "lib", "platform", "components", "hooks", "prompts"]
      .flatMap((d) => walk(join(ROOT, d)))
      .filter((f) => !f.endsWith("platform/ai/types.ts"))
      .filter((f) => /["'`]claude-[a-z]+-\d/.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});

describe("the AI response cache key", () => {
  const BASE: AIRequest = {
    tier: "fast",
    system: "s",
    cacheablePrefix: "fixed",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 10,
    tools: [{ name: "t", description: "d", input_schema: {} }],
    temperature: 0,
    promptCache: false,
  };
  /**
   * Every AIRequest field, and a different value for it. A field that shapes the response must
   * change the key; one that does not (promptCache: billing only) is listed in NOT_IN_KEY.
   */
  const VARIANT: Record<keyof AIRequest, unknown> = {
    tier: "standard",
    system: "other",
    cacheablePrefix: "other fixed",
    messages: [{ role: "user", content: "bye" }],
    maxTokens: 11,
    tools: [{ name: "u", description: "d", input_schema: {} }],
    temperature: 0.5,
    promptCache: true,
  };
  const NOT_IN_KEY = new Set<string>(["promptCache"]);

  it("covers every AIRequest field (a new field must be placed in the key or listed out)", () => {
    const source = readFileSync(join(__dirname, "../platform/ai/types.ts"), "utf8");
    const body = source.slice(
      source.indexOf("export interface AIRequest {"),
      source.indexOf("\n}", source.indexOf("export interface AIRequest {"))
    );
    const fields = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
    expect(fields.sort()).toEqual(Object.keys(VARIANT).sort());
  });

  it.each(Object.keys(VARIANT) as (keyof AIRequest)[])("%s", (field) => {
    const changed = { ...BASE, [field]: VARIANT[field] } as AIRequest;
    const same = buildAICacheKey(changed) === buildAICacheKey(BASE);
    expect(same).toBe(NOT_IN_KEY.has(field));
  });
});

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      return e.name === "__tests__" || e.name === "node_modules" || e.name.startsWith(".")
        ? []
        : walk(p);
    }
    return /\.(?:ts|tsx|mjs|cjs|js)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)
      ? [p]
      : [];
  });
}
