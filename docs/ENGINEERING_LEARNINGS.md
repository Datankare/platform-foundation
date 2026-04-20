# Engineering Learnings

> Living document. Captures principles adopted from industry articles, our own failures, and patterns we discover.
> Each entry: what we learned, where it came from, how we adopted it, and what it changed.
>
> **Rule:** Before adding a new entry, answer: "Does this change how we build?" If no, skip it.

---

## How to Use This File

**For Raman:** When you read an article that passes the "changes how we build" test, add a brief entry below with the source link and one sentence on why it matters. We'll discuss and formalize in the next session.

**For Claude (AI sessions):** Read this file at session start alongside ROADMAP.md and GENAI_MANIFESTO.md. These learnings inform how code is written, not just what code is written.

---

## Adopted Principles

### L1: State Assumptions Before Acting

**Source:** Andrej Karpathy's CLAUDE.md observations (Jan 2026), via Forrest Chang's `andrej-karpathy-skills` repo.

**Problem it fixes:** LLMs silently pick an interpretation and run with it. In our case: test mock mismatches (e.g., `checkBlocklist` vs `scanBlocklist`), wrong class names (`MemoryCacheProvider` vs `InMemoryCacheProvider`), missing constructor params (`HealthRegistry` needs a version string).

**How we adopted it:** Before writing code that touches existing modules, read the actual exports and type signatures first. State what we're assuming. If there are multiple possible interpretations, surface them before proceeding.

**What it changed:** Sprint 6 integration tests required three rounds of fixes because assumptions about module APIs were wrong. This rule prevents that.

---

### L2: Minimal Change Surface

**Source:** Karpathy's CLAUDE.md, reinforced by our own `middleware.ts` sync collision and multiple sed commands touching wrong files.

**Problem it fixes:** Changing code you weren't asked to change. Side effects in patches. Rename operations that miss import references.

**How we adopted it:** "Read file before str_replace" (existing rule) + "state what you'll change and why before editing." Every changed line must trace to the request.

**What it changed:** Reduced fix-after-fix cycles. When the change surface is explicit, both human and AI can verify scope before applying.

---

### L3: Quality Gate as Success Criteria

**Source:** Karpathy's "Goal-Driven Execution" principle: define success criteria, loop until verified.

**Problem it fixes:** Vague "make it work" goals that require constant clarification. Code that passes one check but fails another.

**How we adopted it:** Our 22-point sustainability gate + `typecheck && lint && test` pipeline is exactly this. The gate IS the success criteria. No sprint ships without it. Added Phase 2: 8-point Accessibility Gate (A1-A8), coverage-must-not-decrease rule, incremental k6 load testing.

**What it changed:** Zero regressions shipped to main across 7 sprints. The gate catches everything before merge.

---

### L4: Provider Abstraction Over Direct Integration

