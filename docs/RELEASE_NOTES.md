# Release notes

New platform capabilities per release, newest first. This is the discovery surface for
consumers building on platform-foundation: what shipped, what it gives you, and where to read
more. Engineering detail lives in the ADRs and design docs referenced from each entry; the
per-commit history lives in git.

Each entry names the capabilities a consumer inherits on sync, not every internal change.

---

## v5.1.0 — Held actions decided and resumed only as approved

Date: 2026-10-22

The independent review of Playform v0.8.0 drove the agent-approval path end to end against the real
workflow loop and found that it had never worked on the durable store, and that once it did, one
approval could release a different action; the independent review of this release then closed the
remaining gaps ([register](audits/2026-10-REGISTER.md) PR-1–PR-16,
[learning 119](ENGINEERING_LEARNINGS.md)). Apply migration 046 before deploying.

### What a consumer inherits on sync

- **The whole proposing identity, durably.** Proposals keep the actor's kind, the user it acts for,
  its delegation and its sign-in session (`proposals.actor_identity`, migration 046). Held actions
  still open from before are superseded by the migration (the agent proposes again).
- **`heldActionRefusal(proposal, decider, decision, policy)`** — one rule for every decision route:
  the owner only (anyone else's is "not found"), still open; an approval never by the proposing
  agent, never through the sign-in session it was proposed through (whoever proposed it), refused
  when either session is unknown, and only by the approver type the policy requires. New code
  `approvals.approver_not_allowed` (403). `principalOf(actor)`: a user is themselves; an agent
  stands for the user it acts for, and only if its attested delegation agrees.
- **`resumeApprovedAction({ proposalId, checkCapability })`** — runs the step an approval released,
  once, taking goal, actor, tool and payload from the proposal and its trajectory, never from the
  caller. The pipeline's approved commit also verifies the action and its input (compared as JSON)
  and then **uses the approval atomically**: `ProposalStore.consume` moves it `approved` →
  `executed` (new terminal status), so concurrent resumes run the step once; a loser gets
  `HeldActionNotApprovedError`, never a fresh hold. An operation that is approved or used is never
  proposed again (`proposeOnce`; the database's `idx_proposals_one_live`, migration 046, keeps one
  open, approved or used proposal per operation). `executed` means the approval was used and the
  action attempted — if it then failed, its trajectory is `failed`; the approval is not reusable.
  A store you implement yourself adds `consume` and the one-live rule (the kit checks `consume`).
- **Trajectories belong to their user.** Scoped to the user an actor stands for; continuing another
  owner's, another goal's or a failed one throws `TrajectoryAccessError` (answer it as not found).
  Platform-scoped trajectories from before 5.1 cannot be continued by a delegated agent.
- **`TokenPayload.sessionId`** (optional, stable across refreshes; Cognito: `origin_jti`, reported
  by the platform's Cognito provider and mock). Carry it into `AgentIdentity.sessionId` where your
  route builds the acting identity: without it no held action can be approved.
- `rejectHeldAction` returns the decided record, or nothing when the action was already decided; the
  admin approvals route answers `approvals.decision_conflict` (409) for a decision that did not
  commit. `screenProfileUpdate` refuses a non-text value in a screened field instead of skipping it, and
  `getOwnProfile` throws on a store failure instead of reporting the profile missing;
  `profileUpdateNeedsScreening(update)` tells a route whether an update makes a paid screening call.
  The Cognito provider warns once when tokens carry no `origin_jti` (token revocation off on the app
  client), because then no held action can be approved.
- **Auth routes take text only.** `requireTextFields(body, names, request)` (`@/platform/errors`)
  answers a non-text field `request.invalid_body` and an absent or empty one `request.missing_fields`;
  every auth route uses it. Sign-up applies the built-in password policy when the stored one cannot be
  read, instead of an uncoded 500 (found by the promotion's monkey run, latent since v5.0.0).
  `callAuthProvider(call, { request, context })` (`@/platform/auth/auth-response`) answers a provider
  that throws — yours may — as `internal.error` with a request id; every auth and SSO route uses it.

### Upgrading

Apply `046_proposal_actor_identity.sql` (idempotent) to every database before deploying, and see
[MIGRATION_v4_to_v5.md](MIGRATION_v4_to_v5.md) §7 for a consumer route that decides held actions.

---

## v5.0.0 — Adversarial Validation: the October 2026 audit fixed, and the checks that keep it fixed

Date: 2026-10-22

An independent whole-system adversarial review (nine auditors, eight static and one dynamic) found that
the perimeter held but the inside did not: a moderator could make themselves `super_admin` through the
AI command bar, admin and moderation audit records were never written, strikes and the review queue
lived in per-instance memory, `/api/stream` was an unscreened model proxy, and no route capped paid
calls per day — while every test passed. v5.0.0 fixes the Critical and High findings that live in the
platform ([register](audits/2026-10-REGISTER.md)) and adds, for each pattern behind them, a check that
runs on every commit. **Adversarial Validation** is now a core tenet ([ASSURANCE.md](ASSURANCE.md)).

**This release is breaking**: production refuses to start on settings v4 accepted, ungoverned config
APIs are removed, and new checks scan your code. Upgrade with
[`MIGRATION_v4_to_v5.md`](MIGRATION_v4_to_v5.md); its section 1 must be done before deploying.

### What a consumer inherits on sync

- **Authorization that holds on every path.** `requireAdmin` returns the verified admin, refuses staff
  not in good standing, and answers 503 (never access) when permissions cannot be resolved. Role
  governance (`platform/auth/role-governance.ts`): nobody grants what they do not hold, protected
  roles stay protected. The AI command bar checks each action's own permission, offers only the tools
  the admin holds, and reads only tables they may read.
- **Audit that fails closed.** `audited`/`recordAudit`: the record is written first; no record, no
  action. Real user ids only; agents and processes named in `agent`. `auditedResponse` for routes.
- **Governed configuration only.** `writeGovernedConfig`: tier, validation, history, two-person and
  dual-control checks on every write path; the dual-control list itself is always dual-controlled.
- **Moderation that cannot be turned against users.** Durable strike and review-queue stores
  (`STRIKE_STORE`, `REVIEW_QUEUE_STORE`); an overturn only lowers status; no self-review; the safety
  check knows the user; the classifier's input wrapper cannot be closed from inside.
- **AI spend and output bounded.** A daily paid-request quota per user or guest (governed
  `ai.daily_paid_requests_per_actor`, migration 044), required on every paid route by CI. `/api/stream`
  uses the platform's system prompt and releases output only after screening it (`screenStream`).
- **Fail-closed defaults.** Every durable store refuses `memory` in production; boot failure stops the
  server; harness switches need `DEPLOYMENT_HOST=ci|local`; the paid health probe is cached.
- **Checks that scan your code too** — see [ASSURANCE.md](ASSURANCE.md) §2: the authorization matrix,
  real guards in tests, paid-route quota, JSON bodies, REST URL encoding, security wiring (with the
  consumer-owned register `platform/assurance/unwired-security.ts`), coverage ignores, property-test
  depth.
- **Dynamic and weekly checks.** `fuzz.yml` (deep property tests and the monkey run against a
  production build, on every promotion PR and weekly), `migration-parity.yml`, `zap-scan.yml`; every
  workflow least-privilege.
- **Test infrastructure** for hostile tests: `FakeDatabase` (filters evaluated, writes recorded,
  failures injected, filter strings refused), `test-identities` (real roles from the migrations, the
  real guard), store conformance kits for strikes and the review queue, `fast-check`.
- **Fixed by the independent release review** (register, RR-1–RR-25): an overturn lifts only its own
  decision's consequence; governed config values are stored as JSON, not JSON text (migration 045
  repairs existing rows); the input safety check follows the pipeline's final action; approval
  decisions are audited and an approved change is applied or reopened; failed role lookups stop the
  change; the reviewer-assist route is quota-counted, self-review-checked and injection-safe; the
  checks' own blind spots closed.
- **Security update:** Next.js 16.3.8 → 16.4.2 (critical advisories GHSA-2464-fhr4-w9xw,
  GHSA-673q-mjm6-r5xr — remote code execution; GHSA-p3m5-59mp-jv5r — denial of service) and
  `@sentry/nextjs` → 10.76.2 (GHSA-mchm-gjx6-7h55, tunnel-route middleware bypass). A consumer pins
  its own `next` in its own `package.json`: bump it to 16.4.2 now, independent of adopting v5.0.0.
- Migrations **041–045**; error codes `admin.self_target`, `admin.target_not_found`, `admin.config_invalid_value`,
  `auth.grant_exceeds_own`, `auth.role_protected`, `moderation.self_review`,
  `request.field_not_accepted`.

### Actions for a consumer

1. Follow [`MIGRATION_v4_to_v5.md`](MIGRATION_v4_to_v5.md) section 1 before deploying.
2. Add `platform/assurance/unwired-security.ts` to the sync exclude list.
3. Fix what the new checks report in your routes (section 5), and adopt the consumer-side fixes your own
   routes need (the register's **Consumer** rows).

---

## v4.1.0 — an app declares its own route guards and settings

Date: 2026-10-21

The first consumer sync of v4.0.0 showed that the two route checks recognised only the platform's
verifiers and limiters by name, while a consumer that wraps them — a route guard adding its own
account rules, an agent context verifying two principals — had no way to say so: the checks are
synced files a consumer cannot edit. The same class of gap as learning 110, closed the same way as
ADR-051's app codes.

### What a consumer inherits on sync

- **`platform/route-policy/app-route-policy.ts` (consumer-owned, shipped empty; TASK-136).** Declare the
  app's verifier and limiter wrappers by name, and its own public or rate-limit-exempt routes with a
  reason. **Checked, not trusted:** the route checks locate each declared function's definition and
  require it to call a platform verifier (or `enforceRateLimit`), directly or through another declared
  wrapper; a wrapper that does neither, or cannot be found, fails CI.
- Both route checks share one helper (`__tests__/helpers/route-policy.ts`) with self-tests of the checker.
  Wrapper definitions are looked for in source only — never in tests or Jest manual mocks
  (`__mocks__/`), which re-declare a wrapper's name without its behaviour.
- **`docs/APP_ENV_REFERENCE.md` (consumer-owned, shipped as a template).** The app's own settings and
  its per-environment provider choices. The docs check now reads it with `ENV_REFERENCE.md`, so a
  consumer can inherit the docs check (and `ENV_REFERENCE.md`) instead of excluding them.
- **`PLATFORM_VERSION` (`platform/version.ts`).** The platform release the synced code is; a
  consumer's `package.json` is its own. The release-notes check now tracks it, not `package.json`.

### Actions for a consumer

1. Add `platform/route-policy/app-route-policy.ts` to the sync exclude list, then declare your wrappers in it.
2. Add `docs/APP_ENV_REFERENCE.md` to the sync exclude list and fill it in. If you had excluded
   `docs/ENV_REFERENCE.md` or `__tests__/docs-integrity.test.ts`, stop excluding them; the docs check
   then also needs your own `README.md` (ADR and migration counts), `docs/README.md` (lists every doc)
   and `docs/TAD.md` (indexes every ADR, carries a review date).

---

## v4.0.0 — public-repository hardening: rate limiting, verified callers, secret scanning

Date: 2026-10-21

Preparing the repository for public use found two controls that existed on paper only: a rate limiter
no route called, and a streaming route that verified nothing past the proxy's presence check. Both are
fixed so they cannot silently recur — CI now checks every API route for both — and the repository itself
was hardened for public readers.

**This release is breaking** for a consumer that deploys: production now requires a shared rate-limit
store. Upgrade with [`MIGRATION_v3_to_v4.md`](MIGRATION_v3_to_v4.md).

### What a consumer inherits on sync

- **Rate limiting on every API route (ADR-052, TASK-134).** `enforceRateLimit(request, rule, { actorId? })`
  — `429 rate.limited` with `Retry-After`; `503 service.unavailable` when the store cannot answer (fail
  closed). The store is a provider slot, `RATE_LIMIT_STORE` = `supabase` (migration 039: an exact sliding
  window in Postgres, serialised per bucket) · `upstash` · `memory`, with one conformance kit for all three;
  production refuses `memory`. Spoof-resistant caller address (`TRUSTED_PROXY_HOPS`). Rules per route group:
  sign-in 10 per 15 minutes, account flows 10 per hour, guest minting 20 per hour, AI 20 per minute per user.
- **`/api/stream` verifies its caller (TASK-133).** Signed-in users only, account-governed under the
  `stream` feature; every request field bounded server-side and refused with a coded error when out of
  bounds; input screened before the model; upstream errors reported by code only.
- **CI checks over every route.** `__tests__/api-route-auth.test.ts` (each route verifies its caller or is
  public by design, with a reason) and `__tests__/api-route-rate-limit.test.ts` (each handler is limited or
  the route is exempt, with a reason). They scan a consumer's own routes after sync.
- **Migration replay checks behaviour.** The CI replay now exercises the rate-limit functions on real
  Postgres, including concurrency (20 simultaneous requests, limit 5: exactly 5 admitted).
- **Repository hygiene.** A full-history secret scan in CI (gitleaks, pinned and checksum-verified; known
  false positives listed by fingerprint); Semgrep results uploaded to code scanning; `SECURITY.md` (private
  vulnerability reporting); [`COMPONENT_REGISTER.md`](COMPONENT_REGISTER.md) (licence verdict and exit
  path for each dependency and service); resource identifiers removed from docs and examples; the
  licence names its owner; RAMPS "M" is Manageability throughout.
- **Removed.** `platform/auth/rate-limit.ts` (the per-instance admin limiter). `createRateLimiter`'s
  `"redis"` provider is now `"upstash"`, chosen explicitly.

### Actions for a deploying consumer

1. Apply migration 039 to every database; set `RATE_LIMIT_STORE=supabase` on every deployment.
2. Rate-limit and verify your own routes until both route tests pass; reset the limiter in your
   `jest.setup.ts`.
3. To offer streaming, add `stream` to `account_status.known_features`.

---

## v3.1.0 — consumer seams: app error codes, consumer migrations, platform guests

Date: 2026-10-09

The first consumer sync of v3.0 showed three places where the platform said a consumer could do
something but gave it no way to. Each is a seam now, exercised by tests in this repository.

### What a consumer inherits on sync

- **Its own error codes (ADR-051 D1, TASK-120).** `platform/errors/app-codes.ts` (`APP_ERROR_CODES`,
  codes `app.<area>.<name>`), `messages/app/en.json` (messages under `errors.app` and `screens.app`
  only) and the generated `docs/APP_API_ERRORS.md`. The registry and catalog merge them at load, so
  `apiError("app.files.too_large", …)` type-checks and renders like a platform code; a key outside the
  app namespaces, or one the platform already defines, is refused at load. Shipped empty. See
  [`platform/errors/README.md`](../platform/errors/README.md).
- **Consumer migrations are replayed (TASK-119).** The baseline covers what it _records_, not a number
  range: `scripts/migration-replay.sh` applies every migration the baseline does not record — a
  consumer's own migrations whatever their number, then newer platform ones — and the schema-baseline
  test checks the record instead of the numbers.
- **Platform-minted guests (ADR-050 D4).** `POST /api/auth/guest` signs the guest token itself, under any
  auth provider, and the sign-in screen calls it. A guest now works under the test double too, so an E2E
  harness can exercise guests (on a production build, set `GUEST_TOKEN_SECRET`).
- **`SMOKE_TRANSLATION_FIELD`** for the deployed smoke test — the field of each `translations[]` item that
  holds the text (default `text`).
- **CI: the migration replay no longer pulls from Docker Hub (TASK-122).** It installs Postgres 17 and
  pgvector from the PostgreSQL apt repository on the runner; anonymous Docker Hub pulls are rate-limited
  and failed the job with nothing wrong in the code. `.github/` does not sync — a consumer copying the job
  takes this form.

### Actions for a consumer

1. Add `platform/errors/app-codes.ts`, `messages/app/**` and `docs/APP_API_ERRORS.md` to the sync
   exclude list **before the next sync after this one** — this sync brings the empty versions; the next
   would overwrite yours.
2. Move the app's own API errors onto codes (`apiError`), declaring app codes only where no platform code
   fits; regenerate `docs/APP_API_ERRORS.md`.
3. **Check every existing database for the app's own migrations** (`applied_migrations` against the
   files). A database built from the baseline before v3.1.0 does not have them; apply them in filename
   order.

No breaking change: the empty app files change nothing, and the guest route returns the same body.

---

## v3.0.1 — development-dependency advisories

Date: 2026-10-09

No runtime change; the production dependency tree is unchanged and `npm audit --omit=dev` is clean.

- **handlebars** 4.7.10 (in-range update, via ts-jest) — SEC-014.
- **brace-expansion** overrides raised to 1.1.21 and 2.1.7 — SEC-015.
- **sprintf-js** (SEC-012) and **braces** (SEC-013) have no patched release; both are reachable only
  from the test toolchain with the repository's own input. Recorded as accepted risk in
  [`SECURITY_DEBT.md`](SECURITY_DEBT.md) and reassessed at every dependency sweep.

**Consumer action:** `package.json` is sync-excluded — apply the same handlebars update and
brace-expansion overrides in your own `package.json` and run `npm install`.

---

## v3.0.0 — Sprint 7A: deployment & auth readiness

Date: 2026-10-09

The first real deployment showed that configuration no test could see broke every user: mock auth
in a deployment, unsigned guest tokens, no database, the wrong branch live, and end-to-end tests
passing while users saw errors. v3.0.0 makes that class of failure loud and early.

**This release is breaking** for a consumer that deploys — the production boot is stricter by
design — and it removes the never-working guest lifecycle. Upgrade with
[`MIGRATION_v2_to_v3.md`](MIGRATION_v2_to_v3.md).

### What a consumer inherits on sync

- **Deployment environment contract (ADR-050 D1/D2, Accepted).** Production refuses to boot on test-double
  auth, a missing, mis-shaped or alias-only setting, or an in-memory store, and names every violation.
  One source per setting (`SUPABASE_URL`, `NEXT_PUBLIC_COGNITO_*`); `AWS_REGION` no longer read.
- **Signed, bounded guests (ADR-050 D4).** Platform-owned HMAC-signed, namespaced guest tokens
  (`GUEST_TOKEN_SECRET`); routes opt guests in (`requireActorWithStatus … allowGuests`); a governed
  translate allowance (1–10, default 5, dual control) enforced before any paid call (migration 037,
  `GUEST_USAGE_STORE`).
- **One error contract (ADR-051 D1–D3, D5 a–e).** Every API error is `{ code, message, params }` from a
  registry and an ICU catalog (`messages/en.json`, locale negotiation); auth routes return real statuses;
  generated [`API_ERRORS.md`](API_ERRORS.md); free-text errors fail CI (now including `proxy.ts`); a
  screen-literal ratchet (287) for Sprint 7B.
- **Optional features offered only when configured (ADR-050 D3).** `platform/features`,
  `GET /api/features`, `requireFeature()` → `feature.not_configured`; durable social store required in
  production.
- **Single sign-on (TASK-101).** Cognito hosted sign-in with `state` + PKCE, `/auth/callback`, declared
  hosted domain and `SSO_PROVIDERS`; only configured providers are shown.
- **Accounts provisioned on first use (TASK-117).** The platform `users` row is created on a new user's
  first request; a missing row is no longer reported as "suspended"; new code `account.not_provisioned`.
- **Schema baseline + migration replay in CI (TASK-091).** `supabase/baseline/000_baseline.sql` builds a new
  database (the numbered chain could not); the CI job **Migration replay** applies the baseline and every
  newer migration to Postgres 17 + pgvector on every push and fails on a SQL error, a missing table or
  function, or a table without row-level security.
- **Deployed smoke test (ADR-050 D5/D6, TASK-102/105).** `scripts/deploy-smoke.mjs` checks a deployed
  address — health and the deployed commit, features, a coded refusal, a signed guest token, a real
  translation; `/api/health` reports `commit`.
- **Proxy.** A credentialed API call is no longer redirected to `/auth` without a session cookie; its 401 is
  coded.
- **Removed (TASK-111).** The session-count guest lifecycle (exports, `/api/admin/guest-config`, admin tool and
  panel) and, via migration 038, its table, four `users` columns and two config keys — it never worked.
- **Security.** Next.js 16.3.8 (critical GHSA-vcvr-r3jv-pc5j), sharp 0.35.5, brace-expansion 5.0.12, fast-uri
  3.1.8, source-map-js 1.2.2; production audit clean.

### Actions for a deploying consumer

1. Set the production settings in [MIGRATION_v2_to_v3.md](MIGRATION_v2_to_v3.md) §1 before deploying.
2. Existing database: apply 037 before deploying; apply 038 after the code without the guest lifecycle is
   live. New database: the baseline, then migrations after it.
3. Run the deployed smoke test after each deploy.

Apple and Microsoft sign-in moved to Phase 6 (TASK-112). Screen strings move to the catalog in Sprint 7B
(ADR-051 stays Proposed until then).

---

## v2.6.2 — migration 036 fix

Date: 2026-09-26

`036_governed_agent_budget.sql` (v2.5.0, ADR-048 M1) failed when applied: its `UPDATE` cast a jsonb
expression back to text on the jsonb `platform_config.value` column. The update now operates on jsonb
directly. Verified on Postgres 16: the migration seeds both governed budget keys, appends both to
`config.dual_control_keys`, and self-records. Consumers that already applied 036 successfully need no
action; consumers whose 036 failed should apply this version. Migration replay in CI is TASK-091.

---

## v2.6.1 — portable production-boot check

Date: 2026-09-26

Patch to the TASK-089 production-boot check (v2.6.0). The test drives `register()` through a
simulated production boot but did not set `NEXT_RUNTIME`, which Next.js sets to `nodejs` on a real
server. A consumer whose `instrumentation.ts` returns early outside the Node runtime (Playform's does)
therefore saw `register()` as a no-op and the check failed on sync. The simulated boot now sets
`NEXT_RUNTIME=nodejs`, so the check is faithful to a real server boot and runs unchanged against any
consumer's own instrumentation.

---

## v2.6.0 — Sprint 7: activity session durability & ownership (ADR-049)

Date: 2026-09-26

What a consumer inherits on sync:

- **Only a participant can load a session (ADR-049 D2).** `loadSession` now rejects an actor that
  is not one of the session's participants with `SessionAccessDeniedError`, before any D6 repair
  write. A session id is no longer a credential — consumers can resume sessions by id without
  writing their own ownership check.
- **Activity sessions are durable in production (ADR-049 D1).** The ADR-048 D3 fail-closed guard now
  covers `APP_STATE_STORE`: an in-memory activity state store refuses to boot in production, and
  `APP_STATE_STORE=supabase` without credentials no longer falls back to memory silently. The
  `E2E_IN_MEMORY_STORES=true` test-harness opt-out applies. **Action for production consumers:** set
  `APP_STATE_STORE=supabase` with Supabase credentials.
- **Production-boot check in PF's own gate (TASK-089)** and the **override reaudit cadence**
  (TASK-070/058) from Sprint 7 milestones 1–2.

---

## v2.5.1 — Sprint 6.5 patch: E2E opt-out for the production store guard

Date: 2026-09-25

Patch to the ADR-048 D3 production store guard (v2.5.0). The guard refuses to boot the agent
runtime on in-memory trajectory/budget stores when NODE_ENV=production — correct for a real
deployment, but an E2E harness runs the production build (Playwright's `next start` forces
NODE_ENV=production) with no Supabase provisioned, which the guard could not distinguish from a
deployment. It now honors an explicit `E2E_IN_MEMORY_STORES=true` opt-out set by the test harness;
a real deployment never sets it and still fails closed. The opt-out is logged when used.

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
