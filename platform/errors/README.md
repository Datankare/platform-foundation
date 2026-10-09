# platform/errors

API error codes and the translatable message catalog (ADR-051, TASK-109).

## Files

| File           | Purpose                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------- |
| `registry.ts`  | Every platform error code: HTTP status, parameters, what the caller should do                     |
| `spec.ts`      | The shape of a code's declaration (shared by both registries)                                     |
| `app-codes.ts` | The consuming app's own `app.*` codes — **consumer-owned**, shipped empty                         |
| `messages.ts`  | Catalog lookup (`messages/<locale>.json`), locale negotiation, ICU rendering (intl-messageformat) |
| `respond.ts`   | `apiError(code, { params, request })` — the only way a route returns an error                     |
| `doc.ts`       | Generates `docs/API_ERRORS.md` (platform) and `docs/APP_API_ERRORS.md` (app)                      |

## Usage

```typescript
import { apiError } from "@/platform/errors";

if (!body.email)
  return apiError("request.missing_fields", { params: { fields: ["email"] }, request });
```

## Adding a code

1. Add it to `ERROR_CODES` in `registry.ts` (status, params, caller action).
2. Add `errors.<code>` to `messages/en.json` — ICU; every non-optional param appears in the message, and no other argument does.
3. Regenerate the reference: `UPDATE_API_ERRORS_DOC=1 npx jest __tests__/api-errors-doc.test.ts`.

CI fails if the registry, the catalog and `docs/API_ERRORS.md` disagree.

## An app's own codes (ADR-051 D1)

An app built on platform-foundation returns errors the platform has no code for (its own routes and
domain). It declares them itself, in files platform-foundation ships empty and the app owns:

| File                           | Holds                                                                  |
| ------------------------------ | ---------------------------------------------------------------------- |
| `platform/errors/app-codes.ts` | `APP_ERROR_CODES` — every code `app.<area>.<name>`, same spec as above |
| `messages/app/en.json`         | Their messages, under `errors.app` (and later `screens.app`) only      |
| `docs/APP_API_ERRORS.md`       | Generated reference for those codes                                    |

**List all three in the app's sync exclude list** — otherwise the next sync replaces them with the
empty versions. The registry and catalog merge them at load: `apiError("app.files.too_large", …)`
type-checks and renders like any platform code. An app key outside its namespaces, or one the
platform already defines, is refused at load, so an app can neither shadow nor reword a platform
message. Prefer a platform code whenever one fits (`request.*`, `rate.limited`,
`service.unavailable`, `content.rejected`, …); add an app code only for what is the app's own.
