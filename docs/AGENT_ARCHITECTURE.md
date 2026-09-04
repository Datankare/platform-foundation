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

## Governed authority (Phase 5 — Sprint 3/3c)

The clusters above describe what agents _do_. This section describes the authority under which
they do it — the governance layer added in Phase 5 that makes agent action attested, scoped,
and auditable rather than implicitly trusted. It sits beneath the agent clusters and above the
platform services, and every agent-invoked capability passes through it.

### The two-principal check

An agent never acts on its own authority alone. Every agent-invoked capability is authorized by
**two independent gates, both of which must pass** (ADR-033):

- **User gate (principal 1)** — the acting user's own verified session (Cognito JWT), plus a
  per-capability account-status check. This answers "may this user do this."
- **Agent gate (principal 2)** — the agent must be a registered, active, in-scope member of the
  trusted-agent registry. This answers "is this agent trusted to act."

The gates are independent: a permitted user working through an untrusted agent is denied, and a
trusted agent acting for a restricted user is denied. Both must clear. Every denial is
fail-closed and names which gate failed, for the audit trail.

### Agent identity — attested delegation (rung 2, ADR-033)

Agent identity matured through two rungs:

- **Rung 1 (superseded):** an agent was named by an `x-agent-role` header and checked against a
  hard-coded allowlist. A bare, unverified claim.
- **Rung 2 (current):** an agent presents a **short-lived, RS256-signed delegation token** in
  the `x-agent-delegation` header, obtained through an OAuth 2.1 / PKCE consent flow in which
  the user explicitly authorizes the agent for a specific scope. Verification checks the
  signature, expiry, audience, the `onBehalfOf` binding (the token must attest _this_
  authenticated user delegated to the agent — the anti-impersonation core), and replay. The
  rung-1 header path is retired: a signed token is the only thing that resolves an agent
  identity.

Token lifetime is governed, not free: `effective_ttl = min(requested, agent ceiling, global
cap)`. There are deliberately no refresh tokens — tokens are re-minted through fresh consent,
removing a long-lived secret. (Developer contract: `docs/AGENT_DELEGATION_GUIDE.md`.)

### The trusted-agent registry

The rung-1 allowlist is replaced by a **governed registry**: each agent has an owner, a scope
(the capabilities it may act on), a status (active/suspended), and a token-lifetime ceiling.
The registry is admin-managed config with a fail-safe built-in fallback, so a config outage
keeps known agents working while still failing closed on the rest. Suspending an agent or
narrowing its scope is a governed config change, not a code change.

### Capability → feature mapping and the user gate

A capability an agent invokes maps to a set of user-facing features (the capability→feature
map). The user gate checks the acting user against _every_ mapped feature via the account-status
guard. Layered on top is **per-account feature restriction** (ADR-034): a specific user can be
blocked from a specific feature independent of their account status — a targeted, orthogonal
control that denies at the user gate, fail-closed.

### The GenAI-native governance admin

All of the above is administered through the platform's natural-language admin (ADR-035):
prompt → AI plan → human confirm → execute, not CRUD forms. The trusted-agent registry, the
capability→feature map, the approval policy, and per-account blocks are each a governance panel
over a governed store. The mechanism is vocabulary-free platform machinery; the specific values
(which agents, which capabilities) are consumer config. Safety-tier changes route through
two-person approval.

### Where this sits in the layer diagram

The governed-authority layer slots between the agent clusters and the platform services:

```
  Input / Processing / Social agent clusters
                  │  each agent-invoked capability passes through ▼
┌─────────────────────────────────────────────────────────────┐
│              Governed authority (Phase 5)                    │
│                                                             │
│  User gate (principal 1)          Agent gate (principal 2)  │
│  · Cognito session                · trusted-agent registry  │
│  · account-status + per-account   · attested delegation     │
│    feature restriction              (rung-2 RS256 token)    │
│                                                             │
│  Capability→feature map · Approval policy · Governance admin │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
  Platform services: Moderation · AI · Embedding · Real-time
  Observability · Data (Supabase · Trajectories · Budgets · …)
```

---

## Phase 5 extension points

Delivered in Phase 5 (see "Governed authority" above and the agentic-workflow framework):

