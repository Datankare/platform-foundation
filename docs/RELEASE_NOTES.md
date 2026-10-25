# Release notes

New platform capabilities per release, newest first. This is the discovery surface for
consumers building on platform-foundation: what shipped, what it gives you, and where to read
more. Engineering detail lives in the ADRs and design docs referenced from each entry; the
per-commit history lives in git.

Each entry names the capabilities a consumer inherits on sync, not every internal change.

---

## v6.0.0 — Tenancy, modules, jobs, the container, and the audit's Wave 2

Date: 2026-10-24 (Sprint 7R close). **Breaking** — deploy with the ordered runbook in
[MIGRATION_v5_to_v6.md](MIGRATION_v5_to_v6.md) §1: migrations 046–052 in the SQL Editor, then the
settings per environment (`CRON_SECRET` on every Preview and Production deployment, `JOB_STORE`,
`DATABASE_*`, `TENANCY_MODE`/`TENANT_ID`, `CACHE_PROVIDER`, the confidential Cognito client,
`PROVENANCE_SIGNING_KEY`). ADR-053, ADR-054, ADR-055 and ADR-056 are Accepted.

### R2 — Integrity fixes

- `adminGuard` returns the verified admin and every admin audit record names them (TASK-138).
- `ai_metrics` exists (migration 048) for the metrics sink (TASK-113).
- Agent budget days are UTC dates, and the COPPA age is computed the same way — never overstated,
  whatever the host's zone (TASK-144).
- The cache is chosen (`CACHE_PROVIDER`), never inferred; production refuses to boot without it,
  and `upstash` without its credentials refuses instead of falling back to memory (TASK-139).
- Host-neutral deployment: `DEPLOYMENT_HOST`, the commit from `GIT_COMMIT_SHA`, the version from
  `platform/version.ts` (TASK-140).
- Migration records tell the truth: 047 records `007_seed_separation.sql` as "absent" where its
  effect never happened; migration parity lists "absent" records (TASK-148).

### R3 — Tenancy (ADR-053; Sprint 7T brought in whole)

- One codebase, `TENANCY_MODE=single` (one `TENANT_ID`) or `shared`; every API route runs in a
  tenant scope (`tenantRoute`), failing closed.
- Migration 049: tenants and domains, `tenant_id` with tenant-scoped keys and foreign keys, forced
  row-level security for the `app_tenant` role on every tenant-owned table, layered configuration,
  the public key closed (TASK-114).
- `platform/data` — direct Postgres through a transaction pooler (`withTenantTx`, `withPlatformTx`,
  `withOwnerTx`); every store and admin path on it; values only as parameters (a CI check).
- Per-tenant cache keys, rate limits, budgets (with a tenant cap), audit, metrics and realtime
  topics; shared-mode identity assignment (Cognito `custom:tenant_id`).
- The operator console and lifecycle — provision, addresses, suspend, two-operator deletion,
  restore, purge, export — and tenant settings for tenant administrators.
- The isolation kit on every store, in memory and on Postgres in CI; review-queue state conflicts,
  soft deletions, `signups_enabled`, the AI cache key, `apiFetch` and dual-control config fixed
  (TASK-150–155).

### R4 — The core and product modules (ADR-054)

- `definePlatformModule` and extensible registries (providers, agents, prompts and evals, content
  types, features, goals, rate rules, consent and moderation lists, health probes, kit manifests);
  the app's modules listed in `platform/modules/app-modules.ts` and registered at boot.
- The 22 boundary imports removed and `import/no-restricted-paths` on, drawn from the module
  manifest; the core's tests pass with no module (`npm run test:core`); module migrations replay
  after the core's, in dependency order.

### R5 — Background work and health (ADR-056)

- `platform/jobs`: a Postgres-backed queue and scheduler (migrations 050, 051) with retries,
  idempotency, dead letters and fair claims; every timed duty a registered job, run by a signed
  tick (`/api/internal/jobs/tick`, Vercel Cron or `scripts/jobs-worker.mjs`) — `CRON_SECRET` is
  required on every deployment (TASK-141).
