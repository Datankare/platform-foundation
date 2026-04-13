# ADR-018: Realtime Architecture

**Status:** Accepted
**Date:** 2026-04-10
**Author:** Raman Sud

## Context

Sprint 5 requires realtime capabilities: AI response streaming, bidirectional messaging, presence tracking, and an agentic-native message schema that supports agent-to-agent communication, trajectory observation, and cognition-commitment boundaries.

The platform runs on Vercel (serverless) with Supabase as the database layer. Traditional persistent WebSocket servers are not viable on serverless infrastructure.

## Decision

### Provider-Abstracted Realtime

Build a `RealtimeProvider` interface following the same pattern as `AuthProvider`, `CacheProvider`, `AIProvider`, and `ErrorReporter`. The interface defines the contract; implementations are swappable via a single environment variable.

```
REALTIME_PROVIDER = "supabase" | "mock" | "ably" | "pusher" | ...
```

### First Implementation: Supabase Realtime

Supabase Realtime is the first production implementation because:

- Already in the stack (zero new dependencies)
- Supports broadcast (arbitrary messaging), presence, and Postgres Changes
- Works on Vercel (client-side WebSocket, no server persistence needed)
- Sufficient for current scale (200 free, 500 pro concurrent connections)

### Agentic-Native Message Schema

Every `RealtimeMessage` carries agentic metadata from day one:

| Field                                       | Principle                  | Purpose                                   |
| ------------------------------------------- | -------------------------- | ----------------------------------------- |
| `actorType`, `actorId`, `onBehalfOf`        | P15 — Agent Identity       | Who sent this, on whose behalf            |
| `intent`                                    | P17 — Cognition-Commitment | inform/propose/commit/checkpoint/rollback |
| `trajectoryId`, `stepIndex`, `parentStepId` | P18 — Durable Trajectories | Which execution path this belongs to      |
| `memoryHint`                                | P16 — Cognitive Memory     | How downstream systems should store this  |

These fields are typed and enforced at the interface level. They activate naturally when agents arrive in Phase 5 — no schema migration needed.

### AI Streaming

The `AIProvider` interface is extended with an optional `stream()` method returning `AsyncIterable<AIStreamChunk>`. The orchestrator wraps it with:

- Time-to-first-token instrumentation (SLA: <2 seconds)
- Circuit breaker (same as `complete()`)
- Fallback: if streaming fails, retry with `complete()` and return as single chunk
- Cost tracking per stream

The `/api/stream` endpoint serves SSE (Server-Sent Events) to the browser.

### Scale Migration Path

| Stage      | Concurrent Users            | Provider                                      | Action Required |
| ---------- | --------------------------- | --------------------------------------------- | --------------- |
| MVP → 10K  | Supabase Pro                | None                                          |
| 10K → 100K | Ably or Supabase Enterprise | Implement `AblyRealtimeProvider`, set env var |
| 100K → 1M+ | Ably/Pusher Enterprise      | Same provider, scale plan                     |
| 1M+        | Custom (Redis Cluster + WS) | Implement `CustomRealtimeProvider`            |

At every stage, the `RealtimeProvider` interface stays the same. No consumer code changes.

### Latency SLAs

| Metric                   | Target                      | Enforcement                             |
| ------------------------ | --------------------------- | --------------------------------------- |
| Time-to-first-token      | <2 seconds                  | Orchestrator warns + metric if exceeded |
| Message broadcast        | <200ms local, <500ms global | Health probe monitors                   |
| Presence propagation     | <1 second                   | Health probe monitors                   |
| Connection establishment | <3 seconds                  | Connect timeout                         |
| Reconnection after drop  | <5 seconds                  | Exponential backoff, max 3 retries      |

### How to Add a New Provider

1. Create `platform/realtime/{provider}-realtime.ts` implementing `RealtimeProvider`
2. Map `RealtimeMessage` schema to provider's native format (preserve all P15-P18 fields)
3. Register in `platform/providers/registry.ts` (add case to `initRealtimeProvider`)
4. Set `REALTIME_PROVIDER={provider}` environment variable
5. Add tests in `__tests__/{provider}-realtime.test.ts`
6. Update this ADR's providers table

## Consequences

### Positive

- Provider abstraction prevents vendor lock-in
- Agentic message schema is future-proof — no migration at Phase 5
- AI streaming through orchestrator maintains instrumentation and safety invariants
- Mock provider enables full test coverage without external dependencies
- Latency SLAs are measurable and enforceable

### Negative

- Supabase Realtime has connection limits on free/pro tiers
- The provider abstraction adds a layer of indirection
- Some Supabase-specific features (Postgres Changes) don't map 1:1 to other providers

### Risks

- Supabase Realtime at scale is less battle-tested than Ably/Pusher
- Mitigation: provider swap is a configuration change, not a rewrite

## Providers

| Provider          | Status         | Connections            | Latency                   | Notes                      |
| ----------------- | -------------- | ---------------------- | ------------------------- | -------------------------- |
| Supabase Realtime | ✅ Implemented | 200 (free) / 500 (pro) | ~50-100ms (single region) | First implementation       |
| Mock              | ✅ Implemented | Unlimited (in-memory)  | 1ms                       | Tests + local dev          |
| Ably              | 📋 Planned     | 500M+                  | <65ms (global edge)       | Scale migration target     |
| Pusher            | 📋 Planned     | 100K+                  | <100ms                    | Alternative scale option   |
| Custom WS         | 📋 Planned     | Unlimited              | Depends on infra          | Requires dedicated servers |

## References

- ADR-007 — Monorepo structure (`platform/realtime/`)
- ADR-011 — Security headers (CSP for WebSocket)
- ADR-014 — Observability (health probes, metrics)
- ADR-015 — GenAI-Native Stack (AI streaming through orchestrator)
- GenAI Manifesto P7, P15, P16, P17, P18
- Rodriguez, J. (2026). "The Agent-Native Rewrite." The Sequence Opinion #840.