- ✅ Governed agent identity (rung-2 attested delegation), trusted-agent registry, two-principal check
- ✅ Per-account feature restriction; GenAI-native governance admin
- ✅ Human-in-the-loop breakpoints — held actions with approve/reject/resume (ADR-029/031)
- ✅ Durable trajectories, budgets, proposals, effect ledger

Still open / forthcoming:

- Multi-agent orchestration (agents coordinating on complex workflows)
- Tool marketplace (agents discovering and using new tools)
- Admin-authored workflow composition (tracked as FEAT-090, needs its own ADR)
- Cross-workflow trajectory linking
- New agents: Game AI, Dispute Resolution, Anti-Cheat
- New input classifiers: Camera/OCR, Gesture, Video

---

## Sprint 4b delivery notes

### Social agents — intentional structural similarity

All 5 social agent workflows (matchmaker, gatekeeper, concierge, analyst, curator) follow the same 2-step pattern: Step 0 gathers context (rule-based, zero cost), Step 1 calls the LLM. This is intentional — each agent will diverge as multi-step reasoning, tool use, and memory are added in later sprints. The shared pattern makes the current behavior predictable and testable while preserving room for independent evolution.

### Input agent swap

AgentClassifier and AgentIntentResolver implement the existing InputClassifier and IntentResolver interfaces. The DefaultInputConductor accepts both via constructor injection — no conductor code changed. Non-mic events bypass the LLM entirely (delegated to rule-based fallback). Both agent implementations fall back to their rule-based counterparts on any LLM error (P11).

### scopeKey bug fix

Sprint 4a shipped a precedence bug: `(scopeId ?? scopeType === "platform")` evaluated as `(scopeId ?? (scopeType === "platform"))` due to `??` being lower precedence than `===`. This caused all scoped agent runs to use `"platform"` as their budget scope key, defeating per-group budget tracking. Fixed to `scopeId ?? scopeType`.

---

_Last reviewed: September 2026 (v2.0.0 — added the Governed authority section: rung-2 identity, delegation, governance admin, per-account restriction)_

## Human review + reviewer-assist (Sprint 6)

The human-oversight surface for moderation (P10), backed by `platform/moderation/`
(review-types, review-store, review-service, review-assist) and surfaced via
`components/ReviewDashboard` + `components/AppealForm`. See ADR-024 (queue +
appeals) and ADR-025 (reviewer-assist).

### Review queue

A single `review_queue` (migration 018) collects items from three sources:

| Source       | Producer                       | Trigger                                                              |
| ------------ | ------------------------------ | -------------------------------------------------------------------- |
| `escalation` | Guardian / safety middleware   | Classifier confidence below the per-level `escalate_below` threshold |
| `ban_review` | Sentinel (intended)            | A ban consequence flagged for human confirmation                     |
| `appeal`     | Appeals route (user-initiated) | A user contests a prior block within the appeal window               |

Each item carries the full automated decision context — classifier output,
severity, the layer that triggered it, context factors, reasoning, and (when
present) the RAG explanation chain — plus `previous_account_status`, so an
overturn restores the status that existed before the reviewed decision rather
than blanket-resetting to active.

### Lifecycle

`pending → claimed → resolved`. A moderator claims an item (claim times out back
to pending after `review_claim_timeout_hours`), then resolves it as **uphold**,
**overturn** (reverse the decision, restore prior status, expire the linked
strike), or **modify** (substitute a different moderation action). Reviewer notes
are mandatory on every resolution, so each decision carries a human rationale.

### RBAC

All review/appeal-resolution routes are gated on the `can_moderate` permission
(migration 018), granted to a new `moderator` role and to `admin`/`super_admin`.
The reviewer identity comes from the session, never the request body; the appeals
route resolves the user from the session and verifies ownership of the original
decision before queuing.

### Reviewer-assist (advisory)

On demand, a reviewer can request an AI suggestion for an item
(`POST /api/moderation/review/{id}/assist`). The assist reads the same recorded
context and returns a non-binding `{ recommendation, rationale }` that may prefill
the decision control. It is advisory only (P10 — never auto-resolves), on-demand
(P12 — bounded token cost), and fail-open (P11 — any model/parse failure yields no
suggestion, never an error that blocks the workflow). See ADR-025.

_Follow-ups (not yet wired):_ Sentinel `ban_review` auto-submit is not connected
(only escalation and appeals currently produce items); strike expiry on overturn
is logged but there is no per-strike expire API yet.
