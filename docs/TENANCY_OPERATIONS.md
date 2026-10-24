# Tenancy — operating a deployment (ADR-053)

A **tenant** is the unit of isolation: its users, data, configuration, limits, budgets, audit
records and metrics. One codebase runs two ways:

| Mode                      | `TENANCY_MODE` | Who is in it                                                                                           |
| ------------------------- | -------------- | ------------------------------------------------------------------------------------------------------ |
| Dedicated (single-tenant) | `single`       | One tenant, `TENANT_ID`. Every user and row is that tenant's. Its administrators govern everything.    |
| Shared (multi-tenant)     | `shared`       | Many tenants. Each request's tenant comes from the verified identity, or, before sign-in, the address. |

Isolation is enforced by Postgres, not by application code: every request reaches the database
as the role `app_tenant`, which cannot bypass row-level security, and every transaction carries
its tenant (`withTenantTx`). Data written by one tenant cannot be read, changed, deleted or even
referenced by another; a request with no tenant reaches nothing.

---

## 1. The database (every deployment)

### 1.1 Apply the migrations

Apply `supabase/migrations/049_tenancy.sql` (after 047 and 048) in the Supabase **SQL Editor** —
in the browser, not a terminal. It is idempotent. It creates the `app_tenant` role **without a
password and unable to sign in**: a migration never carries a secret.

**On a database that already holds data**, check how large the tenant-owned tables are first —
in the SQL Editor:

```sql
select c.relname as table_name,
       c.reltuples::bigint as approx_rows,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total_size
from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
  and c.relname in ('agent_approval_policy', 'agent_budgets', 'agent_trajectories', 'ai_metrics',
    'app_sessions', 'audit_log', 'consent_records', 'content_safety_audit', 'document_embeddings',
    'effect_ledger', 'group_invites', 'group_memberships', 'groups', 'guest_usage',
    'password_policy', 'proposals', 'purge_log', 'rate_limit_events', 'review_queue',
    'user_ai_context', 'user_devices', 'user_entitlements', 'user_feature_restrictions',
    'user_interactions', 'user_strikes', 'users', 'platform_config_history',
    'config_pending_approvals')
order by pg_total_relation_size(c.oid) desc;
```

What 049 does to those tables, and the locking to expect:

- **No table is rewritten.** `tenant_id` is added with the default tenant as a constant default,
  which Postgres records once instead of writing it into every row.
- **Foreign keys** are added unchecked and then validated: one read of each table, not a rewrite.
- **Index builds still block writes.** The per-tenant unique keys, the new primary keys (which
  begin with `tenant_id`) and the `tenant_id` indexes are built in place — `CONCURRENTLY` is not
  possible in the SQL Editor's single request — and adding columns, constraints and policies
  takes an exclusive lock on each table.
- **The whole script is one transaction**, so every lock it takes is held until it commits:
  requests that touch those tables wait (and time out after `DATABASE_STATEMENT_TIMEOUT_MS`) for
  about as long as it takes to read every tenant-owned table once and build its indexes —
  seconds for tables of a few hundred thousand rows, minutes for many millions.

So apply it in a **quiet period**. If the pre-flight shows tables in the millions of rows, take a
backup first and schedule a maintenance window.

Run it as the project's `postgres` user (the SQL Editor does). Afterwards the request role must
not be able to create temporary tables — 049 warns if it could not change that:

```sql
select has_database_privilege('app_tenant', current_database(), 'TEMPORARY');  -- false
```

Then, in the Supabase dashboard → Project Settings → Data API, turn **off** "Automatically expose
new tables and functions" (the wording may differ by dashboard version). 049 revokes every table
from the public roles; this keeps a table created later from being exposed before its migration
revokes it. Do it on every project (dev and production alike).

### 1.2 Give `app_tenant` a password

1. On your computer, put a new random password on the clipboard (it is never shown):

   ```bash
   openssl rand -base64 33 | tr -d '/+=\n' | pbcopy
   ```

