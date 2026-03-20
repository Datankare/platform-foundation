# ADR-007 — Monorepo Structure

**Status:** Accepted
**Date:** 2026-03-19

## Context

Platform Foundation is a application platform, not a single game. Multiple games will be built
on shared infrastructure. The codebase must clearly separate platform-level
code from game-level code, and make it easy to add new games without
touching platform code.

## Decision

Single GitHub repository (monorepo) with strict directory-level separation
between layers:

```
platform-foundation/
├── platform/       ← Game-agnostic shared infrastructure
│   ├── auth/
│   ├── realtime/
│   ├── voice/
│   ├── translation/
│   ├── moderation/
│   ├── monetization/
│   ├── analytics/
│   └── game-engine/  ← The abstraction layer all games implement
├── games/
│   └── app-01/    ← First game — uses platform via game-engine interface
├── shared/
│   ├── ui-components/
│   ├── utils/
│   ├── types/
│   └── config/
├── infra/
│   ├── terraform/
│   ├── ci-cd/
│   └── environments/
├── app/            ← Next.js App Router (current spike — migrates to games/)
├── components/     ← Current spike components (migrates to shared/ and games/)
├── lib/            ← Current spike logic (migrates to platform/ modules)
├── docs/           ← Architecture docs, ADRs, TAD, runbooks
└── prompts/        ← Versioned LLM prompt library
```

## Migration Strategy

Existing spike code (app/, components/, lib/, types/) is NOT moved immediately.
It continues to work as-is. Code migrates into the monorepo structure
incrementally as each platform module is built:

- Phase 1: lib/safety.ts → platform/moderation/
- Phase 1: lib/translate.ts → platform/translation/
- Phase 1: lib/tts.ts → platform/voice/
- Phase 1: types/ → shared/types/
- Phase 2: Real-time engine → platform/realtime/
- Phase 3: Voice pipeline → platform/voice/
- Phase 8: Game 1 UI → games/app-01/

## Why Monorepo Over Polyrepo

| Factor                    | Monorepo          | Polyrepo               |
| ------------------------- | ----------------- | ---------------------- |
| Code sharing              | Trivial           | Complex (npm packages) |
| Refactoring across layers | Single PR         | Multiple PRs           |
| CI/CD                     | Single pipeline   | Multiple pipelines     |
| Onboarding                | One repo to clone | Multiple repos         |
| Lean team                 | Simpler to manage | More overhead          |

For a lean two-person team building a platform with shared infrastructure,
monorepo is unambiguously the right choice.

## Consequences

- All platform and game code lives in one repository
- Directory structure enforces the platform/game separation at the filesystem level
- New games are added as new directories under games/
- Platform modules are added as new directories under platform/
- The game-engine/ directory defines the contract all games must implement
- Lighthouse JSON excluded from Git (large generated file — summary kept in LIGHTHOUSE.md)
