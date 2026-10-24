# ADR-053: Tenancy — One Codebase, Shared or Dedicated Deployment

Status: Proposed (Phase 5 Sprint 7R entry gate, 2026-10-21); amended in implementation (§6). Decision maker: Raman Sud.
Related: ADR-012 (auth), ADR-013 (roles), ADR-023/042 (RAG scope), ADR-048 (governed budgets), ADR-050 (environment contract), ADR-052 (rate limiting), ADR-055 (deploy anywhere), TASK-126, TASK-137, TASK-138, TASK-144.

---

## 1. Context

The platform has no tenant. A survey of the code in October 2026 (Sprint 7R entry gate) found:

- **Identity.** The verified actor (`Actor`, `platform/auth/middleware.ts`) is a user or a guest; neither carries an organisation. `adminGuard` verifies the caller and then discards it, so admin audit records name the placeholder `"authenticated-admin"` (TASK-138).
- **Data.** 36 tables, all with row-level security enabled and none forced; 47 live policies — about 23 for the service role only, the rest keyed on `auth.uid()` (never set, because users sign in through Cognito), `is_admin()` or `true`. Every server path — 70 calls through the shared client in 32 files (the RAG embedding store among them, through a client it is given), plus 13 files calling the REST API directly (12 stores and the database health probe) — uses the service-role key, which bypasses row-level security. The policies therefore protect nothing on server paths, and one owner-rights function was callable with the public key (TASK-137, fixed).
- **Shared state.** 55 governed config keys, roles and permissions, rate-limit buckets, agent budgets, the AI response cache (not even partitioned per user), audit records and metrics are all global.
- **Agents.** Runs are scoped `user`, `group` (a social group) or `platform`; a budget day is the server's local day (TASK-144).
- **One exception.** RAG knowledge-base scope already supports a tenant dimension (`platform/rag/scope.ts`).

The decision of 2026-10-17 requires both a shared multi-tenant deployment and a dedicated per-client deployment from one codebase.

## 2. Decisions

**D1 — One model, two deployment shapes.** A tenant is the unit of isolation: its users, data, configuration, limits, budgets, audit and metrics. `TENANCY_MODE` (environment contract) is `shared` or `single`. A dedicated per-client deployment is the shared code running with `TENANCY_MODE=single` and `TENANT_ID` set; it never resolves any other tenant. There is no second code path.

**D2 — Tenant identity comes from verified identity, never the request body.**

| Caller                                            | Tenant resolved from                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed-in user (shared)                           | The Cognito attribute `custom:tenant_id`, read in the same `GetUser` call that verifies the token. A user belongs to exactly one tenant. The attribute is read-only for every app client — set only by the platform (`AdminUpdateUserAttributes`, §6 A1), never by the user (`UpdateUserAttributes`) — and the operator readiness check verifies the pool's client permissions and federated mappings. On a tenant's own domain, a token for another tenant is refused. |
| Signed-in user (single)                           | `TENANT_ID`; a token whose attribute names another tenant is refused.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Guest                                             | The tenant the guest token was minted for (a signed `tid` claim).                                                                                                                                                                                                                                                                                                                                                                                                       |
| Anonymous (sign-in, guest minting, public routes) | The request host, through the `tenant_domains` table (shared); `TENANT_ID` (single). An unknown host is refused. A forwarded host header is trusted only through `TRUSTED_PROXY_HOPS`, as for addresses (ADR-052 D5).                                                                                                                                                                                                                                                   |
| Agent                                             | The tenant of the principal it acts for; never set by the agent.                                                                                                                                                                                                                                                                                                                                                                                                        |

Shared deployments use one Cognito pool; a dedicated deployment has its own pool. A platform operator (`super_admin`) acts across tenants only through explicit, audited operator routes.

**D3 — Tenant context travels with the request.** `TenantContext { tenantId, mode }` (kernel) is established once per request by the rate limiter (from the address) and the verifiers (from the identity), and held in request-scoped `AsyncLocalStorage` (§6 A2); `Actor`, `WorkflowContext` and budget statuses carry `tenantId` explicitly. The data layer, caches and limiters read the current tenant from context and **fail closed** — throw — when there is none. Background jobs (ADR-056) run each tenant's work inside its own context.

