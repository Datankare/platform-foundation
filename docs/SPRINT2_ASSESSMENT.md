# Sprint 2 Assessment — Phase 5, Agentic Workflow Framework

**Sprint:** Phase 5, Sprint 2
**Scope:** ADR-029 (agentic workflow framework) + ADR-031 (action lifecycle protocol)
**Assessed:** August 4, 2026

---

## Gates run

Three gates run at sprint closure. E1–E15 is the PHASE exit gate and is not run — Phase 5 is
not complete, Sprint 2 of it is.

| Gate                 | Points              | Result                                    |
| -------------------- | ------------------- | ----------------------------------------- |
| Sustainability       | 22 (A1–A11, B1–B11) | PASS with 1 finding, fixed in sprint      |
| Accessibility        | 8 (A1–A8)           | N/A — no component or `.tsx` file touched |
| Sprint documentation | 7 (D1–D7)           | PASS — this commit                        |

---

## Delivery

| Metric              | Phase 4 close | Sprint 2 close | Delta  |
| ------------------- | ------------- | -------------- | ------ |
| Test suites         | 154           | 186            | +32    |
| Tests               | 2,089         | 2,407          | +318   |
| Statement coverage  | 88.54%        | 89.18%         | +0.64  |
| Branch coverage     | 75.90%        | 76.96%         | +1.06  |
| Function coverage   | 80.26%        | 91.91%         | +11.65 |
| Line coverage       | 89.78%        | 90.22%         | +0.44  |
| ADRs                | 27            | 30             | +3     |
| Registry slots      | 14            | 18             | +4     |
| Conformance kits    | 16            | 23             | +7     |
| Supabase migrations | 21            | 30             | +9     |

Coverage thresholds now enforced in CI at lines 80 /
functions 84 / branches 75 —
raised this sprint from 80/80/70, which sat far enough below what was held that a commit
could drop several points and still pass.

---

## 22-point sustainability gate

**Measured** — the count is the verdict.

| #   | Point                 | Status              | Evidence                                                                                                  |
| --- | --------------------- | ------------------- | --------------------------------------------------------------------------------------------------------- |
| A6  | Formatting            | PASS                | prettier + eslint enforced in CI, zero warnings                                                           |
| A7  | Error handling        | PASS                | 0 empty catch blocks; 2 catches opening with a justification comment                                      |
| A8  | SRP                   | PASS                | 0 functions over 200 lines                                                                                |
| A9  | Testing               | PASS                | thresholds enforced in CI; every new store has a conformance arm                                          |
| A10 | State & immutability  | PASS                | 2 module-level `let`, both documented singletons                                                          |
| A11 | Performance           | **FINDING — FIXED** | 55 bare `await fetch(` with no timeout across 14 files; all routed through `fetchWithTimeout` this sprint |
| B2  | Loop & retry caps     | PASS                | every retry named and bounded; 0 `while (true)`                                                           |
| B4  | Function length       | PASS with note      | 8 functions over 60 lines, each a governed sequence whose steps are order-dependent                       |
| B6  | Error swallowing      | PASS                | 0 empty catches                                                                                           |
| B7  | State scoping         | PASS                | module-level mutable state is singletons only                                                             |
| B10 | Static analysis in CI | PASS                | typecheck, lint, format, coverage, prod dependency audit — all present                                    |

**Judged** — evidence reviewed.

| #   | Point                  | Status | Notes                                                                                                                                    |
| --- | ---------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Naming                 | PASS   | `executeActionPipeline`, `proposeOnce`, `approveWithReconciliation`, `repairSession`, `mostRestrictiveCeiling` — intent-based throughout |
| A2  | Documentation          | PASS   | every new module carries a header stating what it is and why; ADR decisions cited at the code that implements them                       |
| A3  | Placement              | PASS   | new modules follow the existing convention: constants at top, imports external → internal → types                                        |
| A4  | Control flow           | PASS   | 1 line indented 12+ spaces across the whole sprint                                                                                       |
| A5  | Redundancy             | PASS   | the pipeline extraction removed a duplicated commit sequence; two adapters now share one implementation                                  |
| B1  | Nesting depth          | PASS   | see A4                                                                                                                                   |
| B3  | Resource cleanup       | PASS   | no handles or sockets opened; `fetchWithTimeout` owns AbortController lifecycle                                                          |
| B5  | Input validation       | PASS   | ajv at both tool edges — schemas were descriptive before this sprint and are enforced now                                                |
| B8  | Side-effect separation | PASS   | `action-pipeline/risk.ts` is pure; the committing sequence is separate and named                                                         |
| B9  | Abstraction depth      | PASS   | kernel → action-pipeline → adapters reads linearly; the layering removed a cycle rather than adding indirection                          |
| B11 | Edge case testing      | PASS   | indeterminate, CAS conflict, retry-finds-predecessor, refusal, stale approval and crash-window arms all present                          |

---

## Security

| Item                                        | Severity | Resolution                                                                                             |
| ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| GHSA-rgw5-rvv9-x895 brace-expansion DoS     | High     | Override corrected 5.0.8 → 5.0.9. The existing override was pinning the tree to the vulnerable version |
| GHSA-7p8r-x3mc-p8w7 fast-uri host confusion | High     | `npm update` to 3.1.5, in-range                                                                        |
| GHSA-2v37-7h3g-55p8 nanoid infinite loop    | High     | `npm update` to 3.3.18 via postcss, in-range                                                           |
| A11 — 55 calls without timeouts             | Medium   | All routed through `fetchWithTimeout`, `maxRetries: 0` to protect CAS commits from double-apply        |

The hard production audit gate caught all three advisories before merge. That is the gate
earning its cost — it also blocked the sprint for a day when an override was misdiagnosed.

---

## Process findings

Recorded as gotchas because the sprint produced them, not because they are comfortable.

| #   | Finding                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 66  | A PostgREST fetch fake validates a store against itself, not against the schema. A migration referenced a column that did not exist; the gate was green and it failed on first call |
| 67  | Query `applied_migrations` before writing or applying a migration — three were applied by hand with no record before the tracking table existed                                     |
| 68  | A pinned override can pin you to the vulnerable version. Roughly a day was lost to reading a second override as npm ignoring the first                                              |
| 69  | Track every ADR decision from the moment the ADR is read, and report what a commit LEAVES as explicitly as what it does                                                             |

Gotcha 69 is the significant one. ADR-029's ten decisions were mapped to steps at the outset
and ADR-031's nine were not. Five decisions shipped as anchors without implementations —
`observedVersion` with a comment naming it the stale-approval anchor and nothing comparing it,
`producedBy` as the repair anchor with nothing reading it, an effect ledger no production code
called — and surfaced at the conformance step as though newly discovered. They were omissions
being reported as discoveries. All five were closed this sprint.

---

## Carried, explicitly

| Task         | Item                                | Why it is open                                                                                                                    |
| ------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| TASK-068     | Automatic compensation unwind       | Deferred on stated criteria; none of the three trigger signals has fired, and building it now means inventing semantics           |
| TASK-072     | Turn advancement in the coordinator | `dispatch()` checks turn order and does not advance it, so persisted turn state depends on the caller calling `updateSessionMeta` |
| TASK-069/070 | Override hygiene                    | No override records why it exists or what would allow its removal                                                                 |
| TASK-057…064 | Pre-existing                        | Carried from Sprint 1 and Phase 4                                                                                                 |

---

_Assessed by: Raman Sud, CTO_
_Date: August 4, 2026_

_Last updated: August 4, 2026 (Phase 5 Sprint 2 closure)_