**Source:** Our own architectural evolution (Phase 1-2). Reinforced by "The Agent-Native Rewrite" (Rodriguez, The Sequence Opinion #840, March 2026).

**Problem it fixes:** Vendor lock-in. Untestable code. Configuration scattered across files.

**How we adopted it:** Every external dependency gets an interface: AuthProvider, CacheProvider, AIProvider, ErrorReporter, RealtimeProvider, TranslationProvider (Phase 3), TTSProvider (Phase 3), STTProvider (Phase 3). Swap via env var. Mock for tests.

**What it changed:** 100% of tests run without external services. Provider swap = config change, not rewrite.

---

### L5: Agentic-Native From Day One

**Source:** Rodriguez, J. (2026). "The Agent-Native Rewrite." The Sequence Opinion #840.

**Problem it fixes:** Retrofitting agent support into systems designed for humans only. Schema migrations, identity model rewrites, authorization rethinking — all expensive.

**How we adopted it:** GenAI Manifesto P15-P18. Every RealtimeMessage carries agent identity, intent, trajectory, and memory hints. These fields activate when agents arrive — no migration needed.

**What it changed:** Phase 5 agent integration will be a configuration exercise, not an architecture rewrite.

---

### L6: Accessibility Is Not Optional

**Source:** Our own Phase 2 close audit. WCAG AA compliance gaps found in 9 components.

**Problem it fixes:** Shipping UI that screen readers can't navigate, forms that assistive tech can't operate, contrast ratios that fail for low-vision users.

**How we adopted it:** 8-point Accessibility Gate (A1-A8) required every sprint. E14/E15 in phase exit gate. `aria-live`, `aria-busy`, `role` attributes are not nice-to-haves — they're gating.

**What it changed:** 17 fixes across 9 components in Sprint 6. Accessibility is now as non-negotiable as test coverage.

---

### L7: Long Sessions Drift — Front-Load Critical Rules

**Source:** Rezvani, A. (2026). "Andrej Karpathy's CLAUDE.md: What Each Principle Really Fixes." Medium.

**Problem it fixes:** In long AI-assisted sessions, instructions from the beginning of context get de-prioritized as the window fills. Principles that worked in the first hour quietly stop working by hour three.

**How we adopted it:** Critical standing rules (quality gate, build order, test-alongside-code) are loaded via memory at session start, not buried in docs. For multi-sprint sessions, we start fresh conversations rather than extending stale ones. Compaction summaries preserve key rules.

**What it changed:** Explains why we've had more errors in late-session work (e.g., Sprint 6 integration test type mismatches happened deep into a long session). Reinforces our practice of starting fresh sessions for new sprints.

---

### L8: Project Rules Before Behavioral Principles

**Source:** Rezvani, A. (2026). Same article. "I ended up putting Karpathy's principles after my project-specific rules. Project rules establish what this codebase is, behavioral principles establish how to behave inside it."

**Problem it fixes:** When behavioral guidelines (be simple, be surgical) load before project-specific rules (use provider abstraction, tests alongside code, 22-point gate), the AI treats project rules as advisory rather than mandatory.

**How we adopted it:** Our standing rules already load first via memory. ENGINEERING_LEARNINGS.md is a reference doc, not a system prompt. This is the correct order. Standing rules > project conventions > general principles.

**What it changed:** Validates our current approach. No process change needed, but worth documenting why the order matters.

---

### L9: Living Documents Go Stale — Review at Phase Boundaries

**Source:** Rezvani article + Karpathy's own admission: "I had not figured out a good way to keep CLAUDE.md updated."

**Problem it fixes:** Engineering principles and standing rules accumulate but never get pruned. New conventions emerge, old rules become irrelevant or contradictory, and the gap between documentation and practice becomes its own source of bugs.

**How we adopted it:** ENGINEERING_LEARNINGS.md, GENAI_MANIFESTO.md, and standing rules are reviewed at every phase boundary as part of the N4 entry gate check. Stale entries are updated or removed. "Last updated" date tracked at bottom of file.

**What it changed:** Prevents documentation rot. Each phase boundary is a natural checkpoint to ask: "Is everything in this file still true?"

---

### L10: Claude.ai vs Claude Code — Know What Each Tool Costs You

**Source:** Our own workflow analysis after 7 sprints across Phase 2 (April 2026).

**Problem it fixes:** Choosing the wrong AI-assisted development workflow without understanding the tradeoffs. Both tools have real strengths; neither is strictly better.

**What Claude.ai costs us (friction):**

- **No autonomous file operations.** Every file edit requires generating scripts/patches, human copy-paste, and running manually. Claude Code reads/writes files directly in the repo.
- **No autonomous test-fix loops.** Claude Code runs tests, sees failures, fixes, re-runs until green — one pass. We do this across multiple messages. Sprint 6 integration tests took 4 fix rounds that Claude Code would have self-corrected.
- **No git operations.** We compose git commands, human pastes them. Zsh comment syntax (`#`) causes failures regularly. Claude Code branches, commits, pushes natively.
- **No live file reading.** Every type mismatch we hit (`MetricEvent.value` vs `.values`, `blocked` vs `matched`, `MemoryCacheProvider` vs `InMemoryCacheProvider`) happened because the AI couldn't read the actual file — it had to ask the human to run `grep`/`head`/`sed -n`.
- **Session context limits.** Long sessions get compacted. Context drifts. Standing rules weaken over time (see L7).

**What Claude.ai gives us (safety + depth):**

- **Human review on every change.** Nothing lands without verification. Zero regressions shipped to main across 7 sprints. Claude Code can make bad decisions autonomously at speed.
- **Architectural discussion.** Phase planning, RAMPS assessments, risk analysis (song ID costs/privacy), article analysis (Karpathy) — this depth of conversation doesn't happen naturally in Claude Code, which is biased toward "do this task."
- **Document generation.** ADRs, manifesto, sprint plans, ENGINEERING_LEARNINGS — Claude Code is weaker at long-form structured documents.
- **Cross-session memory.** Claude Code has CLAUDE.md but no memory of project history, preferences, or past decisions. Claude.ai carries context about the full project evolution.
- **Deliberate pace.** Every mistake gets caught before committing. The "A is for Accessibility" correction, the coverage regression flag, the middleware.ts sync collision — all caught because a human reviewed before applying.

**How we adopted it:** Continue using Claude.ai for planning, architecture, review, and document generation. If autonomous coding speed becomes a bottleneck, consider Claude Code for sprint execution with Claude.ai for oversight. The two tools are complementary, not competing.

**Future plan:** Evaluate hybrid workflow — Claude Code for mechanical coding tasks (file creation, test loops, git operations) under a CLAUDE.md that encodes our standing rules, with Claude.ai for architecture decisions, phase planning, and quality review. Not urgent — current workflow delivers reliably, just slower on mechanical steps.

---

### L11: Read Consumer Code Before Building Platform Abstractions

**Source:** Our own Phase 3 Sprint 2 experience (April 2026).

**Problem it fixes:** Building platform abstractions based only on PF's simplified code produces interfaces that are too narrow for the actual consumer. PF had 3 voice configs; Playform had 10. PF had no STT; Playform had full transcription with auto-detect.

**How we adopted it:** Before building any new PF module, always check Playform's implementation of the same feature. The consumer has the richer code — the abstraction must capture that full surface, not just PF's skeleton. Standing rule: "Read Playform before building PF abstraction."

**What it changed:** Sprint 2 voice provider was built to match Playform's full voice surface (10 languages, STT with auto-detect, content extraction routing) rather than PF's 3-language TTS-only skeleton.

---

### L12: The GenAI Mapping Table Is a Pre-Flight Checklist, Not a Planning Document

**Source:** Our own Phase 3 Sprint 3 near-miss (April 2026).

**Problem it fixes:** Skipping the 18-principle mapping table because "I already know the principles." Sprint 3's initial pipeline implementation missed P15-P18 entirely — the agentic principles. The pipeline was an autonomous agent acting on behalf of users, but had no agent identity, no cognitive memory, no intents, and no trajectories. The gap was only caught because the human asked "have we checked all our GenAI principles?" If not caught, the pipeline would have shipped non-agentic and required expensive retrofitting.

**How we adopted it:** The mapping table is now mandatory before any code, every sprint. It checks ALL 18 principles — not just the ones that feel relevant. The principles you skip are the ones that bite. Pilots don't skip the checklist because they've flown before. The value isn't in knowing the items — it's in forcing verification against the actual implementation.

**Standing rule:** Every sprint starts with a complete 18-principle mapping table. No exceptions. If a principle doesn't apply, mark it "—" with a reason. The table is the first output of the sprint, before any file is created.

---

### L13: Design for Agents Running Your Platform, Not Just On It

**Source:** Dharmesh Shah (simple.ai@dharmesh), "Why Agents Need Their Own Interface" (April 2026).

**Problem it fixes:** Exposing granular API endpoints and expecting agents to chain them together. An agent calling `/api/process`, `/api/stream`, `/api/extract`, `/api/tts` separately must reason about workflow, handle errors, retry stale data, and burn tokens re-discovering the orchestration logic every time. This is bad AUX (Agent User Experience).

**The insight:** There are two levels of agentic design:

1. **Agents running ON your platform** — agents can call your APIs. This is table stakes.
2. **Agents running your platform** — the platform exposes workflow-level tools that encapsulate complete workflows. One call = one complete workflow. The platform returns structured results with `nextActions` so agents know what's possible without reasoning from scratch.

**Example — bad AUX (current):**

```
Agent calls: /api/process → parse response → /api/tts → handle error → retry → /api/extract
Five API calls + all error handling per interaction. Agent reasons through it every time.
```

**Example — good AUX (target):**

```
Agent calls: /api/agent/process-content { intent: "translate", input: audio, targetLanguages: ["es"] }
Platform returns: { trajectory, results, nextActions: ["translate-more", "done"], cost }
```

**How we adopted it:** Added to Phase 5 planning as a first-class design goal. Created `docs/AUX_DESIGN.md` to capture the AUX surface before building it. Every new API endpoint is now evaluated against: "Could an agent call this as a single workflow, or does it require multi-call orchestration?"

**Standing rule:** Every endpoint designed from Phase 4 onward must have an AUX assessment: what would an agent need to call to accomplish this workflow in one shot? If the answer is "multiple endpoints + reasoning," design a workflow-level tool.

---

### L14: Pre-Flight Rule — Read Before Write, Every Time

**Source:** Phase 3, Sprint 4 Playform wiring — 6 consecutive failures in a single session.

**Problem it fixes:** Late in a long session, Claude begins making assumptions about file structure, import patterns, test directives, and type compatibility without reading the actual code. The result is a cascade of failures: wrong jest environment, missing mock signatures, incorrect type assertions, broken component wiring. Each fix introduces new assumptions that cause the next failure.

**The insight:** The root cause is always the same — writing code based on what Claude _remembers_ the file looks like, not what it _actually_ looks like. Memory degrades over long sessions (L7), but the pre-flight rule catches it regardless of session length.

**The rule — before creating or modifying ANY file, Claude must:**

1. **Read** an existing file of the same type in the target repo to verify patterns (test directives, import style, type compatibility, mock signatures)
2. **State** any assumptions being made
3. **Verify** the quality gate command includes coverage check

**Why this is L14 and not just L1 restated:** L1 says "state assumptions." L14 says "don't assume at all — read the file first." L1 is about honesty; L14 is about preventing the situation where assumptions are needed. Reading eliminates the assumption.

**How we adopted it:** Added as a permanent standing rule in the session handoff document and enforced from Phase 4 onward. Skipping any step is an L1/L7 violation. If late in a long session, this rule applies with MORE rigor, not less.

**Standing rule:** Before creating or modifying ANY file, read an existing file of the same type first. No exceptions. No "I remember what it looks like." Read it.

### L15: Adversarial Review — Three Hostile Personas, No LGTM Allowed

**Source:** Alireza Rezvani, "Claude Code Skills Field Report" (April 2026). Adversarial code reviewer skill with three forced personas.

**Problem it fixes:** Sustainability gates and checklists verify _presence_ of things (tests exist, coverage held, types pass). They do not force _hostile scrutiny_ — asking what breaks at 3am, whether a new hire can maintain this, or whether there is an injection vector. The Phase 3 Sprint 4 failure (6 consecutive failures on Playform wiring) would have been caught by a New Hire persona asking "can someone with no context understand how SpikeApp assembles its components?"

**The three personas (all mandatory, each MUST find at least one issue):**

1. **Saboteur** — what breaks in production at 3am? Race conditions, retries without idempotency, silent failures, unbounded collections, circuit breaker gaps.
2. **New Hire** — can someone with no context maintain this in six months? Variable names, function length, missing "why" comments, implicit coupling between modules, undocumented assumptions.
3. **Security Auditor** — OWASP top ten, then environment secrets. Input validation at every boundary, injection vectors, hardcoded credentials, CORS misconfigurations.

**Rules of engagement:**

- Each persona MUST surface at least one finding — no "LGTM" allowed
- Findings classified as BLOCK (must fix before merge), CONCERN (should fix, tracked), or NOTE (informational)
- Duplicate findings from two personas are promoted one severity level
- Final verdict: BLOCK / CONCERNS / CLEAN

**How we adopted it:** Added to sprint close process. Before any sprint closes, run the 3-persona adversarial review on the sprint's code. Especially critical for agent-to-agent interactions where edge cases hide in the communication paths.

**Standing rule:** Every sprint close includes a 3-persona adversarial review. No persona may return "LGTM."

### L16: The 30/60 Day Doc Freshness Rule

**Source:** Alireza Rezvani, "Claude Code Skills Field Report" (April 2026). 30-day audit, 60-day delete rule adapted for documentation.

**Problem it fixes:** L9 says "Living Documents Go Stale — Review at Phase Boundaries." But phase boundaries can be 2-4 weeks apart, and some docs drift between phases without anyone noticing. SERVICE_ACCOUNTS.md was not even in the expected directory when we looked for it. AUX_DESIGN.md was written in Phase 3 but will not be actively used until Phase 5 — by then it may be half-wrong. Staleness is time-based, not event-based.

**The rule:**

- Every doc in `docs/` must have a `_Last updated:` footer with a date.
- At every **sprint boundary**: scan for any doc not updated in 30+ days. Verify it is still accurate. Update the footer if confirmed current, or fix the content.
- At every **phase boundary**: flag any doc not updated in 60+ days for refresh. Docs that are 60+ days stale must be re-read and either updated to reflect current state or explicitly confirmed as still accurate with a new date.

**What this is NOT:** This is not an archiving or deletion rule. No doc is deleted based on age alone. The rule forces a freshness check, not a purge.

**How we adopted it:** Added to sprint documentation gate (D1-D7) and phase exit gate (E1-E15). The `_Last updated:` footer is the trigger — if it is missing, add it. If it is old, verify.

**Standing rule:** At sprint close, verify every doc with `_Last updated:` older than 30 days. At phase boundary, docs older than 60 days must be refreshed.

### L17: Module-Level Gotchas — Scar Tissue Where It Matters

**Source:** Alireza Rezvani, "Claude Code Skills Field Report" (April 2026). "The Gotchas section is the most valuable content in any skill."

**Problem it fixes:** Our gotchas are centralized in ENGINEERING_LEARNINGS.md (global patterns) and the session handoff "Things That Trip Us Up" (session-specific). Both are global. When Claude is writing a new test in `platform/social/`, the relevant gotcha — "jest.mock needs generateRequestId" — is buried in a global list, not visible in the module context. L14 (pre-flight rule) mitigates this by forcing a read of existing files, but a module-level gotchas section is more direct.

**The rule:**

- Each `platform/` module maintains a `## Gotchas` section at the bottom of its `index.ts` JSDoc or in a `GOTCHAS.md` file within the module folder.
- When a bug is found during development, the fix goes into:
  1. The **module-level** gotchas (if module-specific — e.g., "SentryErrorReporter requires @sentry/nextjs as peer dependency")
  2. The **global** ENGINEERING_LEARNINGS.md (if it is a cross-cutting pattern — e.g., "always mock generateRequestId")
- Module gotchas are the **first thing read** during pre-flight (L14). Before writing any code in a module, read its gotchas section.
- Gotchas grow over time. They are never pruned. Each entry includes: what broke, why, and the fix.

**How we adopted it:** Starting Phase 4, every new module (`platform/social/`, `platform/agents/`) ships with a Gotchas section from day one. Existing modules get gotchas sections added as bugs are encountered.

**Standing rule:** Every `platform/` module maintains a Gotchas section. Module-specific bugs go there first, global patterns go to ENGINEERING_LEARNINGS.md.

---

## Noted (Not Yet Adopted)

_Entries here are interesting but haven't passed the "changes how we build" test yet._

<!-- Add future candidates here with source link + one sentence on why it might matter -->

---

## Reading Queue

_Articles Raman has flagged for discussion. Processed entries move to "Adopted" or "Noted" above._

| Date       | Source                                                                                                                                      | Topic                                   | Status                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 2026-04-13 | [Karpathy's CLAUDE.md analysis](https://alirezarezvani.medium.com/andrej-karpathys-claude-md-what-each-principle-really-fixes-20b159b4b582) | Four principles for LLM coding behavior | ✅ Processed → L1, L2, L3                                                                                     |
| 2026-03-26 | [The Agent-Native Rewrite](https://thesequence.substack.com/) (Rodriguez, Opinion #840)                                                     | Agent-native architecture vs bolt-on    | ✅ Processed → L5, P15-P18                                                                                    |
| 2026-04-18 | [Claude Code Skills Field Report](https://alirezarezvani.medium.com) (Rezvani)                                                              | Skills at small-team scale              | ✅ Processed → L15, L16, L17                                                                                  |
| 2026-04-19 | [Claude Code /powerup: 10 Built-In Lessons](https://alirezarezvani.medium.com) (Rezvani)                                                    | In-tool discoverability, effort tiers   | ✅ Noted → PHASE4_PLAN (4b effort tier), AGENT_ARCHITECTURE (Concierge UI constraint), AdaptiveInput tooltips |

---

_Last updated: April 19, 2026 (Rezvani /powerup article processed)_