2. In the SQL Editor, type the statement below and paste the password between the quotes.
   Run it, then clear the editor without saving it as a snippet:

   ```sql
   alter role app_tenant with login password 'PASTE-HERE';
   ```

Keep the password only where step 1.3 puts it.

### 1.3 The two connections

| Setting              | Value                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`       | The **transaction pooler** address (Supabase → Connect → Transaction pooler, port 6543), with user `app_tenant.<project-ref>` and the password from 1.2                |
| `DATABASE_OWNER_URL` | The same pooler address with the project's `postgres.<project-ref>` user and its database password — used only by operator paths (platform defaults, tenant lifecycle) |
| `DATABASE_SSL`       | `verify-full`                                                                                                                                                          |
| `DATABASE_SSL_CA`    | Supabase's CA certificate (Database settings → SSL → download), as one line with `\n` for each line break                                                              |

The two URLs must use different users (the boot check refuses the same user for both). A
password with `@`, `:` or `/` must be URL-encoded. Do not add `sslmode` or other TLS options to the
URLs; `DATABASE_SSL` is the one source.

Optional: `DATABASE_POOL_MAX` (default 3; keep 1–3 on serverless hosts) and
`DATABASE_STATEMENT_TIMEOUT_MS` (default 10000).

### 1.4 The stores

Every store selector that says `supabase` (e.g. `MODERATION_STORE=supabase`) now means the
Postgres store reached through `DATABASE_URL`; `postgres` means the same. Nothing else to change.
The Supabase REST API and the service-role key are no longer used for data; `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` remain only for Realtime (`REALTIME_PROVIDER=supabase`).

---

## 2. A dedicated deployment (`single`)

| Setting        | Value                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------- |
| `TENANCY_MODE` | `single`                                                                                  |
| `TENANT_ID`    | `00000000-0000-4000-8000-000000000001` (the default tenant, which owns all existing data) |

Nothing else changes for its users or administrators: the administrators govern every setting,
role and entitlement, as before. The Cognito tenant attribute is not used.

---

## 3. A shared deployment (`shared`)

### 3.1 Settings

| Setting                           | Value                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `TENANCY_MODE`                    | `shared` (and **no** `TENANT_ID`)                                                                                   |
| `TENANT_DIRECTORY_STORE`          | `postgres`                                                                                                          |
| `COGNITO_ADMIN_ACCESS_KEY_ID`     | the IAM key of 3.3                                                                                                  |
| `COGNITO_ADMIN_SECRET_ACCESS_KEY` | its secret                                                                                                          |
| `TRUSTED_PROXY_HOPS`              | proxies in front of the app (Vercel: 1)                                                                             |
| `TENANT_HOST_HEADER`              | where the request's address is read: `x-forwarded-host` (Vercel) or `host` (a container behind AWS ALB) — see below |

Before anyone signs in, the address a request was sent to decides its tenant, so where that
address is read is declared, never inferred (boot refuses a shared deployment without it; a
running one answers `service.unavailable`):

| Host in front of the app                                                                                  | `TENANT_HOST_HEADER` | Why                                                                                                      |
| --------------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| Vercel                                                                                                    | `x-forwarded-host`   | Vercel sets `X-Forwarded-Host` itself; the entry `TRUSTED_PROXY_HOPS` from the right is the one it added |
| A load balancer that forwards `Host` and does not set `X-Forwarded-Host` (AWS ALB, a container behind it) | `host`               | There `X-Forwarded-Host` is whatever the caller sent, so it is ignored entirely                          |

`next start` adds `X-Forwarded-Host` (a copy of `Host`) only to a request that has none — it never
replaces one a caller sent. So `x-forwarded-host` is safe only when the proxy in front always sets
the header; when in doubt, choose `host` and check that the proxy forwards the original `Host`.

Each instance answers addresses from a snapshot of every address, refreshed every 30 seconds: an
address that serves no tenant is refused (`tenant.unknown_host`) without a database query and is
not counted against any limit. If the snapshot cannot be refreshed, the last one is served for up
to 5 minutes (retrying every 5 seconds); after that, or before the first one is read, requests that
need an address answer `service.unavailable` — never a guessed tenant.

### 3.2 The Cognito user pool

A user's tenant is the attribute `custom:tenant_id`, which **users must not be able to change**
(it decides what they can see):

1. User pool → Sign-up experience → **Custom attributes** → add `tenant_id`: type String,
   **mutable**, max length 36.
2. App integration → your app client → **Attribute read and write permissions**: `custom:tenant_id`
   **readable**, **not writable**. **Every other app client of the pool** must not be able to
   write it either: a user can obtain a token from any client of the pool.
3. Every federated sign-in (Google, …) → Attribute mapping: map **nothing** to `tenant_id`.

The operator console's readiness check (section 4) verifies all three.

### 3.3 The IAM key

The platform sets a new user's tenant (AdminUpdateUserAttributes) and checks the pool's setup.
Create an IAM user for this alone, with this policy (replace region, account and pool id):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "cognito-idp:AdminUpdateUserAttributes",
        "cognito-idp:AdminGetUser",
        "cognito-idp:DescribeUserPool",
        "cognito-idp:ListUserPoolClients",
        "cognito-idp:DescribeUserPoolClient",
        "cognito-idp:DescribeIdentityProvider"
      ],
      "Resource": "arn:aws:cognito-idp:REGION:ACCOUNT:userpool/POOL_ID"
    }
  ]
}
```

