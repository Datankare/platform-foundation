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

| Tier       | Model     | Use Case                                    |
| ---------- | --------- | ------------------------------------------- |
| `fast`     | Haiku 4.5 | Safety classification, simple extraction    |
| `standard` | Sonnet 4  | Admin command bar, complex reasoning, tools |

## Circuit Breaker

Protects against cascading failures when the AI provider is down:

- **Closed** → normal operation
- **Open** → fails immediately (5 consecutive failures)
- **Half-open** → probes with single request (after 30s cooldown)

## Instrumentation

Every call automatically records: model, tokens (in/out), latency, estimated cost, success/failure.
Metrics logged via structured logger now; external sink (Sentry/Datadog) in Phase 3.

---

_See [ADR-015](../../docs/adr/ADR-015-genai-native-stack.md) for architecture context._
