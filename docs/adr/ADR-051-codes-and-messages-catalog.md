# ADR-051: Codes and Messages — One Translatable Catalog

Status: Proposed (Phase 5 Sprint 7A; accepted at Sprint 7B close). Decision maker: Raman Sud.
Related: ADR-050 D4 (guest sign-in prompt and guest allowance need codes the app can act on), TASK-109 (API error contract, Sprint 7A), TASK-110 (screen strings, Sprint 7B). `app/api/**`, `platform/**`, `components/**`, `messages/`.

---

## 1. Context

Every error the services return is `{ error: "<English sentence>" }` with an HTTP status: about 150 distinct messages across the PF and Playform routes, plus about 50 platform reason strings (account status, moderation, limits) that reach users. Only two responses carry a machine-readable code (`sign_in_required`, `guest_invalid`, Sprint 7A A3), and nothing documents any of them. A client or agent that needs to act on an error has to match English text, which breaks when the wording changes and cannot be translated.

The screens have the same problem: roughly 430 user-visible strings (text, labels, placeholders, `aria-label`, `title`, `alt`) across about 50 components are English literals. There is no i18n library and no message catalog — in a product whose purpose is translation.

Standing expectation (Raman): every code the services return is documented for anyone building on or using them, with no exceptions; every error has a code and a corresponding text whose structure is easily translatable; the same applies to every label on every screen.

## 2. Decisions

**D1 — One catalog is the source of every user-visible string.** `messages/en.json` is the source of truth; other locales are files of the same shape. Keys are namespaced and stable: `errors.<area>.<code>` for errors, `ui.<screen>.<element>` for screens. PF owns platform keys; a consumer adds its own namespace in a consumer-owned (sync-excluded) file, merged at load. A key, once shipped, is never repurposed — a changed meaning gets a new key.

**D2 — Messages are ICU MessageFormat.** Parameters, plurals and selects live inside the message, never in string concatenation in code, so a translator always sees a whole sentence: `{remaining, plural, one {# translation left} other {# translations left}}`. Code passes values, never fragments of text.

**D3 — Every API error is `{ code, message, params }`.** `code` is the catalog key (stable; clients act on it); `message` is rendered in the request's locale (user preference, then `Accept-Language`, then English); `params` are the values used, so any client can re-render the message in its own locale. Each code declares its HTTP status and caller guidance once, in the error registry; a route returns an error only by code. No free-text error bodies.

**D4 — Every screen string goes through the catalog.** Text nodes and user-visible attributes (`placeholder`, `aria-label`, `title`, `alt`, labels) are `t(key)` calls. Library: `next-intl` (App Router native, ICU, server and client rendering).

**D5 — CI enforces it.** (a) Every code used by a route is registered; every registered code is in the catalog and documented. (b) A route scan fails any error response not built from a registered code. (c) `docs/API_ERRORS.md` is generated from the registry and catalog and checked for drift — it lists every code with its status, meaning, parameters and what the caller should do. (d) Every key used exists in `en`; every `en` key is used. (e) A lint rule flags literal strings in JSX and user-visible attributes, under a ratchet: a checked-in baseline count that may only go down, reaching zero at Sprint 7B close.

**D6 — Which locales ship is separate.** This ADR delivers the structure and English. Which languages are offered, and how catalogs are translated (the platform's own pipeline, human review, or both), is a product decision taken on its own.

_Implementation (7A A4a):_ `platform/errors/` — `registry.ts` (39 codes: status, typed params — `id` identifiers shown verbatim and never translated, `number`, `list` — and caller action), `messages.ts` (catalog lookup, `Accept-Language` negotiation, ICU via `intl-messageformat`, the engine `next-intl` builds on; `next-intl` itself joins in 7B with the screens, since API errors need only the formatter), `respond.ts` (`apiError(code, { params, request })`), `doc.ts` (generates `docs/API_ERRORS.md`). `messages/en.json` holds the `errors.*` namespace. User-facing sentences never embed identifiers; those travel only in `params`. CI: registry ↔ catalog ↔ ICU arguments agree; the reference cannot drift; a free-text ratchet (baseline 102) that A4b takes to zero.

_Implementation (7A A4b):_ every PF API error is coded (A4b-1 guards/admin/process, A4b-2 moderation/approvals with result codes, A4b-3 auth). Services, stores and the auth provider return `errorCode` (+ `errorParams`) with their results; routes answer with `apiError`, `internalError` (500s: detail to the log with a request id, never to the client), `errorFromResult` or `authResultResponse` (auth: challenges stay 200, failures get real statuses — no more 200-on-failure). No status is chosen by matching English. The free-text check is now a hard rule (D5 b). The screen-literal ratchet (D5 e) is a CI test counting JSX text and user-visible attribute literals against a per-repository `screen-literal-baseline.json` (PF: 297), lowered as strings move to the catalog; 7B takes it to zero. 45 codes.

## 3. Sequencing

| Sprint            | Scope                                                                                                                                                                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7A (A4, TASK-109) | Catalog infrastructure; error registry; **every API error** in PF on `{ code, message, params }`; `docs/API_ERRORS.md` generated; D5 (a)–(d); D5 (e) ratchet baseline for screens. Playform's own routes move in the Playform commit that follows the v2.7.0 sync. Precedes B1, whose guest-limit code the app must act on. |
| 7B (TASK-110)     | Every screen string extracted in PF and Playform until the ratchet reaches zero; remaining platform reason strings. ADR-051 Accepted at close.                                                                                                                                                                              |

Sprint 7's remaining UI work (3d, TASK-093/094) lands under the ratchet, so it adds no literals.

## 4. Consequences

- Clients and agents act on codes, not wording; wording can change and be translated freely.
- One file to translate per locale; no strings hidden in components or routes.
- Every route and component touched once. The ratchet keeps the backlog from growing between 7A and 7B.
- `next-intl` becomes a platform dependency.
