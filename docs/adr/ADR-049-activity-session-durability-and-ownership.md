# ADR-049: Activity Session Durability & Ownership

Status: Accepted (Phase 5 Sprint 7). Decision maker: Raman Sud.
Related: ADR-028 (application framework — sessions, dispatch, AUX), ADR-031 (action identity, D6 repair on load), ADR-032 (globalThis singletons), ADR-048 (governed durability — D3 fail-closed stores), TASK-071 (loadSession), Sprint 7 milestone 3 (Playform adoption). `platform/app-framework/session.ts`, `platform/providers/registry.ts`.

---

## 1. Context

Sprint 7 milestone 3 moves Playform's translate experience onto the application framework as a **persisted, resumable activity session**: state lives server-side, every change is a dispatched action, and the browser resumes a session by id. Adopting it exposed two platform gaps that were harmless while sessions were ephemeral and are not once a consumer relies on them:

1. **Durability was opt-in and silent.** `APP_STATE_STORE` defaulted to in-memory, and `APP_STATE_STORE=supabase` with missing credentials **warned and fell back to memory** — in production too. A deployment could run with sessions silently lost on every restart. ADR-048 D3 had closed exactly this for the trajectory and budget stores and explicitly scoped the activity state store out.
2. **A session id was a credential.** `loadSession` reconstructed any session from its id; it never checked that the loading actor was a participant. Once a client holds a session id and a server resumes by it, any authenticated user presenting another user's id would load — and, via D6 repair, could even write to — that user's session.

## 2. Decisions

**D1 — Activity sessions are durable in production.** The ADR-048 D3 fail-closed guard extends to `APP_STATE_STORE`: in a production context an in-memory activity state store refuses to boot, and `APP_STATE_STORE=supabase` without credentials no longer falls back silently — it fails closed. The same explicit `E2E_IN_MEMORY_STORES=true` test-harness opt-out (v2.5.1) applies; a real deployment never sets it. Tests and local development keep the in-memory default.

**D2 — Only a participant may load a session.** `loadSession` rejects an actor whose `actorId` is not among the session's persisted participants with `SessionAccessDeniedError`. The check runs **before** D6 repair, so a non-participant cannot trigger a repair write. Participants are already persisted in session meta (migration 029), so no schema change is needed.

## 3. Consequences

- A production consumer adopting persisted sessions must set `APP_STATE_STORE=supabase` with Supabase credentials — a boot failure otherwise, by design.
- Consumers resume sessions by id without writing their own ownership check; the platform enforces it.
- `SessionAccessDeniedError` is a distinct type so routes can map it to 403/404 without string matching.
- Guard boot order: the activity state store initializes first, so on a fully in-memory production boot its error is the one reported.

## 4. Alternatives rejected

- **Ownership in the consumer's route.** Every consumer would re-implement it, and the D6 repair write happens inside `loadSession` — a route-level check after load is too late.
- **Unguessable ids as the protection.** Obscurity is not authorization; ids appear in URLs, logs and client storage.
