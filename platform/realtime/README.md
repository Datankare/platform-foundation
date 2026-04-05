# realtime

WebSocket engine and room/session management.

## Status

🚧 **Placeholder** — Populated in Phase 2, Sprint 5.

## Target Structure

```
platform/realtime/
  ├── engine.ts        — WebSocket server abstraction (Supabase Realtime or custom)
  ├── rooms.ts         — Room lifecycle: create, join, leave, destroy
  ├── sessions.ts      — Session tracking with heartbeat and reconnection
  ├── middleware.ts     — Auth + rate limiting for WebSocket connections
  └── types.ts         — Room, Session, Message, Event types
```

## Prerequisites

- Redis (Sprint 4) — pub/sub for multi-instance message fanout
- Auth (Phase 1) — JWT validation on WebSocket handshake

---

_See [ADR-007](../../docs/adr/ADR-007-monorepo-structure.md) and [ADR-011](../../docs/adr/ADR-011-security-headers.md) for architecture context._
