# prompts

Versioned LLM prompt library — prompts are first-class artifacts with tests.

## Status

🚧 **Placeholder** — Populated in Phase 2, Sprint 1 (ADR-015: GenAI-Native Stack).

## Target Structure (ADR-015)

```
prompts/
  ├── safety/
  │   ├── classify-v1.ts       — Content classification prompt (versioned)
  │   └── classify-v1.test.ts
  ├── admin/
  │   ├── command-bar-v1.ts    — Admin AI command bar prompt
  │   └── command-bar-v1.test.ts
  └── index.ts                 — Prompt registry with version resolution
```

## Principles

- Every prompt is versioned (`-v1`, `-v2`, etc.)
- Every prompt has a co-located test file
- Prompts are extracted from inline strings — no raw prompt text in route handlers
- All prompts go through the orchestration layer (`platform/ai/orchestrator.ts`)

---

_See [ADR-015](../docs/adr/ADR-015-genai-native-stack.md) and [ADR-001](../docs/adr/ADR-001-platform-game-separation.md) for architecture context._
