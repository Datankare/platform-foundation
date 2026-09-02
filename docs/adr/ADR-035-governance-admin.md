# ADR-035 — GenAI-native governance admin

Status: Accepted (Sprint 3c UX).
Spec basis: ADR-003 (GenAI-native), ADR-030 (agent user experience), ADR-033 (agent
identity), ADR-034 (per-account feature restriction). Extends the admin surface
(`app/admin`, `app/api/admin/ai`, `components/admin`).

## Context

Sprint 3c added governed agent machinery — a trusted-agent registry (ADR-033 D-reg), a
capability→feature map (C), an approval policy (A3), and per-account feature blocks (ADR-034
F1). Each is administered by reading and writing a governed store: a `platform_config` row of
a known shape, or a small table. Without an admin surface these are edited by hand in SQL,
which is neither governed (no confirm, no two-person approval, no audit through the app) nor
discoverable.

The platform already has the right surface for this: the GenAI-native admin (ADR-003) — a
natural-language command bar (`AdminPromptBar`) whose prompt becomes an AI-planned set of
tool calls (`/api/admin/ai`), shown for human confirmation (`ActionConfirmPanel`), then
executed (`/api/admin/ai/execute` → a `toolHandlers` registry). Admin operations flow through
AI → plan → confirm → execute, not CRUD forms.

## Decision

Administer the Sprint 3c governance stores through the existing GenAI-native admin, as a
reusable platform capability — not a set of bespoke forms, and not a Playform one-off.

- One reusable pattern, the **governance panel**: a read view of a governed store's current
  state, above the shared prompt → plan → confirm → execute spine. Every governed surface
  (registry, capabilities, mapping, approval policy, per-account blocks) is the same panel
  configured with a different state view and tool set.
- Each surface contributes: a tool schema (in `getToolsForPanel`), an execute handler (in the
  `handlers/` barrel, registered in `toolHandlers`), and a `describeAction` case so the
  confirm panel renders the planned change legibly. Safety-tier changes route through the
  existing two-person config approval.
- The capability lives in platform-foundation (the admin IS platform-foundation, synced to
  consumers). It holds NO consumer vocabulary: tools operate generically on a named store of a
  declared shape — `suspend_agent` flips a status field in whatever `agent.trusted_agents`
  contains; it does not enumerate specific agents. The specific values (which agents, which
  capabilities) are consumer config, seeded in the consumer's migrations. This is the same
  boundary ADR-033/ADR-034 drew: the mechanism is platform, the vocabulary is the consumer's.

### What lives where

- **platform-foundation:** the governance-panel component, the tool schemas, the execute
  handlers, the `describeAction` cases, the admin nav entries. All vocabulary-free.
- **The consumer (e.g. Playform):** the config VALUES the panels read and write (the agents,
  the capability names), already seeded by consumer migrations; and any user-facing surface
  that is not admin — notably the delegation CONSENT screen (ADR-033 D-consent), which is a
  product page wired to the consumer's `/api/agent/delegation/*` endpoints, not an admin tool.

### Why not a parallel consumer-side admin

Building a second admin extension mechanism in each consumer would fork the admin, duplicate
the prompt/confirm/execute spine, and re-solve two-person approval and audit per consumer. The
platform admin already does all of this; extending it with vocabulary-free tools reuses it and
gives every future consumer the same governance surface for free.

## Consequences

- Governing an agent, a capability map, or a per-account block becomes a natural-language
  admin action with confirm + audit + (where safety-tier) two-person approval — not raw SQL.
- The governance admin is a discoverable, reusable platform capability: any consumer with
  agents inherits it on sync. It is documented for consumers (README capability entry,
  GENAI_ROADMAP, a design doc, and release notes) so a consumer browsing the platform finds
  it.
- The admin gains agent-governance nav sections. The vocabulary-free rule means the tool
  schemas and handlers carry no consumer strings; example prompts stay generic.
- The one non-admin surface (the delegation consent screen) is the consumer's, since it is a
  user-facing product page, not a governed-config admin action.
- Adding a future governed surface is a known recipe: state view + tool schema + handler +
  describeAction, all in platform-foundation.
