# Code Sustainability Review — 22-Point Gate

> Portable checklist for evaluating code sustainability in any repository.
> Run at sprint boundaries, phase boundaries, or as a standalone audit.
>
> Origin: Datankare Engineering Standards
> Version: 1.0 — March 2026

---

## How to Use

### As a standalone audit

1. Copy this file into the repo under `docs/SUSTAINABILITY_CHECKLIST.md`
2. Review each point against the current codebase
3. Rate findings: Critical / High / Medium / Low
4. Document results in a findings report

### As a sprint/phase gate

1. Run both Part A and Part B against all code changed in the sprint
2. Critical/High: must fix before sprint ships
3. Medium: fix or formally defer with justification + phase assignment
4. Low: track, fix opportunistically
5. No sprint is complete until the gate passes

### As a Claude prompt

Paste the codebase (or key files) into a conversation with this instruction:

> Review this codebase against the 22-point sustainability checklist below.
> For each point, give a PASS / FINDING (with severity) / NOT APPLICABLE rating.
> List specific file:line references for any findings.
> Provide a summary table at the end.

Then paste Part A and Part B below.

---

## Phase Boundary Protocol

> Run at every phase boundary. No phase exits without completing the exit gate.
> No phase starts without completing the entry gate.

### Accessibility Gate (every sprint)

| #   | Check                                                                                        | Done |
| --- | -------------------------------------------------------------------------------------------- | ---- |
| A1  | All new/modified components have semantic HTML (labels, headings, landmarks)                 | [ ]  |
| A2  | All interactive elements keyboard-reachable (tab, Enter/Space, Escape)                       | [ ]  |
| A3  | All error messages have `role="alert"` and `aria-live="assertive"`                           | [ ]  |
| A4  | All forms have `aria-busy` during loading states                                             | [ ]  |
| A5  | No new `text-gray-600` or darker on dark backgrounds (WCAG AA contrast 4.5:1 minimum)        | [ ]  |
| A6  | All dynamic content changes announced via `aria-live` regions                                | [ ]  |
| A7  | All decorative elements have `aria-hidden="true"`, all meaningful elements have `aria-label` | [ ]  |
| A8  | axe-core E2E test passes with zero violations                                                | [ ]  |

> Run this gate on every sprint alongside the 22-point sustainability gate.
> Critical/High: must fix before sprint ships.
> Phase boundary: full manual screen reader pass (NVDA or VoiceOver) on all new UX.

### Phase Exit Gate (before marking a phase complete)

| #   | Check                                                                                                        | Done |
| --- | ------------------------------------------------------------------------------------------------------------ | ---- |
| E1  | All sprint sustainability gates passed (22-point, zero failures)                                             | [ ]  |
| E2  | RAMPS assessment written and committed (`docs/RAMPS_PHASE{N}_ASSESSMENT.md`)                                 | [ ]  |
| E3  | README.md updated to reflect current state (both repos)                                                      | [ ]  |
| E4  | ROADMAP.md updated — phase marked complete with dates, metrics recorded                                      | [ ]  |
| E5  | ROADMAP.md changelog entry added with version, date, author, changes                                         | [ ]  |
| E6  | All new ADRs committed and numbered sequentially                                                             | [ ]  |
| E7  | SECURITY_DEBT.md — no Critical/High items open (all fixed or formally deferred with next-phase deadline)     | [ ]  |
| E8  | All deferred items have explicit phase assignment in SECURITY_DEBT.md and ROADMAP.md deferred items registry | [ ]  |
| E9  | Platform-foundation tagged with semver release (`vX.Y.Z`)                                                    | [ ]  |
| E10 | GitHub Release created with release notes and "Set as latest release" checked                                | [ ]  |
| E11 | Both repos on main, CI green                                                                                 | [ ]  |
| E12 | Test counts and coverage recorded in ROADMAP.md phase metrics                                                | [ ]  |
| E13 | Sync workflow verified — consumer repos current with latest PF release                                       | [ ]  |
| E14 | Accessibility gate A1-A8 passed for all components modified in this phase                                    | [ ]  |
| E15 | Manual screen reader test on new UX surfaces (NVDA or VoiceOver)                                             | [ ]  |

### Phase Entry Gate (before starting a new phase)

