# ADR-006 — Database Architecture

**Status:** Accepted
**Date:** 2026-03-19

## Context

Platform Foundation needs to store player data, game state, scores, subscriptions,
moderation logs, and embeddings for the RAG layer. The platform hosts
multiple games, each with different scoring dimensions and state shapes.
A naive relational schema would be brittle — requiring migrations every
time a new game is added with different data structures.

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

- players — identity, auth, subscription status
- sessions — game sessions, device continuity
- subscriptions — payment events, tier history
- moderation_log — all content safety decisions
- auth tokens — security-critical, strict schema

### What uses JSONB for flexibility

Data whose schema varies per game or grows over time:

- game_scores.dimensions — each game defines its own scoring structure
- game_state — each game defines its own state shape
- player_preferences — grows as platform adds features
- analytics_events — flexible event schemas per game type

### Example

```sql
CREATE TABLE player_scores (
  id          UUID PRIMARY KEY,
  player_id   UUID REFERENCES players(id),
  game_id     UUID REFERENCES games(id),
  session_id  UUID REFERENCES sessions(id),
  created_at  TIMESTAMPTZ NOT NULL,
  dimensions  JSONB                       -- game-specific, fully flexible
);
```

Game 1 dimensions: { "words_found": 12, "speed_bonus": 450, "accuracy": 0.94 }
Game 2 dimensions: { "rounds_won": 3, "total_points": 1200, "streak": 7 }

No migration needed when Game 2 has a different scoring structure.

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
query patterns are simple: player scores, session membership,
subscription history. Our groups are small (2-8 players) and
ephemeral. Graph traversal adds operational complexity without
benefit for our query patterns.

### Redis — Speed Layer

Redis handles ephemeral, high-frequency data that does not need
persistence beyond the active session:

- Real-time game state (active sessions only)
- Translation cache (avoid re-translating identical strings)
- Rate limiting (per-player API throttling)
- Session tokens (fast lookup, TTL-managed)

### pgvector — Embeddings

pgvector is a PostgreSQL extension that adds vector similarity search.
This handles the RAG layer and semantic search (player personalization,
game rule retrieval) without a separate vector database. For our scale,
pgvector is more than sufficient and eliminates operational complexity.

## Consequences

- Schema flexibility achieved via JSONB — no brittle fixed schemas for game data
- ACID transactions preserved for payments, auth, and moderation
- Single database system (PostgreSQL) reduces operational complexity
- Supabase provides auth, realtime subscriptions, and row-level security
- GDPR right-to-erasure handled cleanly via cascade deletes on relational keys
- pgvector handles embeddings without a separate vector database
- Redis adds one additional system but is operationally simple and battle-tested
- Game-specific scoring schemas documented per game in /docs/games/
- JSONB fields indexed for query performance as usage patterns emerge
