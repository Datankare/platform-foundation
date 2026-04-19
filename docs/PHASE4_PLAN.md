# Phase 4 — Content Safety Foundation + Social System + Agent Runtime

**Objective:** Full content moderation engine, COPPA enforcement, user-group social system with nine autonomous agents (3 input + 2 processing wrappers + 6 social), RAG foundation, human review queue.

**Start date:** 2026-04-18
**PF release target:** v1.5.0

---

## Sprint Plan (revised April 19, 2026)

### Sprint 0 — Entry housekeeping ✅

- Install @sentry/nextjs, wire instrumentation.ts (both repos)
- Sentry DSNs + ERROR_REPORTER=sentry in Vercel, confirmed live
- TASK-027/028/030 resolved in SECURITY_DEBT.md
- TASK-034 UX review complete — intent-driven adaptive UI approved
- L14-L17 added to ENGINEERING_LEARNINGS.md
- pgvector + ltree enabled on Supabase
- ROADMAP.md Phase 4 started, changelog v4.0.0
- PHASE4_PLAN.md + AGENT_ARCHITECTURE.md committed
- CodeQL security fixes: ReDoS, regex efficiency, filename sanitization
- eslint-plugin-regexp added to both repos
- Semgrep SAST with --error (blocks CI on findings)

### Sprint 1a — PF: Input module + agent types

**Scope:** Generic input agent abstractions in PF. Build order: PF first, Playform inherits.

**Agent types (`platform/agents/types.ts` — pulled forward from Sprint 4a):**

- AgentIdentity: actorType, actorId, agentRole, onBehalfOf
- Trajectory: trajectoryId, agentId, steps[], status, totalCost
- Step: stepIndex, action, input, output, cost, durationMs, timestamp
- Tool: id, name, description, inputSchema, outputSchema
- AgentConfig: id, name, tools[], budgetConfig

**Input module (`platform/input/`):**

- `types.ts` — InputEvent (keystroke/mic/file/paste), InputMode, ClassificationResult (speech/music/noise/text/file), IntentResult (intent + confidence), ActionItem (id/label/primary/icon)
- `conductor.ts` — InputConductor interface: receives InputEvent, returns IntentResult + ActionItem[]. Default rule-based implementation (typing → translate, mic → user-selected mode, file → extract)
- `classifier.ts` — InputClassifier interface: receives audio/text/file data, returns ClassificationResult. Default rule-based implementation. Agent-backed implementation swapped in Sprint 4b
- `intent.ts` — IntentResolver interface: receives ClassificationResult + context, returns IntentResult + ActionItem[]. Default implementation maps to standard actions
- `index.ts` — public API

**Adaptive UI component (`components/AdaptiveInput/`):**

- `AdaptiveInput.tsx` — generic input component driven by agent output contract
  - Mode indicator pills (highlight based on ClassificationResult, also clickable to force mode)
  - Intent detection bar (shows IntentResult with confidence)
  - Adaptive action buttons (renders ActionItem[] — no hardcoded buttons)
  - Textarea with inline mic + upload icons
  - From/To language bar (shows when intent involves translation)
  - Character counter
  - Waveform visualization (shows when audio active)
  - "Listening..." badge (shows when mic active)
- `AdaptiveInput.test.tsx` — tests for all states and transitions

**Tests:** Written alongside code. Coverage must not decrease (PF floor: 82.54%).

**18-principle mapping table required before any code (L12).**

### Sprint 1b — Playform: SpikeApp rewrite + all features preserved

**Scope:** Rewrite SpikeApp using PF's AdaptiveInput + add Playform-specific features.

**Features preserved (every existing feature accounted for):**

- 10 languages (auto-detect + 9 targets in From/To dropdowns)
- Content type classification (greeting, question, song, etc.) — runs on every translate
- Content type source links (Google search) — clickable on content tag
- Translation card with language switching between target languages
- "Listen" / TTS playback button on translation result
- Additional languages picker ("+ Add more target languages")
- Live speech (continuous STT via Web Speech API) — mic icon triggers
- File upload (audio: MP3/WAV/M4A/WEBM/FLAC/OGG, text: PDF/TXT/MD) — upload icon triggers
- Song identification (ACRCloud fingerprint) — Identify pill or auto-detect
- Character counter (2500 max)
- SFW content check (safety.ts screens before processing)
- SongMatchCard with title/artist/album/confidence
- Gray for info messages, red for errors only (UX rule)

