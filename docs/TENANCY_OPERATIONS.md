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
| CI `__tests__/db/identity-relink`      | A re-linked account is reached by its new subject with its role, standing, tenant and data; every ambiguity is refused (§6)                  |

---

## 6. Moving to a new identity pool

A new Cognito user pool (a replaced pool, or production moving to its own) gives every identity
a **new subject**. Accounts are bound to their identity by `users.cognito_sub` (ADR-012 amendment
TASK-174); until each is re-linked, a sign-in with the new subject finds no account and is given a
new, ordinary one — staff included. Re-linking is an operator command, run from a trusted machine;
nothing is changed by hand in the database. It changes only the account's subject — never its
id, role, standing or data — and records who did it and why in the audit log, in the same
transaction.

It moves an account **once**, from an identity of the old pool to one of the current pool, and
never again (review 15): an account already bound to an identity of the current pool — its
subject is a user of the pool, or it was re-linked in this pool before — is refused, whoever
holds its address now. An account made in the new pool (at or after the move time you give) is
never a target. An account whose own address was never verified is moved only when you confirm
it for that account (review 16, 6.6).

### 6.1 Before

| Do                                                                                                                                                                                      | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apply migrations 054 and 055 and deploy the release that has the command ([MIGRATION_v5_to_v6.md](MIGRATION_v5_to_v6.md) §1 step 2)                                                     | The app must recognise an account by its subject (provisioning, the account guard) before any account is re-linked; the command reads `user_deletions.cognito_sub`; 055 makes bulk runs fast                                                                                                                                                                                                                                                                                                                                                          |
| Nothing to decide about the subject (TASK-177): the command always binds the pool user's **`sub`**                                                                                      | It is what every token verifier names a signed-in identity by — the platform's own Cognito provider and Playform's alike, for a native and a federated (Google) user. A Google user's **User name** (`Google_1093…`) is never a subject. Review 16's `--subject` is gone: `--subject sub` still runs for one release (a deprecation note), `--subject username` is refused (exit 2) — drop the flag from any script. No data migration: platform-foundation has no deployment with existing users, and Playform's provider has always bound the `sub` |
| Note **when the deployment moved to the new pool** (UTC): the time of the first deployment whose `NEXT_PUBLIC_COGNITO_USER_POOL_ID` is the new pool (the host's deployment list)        | The command's `--created-before`: accounts made since then are the new pool's (first sign-ins), never re-linked to. If unsure, take an **earlier** time — never a later one                                                                                                                                                                                                                                                                                                                                                                           |
| In the new pool's Google identity provider, map Google's `email_verified` claim to the `email_verified` attribute (Attribute mapping) — for Google and Sign in with Apple **only**      | The command re-links only an address the pool says is verified, from a source it trusts (`AUTH_TRUSTED_EMAIL_IDPS`, default `Google`; add `SignInWithApple` if you use it). **Never map it for Microsoft Entra ID** (or any OIDC/SAML provider whose `email` the account's own tenant sets): its address is not verified by anyone (nOAuth) — such a user is refused `pool.unverified` whatever the mapping says                                                                                                                                      |
| Create a key that may call **only** `cognito-idp:ListUsers` on the new pool (IAM → a user or role with an inline policy on `arn:aws:cognito-idp:<region>:<account>:userpool/<pool id>`) | The command only reads the pool (by address, and by subject to check an account is not already bound there). The app's own `COGNITO_ADMIN_*` key is not allowed `ListUsers`, and should not be                                                                                                                                                                                                                                                                                                                                                        |
| Each person signs in once with the new pool (Google, or sign-up and confirm)                                                                                                            | Their identity then exists in the pool. A first sign-in may also create a stray ordinary account for the new subject — the command offers to merge it (6.3)                                                                                                                                                                                                                                                                                                                                                                                           |
| Staff who sign in with Google: decide how they meet `auth.staff_mfa_required` (on by default)                                                                                           | Cognito applies no second factor to a federated sign-in, so GetUser reports none and `/admin` answers `auth.mfa_required` for them while the setting is on — after the re-link too (the account is reached; administration is refused). Either they sign in with a password and an authenticator, or the setting is turned off (a safety-tier change: a second operator approves it) with two-step verification enforced for them at Google                                                                                                           |

The operator's key (an IAM user of its own; delete its access key when the move is done):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["cognito-idp:ListUsers"],
      "Resource": "arn:aws:cognito-idp:REGION:ACCOUNT:userpool/POOL_ID"
    }
  ]
}
```

### 6.2 The settings — in the shell, never in a file

Open a new terminal in the repository at the deployed release (`npm ci` done). Each secret is
read by a prompt that names it — paste the value it names, then Enter; nothing is shown, written
to a file or kept in the shell's history (works in zsh and bash; every block below pastes as is):

```bash
printf 'DATABASE_OWNER_URL: '; read -rs DATABASE_OWNER_URL; echo; export DATABASE_OWNER_URL
printf 'COGNITO_ADMIN_ACCESS_KEY_ID: '; read -rs COGNITO_ADMIN_ACCESS_KEY_ID; echo; export COGNITO_ADMIN_ACCESS_KEY_ID
printf 'COGNITO_ADMIN_SECRET_ACCESS_KEY: '; read -rs COGNITO_ADMIN_SECRET_ACCESS_KEY; echo; export COGNITO_ADMIN_SECRET_ACCESS_KEY
export DATABASE_SSL=verify-full
export DATABASE_SSL_CA="$(cat ~/Downloads/prod-ca-2021.crt)"
export COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
export POOL_MOVED_AT=2026-10-20T14:00:00Z
```

Then the shared cache, so the change reaches every instance at once — the same way, from the
host's secret store:

```bash
export CACHE_PROVIDER=upstash
printf 'UPSTASH_REDIS_REST_URL: '; read -rs UPSTASH_REDIS_REST_URL; echo; export UPSTASH_REDIS_REST_URL
printf 'UPSTASH_REDIS_REST_TOKEN: '; read -rs UPSTASH_REDIS_REST_TOKEN; echo; export UPSTASH_REDIS_REST_TOKEN
```

(or `export CACHE_PROVIDER=valkey` and `VALKEY_URL` by its own prompt).

- `DATABASE_OWNER_URL` — the owner connection of 1.3 (copy it from the host's secret store, or
  Supabase → Connect), **without** `?sslmode=…`: TLS is `DATABASE_SSL`, and the command refuses a
  URL carrying TLS options (node-postgres would let them override it).
- `DATABASE_SSL_CA` — the CA certificate of 1.3 (public; the downloaded file is fine). Required
  with `verify-full`; `DATABASE_SSL=disable` is refused unless the database is on this machine.
- `AUTH_TRUSTED_EMAIL_IDPS` — only if the deployment sets it (default `Google`): the same value.
- The pool id is not secret; the region comes from it (GovCloud pools, `us-gov-west-1_…`, too).
- Temporary credentials instead of a key: `eval "$(aws configure export-credentials --profile <p> --format env)"`,
  then `export COGNITO_ADMIN_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" COGNITO_ADMIN_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" COGNITO_ADMIN_SESSION_TOKEN="$AWS_SESSION_TOKEN"`.
- Check that each is set — names only, never a value:

  ```bash
  for v in DATABASE_OWNER_URL DATABASE_SSL_CA COGNITO_USER_POOL_ID COGNITO_ADMIN_ACCESS_KEY_ID COGNITO_ADMIN_SECRET_ACCESS_KEY CACHE_PROVIDER POOL_MOVED_AT; do [ -n "$(printenv "$v")" ] && echo "set: $v" || echo "MISSING: $v"; done
  ```

  A setting the command finds wrong is named when it starts (exit 2), never echoed.

Close the terminal when done: the values go with it.

### 6.3 One account

```bash
export STAFF_EMAIL=staff@example.com
node scripts/relink-identity.mjs --email "$STAFF_EMAIL" --created-before "$POOL_MOVED_AT" --operator "Your Name" --reason "dev/staging pool replaced"; echo "exit $?"
```

A **dry run**: it prints what it would change and changes nothing. Read it:

| It prints                                                                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `relink` with account, role, subject                                     | Ready. Run the same command with `--apply`                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `refused … [account.needs_confirmation]` and `--confirm-unverified <id>` | The account's own address was never verified (`users.email_verified` false — made by sign-up, or by an administrator with an address nobody proved): whoever verifies that address in the new pool would get the account. Confirm with the account's person, out of band, that the address is theirs and that they are the one signing in with it now; then add `--confirm-unverified <id>` (the id it printed). The old pool, which could have said more, is gone (6.6) |
| `refused … [subject.held]` and `--merge-from <id>`                       | The person's first sign-in made a stray account that holds only sign-in residue. Run again with `--merge-from <id>` (the id it printed), then `--apply`: the stray is removed and its subject moved to the staff account, in one transaction                                                                                                                                                                                                                             |
| `refused … [subject.held]` without it                                    | The stray holds the person's data (or is not a plain first sign-in): it is not merged. Decide with the person; nothing is lost by waiting                                                                                                                                                                                                                                                                                                                                |
| `refused … [pool.many]`                                                  | Two pool users can each prove the address (a password user and an unlinked Google user): link them (`AdminLinkProviderForUser`) or delete the extra one. An unconfirmed sign-up, or a user whose address is not verified (or verified only by an untrusted provider), beside the one that proves it is ignored (review 16 L4)                                                                                                                                            |
| `refused … [pool.unverified]`                                            | The address is not verified in the pool, or only by a provider not in `AUTH_TRUSTED_EMAIL_IDPS` (for Google: map the claim, 6.1, and sign in again; never for Microsoft Entra ID)                                                                                                                                                                                                                                                                                        |
| `relink` … "re-linked on the operator's confirmation"                    | Ready: an unverified account you confirmed with `--confirm-unverified`; the audit record says `unverifiedConfirmed`                                                                                                                                                                                                                                                                                                                                                      |
| `refused … [account.many]`                                               | More than one account made before the move has the address verified, or none verified and more than one unverified (their ids printed: confirm with the person which is theirs, then `--unverified-account <id>`, which is also its confirmation). Across tenants: `--tenant <id>`                                                                                                                                                                                       |
| `refused … [account.unverified]`                                         | The account named by `--unverified-account` is not the one this address re-links: not an unverified account of the address made before the move, or another account (its address verified) is the target (review 16 L1)                                                                                                                                                                                                                                                  |
| `refused … [account.none]`                                               | No account made before `--created-before` has the address (it says how many newer ones it left out). Check the time; an earlier one only refuses more                                                                                                                                                                                                                                                                                                                    |
| `refused … [account.bound_in_pool]` / `[account.relinked_in_pool]`       | The account is already bound to an identity of the current pool (asked by its `sub`; a legacy row without a subject by its id), or was re-linked in it before: it is never moved again — whoever holds the address now is not its person. A person who lost that identity is account recovery, not this command                                                                                                                                                          |
| `refused … [address.unsupported]`                                        | A non-ASCII address: never matched to an ASCII one (lookalikes). Account recovery, with the person                                                                                                                                                                                                                                                                                                                                                                       |
| `refused … [pool.other_tenant]` / `[subject.held_elsewhere]`             | The identity belongs to another tenant. Never re-linked across tenants                                                                                                                                                                                                                                                                                                                                                                                                   |
| `refused … [account.changed]`                                            | The account or the identity changed while the command ran. Run it again                                                                                                                                                                                                                                                                                                                                                                                                  |
| `linked`                                                                 | Already bound to the pool's identity: nothing to do                                                                                                                                                                                                                                                                                                                                                                                                                      |

Then apply it (add `--merge-from "$STRAY_ID"` after `export STRAY_ID=<the id it printed>` when
it offered a merge, and `--confirm-unverified "$ACCOUNT_ID"` when it asked for one):

```bash
node scripts/relink-identity.mjs --email "$STAFF_EMAIL" --created-before "$POOL_MOVED_AT" --operator "Your Name" --reason "dev/staging pool replaced" --apply; echo "exit $?"
```

Exit codes:

| Exit | Meaning                                                                                                                                                                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Done: every change applied and voided on every instance — or a dry run with nothing refused, or nothing to do                                                                                                                                                   |
| 1    | Refused: nothing changed — an applied run stopped by a refusal, or **a dry run that refused any address**, `--skip-ambiguous` or not (review 16 L5: a refusal is never 0; with `--skip-ambiguous`, `--apply` would re-link the rest)                            |
| 2    | Usage, or a setting missing or wrong (named, never shown): nothing read                                                                                                                                                                                         |
| 3    | The pool or the database unreachable before anything was committed: nothing changed                                                                                                                                                                             |
| 4    | Applied, but some addresses were refused and skipped (bulk, `--skip-ambiguous`): resolve them and run again                                                                                                                                                     |
| 5    | Applied, but not voided on every instance — each subject whose invalidation was not published is named, with why (review 16 M2), or the shared cache is not set in this shell: instances serve what they cached for at most 60 s more                           |
| 6    | Partly applied (bulk): some chunks committed, then the run stopped — it says which. Run the same command again                                                                                                                                                  |
| 7    | **Outcome unknown** (review 16 L7): the database connection failed while a chunk was committing — it may have committed. Do not assume either way: run the dry run (6.4 step 1) — what committed reads `linked` — then run it again with `--apply` for the rest |

The address is matched trimmed, with its ASCII letters in any case, in the database; the pool is
asked for it as typed and in lower case — if the pool holds it in another case, type it as the
pool shows it.

### 6.4 Check it took effect

1. The same command again without `--apply` prints `linked` (exit 0):

   ```bash
   node scripts/relink-identity.mjs --email "$STAFF_EMAIL" --created-before "$POOL_MOVED_AT" --operator "Your Name" --reason "check"; echo "exit $?"
   ```

2. In the SQL Editor (read-only queries):

   ```sql
   select u.id, left(u.cognito_sub, 8) as subject, r.name as role, u.created_at
     from users u join roles r on r.id = u.role_id
    where lower(btrim(u.email)) = 'staff@example.com' and u.deleted_at is null;
   select created_at, details->>'operator' as operator, details->>'reason' as reason,
          details->>'pool' as pool,
          details->>'unverifiedConfirmed' as confirmed, details->>'poolMovedAt' as moved_at
     from audit_log where details->>'type' = 'identity_relinked'
    order by created_at desc limit 5;
   ```

   One row before the move with the staff role, the subject's first 8 characters equal to the
   user's `sub` in the pool (Cognito → Users → the user → its `sub` attribute — for a Google user
   too, never its **User name** `Google_1…`, TASK-177); and the record, naming the current pool.

3. Sign in with the new pool: `/admin` opens with the staff role (a Google user: see the MFA row
   of 6.1).

### 6.5 A whole pool

```bash
node scripts/relink-identity.mjs --all-staff --created-before "$POOL_MOVED_AT" --operator "Your Name" --reason "production moved to its own pool"; echo "exit $?"
```

Every staff account (a role holding an administrative, configuration, platform or moderation
permission); `--all` for every account; `--tenant <id>` for one tenant. The same checks per
address, then one summary. Each address is asked of the pool in lower case and as stored. An
address with no pool user yet is `absent` (reported, not a refusal: re-link it after the person
signs in). Any refusal stops the whole run — nothing is changed — unless `--skip-ambiguous`,
which re-links the rest and reports the refused (exit 4). An address the dry run refused stays
refused when it is applied, even if the data changed in between (review 16 L2): what is applied
is only what the dry run showed. Two addresses that would bind one identity (one address in two
tenants) are both refused, `subject.contested` — re-link the person's own one with `--email …
--tenant <id>`. Strays are merged only with `--merge-strays`, and only those safe to merge.

Accounts whose own address was never verified are refused and **listed** at the end of the dry
run, each with the flag that confirms it:

```text
2 account(s) whose own address was never verified need the operator's confirmation — …
  --confirm-unverified 3f1c…   (ann@example.com, tenant 0000…, role super_admin)
