# realtime

Provider-abstracted realtime communication: AI streaming, messaging, presence, and agentic workflows.

## Status

✅ **Sprint 5 Complete** — RealtimeProvider interface, Supabase + Mock implementations, AI streaming.

## Architecture

```
platform/realtime/
  ├── types.ts              — RealtimeProvider interface, agentic message schema, all contracts
  ├── supabase-realtime.ts  — Supabase Realtime implementation (first production provider)
  ├── mock-realtime.ts      — In-memory mock (tests + local dev)
  ├── middleware.ts          — Auth validation, rate limiting, P17 intent enforcement
  ├── health-probe.ts       — Connection state + latency SLA monitoring
  └── index.ts              — Public API barrel exports
```

## Provider Selection

```
REALTIME_PROVIDER = "supabase" | "mock"   (default: "mock")
```

Zero env vars = mock provider = working demo with no external dependencies.

## Agentic Message Schema (P15-P18)

Every message carries agent identity, intent, trajectory, and memory hints:

```typescript
interface RealtimeMessage {
  id: string;
  type: MessageType;
  channel: string;
  timestamp: number;
  actorType: "user" | "agent" | "system"; // P15
  actorId: string; // P15
  onBehalfOf?: string; // P15
  intent: "inform" | "propose" | "commit" | "checkpoint" | "rollback"; // P17
  trajectoryId?: string; // P18
  stepIndex?: number; // P18
  memoryHint?: "working" | "episodic" | "semantic" | "procedural" | "resource"; // P16
  payload: unknown;
}
```

## AI Streaming

```typescript
// Server: orchestrator streams through provider
for await (const chunk of orchestrator.stream(request, opts)) {
  writer.write(chunk);
}

// Client: useRealtimeStream hook
const { startStream, text, isStreaming, abort } = useRealtimeStream();
startStream("Tell me a story");
```

## Adding a New Provider

1. Create `platform/realtime/{provider}-realtime.ts` implementing `RealtimeProvider`
2. Map `RealtimeMessage` to provider's native format (preserve P15-P18 fields)
3. Register in `platform/providers/registry.ts`
4. Set `REALTIME_PROVIDER={provider}`
5. Add tests
6. Update ADR-018

## Latency SLAs

| Metric              | Target                      |
| ------------------- | --------------------------- |
| Time-to-first-token | <2 seconds                  |
| Broadcast           | <200ms local, <500ms global |
| Presence            | <1 second                   |
| Connection          | <3 seconds                  |

## Scale Path

Supabase (current) → Ably/Pusher (100K+) → Custom WS (1M+). Provider swap = env var change.

---

_See [ADR-018](../../docs/adr/ADR-018-realtime-architecture.md) for full architecture decision._
