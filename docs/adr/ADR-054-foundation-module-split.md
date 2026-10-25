# ADR-054: The Foundation Core and Optional Product Modules

Status: Accepted (2026-10-24, Sprint 7R close, platform-foundation v6.0.0). Proposed at the Sprint 7R entry gate (2026-10-21); implementation in §5. Decision maker: Raman Sud.
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

- **Sprint 7R — delivered (R4, 2026-10-24; R7):** the module registration hook and the extensible registries; the 16 production and 6 test-manifest violations removed, and the social agent definitions moved out of `agent-configs.ts`; the lint rule on; the module manifest; migration naming for new module migrations; and at the close (R7) the app's own manifest and app migration naming (§5, "The app's manifest").
- **Sprint 7S:** modules moved out of the core directories, existing migration seeds superseded, `lib/translate.ts` and `lib/tts.ts` retired, the guest-usage rename, the sync's `modules` selection, and Playform opting into the modules it uses.

## 4. Consequences

- A consumer that uses no product module inherits and tests only the core.
- Adding a product feature means adding a module, never editing a core list.
- Playform opts into `translation`, `voice`, `song-id`, `audio-convert` and `social`.

## 5. Implementation (7R R4)

Delivered on `develop` (2026-10-24). What 7S still does is listed at the end.

**Registration (D4).** `platform/modules/`: `types.ts` (`PlatformModule`), `define.ts`
(`definePlatformModule` validates and freezes: id shape; nothing declared twice; a slot's default
among its selections and never durable; a durable slot names its durable selections, what is lost
and what it must not fall back to; an eval suite only for the module's own prompts; positive whole
rate limits; kits by path under `__tests__/`), `registry.ts` (`registerModules` once at boot,
globalThis-anchored; refuses a duplicate id, a missing or cyclic dependency, and two modules
contributing the same slot, setting, singleton key, agent, prompt, content type, feature, goal,
rule, moderation kind or probe; idempotent for the same set — compared by declaration
fingerprint, so a bundle-duplicated copy is the same set — and refuses a different set),
`compose.ts` (a core list then each module's entries in registration order, refusing a name the
core or an earlier module has, cached per registered set), `contributions.ts` (boot:
`assertModuleContributions`, `registerModuleContentTypes`, `createModuleHealthProbes`). The app's
list is `app-modules.ts`, a consumer seam; `instrumentation.ts` registers it before
`initProviders()`, and `jest.setup.ts` registers it the same way, loading the modules in an isolated
module registry so a suite's own mocks still reach the copies it imports.

**The extensible registries.** Each is the core's list plus the registered modules':

