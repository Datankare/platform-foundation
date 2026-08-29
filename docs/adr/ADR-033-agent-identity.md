# ADR-033 — Agent identity and two-principal authorization

Status: Accepted (rung 1); rung 2 targeted for Sprint 3c
Date: 2026-08-16
Relates to: ADR-030 (AUX, capability enforcement D9), ADR-031 (action identity), the
Sprint 3c admin-governance surface (TASK-087).

## Context

`/api/agent/process-content` (Playform-A) lets an AI agent invoke a workflow on a user's
behalf. Two distinct principals are involved in every such call, and both must be
authorized or the call is a confused-deputy hole:

1. the **user** — is this account entitled to what the workflow does?
2. the **agent** — is this agent authorized to act, and to invoke this capability on the
   user's behalf?

Checking only the user lets any agent invoke anything the user could. Checking only the
agent ignores the user's own entitlements. The 2026 state of the art (IETF AI-agent-auth
drafts, WIMSE/SPIFFE, OAuth 2.1 for agentic delegation) treats an agent as a distinct
identity class and binds agent identity + user identity + consented scope per invocation.
Identity-spoofing via self-declared identity is a named threat (T9); a request-body agent
claim is exactly that hole.

## Decision

### Two-principal check, both mandatory

A capability check passes only if BOTH gates allow (deny if either denies, fail-closed):

- **User gate** — `checkAccountStatus(userId, feature)` for each feature the capability
  maps to. Already rung-2-grade: it runs on a verified Cognito JWT.
- **Agent gate** — `agentAuthorized(agentIdentity, capability)`, where the agent identity
  is DERIVED FROM A VERIFIED CREDENTIAL, never from the request body.

This composes with ADR-030 D9's `checkCapability` seam: the consumer's callback ANDs the
two gates and returns the boolean the loop enforces up front. On denial, the reason names
WHICH gate failed, so the audit trail is unambiguous.

### A maturity ladder, and where we sit

- **Rung 0 — body-declared identity.** Spoofable (T9). Rejected, never shipped.
- **Rung 1 — verified credential against the agent registry (SHIPS NOW).** The agent
  identity is resolved from something the endpoint verifies; `agentAuthorized` checks a
  conservative first-party allowlist, fail-closed. The user gate is already rung 2, so even
  at rung 1 a request cannot exceed the authenticated user's entitlements — the rung-1
  weakness is narrowly "which agent," not "what may be done."
- **Rung 2 — attested delegation (SPRINT 3c).** Standing agent credential + per-invocation
  user-delegation binding (agent + user + scope), OAuth 2.1/PKCE consent, a governed
  trusted agent registry with owner/scope/lifecycle, and the admin surface to manage it —
  the same admin-governance surface as approval policy and capability definition.

### The seam, so rung 2 is a localized swap

Rung 1 is built so rung 2 replaces two isolated function bodies, not a structure:

- `resolveAgentIdentity(request) -> AgentIdentity` — rung 1: derive from verified
  credential. Rung 2: validate the delegation token, extract the bound identity.
- `agentAuthorized(identity, capability) -> boolean` — rung 1: allowlist. Rung 2: governed
  registry lookup.

Everything else — the two-gate composition, the `checkCapability` seam, the three-state
telemetry, the capability->feature map, the endpoint scaffold — is rung-agnostic and
written once.

`AgentIdentity.delegation` (kernel, `AgentDelegation`) is added NOW, unused at rung 1, so
the attested binding rung 2 produces has a forward-compatible home and the sync-carried
kernel type needs no change when the delegation machinery lands. Its wire format is left
open deliberately: the delegation standards are not yet ratified, so the field holds the
resolved binding, not a committed credential format.

### Token-lifetime governance (rung-2 delegation)

A delegation token's lifetime is a property of the _work_ it authorizes, bounded by the
_standing trust_ the agent holds — not a single global constant. Three keying axes were
considered:

- **Global** — one TTL for all tokens. Simple, but cannot lengthen a long-running agent's
  tokens without loosening every agent's.
- **Per-user** — TTL by who delegates. Rejected: lifetime is a property of the task, not the
  user; keying on the user conflates trust-in-user with task-duration and multiplies the
  config surface by the user count.
- **Per-service / per-caller** — TTL by the binding application. Premature: agents are
  first-party and in-process today; there are no distinct service principals to key on. This
  axis re-enters only if/when a service-principal credential type is introduced (a separate
  mechanism, separate ADR).

**Decision: per-agent ceiling + capped per-request ask + a global hard cap.**

- Each trusted-agent registry entry carries `maxTokenTtl` (seconds) — the agent's ceiling, an
  admin-governed property alongside owner/scopes/status, changed through the same governed
  registry config (two-person approval).
- `/authorize` accepts an optional `requested_ttl`; the token endpoint mints with
  `min(requested_ttl, agent.maxTokenTtl, globalHardCap)`.
- A global hard cap (`agent.delegation.max_ttl_seconds`, platform config) is the absolute
  ceiling no agent can exceed — the safety backstop.

**No refresh tokens.** Delegation tokens are short-lived and re-minted through a fresh consent
while the user's session is live. This removes a long-lived, high-value secret and the
revocation machinery it would require; the cost is that user-_absent_ long-running work must
choose an explicit pattern — pre-authorize a longer TTL (bounded by the ceiling), park-and-
resume via the held-action seam, or (for truly autonomous work) a service principal, which is
a separate credential type and not part of rung-2 delegation. The refresh-less contract and
these patterns are documented for agent developers in `docs/AGENT_DELEGATION_GUIDE.md`.

## Consequences

- Ships a real two-principal check now, with the user gate at full strength and the agent
  gate conservative-but-verified — not a body claim with a TODO.
- The rung-1 -> rung-2 rework is two function bodies plus retiring a small allowlist
  constant; all structure survives.
- Rung 2's infrastructure (credential issuer, governed registry, consent UX) is additive
  and lands with the Sprint 3c governance surface, not bolted onto one endpoint now.
- If untrusted third-party agents must call the endpoint BEFORE 3c, rungs 1's allowlist is
  insufficient for them and the standing-credential + delegation-binding pieces must be
  pulled forward — a decision gated on "who calls, and when," recorded here so it is a
  conscious trigger rather than a surprise.
