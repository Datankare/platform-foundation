# ADR-001 — Platform and Game Layer Separation

**Status:** Accepted
**Date:** 2026-03-18

## Context

We are building a commercial cross-platform application platform with the intention
of hosting multiple games on shared infrastructure. The naive approach would
be to build a single game and extract common components later. This typically
results in tightly coupled code that is expensive to refactor.

## Decision

We strictly separate all code into two layers:

**Platform Layer** — game-agnostic shared infrastructure:
Auth, Authorization, Analytics, Voice, NLP, Translation, Moderation,
Real-time, Device continuity, Monetization, Ads, Subscriptions,
RAMPS, WCAG, Security, i18n.

**Game Layer** — game-specific logic:
Game rules, game UI, scoring semantics, game content.

Every architectural decision is first asked: "Is this platform-level or
game-level?" Platform-level code goes into shared infrastructure. Game-level
code is isolated behind clean interfaces so it can be swapped, extended,
or replaced without touching the platform.

## Consequences

- Every new game is 80% done before writing a line of game logic
- All games share the same auth, safety, analytics, monetization
- Fix a bug in translation once — all games benefit
- The platform itself has standalone value — licensable, acquirable
- Requires more upfront design discipline
- Game interfaces must be formally defined and versioned