Create an access key for it and paste the two values straight into the host's environment
settings (never into a chat or a file).

### 3.4 How users join a tenant

- **Sign-up** at a tenant's address creates the account and assigns it that tenant — when the
  tenant accepts new accounts (`signups_enabled`).
- **First sign-in** (including the first Google sign-in) of an identity with no tenant assigns
  the tenant of the address, the same way.
- An **existing account** — one created before the deployment was shared, so its identity has no
  tenant yet — keeps the tenant that holds its data: it is assigned that tenant at its first
  sign-in there (even with sign-ups closed), and refused at any other tenant's address.
- An identity of tenant A signing in at tenant B's address is refused (`tenant.mismatch`) and
  receives no session. One identity belongs to exactly one tenant.

One user pool serves every tenant, so an email address is one identity across the deployment.
What that means, by design:

| Property                                                                                                         | Recommended setting                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An address registered at one tenant cannot sign up at another (`auth.account_exists`)                            | By design: one identity belongs to one tenant, with its data. A person who belongs to two tenants uses a second address                                 |
| Someone could register a victim's address first, unverified, at a tenant with open sign-ups                      | Pool → Sign-up → require email verification; keep "Keep original attribute value active when an update is pending"; set a short unconfirmed-user expiry |
| Password reset works at any tenant's address for the identity it resets                                          | Harmless: it changes that identity's own password; the identity still signs in only at its tenant                                                       |
| A correct password at another tenant's address answers `tenant.mismatch`, a wrong one `auth.invalid_credentials` | Reveals nothing to someone without the password                                                                                                         |

A tenant that needs its own identity rules (its own pool, its own SSO) is a dedicated
deployment (section 2).

### 3.5 Enabling tenants on an existing deployment

A deployment that has run `single` becomes `shared` without moving data: everything it holds is
the default tenant's. In order — each step is safe to stop after:

