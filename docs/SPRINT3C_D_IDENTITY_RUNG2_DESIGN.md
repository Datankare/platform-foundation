# Sprint 3c — D: Agent identity rung 2 (attested delegation). Design for review.

Status: ACCEPTED (2026-08-26). Decisions Q1/Q2/Q3 resolved (see §5). Implemented across the D-* commit series.
Spec basis: ADR-033 (rung 2 section), `AgentDelegation` kernel type, ADR-030 D9 two-gate composition.

## 1. What rung 2 must deliver (from ADR-033, verbatim requirements)

Rung 2 = **attested delegation**, four named pieces:

1. **Standing agent credential** — an agent is a distinct identity with its own verified credential, not a header role.
2. **Per-invocation user-delegation binding** — agent + user + consented scope, bound per call (`AgentDelegation{onBehalfOf, scope[], method}`).
3. **OAuth 2.1 / PKCE consent** — the user consents to an agent acting for them, at a given scope.
4. **Governed trusted-agent registry** — owner / scope / lifecycle per agent, with the admin surface to manage it (same governance surface as approval policy and capability map).

And the retirement: the rung-1 `RECOGNIZED_AGENT_ROLES` allowlist and the `x-agent-role` header trust go away. The two function bodies (`resolveAgentIdentity`, `agentAuthorized`) get new bodies; **their signatures and every caller stay unchanged** (ADR-033's localized-swap guarantee).

## 2. The two-repo boundary (GOTCHA-52, and ADR-033's "PF never holds Playform vocabulary")

- **PF owns the mechanism, not the vocabulary.** The delegation-token _validation_ shape, the registry _interface_, the two-gate composition — generic, PF. But which agents exist, their owners/scopes, the OAuth issuer config — Playform's, seeded/registered Playform-side (same split as B-gov's known-features and C's capability map).
- `lib/agent-identity.ts` is **Playform-owned** (it holds the allowlist and the Playform header today). The rung-2 bodies live here. PF provides any generic delegation-verification primitive.
- `AgentIdentity` / `AgentDelegation` kernel types are **already present and sufficient** — ADR-033 explicitly designed them so rung 2 needs no kernel change. Confirmed against the type: `AgentDelegation{onBehalfOf, scope[], method}` is exactly what `resolveAgentIdentity` will populate. **No kernel edit in D.**

## 3. Design — the four pieces

### 3a. Governed trusted-agent registry (replaces the allowlist) — D2/D1

A config-governed registry, same pattern as C's capability map (proven, gate-able):

- Config key `agent.trusted_agents`, `json_array` of records:
  `[agentId, {owner, scopes[], status}]` pairs → reconstructed to a map.
- An agent record: `{ agentId, owner, scopes: readonly string[], status: "active"|"suspended" }`.
- `agentAuthorized(identity, capability)` becomes: look up `identity.actorId` in the registry; allow iff the agent is `active` AND `capability ∈ its scopes` AND (rung-2) the invocation's delegation scope includes the capability. Fail-closed on absent/suspended/out-of-scope.
- Fallback (config outage): a **Playform-registered** fallback registry via a PF seam `setTrustedAgentsFallback()` — exact mirror of B-gov's `setKnownFeaturesFallback`. PF ships no agent list.
- Admin: appears in the existing config screen as a managed `safety`-tier entry; editable via two-person approval. Owner/scope/lifecycle are the record fields.

### 3b. Standing agent credential + attested delegation — D3 (`resolveAgentIdentity` new body)

Rung 1 read `x-agent-role` and trusted it. Rung 2:

- The request carries a **delegation token** (Authorization: `Bearer <delegation-jwt>` on an agent header distinct from the user JWT, OR a dedicated `x-agent-delegation` header — chosen in §5 Q1).
- `resolveAgentIdentity` **validates** that token: signature against the issuer, `exp`/`nbf`/`iat` (expiry + not-before), `aud` (this endpoint), `jti` (replay defense — see §3d), and extracts the bound `{ agentId, onBehalfOf (user), scope[] }`.
- It cross-checks `onBehalfOf` against the **authenticated** `userId` (the verified Cognito JWT from the user gate). A delegation token whose `onBehalfOf` ≠ the authenticated user is rejected — the token attests _this_ user delegated to _this_ agent. This is the anti-impersonation core (T9).
- On success it returns `AgentIdentity{ actorType:"agent", actorId: agentId, agentRole, onBehalfOf: userId, delegation: { onBehalfOf: userId, scope, method: "oauth2.1-pkce" } }`.
- Absent token → `null` (direct non-agent call), exactly as rung 1.

### 3c. OAuth 2.1 / PKCE consent flow — D3

The token in 3b is minted by a consent flow:

- **Authorization endpoint** (`/api/agent/delegation/authorize`): the user (on the verified session) consents to `agentId` acting for them at `scope[]`. PKCE: the agent supplies `code_challenge` (S256); the endpoint stores it against the issued `code`.
- **Token endpoint** (`/api/agent/delegation/token`): the agent exchanges `code + code_verifier`; the endpoint verifies `SHA256(code_verifier) == code_challenge`, then mints the delegation JWT (short-lived, `jti`, `aud`, the bound scope).
- Consent is recorded (audited) — who delegated what to whom, when. This _is_ the attestation trail.
- Standing agent credential: the agent authenticates to the token endpoint with its own credential (client-credentials style) so only a registered agent can complete the exchange.

### 3d. Replay, expiry, revocation (RAMPS: Resilience, Security)

- **Replay:** `jti` recorded on first use; a re-presented `jti` within the token's validity is rejected. Short TTL bounds the window.
- **Expiry:** `exp` enforced; a clock-skew allowance (small, explicit).
- **Revocation:** a suspended agent in the registry fails `agentAuthorized` even with a still-valid token — the registry is checked per invocation, so revocation is immediate regardless of token TTL.
- **Fail-closed everywhere:** missing/invalid signature, wrong `aud`, expired, replayed, `onBehalfOf` mismatch, unknown/suspended agent, out-of-scope capability → deny, reason named.

## 4. RAMPS / GenAI / engineering-leadership mapping

**RAMPS:**

- **Reliability** — registry checked per-invocation so revocation doesn't wait on token TTL; fallback registry survives config outage (no deny-all, no allow-all).
- **Availability** — config-outage fallback keeps known agents working; unknown agents still fail closed.
- **Maintainability** — the localized-swap guarantee holds: two function bodies + additive endpoints; callers untouched; kernel untouched. Same config-governance pattern as A/B-gov/C, so one mental model.
- **Performance** — token validation is local (signature + claims); one registry read (cached via getConfig's cache). No per-call network to an issuer.
- **Security** — the whole point: T9 impersonation closed by binding token `onBehalfOf` to the verified user JWT; PKCE prevents code interception; `jti` prevents replay; per-invocation registry check enables immediate revocation; fail-closed on every error path.

**GenAI principles (from the ADR's own anchors + the platform set):**

- **P10** (human oversight) — consent is explicit user action; the admin registry is human-governed.
- **P13** (bounded autonomy, central governance) — scope binds what an agent may do per invocation; the registry centrally governs which agents exist.
- **P17** (a change is a commitment) — registry mutations and consents are audited commitments.
- **P4 / P11** (structural safety, fail-closed) — every error path denies.
- **P3 / P18** (reconstructable) — the delegation binding + consent trail make every agent action attributable to a consented user delegation.

**Engineering leadership:**

- **Design-review-before-code** (this doc).
- **Staged, gate-able delivery** — full scope, sequenced so each commit is independently verifiable (the discipline that's kept 3c green).
- **Boundary discipline** — PF mechanism vs Playform vocabulary, GOTCHA-52.
- **Complete test matrix** — enumerated in §6, not sampled.

## 5. Decisions needed before build

**Q1 — delegation token transport. DECIDED: dedicated `x-agent-delegation` header.** A dedicated `x-agent-delegation` header (keeps the user JWT in Authorization, clean separation) vs `Authorization: Bearer` with the user JWT moved to a cookie/session. Recommendation: **dedicated header** — least disruption to the existing user-auth path, clean two-credential model.

**Q2 — delegation token format. DECIDED: self-issued RS256 JWT, `method: "oauth2.1-pkce"`.** A signed JWT minted by our own token endpoint (self-issued, HS/RS256) vs adopting a specific external IdP now. ADR-033 says the wire format is deliberately unratified. Recommendation: **self-issued RS256 JWT** with a documented claim set, `method: "oauth2.1-pkce"` — real crypto, standards-shaped, no premature IdP lock-in. The `AgentDelegation` type already abstracts the format, so a future swap to an external issuer changes only the validation body.

**Q3 — staging of the build. DECIDED: the five-commit sequence below.** Full D is large. These commits, all landing before D is "done," each gate-able:

- **D-reg (PF)** — the trusted-agent registry _mechanism_: interface + config loader + `setTrustedAgentsFallback` seam + fail-closed lookup. Generic, no Playform agents. Rewrites `agentAuthorized` to the registry lookup. (Playform still supplies agents.)
- **D-reg (Playform)** — seed `agent.trusted_agents` + register the fallback (mirrors B-gov Playform). Retires the rung-1 allowlist's role in Playform.
- **D-token (PF or Playform?)** — the delegation-token validation primitive + `resolveAgentIdentity` new body. (PF if generic crypto; Playform if it needs Playform issuer config — likely a PF primitive + Playform wiring.)
- **D-consent (Playform)** — the `/authorize` + `/token` PKCE endpoints + consent audit.
- **D-retire (Playform)** — remove `RECOGNIZED_AGENT_ROLES` and `x-agent-role` trust once the token path is live; update the identity test.

This is not scope reduction — it's the full thing in verifiable units. If you'd rather fewer/larger commits, say so.

## 6. Test matrix (complete, not sampled) — enumerated now so build is measured against it

Registry: active+in-scope allow; suspended deny; unknown deny; out-of-scope deny; config-outage→fallback; fallback empty→fail-closed behavior defined.
Token: valid allow; bad signature deny; expired deny; not-yet-valid deny; wrong aud deny; replayed jti deny; onBehalfOf≠authenticated-user deny; absent→null (non-agent).
PKCE: correct verifier mints; wrong verifier rejected; code reuse rejected; expired code rejected.
Consent: recorded/audited; scope honored; revocation (registry suspend) denies a still-valid token.
Composition: two-gate AND still holds (agent-pass+user-deny → deny naming user; agent-deny → deny naming agent, user gate not consulted).
Retirement: x-agent-role no longer grants; RECOGNIZED_AGENT_ROLES gone; callers unchanged.

## 7. Open confirmations

- Kernel needs **no** change (types sufficient) — confirmed against `AgentDelegation`.
- Everything Playform-vocabulary stays Playform-side; PF gets mechanism only.
- The existing `evaluateCapability` two-gate composition (from C) is rung-agnostic and needs no change — the new bodies slot under it.
