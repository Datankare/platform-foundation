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

**46 codes** in 11 areas.

## Account

| Code                 | HTTP | Message (en)                                    | Params                        | What the caller should do           |
| -------------------- | ---- | ----------------------------------------------- | ----------------------------- | ----------------------------------- |
| `account.not_found`  | 403  | Your account could not be found.                | —                             | Show sign-in / contact support.     |
| `account.restricted` | 403  | Your account cannot use this feature right now. | `feature` (id), `status` (id) | Show the restriction; offer appeal. |

## Approvals

| Code                            | HTTP | Message (en)                                                                  | Params            | What the caller should do                      |
| ------------------------------- | ---- | ----------------------------------------------------------------------------- | ----------------- | ---------------------------------------------- |
| `approvals.decision_conflict`   | 409  | This decision could not be recorded; the item changed. Refresh and try again. | —                 | Refresh.                                       |
| `approvals.expired`             | 409  | This approval has expired. Request the change again.                          | —                 | Tell the requester to submit the change again. |
| `approvals.hold_not_found`      | 404  | That held action was not found.                                               | —                 | Refresh the list.                              |
| `approvals.permission_required` | 403  | Clearing this change requires the {permission} permission.                    | `permission` (id) | Route to a holder of it.                       |
| `approvals.self_approval`       | 409  | You cannot approve your own change; another approver must clear it.           | —                 | Route to another approver.                     |

## Authentication and sign-in

| Code                       | HTTP | Message (en)                                                   | Params                                 | What the caller should do                                                                                                                                  |
| -------------------------- | ---- | -------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.account_exists`      | 409  | An account with this email already exists.                     | —                                      | Offer sign-in or password reset.                                                                                                                           |
| `auth.challenge_failed`    | 401  | Verification did not complete. Try again.                      | —                                      | Restart the challenge.                                                                                                                                     |
| `auth.code_expired`        | 400  | That code has expired. Request a new one.                      | —                                      | Offer resend.                                                                                                                                              |
| `auth.code_invalid`        | 400  | That code is not correct.                                      | —                                      | Let the user retry.                                                                                                                                        |
| `auth.email_not_verified`  | 403  | Verify your email to continue.                                 | —                                      | Show the verification step.                                                                                                                                |
| `auth.guest_invalid`       | 401  | Your guest session has expired. Start a new one or sign in.    | —                                      | Start a new guest session or show sign-in.                                                                                                                 |
| `auth.invalid_credentials` | 401  | Email or password is incorrect.                                | —                                      | Let the user retry.                                                                                                                                        |
| `auth.password_policy`     | 400  | The password does not meet the requirements.                   | `rules` (list, optional)               | Show the password rules; `rules` lists the ids that failed when known (min_length, uppercase, lowercase, number, special, breached, repeated, sequential). |
| `auth.permission_denied`   | 403  | You do not have permission to do this.                         | `permission` (id)                      | Hide or disable the action.                                                                                                                                |
| `auth.required`            | 401  | Sign in to continue.                                           | —                                      | Show sign-in.                                                                                                                                              |
| `auth.role_database_only`  | 403  | The {role} role can only be assigned directly in the database. | `role` (id)                            | Explain; no API path.                                                                                                                                      |
| `auth.role_self_change`    | 403  | You cannot change your own role.                               | —                                      | Ask another administrator.                                                                                                                                 |
| `auth.sign_in_required`    | 401  | Sign in to use this feature.                                   | —                                      | Show sign-in (guest on a users-only route).                                                                                                                |
| `auth.sso_failed`          | 401  | Single sign-on did not complete. Try another sign-in method.   | `provider` (id, optional)              | Offer another sign-in method.                                                                                                                              |
| `auth.token_invalid`       | 401  | Your session has expired. Sign in again.                       | —                                      | Refresh the token, else show sign-in.                                                                                                                      |
| `auth.too_many_attempts`   | 429  | Too many attempts. Try again later.                            | `retryAfterSeconds` (number, optional) | Back off.                                                                                                                                                  |

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

## Rate limits

| Code           | HTTP | Message (en)                              | Params                                 | What the caller should do |
| -------------- | ---- | ----------------------------------------- | -------------------------------------- | ------------------------- |
| `rate.limited` | 429  | Too many requests. Try again in a moment. | `retryAfterSeconds` (number, optional) | Back off.                 |

## Request validation

| Code                     | HTTP | Message (en)                                    | Params                         | What the caller should do       |
| ------------------------ | ---- | ----------------------------------------------- | ------------------------------ | ------------------------------- |
| `request.invalid_body`   | 400  | The request body is not in the expected shape.  | —                              | Fix the client request.         |
| `request.invalid_json`   | 400  | The request body is not valid JSON.             | —                              | Fix the client request.         |
| `request.invalid_value`  | 400  | {field} must be one of: {allowed}.              | `field` (id), `allowed` (list) | Send one of the allowed values. |
| `request.missing_fields` | 400  | Required: {fields}.                             | `fields` (list)                | Send the listed fields.         |
| `request.text_empty`     | 400  | Enter some text.                                | —                              | Prompt for text.                |
| `request.text_too_long`  | 400  | Text must be {max, number} characters or fewer. | `max` (number)                 | Shorten the text.               |

## Service availability

| Code                  | HTTP | Message (en)                                              | Params         | What the caller should do |
| --------------------- | ---- | --------------------------------------------------------- | -------------- | ------------------------- |
| `service.unavailable` | 503  | This service is unavailable right now. Try again shortly. | `service` (id) | Retry later.              |
