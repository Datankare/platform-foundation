# Agent Delegation — developer guide

How an agent obtains authority to act on a user's behalf, and the rules for using it. This is
the operational contract for anyone building an agent on the platform. For the design
rationale see ADR-033 and `docs/SPRINT3C_D_IDENTITY_RUNG2_DESIGN.md`; for the keys this flow
requires, see [`ENV_REFERENCE.md`](ENV_REFERENCE.md#agent-delegation-keys-rung-2-attested-delegation).

## The model in one line

An agent acts under a short-lived, cryptographically signed **delegation token** that binds
_this agent_ + _this user_ + _this scope_, minted only after the user consents through an
OAuth 2.1 / PKCE flow. The token is a per-use credential, not a stored secret.

## Prerequisites

Before any of this works, the platform operator must have:

1. **Configured the delegation key pair** — `DELEGATION_JWT_PRIVATE_KEY` (minting) and
   `DELEGATION_JWT_PUBLIC_KEY` (verifying). Without them delegation is disabled and every
   token request fails closed. See
   [`ENV_REFERENCE.md`](ENV_REFERENCE.md#agent-delegation-keys-rung-2-attested-delegation) for
   generation and placement.
2. **Registered your agent** in the trusted-agent registry (via the governance admin), with
   the scopes it may act on and a token-lifetime ceiling. An agent that is not registered,
   or is suspended, is denied at the agent gate.

## Two principals

Every agent call is authorized by two independent gates, both of which must pass:

1. **User gate** — the user's own session (Cognito JWT). The delegation token never replaces
   this; it rides alongside it.
2. **Agent gate** — the agent must be in the trusted registry, active, and the requested
   capability within its registered scope.

The delegation token is what makes the agent gate _attested_ rather than a bare header claim.

## Getting a token (the PKCE flow)

Two calls, both on the authenticated user's session.

### 1. Generate a PKCE pair

```
code_verifier  = <a high-entropy random string you keep secret, one per request>
code_challenge = base64url( sha256( code_verifier ) )
```

### 2. POST /api/agent/delegation/authorize

```json
{
  "agentId": "agent:<your-agent-id>",
  "scope": ["translate", "speak"],
  "code_challenge": "<from step 1>",
  "code_challenge_method": "S256",
  "requested_ttl": 300
}
```

- `scope` must be a subset of what the agent is registered for — a broader ask is rejected
  (`scope_exceeds_agent`). Consent cannot exceed the agent's standing trust.
- `code_challenge_method` must be `S256`. `plain` is rejected.
- `requested_ttl` is optional (see Token lifetime below).

Returns `{ "code": "<authorization code>", "expires_in": 60 }`. The code is **single-use** and
expires in 60 seconds.

### 3. POST /api/agent/delegation/token

```json
{ "code": "<from step 2>", "code_verifier": "<from step 1>" }
```

Returns `{ "token": "<JWT>", "token_type": "Bearer", "expires_in": <seconds> }`.

The code is consumed atomically on this call — a second exchange, a wrong verifier, an
expired code, or a code from a different user all fail (`invalid_or_expired_code` /
`pkce_verification_failed`). A failed verifier still consumes the code; start over from step 1.

### 4. Present the token

Send it on each agent request in the `x-agent-delegation` header, alongside the user's normal
auth. The endpoint verifies the signature, the `onBehalfOf` binding (must equal the
authenticated user), expiry, and replay before honoring it.

## Token lifetime

The token's TTL is governed, not chosen freely:

```
effective_ttl = min(requested_ttl, agent.maxTokenTtl, global_hard_cap)
```

- **`requested_ttl`** — your optional ask on `/authorize`. Absent -> the agent ceiling.
- **`agent.maxTokenTtl`** — the per-agent ceiling, set in the trusted-agent registry (default
  300s). You cannot exceed it by asking; to raise it, request a registry change through
  governance (it is admin-approved config, not a code or request-time setting).
- **`global_hard_cap`** — `agent.delegation.max_ttl_seconds` (default 900s), the absolute
  ceiling.

## No refresh tokens — how to run long

There are deliberately **no refresh tokens**. A token is short-lived and re-minted through a
fresh consent. This removes a long-lived secret and its revocation machinery; the cost is that
you re-acquire tokens as you go. The rule:

> Treat the delegation token as a per-use, short-lived credential you re-acquire on demand
> while the user's session is live — never a long-lived secret you store.

Concretely:

- **Acquire lazily.** Get a token right before a protected call (or batch), not once at start.
- **Check-expiry-before-use.** Wrap calls: if the token is missing or within ~30s of expiry,
  re-mint first. A `getValidToken()` helper that returns the cached token or mints a new one is
  the standard shape.
- **Re-consent needs a live user session.** `/authorize` requires the authenticated user, so
  self-renewal only works while the user is present.

### Work that must continue while the user is absent

Because re-consent needs the user, user-absent long work must choose one pattern explicitly:

- **(a) Pre-authorize a longer TTL.** While the user is present, mint a token whose lifetime
  covers the job — bounded by the agent ceiling. Simplest; a longer-lived token is a larger
  secret, so keep the ceiling only as high as the work needs.
- **(b) Park and resume.** Break the work at token-sized boundaries; park via the held-action
  flow and resume on the user's next session with a fresh token.
- **(c) Service principal.** For truly autonomous, user-absent work, the agent should act under
  its _own_ authority — a separate credential type with its own governance, **not** this
  delegation flow (which is always "on behalf of a user"). This is a distinct mechanism, out
  of scope for rung-2 delegation.

Pick (a), (b), or (c) deliberately per use case. Do not assume a token persists.

## Failure reference

| Response error                                                 | Meaning                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------ |
| `agent_not_trusted`                                            | Agent absent from the registry or suspended                  |
| `scope_exceeds_agent`                                          | Requested scope not a subset of the agent's registered scope |
| `unsupported_code_challenge_method`                            | `code_challenge_method` was not `S256`                       |
| `missing_code_challenge` / `missing_scope` / `missing_agentId` | Required field absent                                        |
| `invalid_requested_ttl`                                        | `requested_ttl` not a positive integer                       |
| `invalid_or_expired_code`                                      | Code unknown, expired, already used, or another user's       |
| `pkce_verification_failed`                                     | `code_verifier` did not match the stored challenge           |
| `token_mint_failed`                                            | Signing key not configured, or minting error                 |

Every failure is fail-closed: no token is issued and, at the agent gate, the request is denied.