```

Confirm each with its person, then repeat the flag once per account
(`--confirm-unverified "$ID1" --confirm-unverified "$ID2"`). A confirmation that matches no
account needing one is reported (`⚠ … named no account`) — check the id.

With `--apply`, it is applied in chunks of 500 addresses, each one transaction planned again
under lock: a chunk commits whole or not at all, and the output lists each chunk's outcome. A run
stopped after a chunk committed (exit 6) is completed by running the same command again: what was
applied reads `linked`; a chunk whose commit's outcome is unknown (exit 7) is said so, never
"nothing changed". Measured at 100,000 accounts (local Postgres 16, the pool stood in by a fake):
dry run 7 s, apply 20 s, a rerun 6 s — with migration 055; without it the same run exceeded the
statement timeout. Against Cognito, each address costs two or three `ListUsers` calls (by
address, as stored, and the account's current subject), which dominate: plan for Cognito's
`ListUsers` quota.

### 6.6 Verified addresses (`users.email_verified`, TASK-176)

Until TASK-176 every account made through `/api/auth/sign-up` was stored with
`users.email_verified = false` — it is created before the person confirms the address — and
nothing ever changed it. Now a signed-in request brings it up to date from the pool's own answer
for the token: false → true, once, with a `profile_updated` audit record (`field:
email_verified`, `verifiedBy`), only for the address the row already has. It is believed only
from the pool's own verification (a native user's code) or a provider in
`AUTH_TRUSTED_EMAIL_IDPS` (default `Google`): a user of any other provider — Microsoft Entra ID
above all — never marks an address verified, whatever the pool's mapping says, and neither does a
token whose provider does not say who verified it (`identityProviders`; Playform's provider must
fill it — [MIGRATION_v5_to_v6.md](MIGRATION_v5_to_v6.md) §1b). It is never set back to false.
Since TASK-185 the same trusted claim also records `users.email` when the row has none, or when
it changed on an active account and the pool answered that very request (`addressFresh` — a
remembered answer never moves it) — never a banned account's (the stored address is what a ban
follows), and the recorded address carries a ban like a new sign-up's (ADR-012 D5b–D5d). An
account whose person never signs in again keeps what it has. So after a pool move, the re-linked
accounts' addresses are what the command matched them by until each person signs in. Each sign-in
also sets `users.last_login_at`; migrations 056 (the Users list's sort indexes) and then 057 (the
column filled from the audit log's sign-ins, its own transaction — its time grows with
`audit_log`) apply before that code ([MIGRATION_v5_to_v6.md](MIGRATION_v5_to_v6.md) §1 step 2).

There is no backfill: whether an existing account's address was confirmed is known only to the
pool, so no migration can say it. **A person's next sign-in to the current pool marks their
account verified.** For a re-link that cannot work — the old pool is gone, and an old-pool account
can never sign in again to be updated. The current pool's verification proves only that whoever
signs in **now** holds the address: an address mistyped when the account was made (an
administrator-created or phone-confirmed account), or one that changed hands, would give the
account to a stranger. So an account whose own flag is false is re-linked only when the operator
confirms it for that very account (`--confirm-unverified <id>`, recorded as `unverifiedConfirmed`
in the audit record; review 16 D4f). While the old pool still exists, the check worth making
before confirming is that pool's user for the address (Cognito → the old pool → Users: its
`email_verified`); once it is deleted, only the person can confirm it. The old row's flag still
breaks a tie (one verified account beside unverified ones is the target), and accounts made after
the move are never counted or chosen (review 15 H1/M1, unchanged). Reasoning: ADR-012 amendment.

Check it took effect (SQL Editor, read-only) — after the person signs in once:

```sql
select u.id, u.email_verified, a.created_at as marked_at, a.details->>'verifiedBy' as verified_by
  from users u
  left join audit_log a on a.target_id = u.id and a.action = 'profile_updated'
       and a.details->>'field' = 'email_verified'
 where lower(btrim(u.email)) = 'person@example.com' and u.deleted_at is null;
