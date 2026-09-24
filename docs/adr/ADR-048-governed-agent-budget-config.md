# ADR-048: Governed Agent Budget & Durability Configuration

Status: Proposed (Phase 5 Sprint 6.5). Decision maker: Raman Sud.
Related: ADR-031 (action-identity lifecycle $\u2014 effect-ledger), ADR-035 (GenAI-native governance admin), ADR-039/040 (agent registry unification / held-action dual-control), TASK-062/063 (trajectory + budget durability), TASK-046 (live re-baseline). `platform/agents/agent-configs.ts`, `platform/agents/budget-tracker.ts`, `platform/providers/registry.ts`, `platform/admin/config-handlers.ts`.

---

## 1. The end state

An agent's daily cost cap, per-trajectory step cap, and the durability of its budget/trajectory stores are **governed configuration**, not compile-time constants or a bare environment default. Caps are read from the permission-tiered config store at spend time, editable through the ADR-035 GenAI-native admin under RBAC, with raising a catastrophic cap guarded by dual-control (ADR-039/040). The durable store is required in production and fails closed. The hardcoded values in `agent-configs.ts` become the seeded defaults, not the only source of truth.

This closes the gap found verifying TASK-062/063: the durability fix is correct and conformance-tested, but enforcement was **opt-in** (store selection defaulted to in-memory) and the caps were **unconfigurable** (hardcoded per-agent-class constants $\u2014 no admin surface, no RBAC, no approval). The mechanism existed; governance over it did not.

## 2. Decisions

**D1 $\u2014 Budget caps are governed config, read at spend time.** `maxCostPerDay` and `maxStepsPerTrajectory` move from `agent-configs.ts` constants into the permission-tiered config store (P13). The budget tracker + runtime read the governed value, falling back to the seeded default when unset $\u2014 not the constant. The current values ($10/$5 per day; 10/15 steps) are the seeded defaults.

**D2 $\u2014 Raising a cap is dual-control-guarded.** The cost-cap keys join `config.dual_control_keys` (ADR-039/040): raising a daily spend ceiling is a catastrophic-spend action requiring an independent human hold, exactly as signups and moderation thresholds are today. Lowering a cap (tightening) is a standard permission-tiered edit.

**D3 $\u2014 The durable store is required in production, fail-closed.** Rather than flip the global default (which would break the in-memory test/local path), a production-context guard refuses to boot the runtime on an in-memory budget/trajectory store: in a production context with `TRAJECTORY_STORE`/`BUDGET_STORE` unset or `memory`, initialization throws $\u2014 the same fail-closed stance the Supabase path already takes on missing creds. Tests and local keep the in-memory default. A deployment can no longer silently run the TASK-062/063 condition.

**D4 $\u2014 Admin surface + RBAC.** Budget/cost config is exposed through the ADR-035 governed-config admin (search / review / edit) under the existing permission tiers (P13) $\u2014 the same surface that governs moderation and approval policy. There is no bespoke budget screen; it is a governed config category.

**D5 $\u2014 Conformance (L21).** A kit asserts: the governed cap (not the constant) is what the tracker enforces; an unset cap falls back to the seeded default; raising a cap routes through dual-control; the production guard fails closed on an in-memory store. Live binding across serverless instances remains **TASK-046** (Sprint 7, needs a deploy) $\u2014 out of scope here, named as an exit dependency.

## 3. Alternatives considered

(a) **Leave caps as constants, document them** $\u2014 rejected: unbounded-spend governance shouldn't require a code change + deploy, and the caps are invisible to the admin who owns cost.

(b) **A bespoke budget admin screen** $\u2014 rejected: duplicates the ADR-035 governed-config surface + its RBAC/dual-control. Budget is a config category, not a new governance domain.

(c) **Default stores to memory, warn in production** $\u2014 rejected: warning-and-degrading is exactly what let TASK-062/063 hide. Fail closed instead.

## 4. Consequences

- Cost governance becomes admin-owned + dual-control-guarded, closing the configurability half of TASK-062/063.
- The durable path is required in production; a misconfigured deployment fails loudly rather than silently resetting spend per invocation.
- **Does not** prove live enforcement $\u2014 that is TASK-046 (a Sprint 7 deploy). This ADR makes enforcement governed + fail-closed; Sprint 7 proves it binds live.
