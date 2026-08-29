# Sprint 3c — D: Agent identity rung 2 (attested delegation). Design for review.

Status: ACCEPTED (2026-08-26). Decisions Q1/Q2/Q3 resolved (see §5). Implemented across the D-* commit series.
Spec basis: ADR-033 (rung 2 section), `AgentDelegation` kernel type, ADR-030 D9 two-gate composition.

## 1. What rung 2 must deliver (from ADR-033, verbatim requirements)

Rung 2 = **attested delegation**, four named pieces:

1. **Standing agent credential** — an agent is a distinct identity with its own verified credential, not a header role.
2. **Per-invocation user-delegation binding** — agent + user + consented scope, bound per call (`AgentDelegation{onBehalfOf, scope[], method}`).
3. **OAuth 2.1 / PKCE consent** — the user consents to an agent acting for them, at a given scope.
4. **Governed trusted-agent registry** — owner / scope / lifecycle per agent, with the admin surface to manage it (same governance surface as approval policy and capability map).

And the retirement (D-retire, done): the rung-1 `RECOGNIZED_AGENT_ROLES` allowlist and the `x-agent-role` header trust are gone. The two function bodies (`resolveAgentIdentity`, `agentAuthorized`) get new bodies; **their signatures and every caller stay unchanged** (ADR-033's localized-swap guarantee).

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

Rung 1 read `x-agent-role` and trusted it; that path is retired. Rung 2 (the sole path now):

- The request carries a **delegation token** (Authorization: `Bearer <delegation-jwt>` on an agent header distinct from the user JWT, OR a dedicated `x-agent-delegation` header — chosen in §5 Q1).
- `resolveAgentIdentity` **validates** that token: signature against the issuer, `exp`/`nbf`/`iat` (expiry + not-before), `aud` (this endpoint), `jti` (replay defense — see §3d), and extracts the bound `{ agentId, onBehalfOf (user), scope[] }`.
- It cross-checks `onBehalfOf` against the **authenticated** `userId` (the verified Cognito JWT from the user gate). A delegation token whose `onBehalfOf` ≠ the authenticated user is rejected — the token attests _this_ user delegated to _this_ agent. This is the anti-impersonation core (T9).
- On success it returns `AgentIdentity{ actorType:"agent", actorId: agentId, agentRole, onBehalfOf: userId, delegation: { onBehalfOf: userId, scope, method: "oauth2.1-pkce" } }`.
- Absent token → `null` (direct non-agent call). The retired header is ignored.

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

### 3d-ttl. Token-lifetime governance (per-agent ceiling + capped request + global cap)

Token TTL is resolved, at mint time in the `/token` endpoint, as:

```
effective_ttl = min(requested_ttl, agent.maxTokenTtl, agent.delegation.max_ttl_seconds)
```

- **`requested_ttl`** — optional, supplied by the caller on `/authorize`. Absent -> the
  agent ceiling is used. A hint, never authoritative.
- **`agent.maxTokenTtl`** — per-agent ceiling, a field on the trusted-agent registry record
  (extends D-reg's `TrustedAgent`; seeded in migration 033 with a default of 300s). Governs
  by what the agent is; raised for a long-running agent through the governed registry config
  (two-person approval), not in code.
- **`agent.delegation.max_ttl_seconds`** — global hard cap (platform config, default 900s).
  The absolute ceiling no agent can exceed; the safety backstop against a mis-set per-agent
  ceiling.

Rationale (see ADR-033, Token-lifetime governance): TTL is a property of the work, bounded by
the agent's standing trust — so per-agent ceiling, not per-user or per-service. **No refresh
tokens**; user-absent long work uses a pre-authorized longer TTL (within the ceiling),
park-and-resume, or a service principal (separate mechanism). The developer-facing contract
lives in `docs/AGENT_DELEGATION_GUIDE.md`.

## 3e. Security flow diagrams

Two views of the same authorization path. The first is the mental model — two
principals, both must pass. The second draws every failure path explicitly, as it
should be scrutinized before shipping the token validator.

### Overview — the two principals

A request must satisfy two independent gates (the two-principal check, ADR-033).
Identity is resolved solely via the rung-2 attested-delegation token; the rung-1 role header
was retired in D-retire, so an agent call is a valid token or it is nothing. Any gate failing
denies, fail-closed.

<svg xmlns="http://www.w3.org/2000/svg" width="680" viewBox="0 0 680 760" role="img" aria-label="Two-principal agent authorization overview (delegation-only)">
<defs><marker id="ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="#888" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
<style>.t{font:500 14px sans-serif;fill:#222}.s{font:400 12px sans-serif;fill:#555}.a{stroke:#888;stroke-width:1.5;fill:none}</style>
<rect x="220" y="40" width="240" height="44" rx="8" fill="#F1EFE8" stroke="#5F5E5A"/><text class="t" x="340" y="67" text-anchor="middle">Incoming agent request</text>
<line x1="340" y1="84" x2="340" y2="108" class="a" marker-end="url(#ar)"/>
<rect x="190" y="110" width="300" height="56" rx="8" fill="#E6F1FB" stroke="#185FA5"/><text class="t" x="340" y="134" text-anchor="middle">User gate — verify Cognito JWT</text><text class="s" x="340" y="154" text-anchor="middle">principal 1 · already rung-2</text>
<line x1="340" y1="166" x2="340" y2="206" class="a" marker-end="url(#ar)"/>
<rect x="150" y="208" width="380" height="76" rx="8" fill="#E1F5EE" stroke="#0F6E56"/><text class="t" x="340" y="230" text-anchor="middle">Resolve agent identity — attested delegation only</text><text class="s" x="340" y="250" text-anchor="middle">x-agent-delegation token (RS256): sig · exp · aud</text><text class="s" x="340" y="268" text-anchor="middle">onBehalfOf=user · jti replay · scope bound</text>
<line x1="340" y1="284" x2="340" y2="324" class="a" marker-end="url(#ar)"/>
<rect x="210" y="326" width="260" height="56" rx="8" fill="#F1EFE8" stroke="#5F5E5A"/><text class="t" x="340" y="350" text-anchor="middle">AgentIdentity resolved</text><text class="s" x="340" y="370" text-anchor="middle">delegation binding, or null → deny</text>
<line x1="340" y1="382" x2="340" y2="422" class="a" marker-end="url(#ar)"/>
<rect x="190" y="424" width="300" height="56" rx="8" fill="#EEEDFE" stroke="#534AB7"/><text class="t" x="340" y="448" text-anchor="middle">Agent gate — trusted registry</text><text class="s" x="340" y="468" text-anchor="middle">principal 2 · active + in scope</text>
<line x1="340" y1="480" x2="340" y2="520" class="a" marker-end="url(#ar)"/>
<rect x="190" y="522" width="300" height="56" rx="8" fill="#E6F1FB" stroke="#185FA5"/><text class="t" x="340" y="546" text-anchor="middle">User gate — account status</text><text class="s" x="340" y="566" text-anchor="middle">each feature · fail-closed unknown</text>
<line x1="340" y1="578" x2="340" y2="618" class="a" marker-end="url(#ar)"/>
<rect x="230" y="620" width="220" height="44" rx="8" fill="#F1EFE8" stroke="#5F5E5A"/><text class="t" x="340" y="647" text-anchor="middle">Both principals pass?</text>
<line x1="320" y1="664" x2="255" y2="694" class="a" marker-end="url(#ar)"/>
<line x1="360" y1="664" x2="435" y2="694" class="a" marker-end="url(#ar)"/>
<rect x="150" y="696" width="170" height="44" rx="8" fill="#EAF3DE" stroke="#3B6D11"/><text class="t" x="235" y="723" text-anchor="middle">Allow</text>
<rect x="360" y="696" width="170" height="44" rx="8" fill="#FCEBEB" stroke="#A32D2D"/><text class="t" x="445" y="715" text-anchor="middle">Deny</text><text class="s" x="445" y="733" text-anchor="middle">any gate · fail-closed</text>
</svg>

### Complete — every failure path

Each check is a row on the left happy-path spine; each exits right to its own
fail-closed deny.

<svg xmlns="http://www.w3.org/2000/svg" width="680" viewBox="0 0 680 1060" role="img" aria-label="Complete agent authorization flow with every failure path (delegation-only)">
<defs><marker id="ar2" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="#888" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
<style>.t2{font:500 14px sans-serif;fill:#222}.s2{font:400 12px sans-serif;fill:#555}.a2{stroke:#888;stroke-width:1.5;fill:none}.d2{stroke:#A32D2D;stroke-width:1.5;fill:none}</style>
<rect x="470" y="40" width="180" height="960" rx="12" fill="none" stroke="#A32D2D" stroke-width="0.5" stroke-dasharray="4 4"/><text class="s2" x="560" y="58" text-anchor="middle" fill="#A32D2D">Deny · fail-closed</text>
<rect x="40" y="44" width="300" height="40" rx="8" fill="#F1EFE8" stroke="#5F5E5A"/><text class="t2" x="190" y="68" text-anchor="middle">Incoming agent request</text>
<line x1="190" y1="84" x2="190" y2="104" class="a2" marker-end="url(#ar2)"/>
<rect x="40" y="106" width="300" height="52" rx="8" fill="#E6F1FB" stroke="#185FA5"/><text class="t2" x="190" y="128" text-anchor="middle">User gate — verify Cognito JWT</text><text class="s2" x="190" y="147" text-anchor="middle">principal 1 · already rung-2</text>
<line x1="340" y1="132" x2="486" y2="132" class="d2" marker-end="url(#ar2)"/><rect x="490" y="112" width="150" height="40" rx="8" fill="#FCEBEB" stroke="#A32D2D"/><text class="s2" x="565" y="136" text-anchor="middle">invalid / expired JWT</text>
<line x1="190" y1="158" x2="190" y2="178" class="a2" marker-end="url(#ar2)"/>
<rect x="40" y="180" width="300" height="52" rx="8" fill="#F1EFE8" stroke="#5F5E5A"/><text class="t2" x="190" y="202" text-anchor="middle">Delegation token present?</text><text class="s2" x="190" y="221" text-anchor="middle">x-agent-delegation header</text>
<line x1="340" y1="206" x2="486" y2="206" class="d2" marker-end="url(#ar2)"/><rect x="490" y="186" width="150" height="40" rx="8" fill="#FCEBEB" stroke="#A32D2D"/><text class="s2" x="565" y="210" text-anchor="middle">absent → not an agent</text>
<line x1="190" y1="232" x2="190" y2="262" class="a2" marker-end="url(#ar2)"/>
<rect x="40" y="264" width="300" height="40" rx="8" fill="#E1F5EE" stroke="#0F6E56"/><text class="t2" x="190" y="288" text-anchor="middle">Signing key configured?</text>
<line x1="340" y1="284" x2="486" y2="284" class="d2" marker-end="url(#ar2)"/><rect x="490" y="264" width="150" height="40" rx="8" fill="#FCEBEB" stroke="#A32D2D"/><text class="s2" x="565" y="288" text-anchor="middle">no key → fail-closed</text>
<line x1="190" y1="304" x2="190" y2="320" class="a2" marker-end="url(#ar2)"/>
<rect x="40" y="322" width="300" height="40" rx="8" fill="#E1F5EE" stroke="#0F6E56"/><text class="t2" x="190" y="346" text-anchor="middle">Verify RS256 signature</text>
<line x1="340" y1="342" x2="486" y2="342" class="d2" marker-end="url(#ar2)"/><rect x="490" y="322" width="150" height="40" rx="8" fill="#FCEBEB" stroke="#A32D2D"/><text class="s2" x="565" y="346" text-anchor="middle">bad signature</text>
<line x1="190" y1="362" x2="190" y2="378" class="a2" marker-end="url(#ar2)"/>
<rect x="40" y="380" width="300" height="40" rx="8" fill="#E1F5EE" stroke="#0F6E56"/><text class="t2" x="190" y="404" text-anchor="middle">Check exp / nbf / iss / aud</text>
<line x1="340" y1="400" x2="486" y2="400" class="d2" marker-end="url(#ar2)"/><rect x="490" y="380" width="150" height="40" rx="8" fill="#FCEBEB" stroke="#A32D2D"/><text class="s2" x="565" y="404" text-anchor="middle">expired / wrong aud</text>
<line x1="190" y1="420" x2="190" y2="436" class="a2" marker-end="url(#ar2)"/>
<rect x="40" y="438" width="300" height="40" rx="8" fill="#E1F5EE" stroke="#0F6E56"/><text class="t2" x="190" y="462" text-anchor="middle">onBehalfOf = authenticated user</text>
<line x1="340" y1="458" x2="486" y2="458" class="d2" marker-end="url(#ar2)"/><rect x="490" y="438" width="150" height="40" rx="8" fill="#FCEBEB" stroke="#A32D2D"/><text class="s2" x="565" y="462" text-anchor="middle">T9 mismatch</text>
<line x1="190" y1="478" x2="190" y2="494" class="a2" marker-end="url(#ar2)"/>
<rect x="40" y="496" width="300" height="40" rx="8" fill="#E1F5EE" stroke="#0F6E56"/><text class="t2" x="190" y="520" text-anchor="middle">Extract sub (agentId)</text>
<line x1="340" y1="516" x2="486" y2="516" class="d2" marker-end="url(#ar2)"/><rect x="490" y="496" width="150" height="40" rx="8" fill="#FCEBEB" stroke="#A32D2D"/><text class="s2" x="565" y="520" text-anchor="middle">missing sub</text>
<line x1="190" y1="536" x2="190" y2="552" class="a2" marker-end="url(#ar2)"/>
<rect x="40" y="554" width="300" height="52" rx="8" fill="#E1F5EE" stroke="#0F6E56"/><text class="t2" x="190" y="576" text-anchor="middle">jti replay check (cache)</text><text class="s2" x="190" y="595" text-anchor="middle">outage → treat as seen</text>
<line x1="340" y1="580" x2="486" y2="580" class="d2" marker-end="url(#ar2)"/><rect x="490" y="560" width="150" height="40" rx="8" fill="#FCEBEB" stroke="#A32D2D"/><text class="s2" x="565" y="584" text-anchor="middle">replay / cache down</text>
<line x1="190" y1="606" x2="190" y2="626" class="a2" marker-end="url(#ar2)"/>
<rect x="40" y="628" width="300" height="40" rx="8" fill="#F1EFE8" stroke="#5F5E5A"/><text class="t2" x="190" y="652" text-anchor="middle">AgentIdentity resolved</text>
<line x1="190" y1="668" x2="190" y2="688" class="a2" marker-end="url(#ar2)"/>
<rect x="40" y="690" width="300" height="40" rx="8" fill="#EEEDFE" stroke="#534AB7"/><text class="t2" x="190" y="714" text-anchor="middle">Agent registered + active?</text>
<line x1="340" y1="710" x2="486" y2="710" class="d2" marker-end="url(#ar2)"/><rect x="490" y="690" width="150" height="40" rx="8" fill="#FCEBEB" stroke="#A32D2D"/><text class="s2" x="565" y="714" text-anchor="middle">unknown / suspended</text>
<line x1="190" y1="730" x2="190" y2="746" class="a2" marker-end="url(#ar2)"/>
<rect x="40" y="748" width="300" height="40" rx="8" fill="#EEEDFE" stroke="#534AB7"/><text class="t2" x="190" y="772" text-anchor="middle">Capability in agent scope?</text>
<line x1="340" y1="768" x2="486" y2="768" class="d2" marker-end="url(#ar2)"/><rect x="490" y="748" width="150" height="40" rx="8" fill="#FCEBEB" stroke="#A32D2D"/><text class="s2" x="565" y="772" text-anchor="middle">out of scope</text>
<line x1="190" y1="788" x2="190" y2="806" class="a2" marker-end="url(#ar2)"/>
<rect x="40" y="808" width="300" height="52" rx="8" fill="#E6F1FB" stroke="#185FA5"/><text class="t2" x="190" y="830" text-anchor="middle">Each mapped feature allowed?</text><text class="s2" x="190" y="849" text-anchor="middle">account status · principal 1</text>
<line x1="340" y1="834" x2="486" y2="834" class="d2" marker-end="url(#ar2)"/><rect x="490" y="814" width="150" height="40" rx="8" fill="#FCEBEB" stroke="#A32D2D"/><text class="s2" x="565" y="838" text-anchor="middle">restricted / suspended</text>
<line x1="190" y1="860" x2="190" y2="876" class="a2" marker-end="url(#ar2)"/>
<rect x="40" y="878" width="300" height="40" rx="8" fill="#E6F1FB" stroke="#185FA5"/><text class="t2" x="190" y="902" text-anchor="middle">Feature in known-features?</text>
<line x1="340" y1="898" x2="486" y2="898" class="d2" marker-end="url(#ar2)"/><rect x="490" y="878" width="150" height="40" rx="8" fill="#FCEBEB" stroke="#A32D2D"/><text class="s2" x="565" y="902" text-anchor="middle">unknown feature</text>
<line x1="190" y1="918" x2="190" y2="946" class="a2" marker-end="url(#ar2)"/>
<rect x="90" y="948" width="200" height="48" rx="8" fill="#EAF3DE" stroke="#3B6D11"/><text class="t2" x="190" y="968" text-anchor="middle">Allow</text><text class="s2" x="190" y="986" text-anchor="middle">both principals passed</text>
</svg>

### Enumerated failure paths (spec — complete list)

Every point below is an independent, fail-closed deny. This is the checklist the
token validator and the two gates are tested against (see §6).

User gate (principal 1, entry): invalid or expired Cognito JWT -> 401, never reaches
identity resolution.

Rung-2 delegation validation (`resolveDelegatedIdentity`), each a `return null` ->
deny:

- no public key configured -> no agent identity resolved (fail-closed; rung-1 retired, so there is no header to fall back to)
- bad signature or non-RS256 algorithm
- expired (`exp`) or not-yet-valid (`nbf`)
- wrong audience (`aud`) or issuer (`iss`)
- `onBehalfOf` != authenticated user (the T9 anti-impersonation check)
- missing `sub` (agentId)
- replayed `jti` (seen in cache within TTL)
- cache outage during the replay check -> treated as "cannot prove unseen" -> deny
  (fails closed, never open)
- present-but-invalid token while keys ARE configured -> deny, with NO downgrade to
  a header path (there is none; rung-1 retired)

Absent delegation header -> null (a direct, non-agent call). The retired `x-agent-role`
header is ignored entirely — it no longer resolves an agent identity.

Agent gate (principal 2, `agentAuthorized` / trusted registry): actor is not an
agent · unknown agent · suspended agent · capability outside the agent's scope.

Per-capability user gate (principal 1, `checkAccountStatus`): a mapped feature is
restricted or suspended for the account · a mapped feature is not in the governed
known-features list (fail-closed on unknown).

Allow is reached only when the entry user gate, identity resolution, the agent gate,
and every per-capability user-gate check all pass.

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

**Q4 — token-lifetime model. DECIDED: per-agent ceiling + capped per-request ask + global hard cap.** TTL is a property of the work bounded by the agent's standing trust, so it keys on the agent, not the user or the caller. Each trusted-agent record carries `maxTokenTtl`; `/authorize` takes an optional `requested_ttl`; `/token` mints with `min(requested_ttl, agent.maxTokenTtl, agent.delegation.max_ttl_seconds)`. No refresh tokens — user-absent long work uses a pre-authorized longer TTL (within the ceiling), park-and-resume, or a service principal (separate mechanism). Per-user and per-service axes deferred; documented for developers in `docs/AGENT_DELEGATION_GUIDE.md`. See §3d-ttl and ADR-033.

## 6. Test matrix (complete, not sampled) — enumerated now so build is measured against it

Registry: active+in-scope allow; suspended deny; unknown deny; out-of-scope deny; config-outage→fallback; fallback empty→fail-closed behavior defined.
Token: valid allow; bad signature deny; expired deny; not-yet-valid deny; wrong aud deny; replayed jti deny; onBehalfOf≠authenticated-user deny; absent→null (non-agent).
PKCE: correct verifier mints; wrong verifier rejected; code reuse rejected; expired code rejected.
TTL: requested<=ceiling honored; requested>ceiling capped to ceiling; ceiling>global-cap capped to global; absent request uses ceiling.
Consent: recorded/audited; scope honored; revocation (registry suspend) denies a still-valid token.
Composition: two-gate AND still holds (agent-pass+user-deny → deny naming user; agent-deny → deny naming agent, user gate not consulted).
Retirement: x-agent-role no longer grants; RECOGNIZED_AGENT_ROLES gone; callers unchanged.

## 7. Open confirmations

- Kernel needs **no** change (types sufficient) — confirmed against `AgentDelegation`.
- Everything Playform-vocabulary stays Playform-side; PF gets mechanism only.
- The existing `evaluateCapability` two-gate composition (from C) is rung-agnostic and needs no change — the new bodies slot under it.