```

`email_verified` is `true`, with one record (none when the account was verified from the start).
Still `false` after a sign-in: the pool's address is not this one (changed there), it is not
verified in the pool (for Google: the mapping of 6.1), or its provider is not trusted.

### 6.7 Worked example: one Google-federated staff account (Playform, pool `us-east-1_9pRbNsCbE`)

Playform's provider, like the platform's, names an identity by the token's `sub`, and the command
binds the `sub` — there is no subject flag (TASK-177). The staff member has signed in once with
Google to the new pool. Every block pastes into zsh as is.

```bash
printf 'DATABASE_OWNER_URL: '; read -rs DATABASE_OWNER_URL; echo; export DATABASE_OWNER_URL
printf 'COGNITO_ADMIN_ACCESS_KEY_ID: '; read -rs COGNITO_ADMIN_ACCESS_KEY_ID; echo; export COGNITO_ADMIN_ACCESS_KEY_ID
printf 'COGNITO_ADMIN_SECRET_ACCESS_KEY: '; read -rs COGNITO_ADMIN_SECRET_ACCESS_KEY; echo; export COGNITO_ADMIN_SECRET_ACCESS_KEY
printf 'UPSTASH_REDIS_REST_URL: '; read -rs UPSTASH_REDIS_REST_URL; echo; export UPSTASH_REDIS_REST_URL
printf 'UPSTASH_REDIS_REST_TOKEN: '; read -rs UPSTASH_REDIS_REST_TOKEN; echo; export UPSTASH_REDIS_REST_TOKEN
export CACHE_PROVIDER=upstash
export DATABASE_SSL=verify-full
export DATABASE_SSL_CA="$(cat ~/Downloads/prod-ca-2021.crt)"
export COGNITO_USER_POOL_ID=us-east-1_9pRbNsCbE
export POOL_MOVED_AT=2026-10-20T14:00:00Z
export STAFF_EMAIL=staff@example.com
```

Dry run (expect `relink`; or `account.needs_confirmation` with the account id; or
`subject.held` with a `--merge-from` id):

```bash
node scripts/relink-identity.mjs --email "$STAFF_EMAIL" --created-before "$POOL_MOVED_AT" --operator "Your Name" --reason "Playform moved to pool us-east-1_9pRbNsCbE"; echo "exit $?"
```

Only if it printed them (the ids are the ones it printed):

```bash
export ACCOUNT_ID=00000000-0000-4000-8000-000000000000
export STRAY_ID=00000000-0000-4000-8000-000000000000
```

Apply — the dry run's command with `--apply`, and `--confirm-unverified "$ACCOUNT_ID"` /
`--merge-from "$STRAY_ID"` only if it asked for them:

```bash
node scripts/relink-identity.mjs --email "$STAFF_EMAIL" --created-before "$POOL_MOVED_AT" --operator "Your Name" --reason "Playform moved to pool us-east-1_9pRbNsCbE" --apply; echo "exit $?"
```

Verify (expect `linked`, exit 0), then 6.4 step 2, then sign in with Google and open `/admin`:

```bash
node scripts/relink-identity.mjs --email "$STAFF_EMAIL" --created-before "$POOL_MOVED_AT" --operator "Your Name" --reason "check"; echo "exit $?"
```