- Live and ready health: readiness reports boot, the database and the selected cache; realtime and
  modules degrade without taking an instance out (TASK-142). The scheduled load test runs (TASK-143).

### R6 — The container (ADR-055)

- Standalone output, a `Dockerfile` (non-root, read-only friendly, base image by digest), graceful
  shutdown (readiness flips, requests drain, telemetry flushes, pools close), and a CI job that
  builds the image, runs it and passes the deploy smoke test and the job worker against it
  (TASK-128). The R4–R6 adversarial review's sixteen findings fixed before release (TASK-156).

### R7 — The close: consumer seams, time zones, dependencies

- **The app's own module manifest** (TASK-157): `platform/modules/app-manifest.json`, a consumer
  seam the platform ships empty, merged with the platform's `manifest.json` for every reader. An
  app adds its files to a platform module and declares its own modules (dependencies, migrations);
  a path claimed twice, a platform module's dependencies redefined, an unknown dependency or a
  cycle fails loudly, saying what to change. The tests derive module ids from the merge.
- **App migrations never collide** (TASK-158): an app's are `NNN<letter>_<app>_<name>.sql`
  (`052a_playform_…`), after the platform's `NNN` and before `NNN+1`; the platform's are listed in
  `supabase/platform-migrations.json`. Replay, parity and `applied_migrations` take the form; the
  replay and `migration-naming` refuse a bare-numbered app migration and name the file to rename
  it to.
- **UTC everywhere** (TASK-159): every data-layer transaction sets `TimeZone` to UTC, so day
  arithmetic never depends on a database or role time zone; the suite passes under New York,
  Kolkata and UTC, and CI runs it under New York with New York database sessions.
- **A compliant sync to copy** (TASK-160): `docs/templates/sync-from-foundation.yml` and
  `sync-config.json`; `workflow-hygiene` failures name the file, the line and what to write.
- **Dependencies**: Next 16.4.3, `eslint-config-next` 16.4.3, `@sentry/nextjs` 11.9, Jest 30.5
  (`babel-jest`, `jest-environment-jsdom`), `@types/jest` 30, `@testing-library/jest-dom` 7,
  `intl-messageformat` 12.1.4, `@types/react` and `@types/react-dom` 19.3, ESLint 9.39.5; the
  lockfile regenerated (npm 11). `npm audit`: 0 vulnerabilities. ESLint 10 still waits on Next's
  React, accessibility and import plugins (TASK-149); TypeScript 7 waits on `ts-jest` (TypeScript
  `<7`); `@types/node` stays on 24 with the runtime.

### Sprint 7X Wave 2 — the October 2026 audit

