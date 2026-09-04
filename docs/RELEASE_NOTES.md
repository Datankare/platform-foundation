# Release notes

New platform capabilities per release, newest first. This is the discovery surface for
consumers building on platform-foundation: what shipped, what it gives you, and where to read
more. Engineering detail lives in the ADRs and design docs referenced from each entry; the
per-commit history lives in git.

Each entry names the capabilities a consumer inherits on sync, not every internal change.

---

## v2.0.0 — Phase 5 application framework & governed agency

Date: 2026-09-04

The first major release since v1.6.0. It brings the entire Phase 5 framework-and-governance
arc (Sprints 2–3c) to a stable, adoptable baseline: a durable agentic-workflow framework,
attested and admin-governed agent authority, and the full consumer documentation set.

**This release contains one breaking change** — agent identity moved from the rung-1
`x-agent-role` header/allowlist to attested delegation. Consumers using the old header must
migrate; see [`MIGRATION_v1_to_v2.md`](MIGRATION_v1_to_v2.md).

### Headline capabilities

- **Agent identity rung 2 — attested delegation (ADR-033).** Governed trusted-agent registry
  (owner/scope/lifecycle) + RS256 delegation tokens minted through an OAuth 2.1 / PKCE consent
  flow, verified with an on-behalf-of binding and replay defense. Two-principal check
  throughout, fail-closed. Governed token TTL (per-agent ceiling + global cap; no refresh
  tokens). Rung-1 header retired. **Breaking** — see the migration guide.
- **Per-account feature restriction (ADR-034).** Block a specific feature for a specific user,
  orthogonal to account status, fail-closed.
- **GenAI-native governance admin (ADR-035).** Administer the trusted-agent registry, the
  capability→feature map, the approval policy, and per-account blocks through the
  natural-language admin (prompt → AI plan → confirm → execute) — a reusable, vocabulary-free
  platform capability inherited by any consumer with agents.
- **Application & agentic-workflow framework (ADR-028/029/031).** Durable trajectories,
  budgets, proposals, and external effects; gated actions held and resumed rather than
  refused; rollback via compensating actions; three-valued failure (`indeterminate` never
  collapsed into success/failure).
- **AUX, gating, capability, identity stack + observability (Sprints 3/3a/3b).** The agent
  user-experience surface, the capability/gating seams, and Sentry / tracing / metrics /
  health.

### Adopter documentation (new)

A complete consumer-facing set: [`SETUP_AND_INTEGRATION.md`](SETUP_AND_INTEGRATION.md),
[`ENV_REFERENCE.md`](ENV_REFERENCE.md) (every variable, incl. the delegation keys),
[`AGENT_DELEGATION_GUIDE.md`](AGENT_DELEGATION_GUIDE.md), and
[`MIGRATION_v1_to_v2.md`](MIGRATION_v1_to_v2.md). The architecture docs (TAD,
PLATFORM_ARCHITECTURE, AGENT_ARCHITECTURE) are brought current, and a docs-integrity test now
keeps them from drifting.

### Deploy notes

- Set `DELEGATION_JWT_PUBLIC_KEY` / `DELEGATION_JWT_PRIVATE_KEY` before agents can act (see
  ENV_REFERENCE). Migrations apply on deploy. Dependency security advisories cleared (0 audit
  high, prod).

### References

ADR-028 through ADR-035; the `docs/SPRINT3C_*` design docs; the per-sprint changelog in
[`GENAI_ROADMAP.md`](GENAI_ROADMAP.md).

---

## Sprint 3c — Agent governance + identity

Date: 2026-09-02

Agent authorization becomes attested and governed end to end, plus a reusable admin surface to
run it.

### New capabilities

- **Agent identity rung 2 — attested delegation (ADR-033).** Agent authorization moves from a
  bare header/allowlist to a governed trusted-agent registry (owner / scope / lifecycle) plus
  RS256 delegation tokens. `resolveAgentIdentity` verifies a signed token (signature, expiry,
  audience, on-behalf-of binding, replay); an OAuth 2.1 / PKCE consent flow mints it. The
  two-principal check (user gate + agent gate) holds throughout, fail-closed. The rung-1
  `x-agent-role` header is retired — a signed token is the only thing that resolves an agent
  identity.
- **Governed token lifetime (ADR-033).** Delegation-token TTL is `min(requested, per-agent
ceiling, global cap)` — a per-agent ceiling in the registry, an optional capped request, and
  a global backstop. No refresh tokens; short-lived, re-minted through consent. See
  `docs/AGENT_DELEGATION_GUIDE.md` (consumer) for the developer contract and the user-absent
  long-work patterns.
- **Per-account feature restriction (ADR-034).** Block a specific feature for a specific user,
  orthogonal to account status — a surgical revocation that needs no status change. Checked in
  the account-status guard, fail-closed on a read error.
- **GenAI-native governance admin (ADR-035).** Administer the trusted-agent registry, the
  capability→feature map, the approval policy, and per-account blocks through the
  natural-language admin — prompt → AI plan → confirm → execute, not forms, with two-person
  approval on safety-tier changes. A reusable, vocabulary-free platform capability: the tools
  operate on governed config of a known shape, so any consumer with agents inherits the
  governance surface on sync.

### Deploy notes

- Set `DELEGATION_JWT_PUBLIC_KEY` (verify) and `DELEGATION_JWT_PRIVATE_KEY` (mint) before the
  release that carries delegation, or delegation is disabled (fail-closed — agents cannot act).
- Migrations apply on deploy. Consumer migrations that rewrite governed config rows (the
  trusted-agent registry, the known-features set) are idempotent.

### References

ADR-033 (agent identity), ADR-034 (per-account feature restriction), ADR-035 (governance
admin); `docs/SPRINT3C_D_IDENTITY_RUNG2_DESIGN.md`,
`docs/SPRINT3C_F_PER_ACCOUNT_RESTRICTION_DESIGN.md`,
`docs/SPRINT3C_UX_GOVERNANCE_ADMIN_DESIGN.md`.
