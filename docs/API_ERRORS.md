# API Errors

<!-- GENERATED from platform/errors/registry.ts and messages/en.json — do not edit by hand. -->
<!-- Regenerate: UPDATE_API_ERRORS_DOC=1 npx jest __tests__/api-errors-doc.test.ts -->

Every error the API returns has this body (ADR-051 D3):

```json
{
  "code": "request.missing_fields",
  "message": "Required: email.",
  "params": { "fields": ["email"] }
}
```

- **`code`** is stable — act on it. A code is never repurposed; a new meaning gets a new code.
- **`message`** is rendered for the request's locale (`Accept-Language`, English fallback). Show it; never parse it.
- **`params`** are the values the message used, so a client can render the message in its own locale from the catalog key `errors.<code>`. Param kinds: `id` — an identifier, shown verbatim and never translated; `number`; `list` — identifiers, joined in the locale's list style.
- Until Sprint 7B the body also carries `success: false` and `error` (equal to `message`) — deprecated aliases for older screens. Do not build on them.
- `internal.error` always carries a `requestId` to quote when reporting a problem, and never internal detail. A `retryAfterSeconds` param is also sent as the `Retry-After` header.
- An app built on the platform adds its own codes, `app.<area>.<name>`, documented in [APP_API_ERRORS.md](APP_API_ERRORS.md).

**89 codes** in 15 areas.

## Account

| Code                                 | HTTP | Message (en)                                                                                                                                      | Params                        | What the caller should do                                                                                                           |
| ------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `account.age_already_recorded`       | 409  | Your date of birth is already recorded. Contact support to correct it.                                                                            | —                             | The account's date of birth is already recorded and cannot be changed here; contact support to correct it.                          |
| `account.age_unverified`             | 403  | Confirm your date of birth to use {feature}.                                                                                                      | `feature` (id)                | Ask for the user's date of birth and send it once to POST /api/account/age, then retry.                                             |
| `account.child_accounts_unavailable` | 403  | Accounts for children under 13 are not available yet. Nothing was created or saved.                                                               | —                             | Explain that accounts for children under 13 are not available yet; nothing was created or recorded. Do not retry.                   |
| `account.consent_required`           | 403  | A parent or guardian needs to give consent before you can use {feature}.                                                                          | `feature` (id)                | Explain that a parent or guardian must give consent before this feature can be used; do not retry.                                  |
| `account.export_too_large`           | 413  | Your account holds more than {limit, number} records, more than one download can carry. Nothing was cut off — contact support for your full copy. | `limit` (number)              | Explain that the account holds more data than one export can carry and that nothing was cut off; contact support for the full copy. |
| `account.identity_conflict`          | 403  | This sign-in cannot be matched to your account. Sign out and sign in again; if that does not help, contact support.                               | —                             | Do not retry: sign the user out and show sign-in; if it persists after signing in again, contact support.                           |
| `account.not_found`                  | 403  | Your account could not be found.                                                                                                                  | —                             | Show sign-in / contact support.                                                                                                     |
| `account.not_provisioned`            | 503  | Your account is still being set up. Try again in a moment.                                                                                        | —                             | Retry shortly; the account's platform record could not be created. If it persists, contact support.                                 |
| `account.restricted`                 | 403  | Your account cannot use this feature right now.                                                                                                   | `feature` (id), `status` (id) | Show the restriction; offer appeal.                                                                                                 |

## Admin

| Code                         | HTTP | Message (en)                                                            | Params        | What the caller should do                                                                                                |
| ---------------------------- | ---- | ----------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `admin.config_invalid_value` | 422  | That value is not allowed for {key}.                                    | `key` (id)    | Show the setting's allowed type and range, and ask for a valid value.                                                    |
| `admin.config_scope_refused` | 403  | {key} governs the platform, so only an operator can change it.          | `key` (id)    | Explain that this setting governs the platform and only an operator can change it; do not retry.                         |
| `admin.kill_switch_failed`   | 409  | The agents could not all be suspended. Nothing was changed; try again.  | —             | Retry; if it fails again, suspend each agent from the config page (agent.trusted_agents) — a suspension applies at once. |
| `admin.operator_only`        | 403  | Only a platform operator can change this: it is shared by every tenant. | —             | Explain that this changes what every tenant shares, so only a platform operator can do it; do not retry.                 |
| `admin.self_target`          | 403  | You cannot take this action on your own account.                        | —             | Another administrator must take this action on your account.                                                             |
| `admin.target_not_found`     | 404  | No {target} matches that request.                                       | `target` (id) | Refresh the list and pick an existing item.                                                                              |

## Ai

| Code                  | HTTP | Message (en)                                                   | Params | What the caller should do                                                                                    |
| --------------------- | ---- | -------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| `ai.request_declined` | 422  | The AI model declined this request. Rephrase it and try again. | —      | Explain that the AI model declined this request; ask the user to rephrase it. Do not retry the same request. |

