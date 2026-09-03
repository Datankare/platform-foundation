# Migrating from v1.x to v2.0.0

v2.0.0 delivers the Phase 5 application-and-governance framework (agentic workflow lifecycle,
AUX, agent identity rung 2, per-account restriction, and the GenAI-native governance admin).
Most of it is **additive** — new capabilities you opt into. This guide covers the one part that
is **breaking** for a consumer that used the v1.x agent-identity surface, plus the config and
migration steps to adopt the new capabilities.

If you did not use agents in v1.x, there are no breaking changes for you — adopt v2.0.0, apply
the new migrations for any capability you switch on, and you are done.

---

## Breaking change: agent identity is now attested delegation only

**What changed.** In v1.x an agent was identified by the `x-agent-role` HTTP header and
authorized against a small hard-coded allowlist. v2.0.0 retires both:

- The `x-agent-role` header **is no longer trusted** and no longer resolves an agent identity.
- The hard-coded allowlist is replaced by a **governed trusted-agent registry** (owner, scope,
  status, token-lifetime ceiling), managed through the admin surface.
- An agent now identifies itself with a **short-lived, signed delegation token** presented in
  the `x-agent-delegation` header, obtained through an OAuth 2.1 / PKCE consent flow.

**Why.** A bare header is an unverified claim; a signed, user-consented, scope-bound token is
attested authority. See ADR-033 for the full rationale.

**Who is affected.** Any consumer or client that sent `x-agent-role` to invoke agent
capabilities. After upgrading, those requests are treated as non-agent calls and denied at the
agent gate (fail-closed).

### How to migrate

1. **Configure the delegation key pair.** Set `DELEGATION_JWT_PUBLIC_KEY` (verify) and
   `DELEGATION_JWT_PRIVATE_KEY` (mint). Instructions:
   [`ENV_REFERENCE.md`](ENV_REFERENCE.md#agent-delegation-keys-rung-2-attested-delegation).
   Until these are set, delegation is disabled and all agent-on-behalf-of-user calls fail
   closed — so set them before you expect agents to work.

2. **Register your agents.** Move each agent that was in the old allowlist into the
   trusted-agent registry via the governance admin (or seed it in your consumer migration),
   with the scopes it may act on and a token-lifetime ceiling.

3. **Replace the header with the token flow.** Wherever a client sent `x-agent-role: <role>`,
   switch to obtaining a delegation token (PKCE `authorize` → `token`) and sending it as
   `x-agent-delegation: <token>`. The full client contract is in
   [`AGENT_DELEGATION_GUIDE.md`](AGENT_DELEGATION_GUIDE.md).

4. **Remove any lingering `x-agent-role` senders.** They are now dead weight and, if a stray
   one remains, it is simply ignored (the request resolves to a non-agent identity).

There is no compatibility shim by design — a partially-trusted legacy header alongside a signed
token would reintroduce exactly the weakness rung 2 removes.

---

## New capabilities to adopt (additive)

These are opt-in. Apply the relevant migrations and configuration for each you want.

### Per-account feature restriction (ADR-034)

Block a specific feature for a specific user, independent of their account status. Adopt by
applying the `user_feature_restrictions` migration; manage blocks through the governance admin
(the "Per-Account" panel). No code change required in your product.

### GenAI-native governance admin (ADR-035)

Administer the trusted-agent registry, the capability→feature map, the approval policy, and
per-account blocks through the natural-language admin (prompt → plan → confirm → execute). It
arrives with the platform sync; the governed values (which agents, which capabilities) are your
consumer config, seeded by your migrations. New admin permissions gate the panels — grant them
to the roles that should manage governance.

### Agentic workflow lifecycle, AUX, and observability

The application and agentic-workflow framework (durable trajectories, budgets, proposals, held
actions with approval/resume, the effect ledger) is available through the platform. Point the
relevant stores at Supabase (Section 4a of the setup guide) to make them durable in production.

---

## Configuration checklist

- [ ] `DELEGATION_JWT_PUBLIC_KEY` / `DELEGATION_JWT_PRIVATE_KEY` set (if using agents).
- [ ] Trusted-agent registry seeded/populated for your agents.
- [ ] Clients switched from `x-agent-role` to the `x-agent-delegation` token flow.
- [ ] New migrations applied for the capabilities you adopt (per-account restriction, agent
      delegation grants, governed config seeds).
- [ ] Admin permissions granted for the governance panels.
- [ ] Production stores pointed at Supabase where durability matters.
- [ ] `npm run build` and the test suite green after upgrade.

---

## Reference

- ADR-033 — agent identity rung 2 (the breaking change).
- ADR-034 — per-account feature restriction.
- ADR-035 — governance admin.
- [`RELEASE_NOTES.md`](RELEASE_NOTES.md) — the full v2.0.0 contents.