**New features:**

- TASK-032: Language picker hidden during identification (contextual UI)
- TASK-033: Song language displayed on SongMatchCard
- TASK-035: Streaming service search links (Spotify, Apple Music, YouTube Music)
- TASK-031: File-level docstrings on SongMatchCard + useAudioRecorder
- "Translate lyrics to [language]" bridge button — auto-suggests based on target language
- From/To language bar with auto-detect and swap button
- Intent detection bar showing classified intent
- Adaptive action buttons driven by IntentResolver output

**Playform-specific IntentResolver mappings:**

- typing/paste → intent: "translate", actions: [Translate, Speak, Clear]
- speech detected → intent: "transcribe_and_translate", actions: [Translate, Clear]
- music detected → intent: "identify_song", actions: [Identify, Clear]
- file dropped → intent: "extract_and_translate", actions: [Translate, Clear]
- song matched → intent: "song_identified", actions: [Spotify, Apple Music, YouTube, Translate lyrics, Clear]

**Files modified/created:**

- `components/SpikeApp.tsx` — major rewrite, uses AdaptiveInput
- `components/InputModeControl.tsx` — replaced by AdaptiveInput (deleted)
- `hooks/useAudioRecorder.ts` — remove unused recordingLanguage, add song language
- `components/SongMatchCard.tsx` — add streaming links, language, lyrics bridge
- New: Playform IntentResolver implementation
- Tests for all new/modified components

**Coverage must not decrease (Playform floor: 86.03%).**

### Sprint 2 — PF: Moderation engine (ADR-016)

(unchanged from original plan)

### Sprint 3 — PF: COPPA enforcement + account consequences

(unchanged from original plan)

### Sprint 4a — PF: Social data model + core services + agent runtime

**Agent runtime extends types from Sprint 1a:** registry, runtime, trajectory, budget, tools.

(rest unchanged from original plan)

### Sprint 4b — PF: Agent activation + AI-powered social features

**Also activates input agents:** swaps rule-based classifier/intent for agent-backed implementations.

(rest unchanged from original plan)

### Sprint 4c — Playform: Social wiring + team UI

(unchanged from original plan)

### Sprint 5 — PF: RAG foundation + embeddings

(unchanged from original plan)

### Sprint 6 — PF: Human review + appeals

(unchanged from original plan)

### Sprint 7 — Phase gate

(unchanged from original plan)

---

## Complete agent roster (9 agents across 3 clusters)

### Input agents (Sprint 1 UI, Sprint 4b runtime)

| Agent            | Trigger               | Key principle                                   |
| ---------------- | --------------------- | ----------------------------------------------- |
| Conductor        | Every input event     | P2 agentic execution, P18 trajectories          |
| Audio classifier | Mic stream chunks     | P17 cognition-commitment, P6 structured output  |
| Intent agent     | Classification result | P6 structured output, P11 resilient degradation |

### Processing agents (wrap existing pipelines)

| Agent          | Wraps                    | Key principle                       |
| -------------- | ------------------------ | ----------------------------------- |
| Transcription  | platform/voice/ STT      | P3 observability, P12 cost tracking |
| Identification | Song ID + AudioConverter | P3 observability, P12 cost tracking |
| Translation    | platform/translation/    | P3 observability, P12 cost tracking |
| Extraction     | lib/extract.ts           | P3 observability, P12 cost tracking |

### Social agents (Sprint 4a/4b)

| Agent      | Trigger                          | Key principle                               |
| ---------- | -------------------------------- | ------------------------------------------- |
| Guardian   | Every social write               | P4 structural safety, P17 fail-closed       |
| Matchmaker | User signup, periodic, on-demand | P14 feedback loops, P11 fallback            |
| Gatekeeper | Join requests                    | P10 human oversight, P6 structured output   |
| Concierge  | Approved join                    | P15 agent identity, P16 cognitive memory    |
| Analyst    | Scheduled per budget             | P12 economic transparency, P18 trajectories |
| Curator    | Scheduled + on-demand            | P8 context/memory, P11 degradation          |

---

## Coverage floors

| Repo                | Floor  |
| ------------------- | ------ |
| Platform-Foundation | 82.54% |
| Playform            | 86.03% |

---

_Generated: April 19, 2026_