| #   | Check                                                                                                                                          | Done |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| N1  | Previous phase exit gate fully complete                                                                                                        | [ ]  |
| N2  | ROADMAP.md reviewed — all planned deliverables for this phase confirmed or adjusted                                                            | [ ]  |
| N3  | Deferred items from previous phases reviewed — any that belong in this phase confirmed in scope                                                | [ ]  |
| N4  | Cross-phase fabric reviewed (ADR-014 Observability, ADR-015 GenAI-Native, ADR-016 Content Safety) — this phase's fabric deliverables confirmed | [ ]  |
| N5  | Prerequisites for this phase verified (e.g., infrastructure available, dependencies resolved)                                                  | [ ]  |
| N6  | Sprint plan created with task breakdown and sequencing                                                                                         | [ ]  |
| N7  | ROADMAP.md updated — phase status changed to "In Progress", start date recorded                                                                | [ ]  |
| N8  | ROADMAP.md changelog entry added for phase start                                                                                               | [ ]  |

---

## Sprint Documentation Gate (D1-D7)

> Run at the end of every sprint, before the final commit. No deliverable is handed off until all D1-D7 are verified.

| #   | Check                                                              | Done |
| --- | ------------------------------------------------------------------ | ---- |
| D1  | ROADMAP.md sprint status updated                                   | [ ]  |
| D2  | ROADMAP.md deferred items resolved/updated                         | [ ]  |
| D3  | GENAI_ROADMAP.md phase status + sprint count updated               | [ ]  |
| D4  | GENAI_ROADMAP.md sprint deliverables recorded                      | [ ]  |
| D5  | SECURITY_DEBT.md resolved items moved to audit trail               | [ ]  |
| D6  | README.md stats current (test count, module list, migration count) | [ ]  |
| D7  | PR has title + description per .github/pull_request_template.md    | [ ]  |

---

## Part A — Professional Engineering Standards Matrix (11 points)

### A1. Naming

- [ ] Intent-based names throughout (`sanitizeForPrompt`, not `process`)
- [ ] No generic names: `data`, `info`, `x`, `temp`, `result` (without context)
- [ ] Names communicate purpose without requiring comments
- [ ] Consistent naming conventions (camelCase for functions, PascalCase for components)

### A2. Documentation

- [ ] Comments explain **why**, not what
- [ ] Architecture Decision Records (ADRs) for significant choices
- [ ] File-level docstrings explain design principles where non-obvious
- [ ] No commented-out code left in production files

### A3. Placement

- [ ] Variables declared near their point of use
- [ ] Constants at module top, not scattered
- [ ] Helper functions defined before or after main exports (consistent)
- [ ] Imports organized: external → internal → types

### A4. Control Flow

- [ ] Guard clauses with early returns — no deep nesting
- [ ] Maximum 2 levels of nesting; 3+ requires justification
- [ ] No `else` after `return` (use guard clause pattern)
- [ ] Switch/case statements have default handlers

### A5. Redundancy

- [ ] No duplicated logic — Rule of Three applied
- [ ] Shared configuration in a single location (e.g., `shared/config/`)
- [ ] No magic numbers — named constants for all repeated values
- [ ] DRY applied thoughtfully (not prematurely abstracted)

### A6. Formatting

- [ ] Automated formatter (Prettier or equivalent) configured and enforced
- [ ] Linter configured and enforced in CI
- [ ] Zero warnings policy (or explicitly suppressed with justification)
- [ ] Consistent style — no manual formatting debates

### A7. Error Handling

- [ ] Fail-closed by default (when in doubt, reject/deny/block)
- [ ] Structured logging with correlation IDs (requestId)
- [ ] Every error path has a test
- [ ] No empty catch blocks — every error logged, raised, or explicitly returned
- [ ] User-facing errors are safe (no stack traces, no internal details)

### A8. Single Responsibility (SRP)

- [ ] No function exceeds 200 lines
- [ ] Each file has a single clear responsibility
- [ ] Components with 5+ useState hooks should extract custom hooks
- [ ] API routes follow consistent patterns (validate → process → respond)

### A9. Testing

- [ ] All code paths tested — including unlikely/error paths
- [ ] Coverage thresholds enforced in CI
- [ ] Tests written alongside code, not after
- [ ] E2E tests for critical user journeys
- [ ] Architectural invariant tests for design decisions (e.g., fail-closed)

### A10. State & Immutability

- [ ] No direct mutation of objects or arrays
- [ ] React state updated via setState, not direct assignment
- [ ] Server-side functions are pure or have explicit side effects
- [ ] No mutable global state

### A11. Performance

