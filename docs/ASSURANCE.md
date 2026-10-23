# Assurance — how this platform proves what it refuses

Tests that only confirm specified behaviour prove what a system does, not what it refuses. In October
2026 a moderator could make themselves `super_admin` through the AI command bar while every unit,
integration and end-to-end test passed ([learning 116](ENGINEERING_LEARNINGS.md), [TASK-145](TASKS.md)).
This document is the assurance model adopted after that: what runs, when, and what it proves. The
tenet itself — **Adversarial Validation** — is in [CONTRIBUTING.md](../CONTRIBUTING.md) and
[GENAI_MANIFESTO.md](GENAI_MANIFESTO.md) §9.

**Rule:** every practice the team relies on is enforced by a check that runs, or is written down here
as not done. Nothing is assumed.

## 1. Cadence

| When               | What runs                                                                                                                                                                                   | Where                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Every commit       | Type check, lint, format, unit and integration tests with their hostile cases, coverage and its ratchet, build, migration replay, secret scan, CodeQL, Semgrep, production dependency audit | `ci.yml`, `secret-scan.yml`, `codeql.yml`, `semgrep.yml`                                     |
| Every change       | A threat model of the change, its hostile tests written with it, and review                                                                                                                 | The author and reviewer; the [sustainability checklist](SUSTAINABILITY_CHECKLIST.md) A9, B11 |
| Every promotion PR | Deep property tests (5,000 generated cases each) and the monkey run against a production build                                                                                              | `fuzz.yml`                                                                                   |
| Every release      | An independent adversarial review of the release diff by an agent that did not build it, plus the monkey run against staging                                                                | [audits/BRIEF.md](audits/BRIEF.md); `fuzz.yml` with `target_url`                             |
| Weekly             | Dependency audit, ZAP baseline scan, migration parity of each live database, deep property tests and the monkey run                                                                         | `dependency-audit.yml`, `zap-scan.yml`, `migration-parity.yml`, `fuzz.yml`                   |
| Each phase close   | An independent whole-system adversarial review — every ring, every feature, static and dynamic                                                                                              | [audits/BRIEF.md](audits/BRIEF.md); results in `docs/audits/`                                |

## 2. The checks, and what each proves

| Check (test or job)                                           | Proves                                                                                                                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin-authorization-matrix`                                  | Every admin route guard and every command-bar action, search and panel names a permission that exists and some role holds; the second path (command bar) is held to the first path's rule |
| `admin-guard`                                                 | Every real role against every admin permission (roles read from the migrations, `scripts/role-catalog.cjs`); suspended staff refused; a failed lookup is a 503, never access              |
| `no-stubbed-guards`                                           | No test mocks the admin guard or role governance — a test asserting authorization runs the real guard                                                                                     |
| `api-route-auth`, `api-route-rate-limit`                      | Every API route verifies its caller and is rate limited, or is listed as exempt with a reason                                                                                             |
| `api-route-paid-quota`                                        | Every route that makes a paid provider call counts it against the daily quota before the call                                                                                             |
| `api-route-json-body`                                         | No route parses a body without the coded 400 for malformed or non-object JSON                                                                                                             |
| `postgrest-url-encoding`                                      | No value reaches a REST filter URL unencoded                                                                                                                                              |
| `security-wiring`                                             | Every security control has a production caller, or is in `platform/assurance/unwired-security.ts` with the reason                                                                         |
| `coverage-ignore-policy`                                      | No security module is hidden from coverage                                                                                                                                                |
| `property-tests-configured`                                   | Every property test takes its run count from the fuzz job                                                                                                                                 |
| `audit-fail-closed` and each route's "audit unavailable" case | A privileged action whose audit record cannot be written does not happen                                                                                                                  |
| Store conformance kits (`__tests__/contract/`)                | Every implementation of a store behaves the same, including on hostile ids and expiry                                                                                                     |
| Migration replay (`scripts/migration-replay.sh`)              | A database built from zero has every table, function and policy; the role catalog equals the database; every audit action is accepted                                                     |
| Monkey run (`scripts/monkey/monkey.mjs`)                      | Against the running build, whatever is sent by whoever: no uncoded 5xx, no privileged success, no stack, path, key or canary secret in a response, no hang                                |

## 3. What is not yet done

Recorded so nobody assumes it.

| Gap                                                                                                                                                                                                                                                   | Tracked                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Privileged and isolation paths run against an in-memory database that evaluates filters and refuses filter strings (`__tests__/helpers/fake-database.ts`), and the SQL against real Postgres in the replay — not yet the routes against real Postgres | TASK-146                                                 |
| Generated (property-based) input covers sanitization, output screening, paging and search; most suites still use hand-picked hostile cases                                                                                                            | TASK-147                                                 |
| The monkey run's coverage is bounded by the rate limits it must not bypass: from one address most random steps are refused with 429 after the per-route sweep                                                                                         | TASK-147                                                 |
| `security-wiring` checks that a control is used (called or passed) by production code, not that a route reaches it; the scanners are text-based (exported function declarations, template literals), not a type-aware analysis                        | The independent review covers it                         |
| The daily quota counts paid requests, not provider calls weighted by cost                                                                                                                                                                             | TASK-113                                                 |
| The ZAP scan reports; it does not fail the run — its findings are triaged weekly                                                                                                                                                                      | By design                                                |
| Open findings of the October 2026 review                                                                                                                                                                                                              | [audits/2026-10-REGISTER.md](audits/2026-10-REGISTER.md) |

## 4. For a consuming app

The checks in §2 arrive with the sync and run over **your** routes and modules too. You own:

- `platform/route-policy/app-route-policy.ts` — your verifier and limiter wrappers, your paid-call
  functions (`paidCalls`) and any exemptions, each with a reason;
- `platform/assurance/unwired-security.ts` — your register of security controls you have not wired;
- the GitHub Environments `staging` and `production` with `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` (migration parity), and the `ZAP_TARGET_URL` variable (ZAP scan).
  **Protect both Environments**: deployment branches limited to `main` for both (the workflow runs
  from the default branch and checks out the branch it compares; a `staging` limit refuses the
  staging run). Without that, anyone with write access could dispatch a modified copy of the
  workflow from their own branch and read the service-role key. The check knows the schema
  baseline's own record (`000_baseline.sql`), so a database built from it compares cleanly.

Add both files to your sync exclude list. See [SETUP_AND_INTEGRATION.md](SETUP_AND_INTEGRATION.md) §6.

## 5. Running the dynamic checks yourself

```bash
# Production build on the E2E harness (mock auth and AI, in-memory stores)
npm run build
DEPLOYMENT_HOST=ci E2E_IN_MEMORY_STORES=true E2E_TEST_DOUBLE_AUTH=true RATE_LIMIT_STORE=memory \
AI_PROVIDER=mock AUTH_PROVIDER=mock GUEST_TOKEN_SECRET="$(openssl rand -base64 32)" \
ANTHROPIC_API_KEY=canary-local npx next start -p 3000 &

MONKEY_BASE_URL=http://127.0.0.1:3000 MONKEY_MOCK_USER=1 MONKEY_CANARY=canary-local \
MONKEY_STEPS=3000 node scripts/monkey/monkey.mjs      # prints its seed; MONKEY_SEED replays

FC_NUM_RUNS=5000 npx jest __tests__/sanitize.test.ts  # any property test, searched harder
```