**D4 — Row-level security is the enforcement, through direct Postgres.** Server code stops using Supabase's REST API with the service-role key and reaches Postgres directly, through one data layer (`platform/data`), on every host (decision of 2026-10-21; §3 records the alternative):

- Every request-path query runs inside `withTenantTx(ctx, fn)`: a transaction that first runs `select set_config('app.tenant_id', $1, true)` — a bound parameter, never an interpolated string — then the work. The setting is transaction-local, so a pooled connection never carries one tenant's context into another's request. No network or AI call runs inside the transaction; a statement timeout bounds it, so a slow dependency cannot hold pooled connections.
- The request connection's **login role** (`DATABASE_URL`) is itself `app_tenant`: it owns nothing, has `NOBYPASSRLS`, and has no other role to switch to, so neither a code bug nor injected SQL can step outside row-level security by changing role. It can still change `app.tenant_id` itself; that is why the setting comes only from `withTenantTx`, and why the isolation kit and the replay test that `app_tenant` reaches nothing without it.
- Every tenant-owned table gains `tenant_id` (not null) with `FORCE ROW LEVEL SECURITY` and policies of the form `tenant_id = current_setting('app.tenant_id', true)`. A missing setting matches nothing. The `auth.uid()`, `auth.role()` and `is_admin()` policies are replaced.
- **Platform-owned tables** (the role and permission catalog, platform config defaults, migration records) get an explicit read policy and grant for `app_tenant`, and no write. **Owner-rights functions** (`SECURITY DEFINER`) stay closed to `anon` and `authenticated` (TASK-137's replay check) and take the tenant as an argument checked against the setting.
- Connections go through a **transaction-mode pooler**: Supabase's pooler (Supavisor) on Supabase, RDS Proxy on AWS, PgBouncer elsewhere. Setting the tenant with `set_config()` rather than `SET` avoids session pinning; 7P confirms this on RDS Proxy before it is relied on. Serverless instances borrow a connection for one transaction; a long-running container keeps a small pool. Pool size and timeouts are declared settings in the environment contract.
- An owner connection (`DATABASE_OWNER_URL`, never on request paths) is used only for migrations, platform-operator jobs, tenant lifecycle and the job runner's claim step (ADR-056 D2), which then runs each job through `withTenantTx`; each use is listed and checked in CI.
- Supabase stays where it is not data access: Realtime keeps its client, and Supabase remains a supported host. The same data layer runs unchanged on RDS (Sprint 7P), so no REST service is operated on any cloud.

**D5 — Uniqueness, configuration, roles.**

- Global uniques become per tenant: `users.cognito_sub`, the budget index, embedding scope, and any tenant-owned natural key.
- The role and permission **catalog** stays platform-defined; **assignment** is per tenant. The existing `admin` role administers one tenant; platform-wide powers need the new permission `platform_operate` (§6 A4). `is_admin()` is replaced by permission checks.
- Configuration is layered: platform default, then tenant override. Keys that govern the platform itself (dual control, safety tier) can be overridden only by an operator.

**D6 — Every key, limit, budget and record names its tenant.** Cache keys (the AI response cache, permissions, config), rate-limit buckets, budget scopes (with a per-tenant daily cap above the per-agent caps; the day is UTC), audit records, content-safety records and metric labels all include `tenantId`. Social groups remain groups within a tenant; they are not tenants. **Realtime** channels are joined with the public key, so a name prefix is not access control: tenant-bound channels use Supabase Realtime's private channels with authorization, and the REST endpoint's remaining grants to `anon` and `authenticated` are closed (TASK-114, brought into 7T).

**D7 — Tenant lifecycle.** Provision (tenant row, domain, Cognito attribute, first `tenant_admin`, config defaults), suspend (all requests refused with a coded error), export (the GDPR export, per tenant), and delete (purge after a retention period, recorded in `purge_log`). Lifecycle operations are operator-only, audited and idempotent.

**D8 — Isolation is proven, not assumed.** A cross-tenant isolation conformance kit (`__tests__/contract/tenant-isolation-contract.ts`) runs against every store, cache and limiter: data written under tenant A is invisible, unmodifiable and undeletable under tenant B; no operation succeeds without a tenant context; keys of A and B never collide. The migration replay checks that every tenant-owned table has `tenant_id`, forced row-level security and a tenant policy, and that `app_tenant` cannot bypass it.

## 3. Alternative considered for D4 — keep the REST API

Keep Supabase's REST API (supabase-js / PostgREST) and replace the service-role key with a short-lived token minted per request carrying `role: app_tenant` and `tenant_id`; policies read `request.jwt.claims`.

|      | Direct Postgres (chosen)                                                                                                                                                                                                                                                          | REST API with a per-request token                                                                                                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pros | One code path on every host — Supabase, RDS, GCP and Azure all speak Postgres; 7P runs nothing new · Enforcement in the database: a login role that cannot bypass row-level security or change role, tenant set per transaction · No signing secret, no tokens minted per request | Smaller 7T: the 83 paths keep their shape · PostgREST pools connections, which suits serverless · Keeps supabase-js, consistent with Realtime                                                                                               |
| Cons | Larger 7T: the 83 paths move onto one data layer · Connections need a pooler, configured per host · Loses supabase-js query helpers on the server                                                                                                                                 | 7P must deploy and operate PostgREST on AWS and every later cloud · Needs the project's JWT signing secret, tied to Supabase's key system (already in transition) · Code stays shaped by one vendor's API, against the deploy-anywhere goal |

Connection management at scale was weighed explicitly: it exists in both options — PostgREST is itself a pooled client — and is solved by managed transaction-mode poolers on both hosts. A transaction-local `set_config()` is what transaction pooling supports. The REST option moves the work into a service we would operate ourselves off Supabase. Direct Postgres was chosen because the REST option's costs fall on every future host, while direct Postgres's fall once, in 7T.

## 4. Delivery

- **Sprint 7R (groundwork):** tenant context, `TENANCY_MODE`/`TENANT_ID` in the contract, the `tenants` and `tenant_domains` tables with one default tenant, `tenantId` on actors, guest tokens and agent identity, `adminGuard` returning the verified admin (TASK-138), UTC budget days (TASK-144), and the isolation kit running against the in-memory stores (the Postgres stores pass it in 7T).
- **Sprint 7T (everywhere):** the `platform/data` layer and pooler settings; the 83 access paths (70 through the shared client in 32 files, 13 files calling the REST API) moved onto it; `tenant_id` and forced policies on every tenant-owned table; the `app_tenant` login role; platform-table and owner-rights-function rules; private realtime channels (TASK-114); the service-role key off request paths; layered config, per-tenant roles, keys, limits, budgets, audit and metrics; the lifecycle — each store passing the isolation kit on Postgres.

## 5. Consequences

- Existing data belongs to the default tenant; migration backfills it. Playform runs `single` until it has a second tenant.
- Every consumer route that reads data runs inside a tenant context; the route checks (TASK-133/136) gain a tenant assertion.
- 7P provisions RDS with RDS Proxy; no REST service is run.
- New settings join the environment contract: the pooled request connection (`DATABASE_URL`), the owner connection (`DATABASE_OWNER_URL`, operator paths only) and pool limits. `SUPABASE_SERVICE_ROLE_KEY` leaves request paths.
- supabase-js stays for Realtime only.

## 6. Amendments made in implementation (Sprint 7R/7T, October 2026)

Each refines a decision above where building it showed the original wording to be incomplete or
wrong; none weakens it.

- **A1 — How a user's tenant is set (D2).** Sign-up at a tenant's address creates the account and
  assigns it that tenant with `AdminUpdateUserAttributes`, signed with a dedicated IAM key
  (`COGNITO_ADMIN_*`, required in shared mode). An identity with no tenant at its first sign-in
  (federated sign-in, or a failed assignment) is assigned the tenant of the address the same way;
  both only when the tenant accepts new accounts (`signups_enabled`, which was declared but never
  enforced before). An identity of another tenant gets no session (`platform/tenancy/identity.ts`).
- **A2 — The request scope (D3).** `AsyncLocalStorage.enterWith()` inside a helper the handler
  awaits is invisible to the handler after the await, so every route handler is wrapped in
  `tenantRoute()`, which opens an empty scope the limiter and verifiers fill once; a CI check
  requires the wrapper on every exported handler. Agent identities and trajectory records gained
  no tenant field: every store reads the one tenant from the scope, which a run cannot change.
- **A3 — What else row-level security needed (D4).** Foreign keys between tenant-owned tables
  include `tenant_id` (a foreign-key check is not filtered by row-level security, so a plain key
  could point at another tenant's row); every tenant-owned table's primary key begins with
  `tenant_id` (users excepted: an identity is one tenant's); columns that only attribute an action
  reference no user (an operator acting in a tenant is not its user). `tenants` and
  `tenant_domains` are not readable by `app_tenant`; requests ask two owner-rights functions for
  one host or one tenant. A third transaction kind, `withPlatformTx`, runs as `app_tenant` with no
  tenant, for the catalog and those functions. The owner connection serves three named purposes,
  and a CI check lists every file that uses it.
- **A4 — Administrators and operators (D5).** Rather than a new `tenant_admin` role duplicating
  `admin`, `admin` acts within its tenant and `platform_operate` (granted to `super_admin`) marks
  an operator. In a single-tenant deployment the tenant is the platform, so its administrators keep
  every power they had (platform defaults, catalog), on the owner connection.
- **A5 — Layered configuration (D5).** `platform_config` holds the defaults; a tenant's own values
  are rows of `tenant_config_overrides`, writable by `app_tenant` only for keys marked
  `tenant_overridable` (enforced by the policy as well as the code); operators may set any key for
  a tenant. History and two-person approvals record their scope and belong to the tenant they
  were made in.
- **A6 — Budgets (D6).** The per-tenant cap is `agent.budget.tenant_max_cost_per_day`
  (operator-set, default 100 USD), accumulated in a reserved budget scope beside the per-agent
  ones.
- **A7 — Realtime (D6).** Channels join the topic `t:<tenant>:<name>`, private; a policy on
  `realtime.messages` (Supabase only) admits a browser only to topics of the `tenant_id` its token
  carries. No browser client subscribes today; one that does needs a token with that claim.
- **A8 — Lifecycle (D7).** Deletion needs a second operator within 7 days and purges after 30;
  a deleted tenant can be restored (suspended) until then; export is newline-delimited JSON from
  one snapshot; an operator cannot suspend or delete the tenant they act from. Operator requests
  are kept in `tenant_lifecycle_requests`, a purged tenant's row remains as its record.
- **A9 — The address before sign-in (D2).** Where a request's address is read is declared
  (`TENANT_HOST_HEADER`: `x-forwarded-host` or `host`, required in shared mode): a proxy that does
  not set `X-Forwarded-Host` (AWS ALB) passes on the caller's, and `next start` keeps it. Each
  instance answers hosts from an in-memory snapshot of every address (refreshed every 30 s, the
  last good one served for a bounded grace when a refresh fails, then fail closed), so an unknown
  host costs no query and holds no memory; its refusal is not counted. Every route that ends in a
  session (sign-in, SSO, the MFA and new-password challenges) checks the identity's tenant, and
  every route that sets a password applies the tenant's policy.
- **A10 — Operators set any tenant's settings (D5, D7).** `/api/operator/tenants/[id]/config`
  (and its `approvals`) run the config page's own governed code in the target tenant's scope: any
  key for that tenant, its history and audit in that tenant, and the two-person approvals and
  dual-control holds it creates decided there by another operator. Removing a tenant's own value
  is governed like setting one (`reset_config`, approvals record `action` `set` or `reset`). An
  approved dual-control hold of a config change is applied on its approval (it was approved and
  never applied); under two-person approval it then waits for that approval.
- **A11 — Existing accounts keep their tenant (D2).** An identity with no tenant attribute whose
  account already exists (a users row, from before the deployment was shared) is assigned the
  tenant holding that account — at its own address, even with sign-ups closed — and refused at any
  other; only an identity with no account anywhere joins the address's tenant.
