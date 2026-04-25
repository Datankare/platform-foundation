# Agent Architecture — Playform Platform

> Living document. Started Phase 4 (2026-04-17). Updated each phase as agents are added.

---

## Overview

The platform uses three clusters of autonomous agents. Each agent has its own identity (P15), trajectory (P18), tools, and budget (P12). All agents operate within the cognition-commitment boundary (P17): AI evaluations are internal and revisable; durable actions are audited and idempotent.

Agents are defined workflows with AI called at specific steps — not open-ended LLM loops. This keeps costs predictable and behavior auditable.

---

## Architecture layers

```
┌─────────────────────────────────────────────────────────────┐
│                     User input events                       │
│           Keystroke · Mic stream · File drop · Paste        │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                  Input agents (Sprint 1/4b)                  │
│                                                             │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────┐    │
│  │  Conductor    │─►│ Audio          │─►│ Intent       │    │
│  │  Orchestrate  │  │ classifier     │  │ agent        │    │
│  │  input flow   │  │ Speech/music/  │  │ Classify     │    │
│  │               │  │ noise          │  │ user goal    │    │
│  └──────────────┘  └────────────────┘  └──────────────┘    │
└──────────────────────────┬──────────────────────────────────┘
                           │ routes to
┌──────────────────────────▼──────────────────────────────────┐
│               Processing agents                             │
│           Wrap existing provider pipelines                  │
│                                                             │
│  ┌─────────────┐ ┌──────────────┐ ┌───────────┐ ┌────────┐│
│  │Transcription│ │Identification│ │Translation│ │Extract- ││
│  │STT pipeline │ │Song finger-  │ │From/to    │ │ion     ││
│  │             │ │print         │ │pipeline   │ │File    ││
│  └─────────────┘ └──────────────┘ └───────────┘ └────────┘│
└──────────────────────────┬──────────────────────────────────┘
                           │ content screened by
┌──────────────────────────▼──────────────────────────────────┐
│                  Social agents (Sprint 4a/4b)               │
│                                                             │
│  ┌──────────┐  ┌───────────┐  ┌───────────┐               │
│  │ Guardian  │  │ Matchmaker│  │Gatekeeper │               │
│  └──────────┘  └───────────┘  └───────────┘               │
│  ┌──────────┐  ┌───────────┐  ┌───────────┐               │
│  │Concierge │  │  Analyst   │  │  Curator  │               │
│  └──────────┘  └───────────┘  └───────────┘               │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  Platform services: Moderation · AI · Embedding · Real-time │
├─────────────────────────────────────────────────────────────┤
│  Observability: Traces · Metrics · Sentry · Audit log       │
├─────────────────────────────────────────────────────────────┤
│  Data: Supabase · pgvector · ltree · Trajectories · Budgets │
└─────────────────────────────────────────────────────────────┘
```

---

## Cluster 1: Input agents

### Why agents and not a rules engine

The critical decision point is the mic stream. When a user's microphone is active, the system must continuously answer: "Is this someone talking, or is a song playing?" That requires analyzing frequency distribution, rhythm patterns, and speech cadence — a real-time audio classification problem. That's an AI agent, not an if/else.

