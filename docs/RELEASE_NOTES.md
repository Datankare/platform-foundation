# Release notes

New platform capabilities per release, newest first. This is the discovery surface for
consumers building on platform-foundation: what shipped, what it gives you, and where to read
more. Engineering detail lives in the ADRs and design docs referenced from each entry; the
per-commit history lives in git.

Each entry names the capabilities a consumer inherits on sync, not every internal change.

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