| Step | Do                                                                                                                                                                                  | Check                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1    | Section 1 (migrations, `app_tenant`, the two connections), still `TENANCY_MODE=single`                                                                                              | The app works as before                                                           |
| 2    | Sections 3.2 and 3.3 (the Cognito attribute, the IAM key); set `COGNITO_ADMIN_ACCESS_KEY_ID`, `COGNITO_ADMIN_SECRET_ACCESS_KEY` and `TENANT_DIRECTORY_STORE=postgres`; redeploy     | Admin console → **Tenants (operators)** → **Check**: identity and directory ready |
| 3    | Same page: **add address** to the default tenant for **every** address the deployment answers on today (e.g. `app.example.com`, the host's own `*.vercel.app` name if users use it) | The default tenant lists them                                                     |
| 4    | Provision the new tenants (slug, name, their addresses — pointed at this deployment in DNS and the host's domain settings)                                                          | Each listed, active                                                               |
| 5    | Set `TENANCY_MODE=shared` and `TENANT_HOST_HEADER` (3.1), **remove** `TENANT_ID`, redeploy                                                                                          | Sign in at the default address as before; **Check** shows every line ready        |
| 6    | For each new tenant: its first user signs up at the tenant's address; an operator makes them its administrator (**Make admin…**)                                                    | That user sees the **Tenant** page for their tenant only                          |

An address that is not listed answers `tenant.unknown_host` once the deployment is shared — step 3
is what keeps today's users in. The operators are the `super_admin` users; they act from the
default tenant (the console refuses to suspend or delete the tenant an operator is acting from).

---

## 4. Operators

An operator holds `platform_operate` (granted to `super_admin`). In the admin console:

- **Tenants (operators)**: readiness check; provision a tenant (slug, name, addresses); add or
  remove addresses; suspend, resume; request deletion (another operator approves); restore a
  deleted tenant before its purge; make a tenant user its administrator; export a tenant's data;
  purge tenants whose purge time has passed; **Settings…** — every setting of that tenant (any
  key, including those only operators set), its own value or the platform default, and the
  changes waiting for approval there, to approve or reject (another operator than the requester).
- **Tenant**: the tenant you are in — its addresses, today's agent spend against its cap, and the
  settings its administrators may set.

Rules the platform enforces:

| Action                        | Rule                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Every operator action         | Recorded in the audit log first; no record, no change                                                                     |
| Suspend / delete              | Never the tenant the operator is acting from                                                                              |
| Delete                        | Requested by one operator, approved by another within 7 days; the tenant is refused at once; data is purged 30 days later |
| Restore                       | Only before the purge; the tenant comes back suspended                                                                    |
| Export                        | Every row the tenant owns, newline-delimited JSON, from one consistent snapshot, headed by the tenant and its addresses   |
| A suspension or deletion      | Takes effect on the acting instance at once and on every other within 30 seconds (directory cache)                        |
| Adding or removing an address | Answers on the acting instance at once and on every other within 30 seconds (address snapshot)                            |

### Configuration

Every setting has a platform default. In a shared deployment a tenant's administrators may set
their tenant's own value for the settings marked tenant-settable (languages, sign-ups, profile
limits, device limit, trajectory retention, song-ID durations); everything else — dual control,
safety thresholds, cost guards, the trusted-agent registry, COPPA — governs the platform, and only
operators change it, for one tenant or as the default. A tenant's own value can be removed again
("Use default" on the Tenant page, or `DELETE /api/admin/config?key=…`): the tenant then follows the
platform default. Each tenant's agents together are capped at
`agent.budget.tenant_max_cost_per_day` (default 100 USD), above each agent's own cap.

### The role catalog

Roles, permissions and entitlement groups are shared by every tenant. In a shared deployment only
operators change them; a tenant's administrators assign them to their own users.

---

## 5. Checks

| Where                                  | What it proves                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| CI migration replay                    | Every table forced, classified and isolated; `app_tenant` cannot bypass row-level security or leave its role; the public key reaches nothing |
| CI `__tests__/db` (against the replay) | Every store passes the isolation kit: tenant A's data invisible, unmodifiable, undeletable under B                                           |
| CI route checks                        | Every API route runs in a tenant scope (`tenantRoute`), is verified and rate limited                                                         |
| Boot (environment contract)            | The tenancy, database and identity settings above are present and consistent                                                                 |
| Operator console → readiness           | The live deployment: request role, owner connection, directory, Cognito attribute                                                            |
