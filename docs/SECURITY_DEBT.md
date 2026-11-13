# Security & Technical Debt Register

Security-specific consciously deferred items only.
Non-security tasks (refactors, features, infrastructure) live in TASKS.md.
These are NOT ignored — each has a resolution plan and a hard deadline.

---

## Open Items

---

### TASK-044 — Per-environment ACRCloud projects for security isolation

| Field        | Detail                                                                                 |
| ------------ | -------------------------------------------------------------------------------------- |
| **ID**       | TASK-044                                                                               |
| **Type**     | Security — credential isolation                                                        |
| **Severity** | Medium                                                                                 |
| **Phase**    | Phase 8 — Consumer App Integration                                                     |
| **Status**   | In progress — code and documents done (TASK-203, N-36); the owner's console steps open |
| **Logged**   | 2026-04-25                                                                             |
| **Source**   | TASK-026 rotation                                                                      |

**What:** All Vercel environments (Production, Preview, Development) share the same ACRCloud
credentials (`playform-prod-songid`): (1) preview and dev calls consume production's paid credit,
(2) a staging bug that hammers the identify endpoint reaches production's rate limits, (3) a
leaked dev credential exposes production's project.

**Done (TASK-203):** each environment is given its own: production keeps `playform-prod-songid`;
staging gets `playform-staging-songid`; dev runs `SONG_ID_PROVIDER=mock` (no credential, no paid
calls) — the provider registry already takes `mock`, and the song-identification probe and feature
check follow the selection. Playform's APP_ENV_REFERENCE names each environment's value,
`docs/credential-register.json` has one row per project, and ROTATION_RUNBOOK rotates each project
on its own.

**Owner steps (open):**

