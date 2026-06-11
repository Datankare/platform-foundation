# ADR-027: Provider conformance kits (TCK) for all platform abstractions

- **Status:** Accepted
- **Proposed:** 2026-06-09
- **Accepted:** 2026-06-10
- **Relates to:** ADR-012 (provider-agnostic auth interface)
- **Supersedes (in part):** the Sprint 7 "sync drift-check" approach for hand-ported excluded files (dropped — it checked the wrong invariant; see Consequences)

## Context

`platform-foundation` (PF) is a reference framework. For every capability it
defines an **abstraction** (a TypeScript interface) plus a reference/mock
implementation, and ships instructions for consumers to supply their own
implementation behind that interface. A consumer's concrete implementation —
and its implementation tests — are _expected_ to diverge from PF's. Playform is
one representative consumer (auth/Cognito is, today, the only abstraction it
reimplements rather than inheriting from PF).

This created a real gap:

- `tsc` pins method **signatures** across the sync boundary.
- Each repo's **implementation tests** pin that repo's own impl behavior, independently.
- **Nothing asserts that a given implementation actually satisfies the abstraction's behavioral contract** — e.g. that `signIn` surfaces `challengeSession` when the backend returns `NEW_PASSWORD_REQUIRED`, or that errors map to a result object rather than throwing.

The existing `auth-provider.test.ts` _described_ the contract but only ran it
against the mock, with a docstring instructing a human to "swap
`createMockAuthProvider` for `createCognitoAuthProvider`." That swap was never
executed — the exact unenforced-checklist failure mode this team has been
eliminating.

A naive file-diff "drift-check" of the hand-ported excluded files was considered
and rejected: those files are _supposed_ to differ, so the check has no clean
invariant and produces only noise.

## Decision

PF ships, for **every** abstraction, a **conformance kit**: a provider-agnostic
behavioral contract expressed as a reusable function `run<X>Contract(fixtures)`
that asserts what any implementation of that interface must do.

1. **The kit is shared (synced).** It lives at `__tests__/contract/<x>-contract.ts`
   (a plain `.ts`, never auto-run by Jest) and crosses the sync boundary to every
   consumer.
2. **The kit is parametrized by a fixtures adapter, not just a provider factory.**
   Because some operations are interpreted locally by the implementation (e.g. a
   real provider decodes its own token format), a single set of magic-string
   inputs cannot serve every impl. Each kit therefore exposes:
   - **Canonical contract INPUTS** as shared constants (e.g. `AUTH_CONTRACT`) —
     passwords, codes, language codes — that every implementation honors (the
     mock by hardcoding, a real impl by routing its backend stub on the same
     values).
   - An **impl-specific fixtures object** carrying the OPAQUE values a given impl
     interprets without a contract-defined shape (tokens, sessions, sample audio).
     The mock supplies its magic strings; a real arm supplies impl-shaped values
     (e.g. Cognito supplies decodable fake JWTs).
3. **PF runs the kit against its reference/mock impl** in a synced arm — this
   preserves the existing coverage and guarantees the reference impl conforms.
   Abstractions previously missing a reference impl gain one under this ADR
   (`MockAIProvider`, `createMockHealthProbe`).
4. **Each concrete implementation gets its own arm** that wires that impl (with
   its backend SDK / HTTP layer faked) into the _same_ kit:
   - PF-shipped real impls (Google translate/TTS/STT, ACRCloud, Anthropic,
     Redis, Supabase social/realtime) get a single **synced** concrete arm,
     because the impl is identical in every consumer.
   - An abstraction a consumer **reimplements** (today: auth/Cognito) gets a
     **consumer-owned** concrete arm, because the impl and its construction
     differ per consumer. PF tests its reference impl; the consumer tests theirs.
5. **The convention is self-policing.** A registry-driven meta-test
   (`conformance-coverage.test.ts`) walks the live provider registry via
   `getActiveProviders()` and **fails if any registered slot has no conformance
   kit in the manifest** (`__tests__/contract/manifest.ts`). The manifest imports
   each kit runner by value, so a removed kit is a compile error, not a silent
   gap. A new provider cannot land without a kit.

### Correctly-aimed tripwire

When the **contract** is tightened, the kit is edited in PF, syncs to consumers,
and every consumer's concrete arm re-runs the new assertions — failing until
their impl conforms. Implementation-detail changes to PF's reference impls do
**not** ripple to consumers, which is exactly right: consumers may diverge on
implementation, never on contract.

## Findings (validation)

Building the concrete arms immediately earned their keep by surfacing six places
where the kit's assertions were silently mock-biased — i.e. encoded an
implementation detail of the mock rather than the true contract. Each was
resolved by relaxing the kit to the provider-agnostic invariant (or tracked for
unit reconciliation), proving the arms catch real divergence:

1. **SSO redirect casing** — kit asserted the redirect URL contained the literal
   provider key; Cognito uses a capitalized provider name. Relaxed to a
   case-insensitive containment check.
2. **`AuthSession.expiresAt` unit** — mock returns milliseconds, Cognito returns
   epoch seconds. Kit made unit-tolerant; tracked for a single-unit reconciliation.
3. **`GuestTokenResult.expiresAt` unit** — same ms-vs-seconds split; same resolution.
4. **`verifyMfaSetup` session** — `session` is optional in `MfaVerifyResult`;
   Cognito omits it. Dropped the mock-only assertion that it be defined.
5. **`signIn` success on an in-progress challenge** — the mock returns
   `success: true` for the MFA challenge but `success: false` for new-password
   (internally inconsistent); Cognito returns `false` for both. Kit no longer
   asserts `success` mid-challenge; tracked to make the mock consistent.
6. **STT returned language** — a transcription result is a _detected_ language,
   which a real provider (Google) normalizes to its base (`en-US` -> `en`). Kit
   relaxed from a verbatim echo to base-language consistency.

## Consequences

- The manual "any real provider must pass these tests" instruction becomes
  executable and machine-enforced.
- Adding an abstraction now has a fixed cost: an interface, a reference impl, a
  conformance kit, a reference arm, and a manifest entry (enforced by the meta-test).
- The dropped drift-check is retroactively justified: cross-repo consistency of
  files-allowed-to-differ has no clean invariant; _contract conformance_ does.
- Abstractions missing a reference impl are surfaced as work, not hidden.
- Stateful stores (Redis, Supabase) require a faithful in-memory fake of their
  backend protocol in the concrete arm, so the kit's round-trips traverse the
  provider's real request/response mapping rather than canned replies.

## GenAI principle mapping

- **P1** — all capabilities go through an orchestrated abstraction; the kit pins that abstraction's behavior.
- **P6** — every slot has a working fallback; the kit proves the fallback/reference conforms.
- **P10** — no late discovery: the meta-test forbids an unconformed provider slot from existing.