| Registry                           | Core keeps                                                          | Moved to modules                                                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider slots                     | 17 slots (`CoreProviderSelections`, `CORE_PROVIDER_SINGLETON_KEYS`) | `translation`, `tts`, `stt`, `songId`, `audioConverter`, `socialStore` (durable) as `ModuleProviderSlot`s; same settings, same refusals; `providerSingletonKeys()`; the contract's `databaseSelectors()` adds durable module selectors |
| Agents                             | 7 (`AGENT_CONFIGS`, Guardian's `guardian-social` included)          | the five social agents (`platform/social/agent-configs.ts`)                                                                                                                                                                            |
| Prompts, evals                     | 7 prompts, 4 suites (`CORE_EVAL_SUITES`)                            | the five social prompts and suites; `listEvalSuites()` replaces `EVAL_SUITES`                                                                                                                                                          |
| Content types                      | none                                                                | curator (registered at boot; `registerSocialContentTypes` removed)                                                                                                                                                                     |
| Features                           | `sso_*` (`CORE_FEATURE_REQUIREMENTS`)                               | `music_identification` (song-id), `audio_upload`, `speech_input` (voice), `teams` (social); `listFeatureRequirements()` replaces `FEATURE_REQUIREMENTS`; an undeclared feature is not offered                                          |
| Goals (`AgentGoal`, open string)   | `analyze`                                                           | `translate`; `transcribe`, `speak`, `translate-and-speak`, `full-pipeline`; `identify-song` — `registerWorkflow` refuses an undeclared goal                                                                                            |
| Rate rules                         | `DEFAULT_RULES` (7)                                                 | `SONG_IDENTIFY_RULE` (song-id); `listRateRules()` / `getRateRule()`                                                                                                                                                                    |
| Consent / account-status fallbacks | `generate`, `upload_file` (+ `update_profile`)                      | `translate`, `transcribe`, `identify_song`                                                                                                                                                                                             |
| Moderation content kinds           | `generation`, `extraction`, `profile`, `ai-output`                  | `translation`, `transcription` (both with severity reduction), `social`                                                                                                                                                                |
| Health probes                      | —                                                                   | `song-identification` (cached 15 min); instrumentation no longer imports a module                                                                                                                                                      |
| Conformance manifest               | the core kits (`__tests__/contract/manifest.ts`)                    | one kit manifest per module (`__tests__/contract/modules/<id>.ts`), composed by the coverage test from `manifest.json`                                                                                                                 |

**Judged core, and why.** `guardian-social`: Guardian runs every screening of every content kind
under it (`platform/moderation/guardian.ts`); moving it would leave a core-only app unable to
screen, and the id is in trajectories, budgets and audit records — kept, documented. The curator
reference knowledge base (`platform/rag/bootstrap.ts`): a shared-isolation, boundary-free KB that
nothing in the social module reads — the RAG framework's live reference, named for the example.
`analyze`: a generic analysis goal no module implements. `extraction` and `profile`: core uploads
and profiles. `lib/safety.ts` and `types/index.ts`'s `SafetyResult`: the stream route uses them.
`lib/inputValidation.ts` serves only the demo UI and is listed as the translation module's.

**Voice split.** `platform/voice/index.ts` is voice only; `song-id.ts` and `audio-convert.ts` are
the other two modules' entries. The song-ID provider singleton moved to `song-id-provider.ts` (same
key), its probe to `song-id-health.ts`, the converter probe to `audio-convert-health.ts`, and the
converter readiness both features need to `audio-converter-readiness.ts`. The shared probe logic is
the core's `platform/observability/provider-health.ts`. Declared dependencies: `voice` →
`translation` (the pipeline's provider type), `audio-convert` (audio upload needs a converter);
`song-id` → `audio-convert` (a clip is converted before it is identified).

**The boundary (D3).** `platform/modules/manifest.json` lists each module's code, prompts, evals,
routes, components, tests, kits, kit manifest and migrations, the composition roots and the shared
directory (`platform/voice`). `scripts/module-manifest.cjs` is its only reader; `eslint.config.mjs`
generates one `import/no-restricted-paths` zone per module from it: the core may import no module
code, test or kit; a module may import itself and its dependencies; `app-modules.ts` and the home
seam `app-home.tsx` (`app/HomeClient.tsx` renders it; PF's shows the translation demo) are exempt.
`__tests__/module-lint.test.ts` lints fixtures through ESLint's API (aliases, relative, type-only,
`export … from`, `require`, dynamic `import()`); `__tests__/module-boundary.test.ts` walks every
import in the tree (with `jest.mock` / `requireActual`) and requires zero crossings in production
and tests; `__tests__/module-manifest.test.ts` requires the manifest to be true both ways (every
listed path exists; every file in a module directory listed by exactly one module) and to agree
with the definitions and the lint configuration. Core tests that tested a module are listed as
that module's; `__tests__/helpers/moderation-isolation-fixtures.ts` lost its social half to
`social-isolation-fixtures.ts`. `npm run test:core` (a CI step) runs every core test with no module
registered (`PF_TEST_MODULES=none`, `jest.core.config.cjs`); core tests whose fixtures used a
module's goals or content kinds declare them in a fixture module, and core tests that used a
module's feature names use the core's (`generate`).

**Migrations (D5).** New module migrations are `NNN_<module>_<name>.sql` (the id as written) and
listed in the module's entry; a migration whose name names a module must be that module's
(`__tests__/module-migrations.test.ts`). `scripts/migration-replay.sh` takes its order from
`module-manifest.cjs --replay-order`: core migrations in name order, then each selected module's
(`REPLAY_MODULES`, default all) in dependency order. 013 and 015 predate the convention and keep
their names (renaming an applied migration would re-run it).

**Behaviour changes.** None for PF's app with its modules registered, except: the environment
contract lists module durable selectors after the core's in its `DATABASE_URL is required (…)`
message; `GET /api/features` lists the core's features first (same keys and values); a module slot
selection outside its declared values is logged (still passed on); `isFeatureAvailable` /
`requireFeature` answer "not available" for an undeclared feature instead of throwing.

**The app's manifest (R7, TASK-157, TASK-158).** `platform/modules/manifest.json` is the platform's and is synced unchanged; a consumer could not list its own files that belong to a module (Playform rewrote the platform's manifest after every sync) or declare a module of its own, and the platform's tests counted six modules. `platform/modules/app-manifest.json` is a consumer seam (sync-excluded; the platform ships it empty) that `scripts/module-manifest.cjs` merges with the platform's for every reader: an app adds paths to a platform module, or declares a module with its definition, entry, dependencies, path lists and migrations. The merge refuses a path claimed by two modules or by a module and a composition root, an app redefining a platform module's `dependsOn`, `definition`, `entry` or `kitManifest`, an unknown list, an unknown dependency and a cycle, each message naming the file and what to change. The manifest, lint and migration tests derive the module ids from the merge. Migrations: the platform's are `NNN_<name>.sql`, listed in `supabase/platform-migrations.json`; an app's are `NNN<letter>_<app>_<name>.sql` (`052a_playform_…`), sorting after the platform's `NNN` and before `NNN+1`, and an app module's name the module next. The replay checks the names before it applies anything; a bare-numbered app migration is refused unless the app applied it before the convention and lists it (`migrationsBeforeTheConvention`).

**Left for 7S, by decision (§3).** Moving the modules out of the core directories; superseding the
core migrations that seed or alter module data — 002, 005, 007 (`can_play`, `can_translate`,
`can_create_group`), 010/012/014 (`coppa.blocked_features`, `account_status.restricted_features`,
the translation and transcription severity-reduction settings), 037 (`guest.translate_allowance`,
renamed by D7) and 049 (tenancy columns and policies on `groups`, `group_memberships`,
`group_invites`), while the baseline (through 037) still creates module tables; retiring
`lib/translate.ts` and `lib/tts.ts` (and with them `types/index.ts`'s demo types); the guest-usage
rename (the `allowance_exhausted` message names translations); the sync's `modules` selection.
