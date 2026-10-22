# Migrating from v4.x to v5.x

v5.0.0 fixes the findings of the October 2026 whole-system adversarial review
([audits/2026-10-REGISTER.md](audits/2026-10-REGISTER.md), Sprint 7X): privilege escalation through the
AI command bar, audit records that were never written, safety stores in per-instance memory, an
unscreened streaming proxy, no daily cap on paid calls, and more. It is a major version because
production now **refuses to start** on settings v4 accepted, some APIs that bypassed governance are
removed, and new CI checks scan your own code.

Work through the sections in order; each says who is affected. Section 1 must be done **before** the
v5 deployment, or the deployment will not start.

---

## 1. Before you deploy — every deploying consumer

| Do                                                                                                                                                                   | Why                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apply migrations **041–045** to every database (SQL Editor, in order)                                                                                                | 041 creates four admin permissions (super_admin only); 042 one password policy per scope; 043 audit actions; 044 the daily paid-request quota; 045 repairs config values stored as JSON text |
| Set `MODERATION_STORE`, `STRIKE_STORE`, `REVIEW_QUEUE_STORE`, `PROPOSAL_STORE`, `EFFECT_LEDGER`, `APPROVAL_POLICY_STORE` to `supabase` in every deployed environment | Production refuses `memory` (or unset) for every durable store, and `supabase` without credentials is an error                                                                               |
| Set `DEPLOYMENT_HOST` on every deployment (`vercel`, `container`, …); set `ci` or `local` in your E2E harness (e.g. Playwright's `webServer.env`)                    | The harness switches (`E2E_*`, `ADMIN_DEV_BYPASS`) are accepted only where `DEPLOYMENT_HOST` is `ci` or `local` (TASK-140)                                                                   |

Full reference: [ENV_REFERENCE.md](ENV_REFERENCE.md).

## 2. Boot fails closed — consumers with their own `instrumentation.ts`

The platform's `instrumentation.ts` now rethrows an initialisation failure in production, so a server
that cannot start its providers does not serve half-started (audit X-21). If you keep your own copy,
make the same change, and wrap any paid health probe in `CachedHealthProbe`
(`platform/observability/health.ts`) — a public health check must not make a paid call per request
(audit X-13).

## 3. Removed APIs — consumers that import them

| Removed                                                                                                                                                           | Use instead                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setConfig`, `deleteConfig` (`platform/auth/platform-config`)                                                                                                     | `writeGovernedConfig` (`platform/admin/governed-config`) — tier, validation, history, two-person and dual-control checks — or `setConfigWithHistory` for a change already approved |
| `DELETE /api/admin/config`                                                                                                                                        | None: set a governed setting back to its default value with `PUT`, through the same checks                                                                                         |
| `getAdminActorId`, `checkSelfElevation`, `PROTECTED_ROLES` (`platform/auth/admin-guard`)                                                                          | `requireAdmin(request, permission)` returns the verified admin; `checkRoleAssignment`, `checkPermissionGrant`, `PROTECTED_ROLES` (`platform/auth/role-governance`)                 |
| `isHostedDeployment` (`platform/providers/environment-contract`)                                                                                                  | `allowsHarnessSwitches` / `DEPLOYMENT_HOST`                                                                                                                                        |
| `STREAM_MAX_SYSTEM_CHARACTERS`; the `system` option of `useRealtimeStream`                                                                                        | Nothing: `/api/stream` uses the platform's system prompt (`prompts/assistant/stream-v1.ts`) and refuses a caller's with `request.field_not_accepted`                               |
| Command-bar tools `delete_user`, `bulk_change_role`, `assign_role_to_user`, `grant_entitlement`, `revoke_entitlement`, `delete_entitlement_group`, `search_audit` | They had no handler; they are no longer offered to the planner                                                                                                                     |

## 4. Changed behaviour — every consumer

- **Audit fails closed.** `recordAudit` and `audited` throw `AuditWriteError` when the record cannot be
  written, and the action does not happen; routes answer `503 service.unavailable` (`auditedResponse`).
  `actorId` and `targetId` must be user ids (UUIDs) — an agent or process goes in `agent`. `action` is
  typed (`AUDIT_ACTIONS`). `writeAuditLog` remains, best effort, for records whose loss does not
  matter.
- **Admin routes** use `requireAdmin`, which also refuses staff who are not in good standing and
  answers 503 when permissions cannot be resolved.
- **Moderation.** `POST /api/moderation/review` accepts only `source: "escalation"`; ban reviews are
  created by Sentinel, with the real previous status. An overturn only ever lowers an account's
  status. Nobody may claim or resolve a case about their own account.
- **GDPR purge** requires `admin_purge_user_data` (super_admin), and answers 503 when no purge handler
  ran.
- **Approval policies** are validated (`approvalRulesProblem`): at most 50 rules, known values, and a
  restricted risk or effect must name a human approver.
- **Config values are stored as JSON.** Governed writes stored `JSON.stringify(value)` in `jsonb`,
  which saved a JSON string; they now store the value itself, and migration 045 repairs rows written
  the old way. If your own code writes `platform_config`, `platform_config_history` or
  `config_pending_approvals`, pass the value, not its JSON text.
- **Approvals.** Every decision is audited before it takes effect; an approved config change is
  applied in the same outcome (`approveAndApply`) and reopened if it cannot be applied. An approval
  needs the permission of its key's tier on every path.
- **Overturns** lift only the overturned decision's own consequence: the account is restored only
  when that decision set its current status (Sentinel's record), never from a status an item claims.
- **Lookups that fail stop the change.** Role, user and entitlement-permission reads that error
  answer 503 instead of passing the rules as "no permissions".
- **Error codes** added: `admin.self_target`, `admin.target_not_found`,
  `admin.config_invalid_value`, `auth.grant_exceeds_own`, `auth.role_protected`,
  `moderation.self_review`, `request.field_not_accepted` — see [API_ERRORS.md](API_ERRORS.md).
- **Logs** redact personal data and credentials (email, password, tokens, cookies, phone, keys) at any
  depth.

## 5. New checks that scan your code — every consumer with routes

These tests arrive with the sync and run over **your** routes and modules:

| Test                         | Requires                                                                                          | If it fails                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `api-route-paid-quota`       | A route that makes a paid call calls `enforceDailyPaidQuota(request, actorId)` before the call    | Add the call after verifying the actor; declare your own paid functions in `app-route-policy.ts` `paidCalls` |
| `api-route-json-body`        | No route calls `request.json()` directly                                                          | `const read = await readJsonObject(request); if (!read.ok) return read.response;`                            |
| `postgrest-url-encoding`     | No unencoded value after a filter operator in a REST URL                                          | `encodeURIComponent(value)`                                                                                  |
| `security-wiring`            | Every security control has a production caller, or is in `platform/assurance/unwired-security.ts` | Wire it, or register it with the reason                                                                      |
| `coverage-ignore-policy`     | No security module (including `app/api/`) in `coveragePathIgnorePatterns`                         | Remove the entry and test the module                                                                         |
| `no-stubbed-guards`          | No test mocks `admin-guard` or `role-governance`                                                  | Use `__tests__/helpers/test-identities.ts`: real roles, the real guard                                       |
| `property-tests-configured`  | Each `fast-check` test calls `fc.configureGlobal(fuzzParams())`                                   | Add it (`__tests__/helpers/fuzz.ts`)                                                                         |
| `admin-authorization-matrix` | Every admin guard names an existing, held permission                                              | Fix the permission or add the migration that creates it                                                      |

Add `fast-check` (4.10.2, exact) to your devDependencies if you keep your own `package.json`.

## 6. New consumer-owned files and settings

| Item                                                            | Action                                                                                                                                                                                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform/assurance/unwired-security.ts`                        | Add to your sync exclude list; start from the platform's copy, then remove entries your app wires                                                                                                                          |
| `app-route-policy.ts` `paidCalls`, `paidQuotaExempt` (optional) | Declare your functions that make paid calls (speech, translation, identification…)                                                                                                                                         |
| `ai.daily_paid_requests_per_actor`                              | Governed setting (migration 044): paid requests per user or guest per 24 hours (a request may make several provider calls), default 200, safety tier, dual control                                                         |
| GitHub Environments `staging`, `production`                     | Secrets `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` for the weekly migration-parity check (`migration-parity.yml`). Limit each Environment's deployment branches (`staging`, `main`) and require reviewers on `production` |
| Repository variable `ZAP_TARGET_URL`                            | The URL the weekly ZAP scan targets (`zap-scan.yml`). If you keep your own `zap-scan.yml`, exclude it from the sync or move its target to the variable                                                                     |

## 7. After you deploy

Run the checks in [ASSURANCE.md](ASSURANCE.md) §5 against staging (`fuzz.yml` with `target_url`), and run
`migration-parity.yml` once by hand. The first parity run may report historical drift between the
repository and a database; resolve it with a migration, never by editing the database by hand.
