# ADR-054: The Foundation Core and Optional Product Modules

Status: Proposed (Phase 5 Sprint 7R entry gate, 2026-10-21). Decision maker: Raman Sud.
Related: ADR-001 (platform/game separation), ADR-007 (monorepo structure), ADR-019/020 (voice, song identification), ADR-021 (social), ADR-027 (conformance kits), TASK-127, TASK-136. `platform/**`, `prompts/**`, `supabase/migrations/**`, `eslint.config.mjs`.

---

## 1. Context

Every consumer inherits everything the platform contains, including features it may not use. A survey of the code in October 2026 found:

- **Product features live in the foundation:** social groups and their five agents, song identification, audio conversion, the voice pipeline, translation (two copies: `platform/translation` and the older `lib/translate.ts` / `lib/tts.ts` behind `/api/process` and the demo UI), and a games placeholder.
- **16 imports from core into those features in 6 files** (the provider registry, the prompt and eval indexes, feature availability, instrumentation, the home page), plus 6 in the test-kit manifest. No lint rule prevents more.
- **Core vocabulary names module features** as fixed values: agent goals (`identify-song`, `translate`, …), feature requirements, the song-identification rate rule, the age-consent and account-status feature lists, moderation content types, and migration seeds (`can_play`, `can_translate`, `can_create_group` in 002, 005 and 007; `coppa.blocked_features` in 012 and 014).
- **Migrations share one numbering**; 013 and 015 are module-only.
- **The guest allowance is named for translation** but is a general limit on guest usage.

## 2. Decisions

**D1 — The core.** Identity and roles, tenancy (ADR-053), errors and catalogs, governed configuration, rate limiting, agents and AI governance, content safety and moderation, consent and GDPR, observability, caching, realtime, the application and content frameworks, RAG, the action pipeline, effects and route policy. A consumer always takes the core.

**D2 — The modules.**

| Module          | Contents                                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `social`        | Groups, memberships, invites, the five social agents, their prompts and evals, the curator content type, migration 015                              |
| `voice`         | Text-to-speech, speech-to-text, the voice pipeline, chunker and voices                                                                              |
| `song-id`       | Song identification providers and types, migration 013, the `SONG_IDENTIFY` rule                                                                    |
| `audio-convert` | Audio format conversion (ffmpeg service, passthrough, mock)                                                                                         |
| `translation`   | Translation providers and language tables, `/api/process`, the demo UI; `lib/translate.ts` and `lib/tts.ts` are retired onto the module's providers |
| `games`         | Placeholder until a game exists                                                                                                                     |

**D3 — The core never imports a module.** `import/no-restricted-paths` (eslint-plugin-import, already installed; it resolves `@/` aliases, relative paths, `require` and dynamic `import()`) declares one zone per module: core paths may not import from it. Modules may import the core and, where declared, another module (`voice` → `translation` types). Until 7S moves them, `voice`, `song-id` and `audio-convert` share `platform/voice/`, so their zones are drawn by file pattern. A rule that sees only imports cannot catch a core file that defines module content without importing it — the five social agents in `platform/agents/agent-configs.ts` — so those move to their module's registration in 7R.

**D4 — Modules register themselves.** A module exports one `definePlatformModule({ id, providers, singletonKeys, agents, prompts, evals, contentTypes, features, goals, rateRules, consentFeatures, moderationContentTypes, healthProbes, kits })`. The core's registries — providers, agents, prompts and evals, content types, feature requirements, agent goals, rate rules, consent and account-status feature lists, moderation content types, health probes and the conformance manifest — become lists that modules add to at boot, instead of fixed values naming them. An app lists its modules once (`platform/modules/app-modules.ts`, a consumer seam shipped with the platform's modules).

**D5 — Each module owns its migrations.** A module's migrations are named `NNN_<module>_<name>.sql` and listed in the module manifest; core migrations never seed module data. Seeds in core migrations that name module features (002, 005, 007, 012, 014) are superseded by module migrations that add them. The migration replay applies the core, then each selected module's migrations.

**D6 — Sync is core plus opted-in modules.** The platform ships a manifest (`platform/modules/manifest.json`) mapping each module to its paths: code, prompts and evals, tests and kit, migrations, routes and components. A consumer's sync config gains `"modules": [...]`; the sync copies the core plus those modules. Removing a module from a consumer is manual (the sync never deletes) and is described in SETUP_AND_INTEGRATION.

**D7 — The guest allowance becomes a core guest-usage limit.** Renamed from translation to usage (`guest.usage_allowance`), with the per-feature cost supplied by the feature that consumes it. The old key is migrated, not dropped.

## 3. Delivery

- **Sprint 7R:** the module registration hook and the extensible registries; the 16 production and 6 test-manifest violations removed, and the social agent definitions moved out of `agent-configs.ts`; the lint rule on; the module manifest; migration naming for new module migrations.
- **Sprint 7S:** modules moved out of the core directories, existing migration seeds superseded, `lib/translate.ts` and `lib/tts.ts` retired, the guest-usage rename, the sync's `modules` selection, and Playform opting into the modules it uses.

## 4. Consequences

- A consumer that uses no product module inherits and tests only the core.
- Adding a product feature means adding a module, never editing a core list.
- Playform opts into `translation`, `voice`, `song-id`, `audio-convert` and `social`.
