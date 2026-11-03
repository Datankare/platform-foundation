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

## Getting a token (the PKCE flow, the agent authenticated)

Every call is on the authenticated user's session. The **agent** makes the request and the
exchange, authenticating with its own **client credential**; the **user** consents in between, on
a screen that shows only what the server recorded, and proves it is them. (TASK-194, audit C-7:
an issuer that authenticates only the user lets any signed-in user mint a token as any registered
agent, so agent attribution in audit records and trajectories is forgeable.) The issuer is the
consuming app's — Playform's `lib/agent-delegation.ts` is the reference; the paths below are its.

### 0. The agent's client credential

An administrator holding `admin_manage_agents` issues it:
`POST /api/agent/delegation/credential { "agentId" }` → `{ "clientSecret", "credentialId",
"pending" }`, shown once, stored as its SHA-256 hash. The agent sends it on its request and its
exchange as `x-agent-client-id` / `x-agent-client-secret` headers — never in a body, a URL or a
browser.

- A **first-party** agent's (any user may delegate to it) is dual-controlled (round 1, B3): held
  until a second administrator approves it (`POST /api/agent/delegation/credential/approve
{ "credentialId" }`, never the requester).
- A rotation keeps the previous credential valid for a governed overlap
  (`agent.delegation.credential_overlap_seconds`, 24 h by default), so the agent switches without
  an outage; `DELETE /api/agent/delegation/credential { "agentId" }` revokes all of an agent's.

### 1. Generate a PKCE pair

```
code_verifier  = 43–128 characters of A–Z a–z 0–9 - . _ ~, random, one per request
code_challenge = base64url( sha256( code_verifier ) )   (43 characters)
```

Both are checked for form (RFC 7636; round 1, B8) and compared in constant time.

### 2. POST /api/agent/delegation/request (the agent)

```json
{
  "scope": ["translate", "speak"],
  "code_challenge": "<from step 1>",
  "code_challenge_method": "S256",
  "requested_ttl": 300
}
```

With the client credential headers. The agent must be registered and active, and one this user
may delegate to (its registry `owner` is `first-party` or this user); `scope` must be a subset of
its registered scopes (`scope_exceeds_agent`); `S256` only. Returns `{ "request": "<handle>",
"expires_in": 300 }`; send the user to the consent screen with the handle only.

### 3. The user consents — with a step-up

The consent screen reads the request from the server (never the URL: audit E-118) and shows the
agent's registry name, each scope in words and the token's effective lifetime. **Allow** is
`POST /api/agent/delegation/authorize { "request", "decision": "allow", "password",
"currentCode"? }`: the user's password, and a current code when the account has two-step
verification, confirmed by the identity provider (`platform/auth/mfa-routes.ts` `confirmStepUp`;
round 1, B1). The agent holds the user's bearer token while it asks, so the bearer alone must not
be able to consent. Deny needs no step-up.

### 4. POST /api/agent/delegation/token (the agent)

```json
{ "code": "<the request handle>", "code_verifier": "<from step 1>" }
```

With the client credential headers again. Returns `{ "token": "<JWT>", "token_type": "Bearer",
"expires_in": <seconds> }`. The request is consumed atomically — a second exchange, a wrong
verifier, an expired, unconsented or denied request, another user's or another agent's all fail
(`invalid_or_expired_code` / `pkce_verification_failed`). A failed verifier still consumes it.

### 5. Present the token

Send it on the agent request in the `x-agent-delegation` header, alongside the user's normal
auth. The endpoint verifies the signature, the `onBehalfOf` binding (must equal the
authenticated user) and expiry, and honours a token once (its use is recorded; a replay is
refused).

## Token lifetime

The token's TTL is governed, not chosen freely:

```
effective_ttl = min(requested_ttl, agent.maxTokenTtl, global_hard_cap)
```

- **`requested_ttl`** — your optional ask on `/request`. Absent -> the agent ceiling.
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
- **One token per call.** A token is honoured once: mint one for each protected call, and never
  retry a call with the token it already used.
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
| `client_unauthenticated`                                       | No, or a wrong, agent client credential                      |
| `agent_not_owned`                                              | The agent's owner is neither `first-party` nor this user     |
| `agent_not_trusted`                                            | Agent absent from the registry or suspended                  |
| `scope_exceeds_agent`                                          | Requested scope not a subset of the agent's registered scope |
| `unsupported_code_challenge_method`                            | `code_challenge_method` was not `S256`                       |
| `invalid_code_challenge` / `invalid_code_verifier`             | Not of RFC 7636's form                                       |
| `missing_code_challenge` / `missing_scope` / `missing_agentId` | Required field absent                                        |
| `invalid_requested_ttl`                                        | `requested_ttl` not a positive integer                       |
| `invalid_or_expired_code`                                      | Request unknown, expired, unconsented, used, or not yours    |
| `pkce_verification_failed`                                     | `code_verifier` did not match the stored challenge           |
| `token_mint_failed`                                            | Signing key not configured, or minting error                 |

Every failure is fail-closed: no token is issued and, at the agent gate, the request is denied.
