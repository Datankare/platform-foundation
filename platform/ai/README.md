# platform/ai/

LLM orchestration layer — GenAI as infrastructure, not a feature (ADR-015).

## Architecture

```
platform/ai/
  ├── types.ts             — Core types: ModelTier, AIRequest/Response, AIProvider interface
  ├── provider.ts          — Provider implementations (Anthropic primary)
  ├── orchestrator.ts      — Model tiering, circuit breaker, retry, instrumentation
  ├── instrumentation.ts   — Per-call metrics: model, tokens, latency, cost
  └── index.ts             — Public API (barrel exports)
```

## Usage

```typescript
import { getOrchestrator } from "@/platform/ai";

const response = await getOrchestrator().complete(
  {
    tier: "fast", // Haiku — cheap, fast
    system: "You are a safety classifier.",
    messages: [{ role: "user", content: "Check this text" }],
    maxTokens: 64,
  },
  {
    useCase: "safety-classify", // Instrumentation label
    requestId: "abc123", // Trace correlation
  }
);
```

## Model Tiering

| Tier       | Model      | Use Case                                    |
| ---------- | ---------- | ------------------------------------------- |
| `fast`     | Haiku 4.5  | Safety classification, simple extraction    |
| `standard` | Sonnet 5.5 | Admin command bar, complex reasoning, tools |

Per-model request settings (`ModelConfig` in `types.ts`):

- **`standard` (Sonnet 5.5) ignores `temperature`** — the model answers a request carrying it with
  a 400, so the provider drops it (`acceptsTemperature: false`); prompts' temperatures apply on
  the fast tier only — including `/api/stream`'s `temperature`, accepted on either tier and
  applied only on `fast`. It is sent `thinking: { type: "between_tools" }`, which turns off up-front
  thinking; it may still think between tool calls.
- **A forced `tool_choice` (`any` or a named tool) returns a 400 on Sonnet 5.5**, as does an
  assistant prefill (a conversation must end with a user turn). `AIRequest` sends no `tool_choice`
  (the API's default, `auto`); say in the prompt when to use a tool.
- **Thinking blocks** come back as `{ type: "thinking", raw }` content blocks: opaque, never
  rendered (read the `text` blocks for the reply), and passed back unmodified when the assistant
  turn is sent again in a tool loop — the API needs them signed and unchanged.
- **Refusals throw.** A `stop_reason: "refusal"` (complete or stream) throws `AIRefusalError`, a
  permanent `AIProviderError`, not an empty reply. It carries the `usage` it was billed for, and
  the orchestrator records that cost in the failure metrics. Test for it with
  `isAIRefusalError(err)` (also true for a copy from another bundle, where `instanceof` is false)
  and read its usage with `refusalUsage(err)`. Answer it as `ai.request_declined`, not
  `service.unavailable`: the same request is declined again.
- **Thinking blocks are checked before they are sent back:** only `thinking` or
  `redacted_thinking` in an assistant turn; anything else in `raw` refuses the request.
- **Retirement and request shape.** `.github/workflows/model-registry-check.yml` (weekly, and on a
  PR changing the registry) checks that every registry model resolves and is not retired (a
  deprecation warns), and sends each tier one `max_tokens: 1` request with its real settings
  (`scripts/check-model-ids.mjs`). Model IDs live only in `MODEL_REGISTRY`: a test refuses a
  `claude-` literal anywhere else.

## Prompt caching (`promptCache`) and its gate

Off unless all three hold: the governed setting **`ai.prompt_cache_enabled`** is true (migration
058, default false, operator-only), the request sets **`promptCache: true`**, and the request
carries a **`cacheablePrefix`**. The orchestrator drops `promptCache` while the setting is off or
unreadable. The provider sends `cacheablePrefix` as the first system block with the one cache
breakpoint after it, then `system` uncached; the tools render before it and are inside the cached
span. `system`, the tools alone and the messages are never marked.

**`cacheablePrefix` is for fixed, tenant-free text only** — the same bytes for every tenant and
user. A tenant's name, settings, data or a user's input go in `system`, after the breakpoint. A
prefix under the model's minimum (512 tokens on Sonnet 5.5, 4,096 on Haiku 4.5) is not cached: its
tokens are billed as ordinary input, with no write premium. A write costs `cacheWriteCostPer1M` (1.25x input, 5-minute TTL) and a read
`cacheReadCostPer1M` (0.05x on Sonnet 5.5, 0.1x on Haiku 4.5): it pays only for a prefix re-sent
within 5 minutes.

## Circuit Breaker

Protects against cascading failures when the AI provider is down:

- **Closed** → normal operation
- **Open** → fails immediately (5 consecutive failures)
- **Half-open** → probes with single request (after 30s cooldown)

## Instrumentation

Every call automatically records: model, tokens, latency, estimated cost, success/failure, through
the observability `MetricsSink` (the `ai_metrics` table, per tenant) as `ai.call`.

**Usage fields.** `AIUsage` is the API's: `inputTokens` is the **uncached** remainder of the
prompt; `cacheReadTokens` and `cacheWriteTokens` are the cached parts; the prompt's total is their
sum. `ai.call` values carry all three (0 when none), and `MetricsSummary` reports
`totalInputTokens`, `totalCacheReadTokens`, `totalCacheWriteTokens` and `totalPromptTokens`.

**Cost.** `estimateCost(tier, response.usage)` — pass the whole usage, so cache tokens are always
billed, each at the model's own price (`ModelConfig.cacheReadCostPer1M`, `cacheWriteCostPer1M`).

---

_See [ADR-015](../../docs/adr/ADR-015-genai-native-stack.md) for architecture context._