1. Create the `playform-staging-songid` ACRCloud project (Recorded Audio, Audio Fingerprinting,
   the ACRCloud Music bucket — as ROTATION_RUNBOOK's "Create project").
2. In the `playform-staging` Vercel project: set `ACRCLOUD_ACCESS_KEY`, `ACRCLOUD_ACCESS_SECRET`
   and `ACRCLOUD_HOST` to that project's, scoped to its environment only.
3. In the `playform-dev` Vercel project: set `SONG_ID_PROVIDER=mock` and remove the three
   `ACRCLOUD_*` values.
4. Redeploy both, and check each one's `/api/health` lists `song-identification` as its provider
   says (staging: the probe; dev: not probed — `mock` is local).
5. Then move this row to Resolved.

---

### SEC-016 — a stolen access token can call Cognito directly (accepted residual until batch S9)

| Field        | Detail                                                                 |
| ------------ | ---------------------------------------------------------------------- |
| **ID**       | SEC-016                                                                |
| **Type**     | Security — session token exposure (authentication)                     |
| **Severity** | Medium                                                                 |
| **OWASP**    | A07 — Identification and Authentication Failures                       |
| **Status**   | Accepted residual — root fix is batch S9 (server-side sessions)        |
| **Logged**   | 2026-10-30 (TASK-194 review round 1, finding C1; the owner's decision) |
| **Deadline** | Batch S9 of the sweep                                                  |

**What:** the browser keeps the Cognito access token in `localStorage`
(`platform/auth/context.tsx`), and the token carries the `aws.cognito.signin.user.admin` scope.
TASK-194 (C-3) made **the app's own routes** require a step-up — the password and a current code —
before a second factor is turned off or replaced (`/api/auth/mfa/disable`, `/api/auth/mfa/setup`
for an enrolled account). That does not bind Cognito itself: whoever steals the token (an XSS, a
malicious extension, a shared machine) can call Cognito's own API with it directly —
`SetUserMFAPreference`, `AssociateSoftwareToken`, `VerifySoftwareToken`, `ChangePassword` with the
old password, `UpdateUserAttributes` — and so turn off or replace the factor without the step-up,
until the token expires. **The app's routes require step-up; direct Cognito calls with a stolen
access token remain possible until S9.**

**Resolution plan:** batch S9 — server-side sessions: the access token never reaches the browser
(an httpOnly session cookie the server maps to the tokens), so a script in the page cannot read it.
Until then: the token's lifetime is the pool's (keep it short), sign-out revokes it, and every MFA
change the app makes is recorded.

---

### SEC-012 — sprintf-js denial of service, no patched release (accepted risk)

| Field        | Detail                                                     |
| ------------ | ---------------------------------------------------------- |
| **ID**       | SEC-012                                                    |
| **Type**     | Security — dependency advisory (development only)          |
| **Severity** | Moderate (advisory); not reachable here                    |
| **Advisory** | GHSA-hp3w-g68c-fv3c — sprintf-js ≤1.1.3, no patch released |
| **Status**   | Accepted risk — reassessed at every dependency sweep       |
| **Logged**   | 2026-10-09 (v3.0.1)                                        |

**What:** unbounded precision specifiers in a format string exhaust memory. Path:
`babel-jest → babel-plugin-istanbul → @istanbuljs/load-nyc-config → js-yaml@3 → argparse@1 → sprintf-js@1.0.3`.
argparse formats only its own help and error text with its own format strings, and only when
js-yaml's command-line tool runs — the test toolchain loads js-yaml as a library and never runs that
tool. No patched version exists, so there is no override to apply.

**Traced 2026-11-08 (TASK-203, N-83; the owner's decision of 2026-11-07: replace it if reachable at
runtime, keep it accepted with the evidence if not) — build and test only, kept accepted:**

- `npm ls sprintf-js --all` (both repositories): the one path above, under `babel-jest`, a
  devDependency.
- `npm ls sprintf-js --all --omit=dev`: empty — nothing the deployed app installs depends on it.
- No source of ours imports `sprintf-js`, `argparse` or `js-yaml`
  (`grep -rlnE "from ['\"](sprintf-js|argparse|js-yaml)['\"]|require\(['\"](sprintf-js|argparse|js-yaml)['\"]\)" app platform lib components hooks proxy.ts instrumentation.ts`
  finds nothing).
- `npm audit` on 2026-11-08 does not list `sprintf-js` at all (it lists other advisories; see the
  register's findings out of this item's scope).

**Resolution plan:** at each dependency sweep, check for a patched sprintf-js or an istanbul release
that drops js-yaml@3; apply it and move this row to Resolved. GitHub alert dismissed as "risk is
tolerable" citing SEC-012.

---

### SEC-013 — braces stack exhaustion, no patched release (accepted risk)

| Field        | Detail                                                 |
| ------------ | ------------------------------------------------------ |
| **ID**       | SEC-013                                                |
| **Type**     | Security — dependency advisory (development only)      |
| **Severity** | High (advisory); not reachable here                    |
| **Advisory** | GHSA-vfj7-8cjw-p6xm — braces ≤3.0.3, no patch released |
| **Status**   | Accepted risk — reassessed at every dependency sweep   |
| **Logged**   | 2026-10-09 (v3.0.1)                                    |

**What:** deeply nested brace patterns exhaust the stack. Path, as of 2026-11-08:
`eslint-config-next → @next/eslint-plugin-next → fast-glob@3 → micromatch@4 → braces@3.0.3` (the
`@types/jest → expect → jest-message-util` path once recorded here no longer installs it).
micromatch expands only the glob patterns the linter is given — this repository's own
configuration — never user input. No patched version exists.

**Traced 2026-11-08 (TASK-203, N-83; the owner's decision of 2026-11-07) — lint only, kept
accepted:**

- `npm ls braces --all` (both repositories): the one path above, under `eslint-config-next`, a
  devDependency.
- `npm ls braces --all --omit=dev`: empty — nothing the deployed app installs depends on it.
- No source of ours imports `braces`, `micromatch` or `fast-glob`
  (`grep -rlnE "from ['\"](braces|micromatch|fast-glob)['\"]|require\(['\"](braces|micromatch|fast-glob)['\"]\)" app platform lib components hooks proxy.ts instrumentation.ts`
  finds nothing).
- `npm audit` on 2026-11-08 does not list `braces`.

**Resolution plan:** at each dependency sweep, check for a patched braces; apply it and move this
row to Resolved.

---

### H-13 — consumer identifiers in the public history (accepted, the owner's decision)

| Field        | Detail                                                                 |
| ------------ | ---------------------------------------------------------------------- |
| **ID**       | H-13 (audit 2026-10, [register](audits/2026-10-REGISTER.md))           |
| **Type**     | Security — information exposure (history)                              |
| **Severity** | Low                                                                    |
| **Status**   | Accepted — the owner's decision, confirmed 2026-11-07 (TASK-203, N-83) |
| **Logged**   | 2026-10 (audit Wave 2)                                                 |

**What:** earlier commits name a Cognito user pool id and a Supabase project reference.

**Why it stays accepted:** the tree is clean (gitleaks scans every commit in CI); a pool id and a
project reference are not secrets — each is public in every browser bundle the deployment serves;
and removing them would mean rewriting the public history, which only the owner can approve and
has decided against. A credential, if one were ever found in the history, is rotated, never
accepted under this item.

---

## Dependency Overrides (TASK-070)

Every entry under `overrides` in `package.json` is a claim that a dependency's own version
choice is wrong. Claims expire, and an unaudited override is worse than none: it is invisible,
survives `npm update`, and points diagnosis away from itself (SEC-008 held the tree at the
vulnerable `brace-expansion` 5.0.8 for a day for exactly this reason). Each override below has a
recorded reason and a removal condition. `scripts/override-audit.mjs` (CI Layer 0e) fails the
build if any override key is missing from this table, so a new override cannot land undocumented.

Removal procedure for any override: remove the entry, `npm install`, `npm audit`; if the tree
stays clean and installs, the override has expired and should be dropped.

| Override                             | Pinned                             | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Removal condition                                                                                                             |
| ------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| postcss                              | >=8.5.18                           | Forces a postcss line carrying patched nanoid (SEC-010, GHSA-2v37-7h3g-55p8).                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Consumer requires postcss >=8.5.18 (patched nanoid) natively.                                                                 |
| browserslist                         | ^4.28.7                            | Holds the transitive browserslist at 4.28.7 or later: through 4.28.6 a stream of distinct queries grows memory without bound (GHSA-c83g-rgw3-j3cx, high), and untrusted `browserslist-stats.json` stats crash it or write to a prototype (GHSA-73wf-gq98-2v4g, high). The advisories were confirmed against npm's advisory database for TASK-213.                                                                                                                                                                                                       | Audit clean after removal.                                                                                                    |
| fast-uri                             | ^3.1.9                             | fast-uri host confusion (SEC-009, GHSA-7p8r-x3mc-p8w7); raised to 3.1.8 for the 2026-10-07 advisory (3.0.0–3.1.7). Raised to 3.1.9 (TASK-213) for the four that release fixed (2026-10-19): scheme spoofing GHSA-w74x-v6f9-j3xg, host confusion GHSA-wjr9-j795-jxcr, relative-reference normalization GHSA-xhq7-xmqj-769h, suffix-reference scheme injection GHSA-333x-w4r6-6crp.                                                                                                                                                                       | Consumer (fastify/ajv) requires patched fast-uri natively.                                                                    |
| @humanfs/node                        | ^0.16.8                            | Holds @humanfs/node (ESLint's; development only) at 0.16.8 or later: below it a recursive copy follows symlinked files and copies data from outside the source tree (GHSA-p498-v437-472g, moderate). The advisory was confirmed against npm's advisory database for TASK-213.                                                                                                                                                                                                                                                                           | Audit clean after removal.                                                                                                    |
| sharp                                | ^0.35.5                            | sharp/librsvg CVE-2026-96889 (GHSA-wq5f-xc86-pv6w, 2026-10-07): fixed in 0.35.5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Audit clean after removal.                                                                                                    |
| brace-expansion@5                    | 5.0.12                             | ReDoS (SEC-008, GHSA-rgw5-rvv9-x895), then parseCommaParts stack exhaustion (2026-10-07, ≤5.0.11).                                                                                                                                                                                                                                                                                                                                                                                                                                                      | TASK-069: 5.x consumers require patched natively.                                                                             |
| brace-expansion@1                    | 1.1.21                             | Same ReDoS family (GHSA-rgw5-rvv9-x895), then parseCommaParts stack exhaustion on the 1.x line (2026-10-09, SEC-015).                                                                                                                                                                                                                                                                                                                                                                                                                                   | 1.x consumers require patched natively.                                                                                       |
| brace-expansion@2                    | 2.1.7                              | Same ReDoS family, then parseCommaParts stack exhaustion on the 2.x line (2026-10-09, SEC-015).                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 2.x consumers require patched natively.                                                                                       |
| js-yaml@3                            | 3.15.2                             | js-yaml advisory on the 3.x line (TASK-049 dependency-advisory family).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 3.x consumers require patched natively.                                                                                       |
| js-yaml@4                            | 4.3.2                              | js-yaml advisory on the 4.x line.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 4.x consumers require patched natively.                                                                                       |
| source-map-js                        | ^1.2.2                             | Event-loop DoS via indexed section offsets (GHSA-68fv-2mgg-jv7q, 2026-10-07); via next → postcss.                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Consumers (postcss) require ≥1.2.2 natively.                                                                                  |
| glob                                 | ^14.0.4                            | Glob AbortSignal cancellation bypass (GHSA-3g3m-2fjr-6pw4, 9.0.0–14.0.1; TASK-203). Jest 30.5.2 (latest: `@jest/reporters`, `jest-config`, `jest-runtime`) and `test-exclude` 7/8 still ask for glob 10/13, with no fixed release; `@sentry/nextjs` was upgraded to 11.11.0 instead, which asks for glob ^14.0.3 itself.                                                                                                                                                                                                                                | Jest and test-exclude require glob >=14.0.2 natively.                                                                         |
| @stryker-mutator/core                | minimatch ^11.0.5                  | minimatch globparts amplification DoS (GHSA-g3hv-75wg-m249, 7.0.0–11.0.0; TASK-203): Stryker 10.1.1 (latest) pins `minimatch ~10.2.4`.                                                                                                                                                                                                                                                                                                                                                                                                                  | Stryker requires minimatch >=11.0.1.                                                                                          |
| test-exclude                         | minimatch ^11.0.5                  | The same minimatch advisory: test-exclude 8.0.0 (latest, through babel-plugin-istanbul) asks for ^10.2.2.                                                                                                                                                                                                                                                                                                                                                                                                                                               | test-exclude requires minimatch >=11.0.1.                                                                                     |
| @typescript-eslint/typescript-estree | minimatch ^11.0.5                  | The same minimatch advisory: typescript-eslint 8.72.1 (latest) asks for ^10.2.2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | typescript-estree requires minimatch >=11.0.1.                                                                                |
| qs                                   | ^6.17.1                            | qs DoS and array-limit bypasses (GHSA-q8mj-m7cp-5q26, GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g, GHSA-6pq8-jhm2-2vcw; ≤6.16.0; TASK-203): Stryker's `typed-rest-client ~2.3.0` pins qs 6.15.1 exactly; 2.3.1 is that line's last release.                                                                                                                                                                                                                                                                                                                | Stryker moves to typed-rest-client 3.x (qs ^6.16.0) or later.                                                                 |
| deepmerge                            | $deepmerge (file:vendor/deepmerge) | deepmerge `mergeObject()` prototype poisoning (CVE-2026-93753, GHSA-gcqx-w48m-w2h4): every release through 4.3.1 is affected and none is fixed. Jest's `jest-config` uses it. `vendor/deepmerge` is 4.3.1's build with each key written as an own data property (`setOwn`), MIT, credited to its authors in the file; `__tests__/vendored-deepmerge.test.ts` holds that a parsed `__proto__` key stays an own property and the merged object's prototype is untouched, that merging is otherwise unchanged, and that `deepmerge` resolves to this copy. | Upstream publishes a fixed deepmerge, or jest-config drops it: remove the override, the devDependency and `vendor/deepmerge`. |

---

**Reaudit cadence (TASK-070):** the scheduled dependency sweep (`.github/workflows/dependency-audit.yml`)
runs `scripts/override-reaudit.mjs`, which emits a per-override triage checklist to the run summary
so the remove-install-audit reaudit happens on a cadence, not never. **Cross-repo (TASK-058):**
platform-foundation and Playform maintain overrides independently (`package.json` is sync-excluded);
an override added in one repo is not inherited by the other, so reconcile divergence at each triage.

## Resolved Items

_Items below have been resolved and are retained for audit trail only._

| ID       | Description                                                                                       | Resolved In                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Date       |
| -------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| DS-001   | next/image disk cache vulnerability                                                               | Phase 0 (Next.js 16 upgrade)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 2026-03-18 |
| SEC-002  | No rate limiting on API routes                                                                    | Phase 1, Sprint 6 covered admin routes only, per instance; every route since ADR-052 (TASK-134)                                                                                                                                                                                                                                                                                                                                                                                                                                   | 2026-10-20 |
| SEC-003  | No retry logic for external API calls                                                             | Phase 1, Sprint 7a (fetchWithTimeout retry)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 2026-04-01 |
| SEC-004  | No E2E tests — Playwright not integrated                                                          | Phase 0.75                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 2026-03-22 |
| SEC-005  | SpeechRecognition hardcoded to en-US                                                              | Phase 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 2026-04-02 |
| SEC-006  | Placeholder READMEs lack interface contracts                                                      | Phase 1 (auth) + Phase 2 start (moderation, prompts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 2026-04-03 |
| TASK-026 | Rotate ACRCloud access secret                                                                     | Sprint 3c — paid project `playform-prod-songid`, trial 99216 deprovisioned. See ROTATION_RUNBOOK.md                                                                                                                                                                                                                                                                                                                                                                                                                               | 2026-04-25 |
| TASK-027 | Narrow IAM permissions (scoped from FullAccess)                                                   | Phase 4 entry (confirmed via CLI)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 2026-04-17 |
| SEC-008  | brace-expansion DoS (GHSA-rgw5-rvv9-x895) — override pinned the tree to the vulnerable 5.0.8      | Phase 5, Sprint 2 — override corrected to 5.0.9; TASK-069/070 filed for override hygiene                                                                                                                                                                                                                                                                                                                                                                                                                                          | 2026-08-03 |
| SEC-009  | fast-uri host confusion (GHSA-7p8r-x3mc-p8w7)                                                     | Phase 5, Sprint 2 — npm update to 3.1.5, in-range, no override needed                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 2026-08-04 |
| SEC-010  | nanoid infinite loop (GHSA-2v37-7h3g-55p8)                                                        | Phase 5, Sprint 2 — npm update to 3.3.18 via postcss, in-range                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 2026-08-04 |
| SEC-011  | 55 external calls without timeouts (A11)                                                          | Phase 5, Sprint 2 — all routed through fetchWithTimeout, maxRetries 0 to protect CAS                                                                                                                                                                                                                                                                                                                                                                                                                                              | 2026-08-04 |
| SEC-014  | handlebars advisories (Dependabot #14–16), development only via ts-jest                           | v3.0.1 — npm update to 4.7.10, in-range, no override needed                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 2026-10-09 |
| SEC-015  | brace-expansion stack exhaustion on the 1.x and 2.x lines (Dependabot #10, #11), development only | v3.0.1 — overrides raised to 1.1.21 and 2.1.7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 2026-10-09 |
| SEC-017  | style-src kept 'unsafe-inline' (the rest of SEC-001)                                              | TASK-203: `style-src 'self' 'nonce-…'` (`platform/security/csp.ts`), the nonce Next.js puts on the tags it renders — the approach of the Next.js documentation's "Content Security Policy" guide (nextjs.org/docs/app/guides/content-security-policy, Vercel); no component renders a `style` attribute (`no-inline-style-attributes` guard; the confidence bar sets its width from script); Playform's `e2e/csp.spec.ts` checks the header and that the sign-in page, the main page and the admin console raise no CSP violation | 2026-11-08 |
| SEC-001  | CSP allowed unsafe-eval and unsafe-inline scripts                                                 | Sprint 7X (audit G-10, H-7, X-17): a nonce per response, `'strict-dynamic'`, `'unsafe-eval'` in development only (`platform/security/csp.ts`); the styles' remainder, SEC-017, resolved by TASK-203                                                                                                                                                                                                                                                                                                                               | 2026-10-25 |
| TASK-049 | Playform Dependabot vulnerabilities (4 alerts)                                                    | Phase 5, Sprint 0 — npm audit fix (@babel/core, @opentelemetry/core via @sentry/nextjs, js-yaml); 0 alerts open                                                                                                                                                                                                                                                                                                                                                                                                                   | 2026-07-12 |

---

## Migration Note (April 25, 2026)

The following items were migrated to TASKS.md (Sprint 3c) as they are not security-related:

- CI-001 → TASKS.md (build/CI category)
- TASK-019 → TASKS.md (refactor)
- TASK-024 → TASKS.md (feature deferral)
- TASK-025 → TASKS.md (infrastructure)
- TASK-014 through TASK-023 resolved items → TASKS.md resolved table
- TASK-028 resolved → TASKS.md resolved table

---

_Last updated: November 8, 2026 (TASK-203 — SEC-001 and its style-src remainder SEC-017 resolved; the npm audit advisories cleared; TASK-044's code and documents done, its owner steps open; SEC-012 and SEC-013 traced to build and lint only and kept accepted with the evidence; H-13 recorded as accepted)_