Where agents would be overkill (and we don't use them): showing/hiding the textarea, validating character count, swapping language dropdowns — those are UI state management.

### Conductor agent

- **Job:** Orchestrate the input layer. Receive raw input events, delegate to specialized agents, collect outputs, emit unified intent + processed data.
- **Trigger:** Every input event (keystroke, mic chunk, file drop, paste).
- **Trajectory:** `input-received → classified → intent-resolved → actions-emitted`

### Audio classifier agent

- **Job:** Classify audio stream as speech, music, or noise.
- **Trigger:** Mic stream chunks from Conductor.
- **Output:** `{ classification, confidence, features: { rhythmRegularity, harmonicContent, speechCadence } }`
- **P17:** Classification = cognition (revisable). Routing = commitment (logged).

### Intent agent

- **Job:** Map classified input + processed data to user intent and available actions.
- **Trigger:** Classification result from Audio Classifier or text input from Conductor.
- **Output:** `{ intent, actions: [{ id, label, primary? }] }`
- **P6:** Structured output. The UI renders whatever actions the agent returns — no hardcoded buttons.

### Extension model

Each new modality is a new output from the classifier. Conductor, Intent Agent, and UI rendering are unchanged:

| New modality            | What changes                      | What stays the same                   |
| ----------------------- | --------------------------------- | ------------------------------------- |
| Camera input (OCR)      | New classifier: "image/text"      | Conductor routing, Intent Agent, UI   |
| Gesture input           | New classifier: "gesture/command" | Same agent runtime, trajectory format |
| Multi-language audio    | Classifier adds language field    | Processing agents use it for routing  |
| Video input             | New classifier: "video/music"     | Same identification pipeline          |
| Real-time collaboration | Social agents add group context   | Input agents unaware of groups        |

---

## Cluster 2: Processing agents

Wrap existing provider pipelines as agents with trajectories, cost tracking, and observability.

| Agent          | Wraps                    | Trajectory                                     |
| -------------- | ------------------------ | ---------------------------------------------- |
| Transcription  | `platform/voice/` STT    | audio → STT → text → safety check              |
| Identification | Song ID + AudioConverter | audio → convert → fingerprint → match → enrich |
| Translation    | `platform/translation/`  | text → detect language → translate → TTS       |
| Extraction     | `lib/extract.ts`         | file → type detect → extract → text            |

---

## Cluster 3: Social agents

| Agent      | Job                           | Key principle                                 |
| ---------- | ----------------------------- | --------------------------------------------- |
| Guardian   | Content safety, all surfaces  | P4 fail-closed, P17 borderline → human review |
| Matchmaker | Group recommendations         | P14 feedback loops, P11 fallback to browse    |
| Gatekeeper | Join request evaluation       | P10 human oversight, P6 structured output     |
| Concierge  | Onboarding, persona coaching  | P15 agent identity, P16 cognitive memory      |
| Analyst    | Group health, hierarchy stats | P12 economic transparency, P18 trajectories   |
| Curator    | Digests, personalized content | P8 context/memory, P11 resilient degradation  |

### Concierge design constraint

The Concierge agent MUST use the same AdaptiveInput component and ActionItem[] contract as the rest of the app. Onboarding flows are not a separate UI — they are IntentResolver outputs rendered by the same component the user will use daily. This means the Concierge's onboarding actions (e.g., "Try speaking", "Upload a file", "Identify a song") appear as ActionItem[] buttons, and the user learns by doing, not by watching a tutorial.

**Source:** Rezvani, A. (2026). "Claude Code /powerup: 10 Built-In Lessons." Key insight: "Learn the tool inside the tool." Anthropic built their tutorial using the same rendering framework that powers the product. Applied here: the Concierge teaches users through the same UI contract they'll use in production.

### Inter-agent communication

| From       | To                | Trigger            | Data                          |
| ---------- | ----------------- | ------------------ | ----------------------------- |
| Conductor  | Audio classifier  | Mic stream active  | Raw audio chunks              |
| Conductor  | Processing agents | Intent resolved    | Routed input                  |
| Gatekeeper | Concierge         | Approved join      | userId, groupId               |
| Guardian   | Analyst           | Moderation event   | contentId, action, confidence |
| Analyst    | Guardian          | Anomaly detected   | groupId, anomalyType          |
| Matchmaker | Gatekeeper        | User requests join | userId, groupId               |
| Curator    | Analyst           | Engagement signals | metrics                       |

---

## Sequence: Mic input flow

### Step 1 — User activates mic

Browser requests permission, audio stream starts. UI shows "Listening..." badge and waveform. No mode pill highlighted yet — system is observing.

### Step 2 — Conductor receives stream

Creates trajectory `input-abc-123`. Logs step 1: "mic stream received." Delegates raw audio chunks to Audio Classifier.

### Step 3 — Audio classifier analyzes (critical AI decision)

Examines first 2-3 seconds. Analyzes frequency distribution, rhythm regularity, speech cadence. If speech: routes to Transcription. If music: routes to Identification.

### Step 4 — Classification result

Returns: `{ classification: "music", confidence: 0.87 }`. UI updates: "Identify song" pill highlights. Intent bar: "Detected intent: Identify song."

### Step 5 — Route to identification agent

Conductor routes audio to Identification agent. Trajectory step 3 logged. Pipeline: canonical format conversion (ffmpeg-service) → fingerprint → ACRCloud lookup → metadata enrichment.

### Step 6 — Song identified

Identification agent returns match. Guardian screens content (title, artist) for safety. Returns: `{ matched: true, song: { title, artist, album, language }, confidence: 0.92, cost: { apiCalls: 2, usd: 0.005 } }`

### Step 7 — Intent agent determines actions

Receives identification result + user's target language. Returns structured actions array: Spotify, Apple Music, YouTube, "Translate lyrics to Spanish" (primary).

### Step 8 — UI adapts

SongMatchCard rendered with streaming links promoted and lyrics bridge as primary action. Trajectory complete: 7 steps, 2 API calls, $0.005 cost. Fully inspectable and replayable.

---

## Cognition vs. commitment boundary (P17)

| Cognition (internal, revisable) | Commitment (durable, audited) |
| ------------------------------- | ----------------------------- |
| Classify audio as speech/music  | Route to processing pipeline  |
| Detect user intent              | — (intent is advisory)        |
| Screen content for safety       | Block content                 |
| Evaluate join criteria          | Approve/deny join request     |
| Recommend groups                | — (suggestions only)          |
| Detect anomalies                | Increase scrutiny level       |

---

## Module structure

### Agent runtime (`platform/agents/`)

```
platform/agents/
├── types.ts           — AgentIdentity, AgentConfig, Trajectory, Step, Tool
├── registry.ts        — register/lookup agents by name
├── runtime.ts         — execute workflow: trigger → plan → step → observe → next
├── trajectory.ts      — create, checkpoint, resume, complete trajectories
├── budget.ts          — per-agent and per-group cost tracking
├── tools.ts           — typed tool definitions
└── index.ts           — public API
```

### Input module (`platform/input/`)

```
platform/input/
├── types.ts           — InputEvent, ClassificationResult, IntentResult, ActionItem, InputMode
├── conductor.ts       — InputConductor interface + default implementation
├── classifier.ts      — InputClassifier interface + rule-based default
├── intent.ts          — IntentResolver interface + default implementation
└── index.ts           — public API
```

---

## GenAI principle mapping

| #   | Principle             | Application                                       |
| --- | --------------------- | ------------------------------------------------- |
| P1  | Intent-driven         | All operations through typed interfaces           |
| P2  | Agentic execution     | Each agent is a multi-step instrumented workflow  |
| P3  | Total observability   | Every agent action traced with cost               |
| P4  | Structural safety     | Guardian screens all content, fail-closed         |
| P5  | Versioned artifacts   | Agent configs and templates in registry           |
| P6  | Structured outputs    | All agents return typed schemas, not free text    |
| P7  | Provider-aware        | Classifiers, processors all env-var swappable     |
| P8  | Context/memory        | Per-user and per-group AI context                 |
| P9  | Automated eval        | Classification accuracy, recommendation quality   |
| P10 | Human oversight       | Escalation chains, admin review queues            |
| P11 | Resilient degradation | Agent down → fallback to rule-based               |
| P12 | Economic transparency | Per-agent per-scope cost tracking and budgets     |
| P13 | Control plane         | Rate limiting, admin controls                     |
| P14 | Feedback loops        | Recommendation → click → join → retain signal     |
| P15 | Agent identity        | actorType/actorId/onBehalfOf on every action      |
| P16 | Cognitive memory      | Persistent context across sessions                |
| P17 | Cognition-commitment  | AI evaluates internally; durable actions separate |
| P18 | Durable trajectories  | Every agent run is inspectable and replayable     |

---

## Phase 5 extension points

- Multi-agent orchestration (agents coordinating on complex workflows)
- Tool marketplace (agents discovering and using new tools)
- Human-in-the-loop breakpoints
- Cross-workflow trajectory linking
- New agents: Game AI, Dispute Resolution, Anti-Cheat
- New input classifiers: Camera/OCR, Gesture, Video

---

_Last updated: April 24, 2026 (Sprint 3b — Sentinel agent added to roster)_