- [ ] No N+1 query patterns
- [ ] Parallel execution where possible (Promise.all)
- [ ] Timeouts on all external API calls
- [ ] No unbounded data fetching (pagination, limits)

---

## Part B — Generated Code Engineering Principles (11 points)

### B1. Nesting Depth

- [ ] Logic is one level deep where possible
- [ ] If more than two levels of nesting exist, there is documented justification
- [ ] Complex conditionals are extracted into named boolean variables or functions

### B2. Loop & Retry Caps

- [ ] Every loop has a known maximum iteration count
- [ ] Every retry mechanism has a cap and backoff strategy
- [ ] Every recursive function has a base case AND a depth limit
- [ ] Documented: "what happens when we hit the maximum?"

### B3. Resource Cleanup

- [ ] Database connections closed on every exit path (including errors)
- [ ] File handles closed in `finally` blocks
- [ ] AbortControllers and timers cleaned up
- [ ] Subscriptions and event listeners removed on unmount

### B4. Function Length

- [ ] No function longer than 40-60 lines of logic
- [ ] Decomposition is done upfront, not as a refactoring afterthought
- [ ] Long functions are split into focused helpers with descriptive names

### B5. Input Validation

- [ ] Preconditions asserted before function executes
- [ ] Postconditions verified after critical operations
- [ ] Assumptions are visible and loud (explicit checks, not silent defaults)
- [ ] Type checking at API boundaries (runtime, not just TypeScript)

### B6. Error Swallowing

- [ ] Every `catch` block does one of: log, raise, or explicitly return
- [ ] No empty `catch {}` blocks anywhere
- [ ] Error objects are captured (not discarded with parameterless catch)
- [ ] Unchecked return values are handled or explicitly ignored with comment

### B7. State Scoping

- [ ] State is scoped as locally as possible
- [ ] Dependencies passed explicitly (visible at call site)
- [ ] Module-level variables are immutable constants only
- [ ] No class-level mutable state unless justified

### B8. Side Effect Separation

- [ ] Clear structural separation: pure computation vs side effects
- [ ] Side-effectful functions are named to make the danger obvious
- [ ] No API calls or writes buried inside what appears to be a utility
- [ ] Database writes, network calls, and file I/O are in dedicated layers

### B9. Abstraction Depth

- [ ] Code can be read linearly without jumping between abstractions
- [ ] No unnecessary wrapper classes or factory patterns
- [ ] Composition is favored over inheritance
- [ ] After every generation: "can this be written more directly?"

### B10. Static Analysis in CI

- [ ] Linter configured to fail the build on violations
- [ ] SAST tool (Semgrep, CodeQL) running in CI
- [ ] Dependency vulnerability scanning (npm audit, Dependabot)
- [ ] Set up BEFORE code is written, not after

### B11. Edge Case Testing

- [ ] Tests cover failure modes, not just happy paths
- [ ] Unexpected input types tested (null, undefined, empty, oversized)
- [ ] Network failure and timeout scenarios tested
- [ ] Boundary conditions tested (empty arrays, max values, off-by-one)

---

## Findings Template

| #   | Point                  | Status         | Severity    | Details |
| --- | ---------------------- | -------------- | ----------- | ------- |
| A1  | Naming                 | PASS / FINDING | — / C/H/M/L |         |
| A2  | Documentation          |                |             |         |
| A3  | Placement              |                |             |         |
| A4  | Control Flow           |                |             |         |
| A5  | Redundancy             |                |             |         |
| A6  | Formatting             |                |             |         |
| A7  | Error Handling         |                |             |         |
| A8  | SRP                    |                |             |         |
| A9  | Testing                |                |             |         |
| A10 | State/Immutability     |                |             |         |
| A11 | Performance            |                |             |         |
| B1  | Nesting Depth          |                |             |         |
| B2  | Loop/Retry Caps        |                |             |         |
| B3  | Resource Cleanup       |                |             |         |
| B4  | Function Length        |                |             |         |
| B5  | Input Validation       |                |             |         |
| B6  | Error Swallowing       |                |             |         |
| B7  | State Scoping          |                |             |         |
| B8  | Side Effect Separation |                |             |         |
| B9  | Abstraction Depth      |                |             |         |
| B10 | Static Analysis in CI  |                |             |         |
| B11 | Edge Case Testing      |                |             |         |

**Summary:** **_ of 22 pass. _** findings (**_ Critical, _** High, **_ Medium, _** Low).

---

## License

This checklist is open for use. Attribution appreciated: Datankare Engineering Standards.
