# Release notes

New platform capabilities per release, newest first. This is the discovery surface for
consumers building on platform-foundation: what shipped, what it gives you, and where to read
more. Engineering detail lives in the ADRs and design docs referenced from each entry; the
per-commit history lives in git.

Each entry names the capabilities a consumer inherits on sync, not every internal change.

---

## v2.5.0 — Sprint 6.5: maintenance & governance hardening

Date: 2026-09-24

A maintenance sprint — no new consumer capability, but the platform's governance and quality
gates are materially harder to regress. What a consumer inherits on sync is a stronger set of
guardrails.

### Headline changes

- **Governed agent budget & durability config (ADR-048).** Per-agent daily-cost and per-trajectory
  step caps resolve from governed config as a platform ceiling: governance may only tighten a
  per-agent default, never silently raise it, and any config-store error or non-positive value
  fails safe to that default. The durable trajectory/budget stores are now required in a production
  context — an in-memory store refuses to boot the runtime (fail-closed), the stance the Supabase
  path already took on missing creds.
- **Promotion guard (TASK-060).** CI rejects any PR into `main` that is not a real promotion source
  (staging / promote/* / hotfix/*), so `develop → main` can no longer be merged wrong-base.
- **Coverage ratchet (TASK-080).** Coverage floors ratchet with hysteresis from a committed
  baseline: a fall below fails CI, slack above baseline+margin raises the floor automatically, and
  it never auto-lowers.
- **Boundary-map conformance (TASK-064).** A conformance arm ties every config tool to an explicit
  cognition/commitment boundary, so the map and the tool roster cannot drift apart unnoticed.
- **Dependency-override hygiene (TASK-070) + audit sweep (TASK-058).** Every package.json override
  has a recorded reason and removal condition, enforced by a CI drift guard; a scheduled npm audit
  sweep surfaces advisories proactively.

See ADR-048 and docs/SECURITY_DEBT.md for detail.

---

## v2.4.0 — Sprint 6: multimodal AI (input, governed generation, safety, provenance)

Date: 2026-09-24

Multimodal lands end to end on one shared substrate: image/audio input, governed image generation, a
screening seam for both directions, and provenance / synthetic-media detection. Everything fails closed.

### Headline capabilities

- **Multimodal provider interface (ADR-044).** Image and audio enter the provider interface as content
  blocks; providers declare a per-modality capability descriptor that drives routing; an unsupported
  modality degrades to text rather than failing the turn. The content model + descriptor are the write-once
  substrate the rest of the sprint builds on.
- **Multimodal content safety (ADR-046).** One screenModality seam screens image/audio in both directions,
  fail-closed, across independent NSFW / real-person / baseline axes. CSAM and real-person sexual imagery are
  hard-refused above the tunable tier system, non-configurable. Input is screened before any model sees it.
- **Governed image generation (ADR-045).** Generation is a committed effect: draft (idempotent) -> screen ->
  risk-classify -> auto-commit low-risk at the boundary / hold high-risk for Confirm. Committed images carry a
  verifiable provenance credential; held generations enqueue in the admin approval queue.
- **Provenance & synthetic-media detection (ADR-047).** A C2PA-shaped, verifiable credential is emitted on
  every committed image; inbound media is classified for synthetic origin as a risk signal that raises the
  generation tier — never a standalone gate.

---

## v2.3.0 — Sprint 5: application-specific RAG & UGC input screening

Date: 2026-09-22

Retrieval-grounded knowledge and a screened input surface land on the platform. Both follow
the platform pattern (PF owns the loop and the isolation; the consumer supplies content and
queries), and both fail closed.

### Headline capabilities

- **Application-specific RAG (ADR-042).** A store-agnostic isolation contract with named-dimension
  scope and a knowledge-base registry: every read, write, and delete is confined to its scope, and
  a store earns trust only by passing the store-agnostic no-leak conformance kit. Two reference
  stores ship — in-memory and a durable Supabase/pgvector store — both enforcing scope in the
  platform layer (an optional Row-Level-Security backstop is documented, never depended on). A
  curator reference knowledge base is registered on the boot path; adopters copy it.
- **UGC input screening (ADR-043).** Input screening made structural (Standing Rule 11) and
  fail-closed at both enforcement points on the RAG data path — ingestion (data-poisoning) and
  query (prompt-injection) — on the provider-agnostic screenContent seam. A poisoned document
  never enters the index; a malicious query never reaches retrieval. Block, escalate, or a screen
  error all withhold; a store-agnostic conformance kit proves both points.

---

## v2.2.0 — Sprint 4: adaptive behavior & dynamic content generation frameworks

Date: 2026-09-19

Two PF-native generative frameworks land on the prompt-eval harness they gate on. Both follow
the platform pattern (PF owns the loop, the consumer supplies the functions), run on the governed
agent runtime, and fail closed.

### Headline capabilities

- **Adaptive behavior framework (ADR-036).** A consumer describes how an agent should adapt; the
  framework runs the decision on the governed runtime with a mandatory deterministic fallback,
  routes any effectful outcome through the action pipeline, and keeps adaptation to within-session
  working memory.
- **Dynamic content generation framework (ADR-037).** Generated content runs on the runtime, is
  schema-validated, and — the gap this closes — is screened by the Guardian before it can
  surface; any orchestrator error, parse failure, schema miss, or screening block falls back to the
  consumer's static template. Curator is the reference content type; durable content surfaces only
  through the governed commitment boundary.
- **Prompt-eval harness (ADR-038).** A deterministic record-replay CI gate that runs recorded
  fixtures through each prompt's own parser, with enum-exhaustive / fail-closed / boundary /
  adversarial coverage enforced; both frameworks gate on it.

Each framework ships an L21 conformance kit a consumer runs against its own implementations.

### References

ADR-036 (adaptive behavior), ADR-037 (dynamic content generation), ADR-038 (prompt-eval harness).

## v2.1.1 — patch: agent registry survives bundle duplication

Date: 2026-09-14

A patch fixing a production agent-registration defect surfaced by a downstream consumer's
end-to-end tests. No API change; consumers inherit the fix on sync.

### Fix

- **Agent registry now survives Next.js/Turbopack module duplication.** The registry held
  agents in a module-level `Map`, which Next duplicates across the instrumentation bundle and
  the route bundles — so a consumer registering agents at server startup populated one copy
  while the routes read another, empty one, and moderation failed closed. The registry is now
  backed by the same `globalThis` singleton carrier the observability layer uses.

---

## v2.1.0 — Sprint 3d: registry unification & held-action governance

Date: 2026-09-10

The first minor release on the v2 line. It ships Sprint 3d — Agent Registry Unification
(ADR-039) — and the dual-control governance surface built on it, plus a full test-coverage
remediation of the admin surface. No breaking changes; consumers inherit these on sync.

### Headline capabilities

- **Unified agent registry (ADR-039).** One registry is the single source of truth for every
  agent; a CI guard fails the build if an agent runs off the governed runtime, and the
  Guardian fails closed to escalation.
- **Escalation SLA + reaper (ADR-041).** Over-SLA escalations are swept by a permission-gated
  route and resolved to a concrete, appealable block (never "allow"); the SLA is fail-closed
  to the shortest window, and the reaper is idempotent.
- **Held-action & dual-control admin (ADR-040).** A `safety_approver` role (a safety peer that
  cannot self-escalate) makes two-person control operable without a second super_admin; a
  unified Approvals queue over both hold mechanisms; approve/reject with self-approval blocked
  server-side (even for super_admin); dual-control-keys management through the governed config
  path; and approve-by-conversation behind a mandatory confirm.
- **Admin coverage remediation.** The whole admin surface — services, routes, handlers, tool
  schemas — is now in the coverage map (no blanket ignores), with the enforced floors ratcheted
  to statements 88 / lines 90 / functions 90 / branches 76.
- **Security.** The bundled Next.js is patched to 16.3.5 and sharp to 0.35.4, clearing two
  published advisories (an unauthenticated RCE in the Next.js image-optimization path; libheif
  vulnerabilities via sharp). Consumers inherit the fix on sync.

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
