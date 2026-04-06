# ADR-006 — Database Architecture

**Status:** Accepted
**Date:** 2026-03-19

## Context

Platform Foundation needs to store user data, application state, scores, subscriptions,
moderation logs, and embeddings for the RAG layer. The platform hosts
multiple applications, each with different scoring dimensions and state shapes.
A naive relational schema would be brittle — requiring migrations every
time a new application is added with different data structures.

The team considered three approaches:

- Pure relational (PostgreSQL)
- Document database (MongoDB)
- Graph database (Neo4j)
- Hybrid PostgreSQL + JSONB

## Decision

**PostgreSQL with JSONB columns for flexible data + pgvector for embeddings**,
hosted via Supabase. Redis as a separate speed layer for ephemeral state.

### What stays strictly relational

Data that must be precise, consistent, and legally defensible:

- users — identity, auth, subscription status
- sessions — application sessions, device continuity
- subscriptions — payment events, tier history
- moderation_log — all content safety decisions
- auth tokens — security-critical, strict schema

### What uses JSONB for flexibility

Data whose schema varies per application or grows over time:

- app_scores.dimensions — each application defines its own scoring structure
- app_state — each application defines its own state shape
- user_preferences — grows as platform adds features
- analytics_events — flexible event schemas per application type

### Example

```sql
CREATE TABLE app_scores (
  id          UUID PRIMARY KEY,
  user_id     UUID REFERENCES users(id),
  app_id      UUID REFERENCES apps(id),
  session_id  UUID REFERENCES sessions(id),
  created_at  TIMESTAMPTZ NOT NULL,
  dimensions  JSONB                       -- app-specific, fully flexible
);
```

App 1 dimensions: { "words_found": 12, "speed_bonus": 450, "accuracy": 0.94 }
App 2 dimensions: { "rounds_won": 3, "total_points": 1200, "streak": 7 }

No migration needed when App 2 has a different scoring structure.

### Why not MongoDB

MongoDB provides JSONB-style flexibility but loses:

- ACID transactions — critical for payment processing
- Foreign key enforcement — critical for data integrity
- Native auth integration (Supabase is built on PostgreSQL)
- pgvector for embeddings — would require separate vector DB
- Clean cascade deletes for GDPR right-to-erasure

### Why not a Graph DB

Graph databases excel at multi-hop relationship traversal —
finding friends of friends, complex network queries. Our primary
query patterns are simple: user scores, session membership,
subscription history. Our groups are small (2-8 users) and
ephemeral. Graph traversal adds operational complexity without
benefit for our query patterns.

### Redis — Speed Layer

Redis handles ephemeral, high-frequency data that does not need
persistence beyond the active session:

- Real-time application state (active sessions only)
- Translation cache (avoid re-translating identical strings)
- Rate limiting (per-user API throttling)
- Session tokens (fast lookup, TTL-managed)

### pgvector — Embeddings

pgvector is a PostgreSQL extension that adds vector similarity search.
This handles the RAG layer and semantic search (user personalization,
domain knowledge retrieval) without a separate vector database. For our scale,
pgvector is more than sufficient and eliminates operational complexity.

## Consequences

- Schema flexibility achieved via JSONB — no brittle fixed schemas for application data
- ACID transactions preserved for payments, auth, and moderation
- Single database system (PostgreSQL) reduces operational complexity
- Supabase provides auth, realtime subscriptions, and row-level security
- GDPR right-to-erasure handled cleanly via cascade deletes on relational keys
- pgvector handles embeddings without a separate vector database
- Redis adds one additional system but is operationally simple and battle-tested
- Application-specific scoring schemas documented per app by consumers
- JSONB fields indexed for query performance as usage patterns emerge
