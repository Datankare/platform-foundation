# Sustainability Review — Claude Prompt

> Copy everything below this line and paste it into a Claude conversation
> along with the codebase files you want reviewed.

---

You are performing a 22-point Code Sustainability Review against the codebase I'm providing. This is a professional engineering audit, not a surface scan.

For each of the 22 points below, evaluate the codebase and rate it:

- **PASS** — meets the standard
- **FINDING** — with severity (Critical / High / Medium / Low), specific file:line references, and a concrete fix
- **N/A** — not applicable to this codebase (with brief explanation)

Be honest and specific. "Looks good" is not an assessment. Cite specific files and line numbers for every finding. If you're uncertain about a rating, explain your reasoning.

## Part A — Professional Engineering Standards Matrix

**A1. Naming:** Are names intent-based? No generic names (data, info, x, temp). Names communicate purpose without requiring comments.

**A2. Documentation:** Do comments explain why, not what? Are architecture decisions recorded? No commented-out code in production files.

**A3. Placement:** Variables declared near use? Constants at module top? Imports organized consistently?

**A4. Control Flow:** Guard clauses with early returns? Maximum 2 levels of nesting? No else after return?

**A5. Redundancy:** No duplicated logic? Shared config for repeated values? No magic numbers?

**A6. Formatting:** Automated formatter configured and enforced in CI? Zero warnings?

**A7. Error Handling:** Fail-closed by default? Structured logging with correlation IDs? Every error path tested? No empty catch blocks? User-facing errors safe (no stack traces)?

**A8. SRP:** No function over 200 lines? Single responsibility per file? Components with 5+ useState extract hooks?

**A9. Testing:** All paths tested including error paths? Coverage thresholds in CI? Architectural invariant tests?

**A10. State & Immutability:** No direct mutation? Pure functions preferred? No mutable global state?

**A11. Performance:** No N+1 patterns? Parallel where possible? Timeouts on external calls?

## Part B — Generated Code Engineering Principles

**B1. Nesting Depth:** One level deep where possible. Two levels require justification.

**B2. Loop/Retry Caps:** Every loop, poll, retry has a maximum. What happens at the cap?

**B3. Resource Cleanup:** Follow every exit path. Does it close what it opened?

**B4. Function Length:** No function longer than 40-60 lines. Decomposition upfront, not afterthought.

**B5. Input Validation:** Preconditions before execution. Postconditions after. Assumptions visible and loud.

**B6. Error Swallowing:** Every catch block logs, raises, or returns. Nothing swallowed. Ever.

**B7. State Scoping:** State scoped locally. Dependencies passed explicitly. Data flow visible at every call site.

**B8. Side Effect Separation:** Pure computation vs side effects clearly separated. Dangerous operations visible and named.

**B9. Abstraction Depth:** Can it be written more directly? Linear composition over elegant decoding.

**B10. Static Analysis in CI:** Linter failing on violations. SAST running. Dependency scanning. Set up before code, not after.

**B11. Edge Case Testing:** Tests cover failure modes. Unexpected inputs tested. Network failures tested. Boundary conditions tested.

## Output Format

Provide your assessment as:

1. A summary table with all 22 points rated
2. Detailed findings for anything rated FINDING (with severity, file:line, fix)
3. A strengths section (what's done well)
4. A recommended fix order (prioritized by severity and effort)

Rate the overall codebase: how many of 22 pass, how many findings by severity.
