# platform/errors

API error codes and the translatable message catalog (ADR-051, TASK-109).

## Files

| File          | Purpose                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `registry.ts` | Every error code: HTTP status, parameters, what the caller should do                              |
| `messages.ts` | Catalog lookup (`messages/<locale>.json`), locale negotiation, ICU rendering (intl-messageformat) |
| `respond.ts`  | `apiError(code, { params, request })` — the only way a route returns an error                     |
| `doc.ts`      | Generates `docs/API_ERRORS.md`                                                                    |

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