## Approvals

| Code                             | HTTP | Message (en)                                                                                                                                 | Params            | What the caller should do                                                                                                       |
| -------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `approvals.approver_not_allowed` | 403  | This action needs approval from someone else.                                                                                                | —                 | Ask the approver the approval policy names (a person, unless the policy says otherwise).                                        |
| `approvals.decision_conflict`    | 409  | This decision could not be recorded; the item changed. Refresh and try again.                                                                | —                 | Refresh.                                                                                                                        |
| `approvals.expired`              | 409  | This approval has expired. Request the change again.                                                                                         | —                 | Tell the requester to submit the change again.                                                                                  |
| `approvals.hold_not_found`       | 404  | That held action was not found.                                                                                                              | —                 | Refresh the list.                                                                                                               |
| `approvals.indeterminate`        | 409  | This approved change was being applied and its outcome is unknown. Verify whether it took effect, then mark it executed or approve it again. | —                 | Verify whether the change took effect, then mark it executed (decision mark_executed) or approve it again (decision reapprove). |
| `approvals.permission_required`  | 403  | Clearing this change requires the {permission} permission.                                                                                   | `permission` (id) | Route to a holder of it.                                                                                                        |
| `approvals.run_failed`           | 503  | Approved, but it could not be applied. It is still approved: approve it again to retry, or reject it.                                        | —                 | Approve it again to retry, or reject it.                                                                                        |
| `approvals.self_approval`        | 409  | You cannot approve your own change; another approver must clear it.                                                                          | —                 | Route to another approver.                                                                                                      |
| `approvals.stale`                | 409  | The setting changed after this change was requested, so nothing was changed and the request was withdrawn. Request the change again.         | —                 | Nothing was changed and the request is withdrawn. Tell the requester to submit the change again against the current value.      |

## Authentication and sign-in