Every Wave 2 item of the [register](audits/2026-10-REGISTER.md#wave-2-sprint-7x-on-develop-for-v600),
each with its test; migration 052.

- **Two-person control on every path.** Runtime holds have authorities: an approver must hold the
  permission the change needs; an approved hold runs once. Role, agent and approval-policy actions
  — from the command bar or the role page — are held for a second admin.
- **Sessions that can be revoked.** The refresh token lives only in an httpOnly cookie; sign-out
  revokes it and every token of the sign-in; staff sign in with a second factor; a confidential
  Cognito client; sign-in, sign-out and failures are audited; no answer reveals whether an account
  exists.
- **Erasure and export that cover everything.** One register of every table that holds a user's
  data (`platform/auth/user-data.ts`), checked against the schema; `GET /api/account/export` and
  `POST /api/account/delete`; the admin purge erases for real; a banned address keeps its ban.
- **Age at sign-up**, recorded once, with the consent gate on every user route.
- **Fail-closed multimodal safety and signed provenance**; screening consequences recorded before
  the response; a classifier outage never floods the review queue; a ban is never lowered.
- **Plumbing**: whole-exchange fetch timeouts that keep the caller's signal and never resend a
  paid call; a per-request CSP nonce; invalidations that reach every instance; `AI_PROVIDER` that
  takes effect; `LOG_LEVEL` `warn` by default.
- **Checks that run in your repository too**: the route-level role matrix on Postgres, property
  tests for every validator and route body, the monkey's paced sequence mode, workflow hygiene
  (no interpolated inputs, pinned scanners, anchored sync excludes), an exact override audit with
  your own register, and a guard that no route reaches the latent modules.

### Review 7 — fixed before release

An adversarial review of this release's candidate, and its adoption in Playform
([register](audits/2026-10-REGISTER.md#found-by-review-7-of-the-unreleased-wave-2-and-close-out-2026-10-24-fixed-in-v600)):

- **Nothing unjudged is cleared**: a classifier outage, or an unreadable answer, is withheld at
  every content rating level.
- **The app manifest takes nothing of the platform's**: no platform migration, nothing under
  `platform/`, no file the platform ships (`platform/modules/platform-paths.json`).
- **Exports and erasure**: every row, in pages, or a coded refusal (`account.export_too_large`);
  no staff member's data and no other participant's; erasure reaches columns and JSON naming the
  user; the coverage test classifies columns, and a consumer's tables by its own declarations
  (`noUserData` in the app manifest).
- **Power changes under dual control**: entitlement groups and capability mappings; the
  permissions cache follows every role-catalog and account change; an approved hold that failed
  can be rejected and lapses.
- **Token verification remembered** in the shared cache (≤ 60 s, revoked at once everywhere,
  single flight): no Cognito `GetUser` per request; a throttled Cognito fails privileged routes
  closed (503), never a 401.
- **Keys**: the erased-ban address hash is an HMAC (`ERASURE_HASH_KEY`); provenance credentials
  name their key and verify across a rotation (`PROVENANCE_SIGNING_KEY_PREVIOUS`).
- **Checks**: migration numbers bounded, 052 safe over an app's rows and keeping a retired
  setting's history, workflow hygiene over every script form and installer, the role matrix over
  operator routes with the database's permissions and valid bodies.

### Review 8 — fixed before release

A second adversarial review of the candidate
([register](audits/2026-10-REGISTER.md#found-by-review-8-of-the-v600-candidate-2026-10-24-fixed-in-v600)),
every finding fixed with its regression test:

- **Token verification**: every access token's signature is checked locally against the pool's
  keys (`jose`, RS256 only, JWKS kept and refreshed at most once per 30 s) before Cognito's
  `GetUser` — forged tokens cost no quota; a request after a sign-out, role or MFA change never
  takes a racing pre-revocation answer; a new user's tenant and a verified address are read at
  the next request; account export and deletion and MFA routes fail closed.
- **Nothing unjudged is cleared, or queued**: a classifier answer missing or mangling any field
  is unjudged and withheld at every level; unjudged content is not queued for review, and is
  counted for an alert (`moderation.screening_unjudged`).
- **Erasure**: an address is replaced only as a whole value (never another account's near miss);
  every uuid, string, array and JSON column is classified, and each claim is proved by a hostile
  scan; others' cases, contexts, sessions and audit details lose the user's id; the export's
  steps are the user's own. An operator step redacts addresses of accounts erased before this
  release (`supabase/optional/redact_orphan_addresses.sql`).
- **Governance**: every setting whose change is a change of power is under dual control (052);
  lapsed hold withdrawals are audited; the erased-ban hash has a key id and rotation
  (`ERASURE_HASH_KEY_PREVIOUS`), and legacy hashes are upgraded.
- **Boundaries and checks**: the app manifest refuses glob characters and case or Unicode
  variants of platform paths; workflows are parsed as YAML (flow steps, folded lines, aliases,
  composite actions); the in-memory cache is bounded and swept, and refused in a deployment.

### Review 14 — fixed before release

The final verification review of the candidate
([register](audits/2026-10-REGISTER.md#found-by-review-14-of-the-v600-candidate-2026-10-24-fixed-in-v600)),
no Critical or High; every finding fixed with its regression test (TASK-169):

- **A busy instance does not blame the cache**: a stamp read yields once at its 200 ms bound and
  takes an answer that has arrived; a timeout during event-loop lag above 100 ms is counted as lag
  (metric and alert `cache.stamp_read_lag`), never a cache failure, so a CPU-saturated instance no
  longer opens the stamp breaker against a healthy cache. `cache.stamp_breaker_open` and
  `cache.stamp_read_lag` are raised at most once per 5 minutes per instance, with a count.
- **A lost commit keeps its invalidation**: when a commit's answer is lost with the connection, the
  config and permission invalidations still publish (`onCommit(hook, { idempotent: true })`); the
  error is `CommitOutcomeUnknownError`; `audited()` records `indeterminate`; config writes, resets
  and command-bar role changes answer "may or may not have been applied" (`indeterminate`), not
  "failed".
- **Withdrawals leave nothing unreported, in no tenant**: an approval a concurrent reviewer held is
  counted and alerted (`approvals.withdrawal_incomplete`, `remaining`); a platform-scope reduction
  withdraws the platform-scope holds of every tenant holding one, audited in each.
- **"Unavailable", never "empty"**: an admin panel whose read is answered 503 says "Unavailable —
  could not read" (with a retry); the agent-registry and capability-mapping routes answer 503 for a
  malformed stored value; the console reads its first panel at once.
- **For app authors**: run the capability kit under your own names —
  `runCapabilityFeaturesContract(fixtures, { names: { …, fallback: [...] } })`; tag a helper that
  reaches outside the database (or runs hooks that may) with JSDoc `@external`, and pass
  `{ external: true }` to `audited()` / `auditedResponse()` for an act that calls one — a CI check
  reads the code; DB tests run under a 30 s bound (`__tests__/helpers/db.ts`).

### Found adopting the candidate in Playform — fixed before release

Two defects Playform carried as sync-excluded copies (TASK-168); consumers drop their copies:

- **Concurrent first requests each get their account**: the account insert arbitrates every
  unique key of the row (`on conflict do nothing`, no target), not only the id, so a first request
  that loses to a concurrent one answers `existing` — never a unique violation on
  `players_cognito_sub_key` and `account.not_provisioned`. A subject held by another account, or an
  identity held in another tenant, answers `failed`, decided by a read in the same transaction.
- **`migration-naming` is consumer-correct**: it reads the merged manifest, the app's
  `migrationsBeforeTheConvention` included, so an app with grandfathered migrations inherits it
  unchanged.

### Review 13 — fixed before release

A seventh adversarial review of the candidate
([register](audits/2026-10-REGISTER.md#found-by-review-13-of-the-v600-candidate-2026-10-24-fixed-in-v600)),
no Critical or High; every finding fixed with its regression test:

- **An approved reset resets to what the approver saw**: it applies only while the platform
  default it would inherit is the one recorded at request time (`approvals.stale` otherwise).
- **A hanging shared cache never holds a request**: reading a stamped key's invalidation stamp —
  the agent registry, the capability map, every permission check — waits at most 200 ms; after 5
  failures in a row a circuit breaker stops asking for 30 s (alert `cache.stamp_breaker_open`),
  then probes. Such reads go to the database, never to what is cached.
- **For app authors — the capability contract, usable and fail closed**: run
  `runCapabilityFeaturesContract` against your own decision through its seams (`serveMap`,
  `serveUnreadable`, `holdFeatures`, `decide`) — no adapter to write. A malformed **or unreadable**
  `agent.capability_features` allows nothing: there is no built-in fallback map. Read the two
  governed agent keys with `readCapabilityFeatures` / `readTrustedAgents`, or decide with
  `evaluateGovernedCapability` (`platform/agents/governed-agent-config.ts`) — never `getConfig`
  with a default.
- **Withdrawals are scoped and bounded**: a reduction withdraws only the holds of the scope it
  reduced, found by key in the store and withdrawn 100 at a time, one audit record per batch
  (`holdIds`); the kill switch re-run publishes the invalidation again (`republished`).
- **The database keeps chains and lists true**: the chain guard locks a continuation's predecessor
  (a concurrent update waits, then is refused); 052 seeds each dual-control key once, so a database
  that ran an earlier 052 gets `agent.trajectory_max_segments` and an operator's removal stands.
- **Truthful records**: a commit lost with its connection is recorded `indeterminate`, never
  `rolled_back`; an external act (`audited(…, { external: true })`) is refused inside a transaction;
  cache invalidations are published after the commit (`onCommit`). ABA on a compare-and-set is
  documented as accepted (the base value is identical).

### Review 12 — fixed before release

A sixth adversarial review of the candidate
([register](audits/2026-10-REGISTER.md#found-by-review-12-of-the-v600-candidate-2026-10-24-fixed-in-v600)),
every finding fixed with its regression test:

- **A kill switch cannot be undone by an older approval**: every held config change records the
  value it replaces and is applied only onto it — if the setting changed since (a kill switch, a
  power reduction, another approved change), nothing is applied, the request is withdrawn and the
  approver is told `approvals.stale`. The kill switch and every one-admin reduction withdraw the
  pending holds on their setting, each audited. A suspension reaches every instance at its next
  read (the config cache is invalidated through the shared cache), and single-tenant deployments
  have the kill switch too: `POST /api/admin/agents/suspend` for `config_manage_safety` holders.
- **For app authors — capability mappings fail closed**: a capability absent from
  `agent.capability_features` is not allowed. `evaluateCapabilityFeatures` (platform/agents) is
  the evaluator and `__tests__/contract/capability-features-contract.ts` the kit to run against
  your own. Removing or emptying a mapping is held for a second admin; adding a required feature is
  applied at once.
- **For app authors — long sessions stay in order and bounded**: a step always goes to the chain's
  last segment (the database refuses a chain that is cyclic, forked or misnumbered); a chain holds
  at most `agent.trajectory_max_segments` segments (default 20 × 1 000 steps), then
  `request.trajectory_chain_full`; `loadSession` reads only the last segment, and
  `trajectoryChainPages` pages a session's history one segment at a time.
- **Truthful records**: an audited act whose transaction rolls back is recorded as rolled back;
  the kill switch is recorded as attempted, then succeeded or failed; a one-admin reduction is
  recorded before it is made (no record, no change); `toJSON` values are measured as what they
  write; a tenant's compare-and-set is serialised with a platform-default write; marking an
  undecided run executed needs someone other than its requester.

### Review 11 — fixed before release

A fifth adversarial review of the candidate
([register](audits/2026-10-REGISTER.md#found-by-review-11-of-the-v600-candidate-2026-10-24-fixed-in-v600)),
every finding fixed with its regression test:

- **An approval runs once, even when its run is slow**: each claim carries a run token, and only
  that run ends it. A run that outlives its 10-minute lease is never given back to `approved` on a
  guess: the recovery job marks it **undecided** (`indeterminate` — not runnable, alerted, listed
  first on the approvals page) unless its step was recorded (executed) or it was atomic (rolled
  back with it). A person decides: **Took effect** (`mark_executed`) or **Did not — approve again**
  (`reapprove`, a fresh independent approval). A completion that can no longer land is reported
  as applied and audited as a conflict, never swallowed. A failure after a tool's own work is
  "applied", never "approve again to retry"; an approved tool runs once (no output retry).
- **For app authors — sessions no longer stop at 1 000 moves**: when a session's trajectory
  reaches its cap (1 000 steps / 16 MiB), the next move starts a continuation trajectory linked to
  it (`segment`, `previousTrajectoryId`, `stepOffset`), in the same transaction as the move.
  Nothing to change in an app that uses `dispatch()`/`loadSession()`: the result's `trajectory`
  is the continuation, and the next move goes there. To read a session's whole history use
  `readTrajectoryChain(store, trajectoryId)` / `chainSteps(chain)` — a single trajectory row now
  holds one segment. A long-running agent opts in with `invokeTool({ rolloverTrajectory: true })`
  and continues on `outcome.trajectory`; every other path still gets `request.trajectory_full`.
  Exports and erasure cover every segment.
- **A kill switch**: suspending an agent, narrowing its scopes, lowering its token lifetime or
  removing a capability mapping is applied at once by the one admin making it (with
  `config_manage_safety`), audited and alerted — a mixed change that also widens anything is held
  as before. Operators suspend every agent of a tenant with
  `POST /api/operator/tenants/[id]/agents/suspend`. Runbook:
  [runbooks/approvals-and-agents](runbooks/approvals-and-agents.md).
- **Bounded and truthful**: the stored-JSON pre-check counts strings by their length (a shared
  1 MB string no longer makes it write out 1.2 GB); erasure's last-resort redaction keeps the
  document's content (as its text, the address replaced); the command bar's search skips only the
  rows too large to show, names them, and shows the newest first.
- **Smaller**: an atomic action's audit records survive its rollback; a retried policy write inside
  a transaction uses a savepoint; 052 no longer re-creates the email-hash CHECK on every
  application; a cold request waits at most 1 s in all for signing keys; a malformed
  `VALKEY_URL` (a bad percent-escape, a user without a password) is refused at boot with
  `config.valkey_url_invalid`.

### Review 10 — fixed before release

A fourth adversarial review of the candidate
([register](audits/2026-10-REGISTER.md#found-by-review-10-of-the-v600-candidate-2026-10-24-fixed-in-v600)),
every finding fixed with its regression test:

- **One hold per change**: the command bar's agent and capability actions are config writes, held
  only by their key (`agent.trusted_agents`, `agent.capability_features`) under the key's rules —
  `config_manage_safety` to approve, never the requester, an operator for a shared deployment's
  platform default. The review 9 approval capability is removed; a test keeps any action from
  being both action-held and a config write. `admin.dual_control_actions` is always held.
- **A failed run keeps its approval**: an approval is claimed for its run (`executing`) and
  returned when the run fails before taking effect — "approve it again to retry" is now true; a
  crashed run's claim is recovered after 10 minutes; tenant-transaction actions run claim, effect
  and completion in one transaction.
- **Truthful limits**: an oversized tool output is recorded as not kept rather than failing work
  already done; a state too large is refused before the effect; a failure after it says
  "applied, record not stored" and is audited; a trajectory holds at most 1 000 steps / 16 MiB;
  the command bar's search result is cut at 256 KiB.
- **Outages and transport**: a cold instance waits at most 1 s per request for signing keys;
  `VALKEY_URL` options in the URL are refused (they overrode TLS).
- **Erasure**: never a change of type, never a lost key; the email-hash scheme CHECK has no NULL
  hole. Timing tests measure inside the database or assert work.

### Review 9 — fixed before release

A third adversarial review of the candidate
([register](audits/2026-10-REGISTER.md#found-by-review-9-of-the-v600-candidate-2026-10-24-fixed-in-v600)),
every finding fixed with its regression test:

- **Dual control, truthfully**: a held change is its own result everywhere (`held: true`, never
  success — command bar, config page, Jobs console). An approved `register_agent`,
  `set_agent_scope` or `set_capability_mapping` applies exactly once: its write presents the
  approval's capability, minted when the approval is used and bound to it, the key and the value;
  a forged or reused one is refused, and a direct write of those keys is still held.
- **Erasure cannot be blocked**: `jsonb_replace_text_value` no longer recurses and cannot fail on
  any document (depth 10 000, a million elements in seconds); it replaces an address that is an
  object key too. Stored caller JSON is bounded (64 levels, 1 MiB) with coded errors. The
  erased-ban hash records its scheme, and only rows recorded as unkeyed are upgraded.
- **Outages are not sign-outs**: a cold instance retries the signing keys on a short backoff;
  unavailable keys fall through to the remembered verification and the stale grace; a suppressed
  key refresh is 503, never 401; an outage answer after a revocation never stands in.
- **A shared cache for containers**: `CACHE_PROVIDER=valkey` — Valkey or Redis over verified TLS
  (`ioredis`, pinned), passing the cache conformance kit; `memory` stays refused, and the boot
  error and the container guide say what to set.
- **Checks**: a classifier's `"reason": null` is an absent reason; workflow hygiene resolves
  aliases everywhere and matches `uses:` without case; app manifest paths are plain ASCII segments.

---

## v5.1.1 — Dependencies, and no state set inside an effect

Date: 2026-10-23

Clears every open Dependabot update, and fixes the platform's own sign-in page in a production
build ([register](audits/2026-10-REGISTER.md) PR-17). No migration.

### What a consumer inherits on sync

- **Next's lint configuration 16** (`eslint-config-next` 16.4.2) in flat-config form, with React's
  newer hook rules. Every component that set state inside an effect now does not:
  - a component that loads data drops a response for a request it has since replaced
    (`ReviewDashboard` — its Refresh included —, the admin console, `DualControlKeysPanel`,
    `useProfileForm`), so a slow earlier response never overwrites a newer one;
  - state that follows a prop is adjusted during render (`HeldActionsPanel`,
    `useRealtimeChannel`), so the old value never renders first;
  - the auth session is an external store read with `useSyncExternalStore`
    (`platform/auth/context.tsx`): the server render and hydration both show loading, storage is
    read once on the client, and a stale or corrupt session is purged as before;
  - the sign-in page reads a failed SSO attempt's `?error=` the same way (`useReturnError`).
- **The browser signs in through the server.** `createBrowserAuthProvider()`
  (`platform/auth/browser-auth-provider`, Playform's, adopted by the platform) posts to the
  `/api/auth/*` routes and reads a failure from the status, not the body (a coded error keeps
  its code; a reply that is not JSON is `internal.error`); a method with no route answers
  `feature.not_configured` without a request, never a fake success. The platform's sign-in page registers it instead of starting
  every server provider in the browser, which in a production build refused to boot on the
  browser's absent store settings and left the page on "Loading...".
- **The auth screens meet WCAG AA contrast.** With the page rendering at last, the baseline
  accessibility audit reached the sign-in form and found secondary text (`text-gray-500/600` on
  the dark card) at 3.7:1; every auth component now uses `text-gray-400`. Sign-in, register and
  forgot-password pass axe (WCAG 2 A/AA) in a production build.
- React and React DOM 19.3.1 (React DOM 19.3 requires React 19.3), `@sentry/nextjs` 11.8
  (every call the error reporter makes was checked against it), `@supabase/supabase-js` 2.117,
  Playwright 1.63, Prettier 3.9.10 (two ADRs reformatted), and the patch group.
- Removed, unused: `@anthropic-ai/sdk`, `dotenv`, `@eslint/eslintrc` (the flat config needs no
  compatibility layer).
- Dependabot ignores ESLint 10 (the React, accessibility and import plugins in Next's
  configuration declare ESLint up to 9) and `@types/node` majors above the Node we run (24;
  `@types/node` moves from 25 to 24 to match).

### Upgrading

Your own `eslint.config.mjs` is yours (sync-excluded): replace `FlatCompat` with
`eslint-config-next/core-web-vitals`, `eslint-config-next/typescript` and
`eslint-config-prettier/flat`, as PF's does, and fix what React's hook rules report in your own
components the same ways.

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
