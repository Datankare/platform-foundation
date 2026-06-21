# Phase 5 — Application Framework + AUX

**Objective:** An extensible application framework (`platform/app-framework/`) on which consumers implement their specific app type; a reusable agentic workflow framework; an Agent User Experience (AUX) surface exposing agent-native contracts; plus the Phase 5 GenAI-Native deliverables (adaptive behavior, dynamic content generation, application-specific RAG, multimodal) and content-safety coverage of the new user-generated-content surface.

**Start date:** 2026-06-21
**PF release target:** v1.7.0 (phase close)

---

## Sprint Plan

### Sprint 0 — Entry housekeeping

- **TASK-019:** rename `platform/game-engine/` → `platform/app-framework/` (ADR-001 platform-agnostic naming; placeholder dir, no code yet).
- GenAI **P1–P18 mapping table** (L12) for the phase.
- **N7/N8 ROADMAP edits:** Phase 5 → In Progress, start date, changelog 8.0.0 (applied this session).
- **k6 live-burst re-baseline** against staging — moderation + agent layers now sit in request paths (handoff carry-in §5).
- **ACRCloud Edge-Runtime warning fix** in PF — isolate the Node-only `createHmac` import from the Edge bundle (handoff carry-in §1).
- **Doc cleanups (PF):** GENAI_ROADMAP changelog reorder + literal `\u2705`/`\u2014` escape glitch in some Phase 2 rows.
- **TASK-045 scheduled:** Playform GENAI_ROADMAP overlay rebase + D3/D4 dual-repo guard.
- **TASKS.md hygiene:** add TASK-044 (Phase 8) to Open Items (referenced in ROADMAP/handoff but absent); verify or retire the unverified TASK-029/037; and confirm the true status of TASK-038/040/041/043 (the body lists them Open while the prior footer had claimed them resolved) — move to the Resolved table or keep Open accordingly.

### Sprint 1 — Application framework core (PF)

- `platform/app-framework/`: application lifecycle abstraction, application state management, application session lifecycle, turn-based + real-time application support.
- Conformance kit per new abstraction (**L21**); provider registry slot(s) as needed.
- **ADR-028** (Application Framework Architecture).
- 18-principle mapping before code.

### Sprint 2 — Agentic workflow framework (PF)

- `platform/ai/agent.ts`: tool registry (extends the Phase 4 agent runtime), multi-step execution, durable state, rollback (ADR-017 §7).
- Conformance kit; **ADR-029** (Agentic Workflow Framework).

### Sprint 3 — Agent User Experience / AUX (PF)

- Agent-native endpoint contracts over the app-framework + agent workflows: structured `intent` + `nextActions` responses, single-call surfaces, replacing flat human-facing JSON blobs (per `docs/AUX_DESIGN.md`).
- **ADR-030** (Agent User Experience).
- Reflect AUX deliverables into the ROADMAP Phase 5 body (currently only "+ AUX" in the summary row) once AUX_DESIGN.md is worked in full.

### Sprint 4 — Adaptive behavior + dynamic content generation (PF)

- LLM-driven adaptive AI behavior framework — consumers implement app-specific logic (opponents, tutors, assistants).
- AI-generated contextual content framework — consumers define content types and templates.

### Sprint 5 — Application-specific RAG + UGC screening (PF)

- Extend the Phase 4 RAG foundation with app-specific knowledge bases + context injection.
- User-generated content screening: route the new input surface through safety middleware (**Standing Rule 11** — no input surface ships unscreened).

### Sprint 6 — Multimodal AI (PF)

- Image/audio input in the provider interface; image generation (ADR-017 §8).
- Depends on **TASK-025** (ALB for ffmpeg-service stable URL) if the audio path leans on ffmpeg-service.

### Sprint 7 — Playform adoption

- Rewire SpikeApp onto `platform/app-framework`; consume the agent-native (AUX) contracts.
- **TASK-045:** rebase + grow Playform's GENAI_ROADMAP overlay; install the D3/D4 dual-repo guard.
- Playform's "game engine abstraction" overlay framing lives here (consumer-side).

### gate — Phase 5 exit (E1–E15)

- RAMPS Phase 5 assessment; **function coverage ≥ 84%** (RAMPS Phase 4 recommendation; currently PF 80.26%).
- PF v1.7.0 tag + GitHub Release; Playform sync + promote.

---

## ADR roster (planned)

| ADR     | Subject                            |
| ------- | ---------------------------------- |
| ADR-028 | Application Framework Architecture |
| ADR-029 | Agentic Workflow Framework         |
| ADR-030 | Agent User Experience (AUX)        |

> Next sequential ADR is **028**. Note: TASK-039's "ADR-021 candidate" tag is stale — ADR-021 is the social system.

---

## Coverage floors

| Repo                | Floor (stmts) |
| ------------------- | ------------- |
| platform-foundation | 88.54%        |
| Playform            | 89.45%        |

Function-coverage target ≥ 84% (phase goal). Coverage must never decrease between sprints.

---

## Standing rules in force this phase

- **L21:** every new app-framework / agent abstraction ships a conformance kit; the meta-test fails CI the moment a registry slot lands without one.
- **L12:** GenAI 18-principle mapping table before any code each sprint.
- **Build order:** PF first; Playform inherits via SHA-pinned auto-sync from PF main. `ROADMAP.md` and `GENAI_ROADMAP.md` are Playform-owned overlays (sync-excluded).
- **GOTCHA-52:** never modify a PF-synced file in Playform — fix in PF first.

---

_Last updated: June 21, 2026 (Phase 5 opened — entry gate N1–N8, 8-sprint plan)_
