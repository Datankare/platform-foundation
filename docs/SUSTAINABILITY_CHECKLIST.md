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