| Code                        | HTTP | Message (en)                                                                                   | Params                                 | What the caller should do                                                                                                                                  |
| --------------------------- | ---- | ---------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.account_exists`       | 409  | An account with this email already exists.                                                     | —                                      | Offer sign-in or password reset.                                                                                                                           |
| `auth.challenge_failed`     | 401  | Verification did not complete. Try again.                                                      | —                                      | Restart the challenge.                                                                                                                                     |
| `auth.code_expired`         | 400  | That code has expired. Request a new one.                                                      | —                                      | Offer resend.                                                                                                                                              |
| `auth.code_invalid`         | 400  | That code is not correct.                                                                      | —                                      | Let the user retry.                                                                                                                                        |
| `auth.default_role_limited` | 403  | The {role} role is given to every new account, so it cannot carry the {permission} permission. | `role` (id), `permission` (id)         | Explain that the role every new account gets cannot carry staff permissions; grant them through another role.                                              |
| `auth.email_not_verified`   | 403  | Verify your email to continue.                                                                 | —                                      | Show the verification step.                                                                                                                                |
| `auth.grant_exceeds_own`    | 403  | You cannot grant or remove the {permission} permission, because you do not hold it.            | `permission` (id)                      | Ask an administrator who holds the permission.                                                                                                             |
| `auth.guest_invalid`        | 401  | Your guest session has expired. Start a new one or sign in.                                    | —                                      | Start a new guest session or show sign-in.                                                                                                                 |
| `auth.guest_refused`        | 403  | Guest access is not available while your account is restricted.                                | —                                      | Explain that this account's restriction also applies to guest use; offer the appeal route, not a guest session.                                            |
| `auth.invalid_credentials`  | 401  | Email or password is incorrect.                                                                | —                                      | Let the user retry.                                                                                                                                        |
| `auth.mfa_required`         | 403  | Administrative access needs two-step verification. Set it up, then sign in again.              | —                                      | Ask the user to set up MFA (POST /api/auth/mfa/setup, then /verify) and sign in again with it; administrative access needs a second factor.                |
| `auth.password_policy`      | 400  | The password does not meet the requirements.                                                   | `rules` (list, optional)               | Show the password rules; `rules` lists the ids that failed when known (min_length, uppercase, lowercase, number, special, breached, repeated, sequential). |
| `auth.permission_denied`    | 403  | You do not have permission to do this.                                                         | `permission` (id)                      | Hide or disable the action.                                                                                                                                |
| `auth.required`             | 401  | Sign in to continue.                                                                           | —                                      | Show sign-in.                                                                                                                                              |
| `auth.role_database_only`   | 403  | The {role} role can only be assigned directly in the database.                                 | `role` (id)                            | Explain; no API path.                                                                                                                                      |
| `auth.role_protected`       | 403  | The {role} role can only be changed directly in the database.                                  | `role` (id)                            | Explain; no API path.                                                                                                                                      |
| `auth.role_self_change`     | 403  | You cannot change your own role.                                                               | —                                      | Ask another administrator.                                                                                                                                 |
| `auth.sign_in_required`     | 401  | Sign in to use this feature.                                                                   | —                                      | Show sign-in (guest on a users-only route).                                                                                                                |
| `auth.signups_closed`       | 403  | New accounts are not being accepted here right now.                                            | —                                      | Explain that new accounts are not being accepted here; do not retry.                                                                                       |
| `auth.sso_failed`           | 401  | Single sign-on did not complete. Try another sign-in method.                                   | `provider` (id, optional)              | Offer another sign-in method.                                                                                                                              |
| `auth.token_invalid`        | 401  | Your session has expired. Sign in again.                                                       | —                                      | Refresh the token, else show sign-in.                                                                                                                      |
| `auth.too_many_attempts`    | 429  | Too many attempts. Try again later.                                                            | `retryAfterSeconds` (number, optional) | Back off.                                                                                                                                                  |

## Content

| Code               | HTTP | Message (en)                               | Params                    | What the caller should do |
| ------------------ | ---- | ------------------------------------------ | ------------------------- | ------------------------- |
| `content.rejected` | 422  | This content does not meet our guidelines. | `category` (id, optional) | Ask for different input.  |

## Optional features

| Code                     | HTTP | Message (en)                       | Params         | What the caller should do                                                                                   |
| ------------------------ | ---- | ---------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| `feature.not_configured` | 501  | This feature isn't available here. | `feature` (id) | Hide the feature; it is not configured on this deployment (see GET /api/features). Retrying cannot succeed. |

## Guest access

| Code                        | HTTP | Message (en)                                                                                                        | Params           | What the caller should do                                                         |
| --------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------- |
| `guest.allowance_exhausted` | 403  | You've used all {limit, plural, one {# free translation} other {# free translations}}. Sign in to keep translating. | `limit` (number) | Show sign-in; the guest has used every free translation (the governed allowance). |

## Internal

| Code             | HTTP | Message (en)                                                                   | Params           | What the caller should do         |
| ---------------- | ---- | ------------------------------------------------------------------------------ | ---------------- | --------------------------------- |
| `internal.error` | 500  | Something went wrong. Try again; if it continues, quote reference {requestId}. | `requestId` (id) | Retry; report with the reference. |

## Jobs

| Code             | HTTP | Message (en)                                                                | Params | What the caller should do                                                                                                                                    |
| ---------------- | ---- | --------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `jobs.not_dead`  | 409  | Only a dead-lettered job can be replayed or discarded, and this one is not. | —      | Refresh the Jobs page: only a dead-lettered job can be replayed or discarded, and this one is queued, running or finished (another operator may have acted). |
| `jobs.not_found` | 404  | That job was not found.                                                     | —      | Refresh the Jobs page; the job or recurring job named does not exist, or was discarded.                                                                      |

## Moderation

| Code                                  | HTTP | Message (en)                                                                     | Params           | What the caller should do                 |
| ------------------------------------- | ---- | -------------------------------------------------------------------------------- | ---------------- | ----------------------------------------- |
| `moderation.appeal_not_allowed`       | 400  | Only blocked content can be appealed.                                            | —                | Hide the appeal action for this decision. |
| `moderation.appeal_not_found`         | 404  | That appeal was not found.                                                       | —                | —                                         |
| `moderation.appeal_pending`           | 409  | An appeal is already pending for this decision.                                  | —                | Show the pending appeal.                  |
| `moderation.appeal_reason_too_short`  | 400  | Explain your appeal in at least {min, number} characters.                        | `min` (number)   | Ask for a longer reason.                  |
| `moderation.appeal_window_expired`    | 400  | The appeal window has closed. Appeals must be made within {hours, number} hours. | `hours` (number) | Explain the window has closed; no retry.  |
| `moderation.decision_not_found`       | 404  | That moderation decision was not found.                                          | —                | —                                         |
| `moderation.item_state_conflict`      | 409  | This item has already been handled or changed. Refresh the queue.                | `status` (id)    | Refresh the queue.                        |
| `moderation.modified_action_required` | 400  | Choose the modified action.                                                      | —                | Prompt for it.                            |
| `moderation.not_claimer`              | 409  | Only the reviewer who claimed this item can change it.                           | `action` (id)    | Refresh the queue.                        |
| `moderation.not_own_decision`         | 403  | You can only appeal your own moderation decisions.                               | —                | —                                         |
| `moderation.review_item_not_found`    | 404  | That review item was not found.                                                  | —                | —                                         |
| `moderation.self_review`              | 403  | You cannot review a moderation case about your own account.                      | —                | Route the item to another moderator.      |

## Rate limits

| Code           | HTTP | Message (en)                              | Params                                 | What the caller should do |
| -------------- | ---- | ----------------------------------------- | -------------------------------------- | ------------------------- |
| `rate.limited` | 429  | Too many requests. Try again in a moment. | `retryAfterSeconds` (number, optional) | Back off.                 |

## Request validation

| Code                            | HTTP | Message (en)                                                                                                                                       | Params                         | What the caller should do                            |
| ------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------- |
| `request.field_not_accepted`    | 400  | {field} cannot be set by the request.                                                                                                              | `field` (id)                   | Stop sending the field; the server sets it.          |
| `request.invalid_body`          | 400  | The request body is not in the expected shape.                                                                                                     | —                              | Fix the client request.                              |
| `request.invalid_json`          | 400  | The request body is not valid JSON.                                                                                                                | —                              | Fix the client request.                              |
| `request.invalid_value`         | 400  | {field} must be one of: {allowed}.                                                                                                                 | `field` (id), `allowed` (list) | Send one of the allowed values.                      |
| `request.json_too_deep`         | 400  | The data is nested too deeply to store (at most {max, number} levels).                                                                             | `max` (number)                 | Send the data with less nesting; nothing was stored. |
| `request.json_too_large`        | 413  | The data is too large to store (at most {max, number} bytes).                                                                                      | `max` (number)                 | Send less data in one record; nothing was stored.    |
| `request.missing_fields`        | 400  | Required: {fields}.                                                                                                                                | `fields` (list)                | Send the listed fields.                              |
| `request.text_empty`            | 400  | Enter some text.                                                                                                                                   | —                              | Prompt for text.                                     |
| `request.text_too_long`         | 400  | Text must be {max, number} characters or fewer.                                                                                                    | `max` (number)                 | Shorten the text.                                    |
| `request.trajectory_chain_full` | 409  | This session or run has recorded as much as one may (at most {max, number} segments of up to 1,000 steps each). Start a new one; nothing was done. | `max` (number)                 | Start a new session or run; nothing was done.        |
| `request.trajectory_full`       | 409  | This run has recorded as much as one run may (at most {max, number} steps, 16 MiB in all). Start a new one; nothing was done.                      | `max` (number)                 | Start a new run; nothing was done.                   |

## Service availability

| Code                  | HTTP | Message (en)                                              | Params         | What the caller should do |
| --------------------- | ---- | --------------------------------------------------------- | -------------- | ------------------------- |
| `service.unavailable` | 503  | This service is unavailable right now. Try again shortly. | `service` (id) | Retry later.              |

## Tenant

| Code                   | HTTP | Message (en)                                                                              | Params        | What the caller should do                                                                                                         |
| ---------------------- | ---- | ----------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `tenant.conflict`      | 409  | That could not be done: {reason}.                                                         | `reason` (id) | Show the reason (the slug or address is taken, or the tenant is not in the state this needs); refresh and choose again.           |
| `tenant.invalid`       | 400  | Some of the details are not valid: {reason}                                               | `reason` (id) | Show the reason (what the form or request needs) and ask again.                                                                   |
| `tenant.mismatch`      | 403  | This account belongs to a different organisation. Sign in on your organisation's address. | —             | The credentials belong to another tenant than this address serves. Sign in on your own organisation's address; do not retry here. |
| `tenant.missing`       | 403  | Your account is not assigned to an organisation yet. Contact your administrator.          | —             | The account is not assigned to a tenant. An operator must assign it; retrying cannot succeed.                                     |
| `tenant.not_active`    | 409  | That tenant is deleted and awaiting purge. Restore it first.                              | —             | Explain that the tenant is deleted and awaiting purge; restore it first.                                                          |
| `tenant.not_found`     | 404  | That tenant, request or user was not found.                                               | —             | Refresh the tenant list; the tenant, request or user named does not exist.                                                        |
| `tenant.not_shared`    | 409  | This deployment serves one tenant: change its settings on the Platform Config page.       | —             | Explain that this deployment serves one tenant, whose settings are on the Platform Config page; do not retry.                     |
| `tenant.own_tenant`    | 403  | You cannot suspend or delete the organisation you are operating from.                     | —             | Explain that an operator cannot suspend or delete the tenant they operate from; do not retry.                                     |
| `tenant.self_approval` | 403  | Another operator must approve a deletion you requested.                                   | —             | Another operator must approve this deletion; do not retry as the requester.                                                       |
| `tenant.suspended`     | 403  | Access for this organisation is suspended. Contact your administrator.                    | —             | The tenant is suspended. Show the message; contact the operator. Retrying cannot succeed.                                         |
| `tenant.unknown_host`  | 404  | This address is not set up. Check the address and try again.                              | —             | The address is not set up for any tenant. Check the address; retrying cannot succeed.                                             |
