# Sprint 3c — UX: GenAI-native governance admin. Design.

Status: ACCEPTED (2026-08-30). Implements ADR-035.
Spec basis: ADR-035, ADR-003 (GenAI-native admin), ADR-033 (agent identity), ADR-034
(per-account restriction), A3 (approval policy), C (capability→feature map).

## 1. What the UX track delivers

An admin surface for the Sprint 3c governance stores, built on the existing GenAI-native
admin (prompt → AI plan → confirm → execute), plus the one user-facing consent screen. Eight
work items (U1–U8) collapse onto one reusable pattern + a few standalone pieces.

## 2. The reusable pattern — the governance panel

Every governed surface is the same shape:

- A **state view**: a read-only table of the store's current contents (the registry's agents,
  the capability map, the per-account blocks). The one place a table is right — it shows
  state, it does not edit it.
- The **shared spine**: `AdminPromptBar` (natural language) → `POST /api/admin/ai` (Claude
  plans tool calls) → `ActionConfirmPanel` (human-readable confirm) → `POST
/api/admin/ai/execute` (`toolHandlers` apply). This already exists; the panels reuse it.

A surface is therefore defined by three additions, all vocabulary-free (ADR-035):

1. tool schemas in `getToolsForPanel(panel)` (`app/api/admin/ai`),
2. execute handlers in `app/api/admin/ai/handlers/` registered in `toolHandlers`
   (`app/api/admin/ai/execute`),
3. `describeAction` cases in `ActionConfirmPanel` so a planned change reads legibly,

plus a nav entry in `AdminShell` and a state-view render. Safety-tier writes go through the
existing two-person config approval.

## 3. The work items

| Item | Surface                | Store                                 | Tools (vocabulary-free)                                               |
| ---- | ---------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| U1   | Approval policy        | `agent_approval_policy` (A3)          | `set_approval_policy`                                                 |
| U2   | Capabilities           | capability list (C)                   | `define_capability`, `remove_capability`                              |
| U3   | Capability→feature map | `agent.capability_features` (C)       | `set_capability_mapping`                                              |
| U4   | Trusted-agent registry | `agent.trusted_agents` (D-reg)        | `register_agent`, `suspend_agent`, `set_agent_scope`, `set_agent_ttl` |
| U6   | Per-account control    | `user_feature_restrictions` (F1)      | `block_user_feature`, `unblock_user_feature`                          |
| U5   | Delegation consent     | `/api/agent/delegation/*` (D-consent) | — user-facing page, not a tool                                        |
| U7   | AgentConsole demo      | —                                     | wires the governed flow end-to-end for demonstration                  |
| U8   | Design-system pass     | —                                     | consistency sweep across the new panels                               |

U1–U4 and U6 are the governance panel, configured five ways. They are platform-foundation
(the admin is platform-foundation; the tools carry no consumer vocabulary). U5 is the
consumer's (a user-facing product page wired to the consumer's delegation endpoints). U7/U8
are product-demo and polish.

## 4. Build grouping (commits)

- **UX-1 (PF):** U4 registry + U6 per-account — the two data-management surfaces (most alike).
- **UX-2 (PF):** U1 + U2 + U3 — the three config-governed surfaces.
- **UX-3 (consumer):** U5 delegation consent page.
- **UX-4 (consumer):** U7 AgentConsole demo + U8 design pass.

Each PF commit adds tool schemas + handlers + describeAction cases + nav + state view, with
tests, and updates the consumer usage guide as the tool vocabulary firms up.

## 5. Vocabulary-free guardrail (ADR-035)

The PF tool schemas and handlers must not hardcode consumer strings — no specific agent ids,
no specific capability names. A tool operates on whatever the named store contains. Example
prompts in PF stay generic ("suspend an agent", "narrow an agent's scope"); the concrete
values a panel shows come from the live store it reads. This keeps the D-series boundary: the
mechanism is platform, the vocabulary is the consumer's.

## 6. Documentation + discoverability (ADR-035)

Because this is a reusable platform capability, it is surfaced for consumers browsing the
platform: a README capability entry, a GENAI_ROADMAP row, this design doc, a consumer usage
guide (shipped with the code as the tool vocabulary settles), and a RELEASE_NOTES entry at
promotion.

## 7. Out of scope (deferred)

- The consumer usage guide's full tool reference lands with the code (UX-1…4), not here.
- U7/U8 (demo + polish) are the last UX items, after the functional panels.
