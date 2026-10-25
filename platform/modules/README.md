# platform/modules — The core and the optional product modules (ADR-054)

The core (identity, tenancy, errors, configuration, rate limiting, agents and AI governance,
content safety, consent, observability, caching, realtime, the application and content
frameworks, RAG, the action pipeline) is what every app takes. A **product module** — `social`,
`voice`, `song-id`, `audio-convert`, `translation`, `games` — is a feature an app opts into. The
core never imports a module and never names one: each core registry is the core's own list plus
what the registered modules add to it.

## Files

| File                | What it is                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `types.ts`          | `PlatformModule` — what a module may declare                                                                            |
| `define.ts`         | `definePlatformModule` — validates and freezes a declaration                                                            |
| `registry.ts`       | `registerModules` (once, at boot), `getModules`, `isModuleEnabled`, `getModule`; `resetModuleRegistry` (tests)          |
| `compose.ts`        | How a core registry adds the modules' entries to its own, refusing a name already taken                                 |
| `contributions.ts`  | What boot does with the modules: `assertModuleContributions`, `registerModuleContentTypes`, `createModuleHealthProbes`  |
| `app-modules.ts`    | **Consumer seam** — the app's list of modules                                                                           |
| `app-home.tsx`      | **Consumer seam** — what the app's home page shows (PF: the translation demo)                                           |
| `manifest.json`     | Where each module's files are: code, prompts, evals, routes, components, tests, kits, migrations                        |
| `app-manifest.json` | **Consumer seam** — the app's own: paths it adds to a platform module, its own modules, its migration prefix (TASK-157) |

`scripts/module-manifest.cjs` is the one reader of `manifest.json` (the lint boundary, the boundary
and manifest tests, the conformance composition and the migration replay all use it). It merges
the app's `app-manifest.json` in, and refuses a path claimed twice, a platform module's
dependencies redefined, an unknown dependency or a cycle ([SETUP_AND_INTEGRATION](../../docs/SETUP_AND_INTEGRATION.md) §6).

## Writing a module

A module is one `definePlatformModule` call in a definition file inside the module
(`platform/social/module.ts`). Everything it declares is optional:

```typescript
import { definePlatformModule, moduleContentType } from "@/platform/modules/define";

export const SOCIAL_MODULE = definePlatformModule({
  id: "social", // lower-case words joined by hyphens
  dependsOn: [], // the modules it imports — minimal; the lint rule allows exactly these
  providers: [
    {
      slot: "socialStore", // its key in getActiveProviders() and the conformance manifest
      envVar: "SOCIAL_STORE",
      values: ["postgres", "supabase", "memory"],
      defaultValue: "memory",
      durable: {
        selections: ["postgres", "supabase"],
        noun: "groups and memberships",
        fallback: "an in-memory social store",
      },
      singletonKeys: [SOCIAL_STORE_KEY], // what resetProviders() must clear
      init: (selection, { env, warn }) => setSocialStore(/* … */),
    },
  ],
  agents: SOCIAL_AGENT_CONFIGS, // registered with the core's by registerPlatformAgents()
  prompts: [CURATOR_V1 /* … */], // join listPrompts() / getPromptConfig()
  evals: [defineSuite(CURATOR_EVAL) /* … */], // only for the module's own prompts
  contentTypes: [moduleContentType(CURATOR_CONTENT_TYPE)], // registered at boot (ADR-037)
  features: [
    { id: "teams", needs: "…", check: (env) => ({ available: true, preview: true }) },
  ],
  goals: [], // workflow goals it implements (AgentGoal)
  rateRules: [], // the rules its routes enforce (song-id: SONG_IDENTIFY_RULE)
  consentFeatures: [], // refused to COPPA-enforced users when the governed list is unreadable
  accountStatusFeatures: [], // refused to restricted accounts when the governed list is unreadable
  moderationContentTypes: [{ name: "social", severityReduction: false }],
  healthProbes: [], // { name, create } — built after initProviders, around the live provider
  kits: ["__tests__/contract/social-store-contract.ts"], // by path; production never imports a test
});
```

`definePlatformModule` refuses a malformed declaration where it is written (a bad id, anything
declared twice, a default that is not one of the slot's selections, a durable default, an eval
suite for another module's prompt, a non-positive rate rule…) and freezes the result.

What each declaration does at boot:

| Declaration              | Joins                                                          | Held to                                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers`              | `initProviders()` / `getActiveProviders()`, after the core's   | The core's rules: durable selection without `DATABASE_URL` refused; memory refused in production; the environment contract requires `DATABASE_URL` for a durable selector; `resetProviders()` clears `singletonKeys` |
| `agents`                 | `registerPlatformAgents()`                                     | No core or other module's id                                                                                                                                                                                         |
| `prompts`, `evals`       | `listPrompts()`, `getPromptConfig()`, `listEvalSuites()`       | No core prompt name; the eval meta-test covers module suites like core ones                                                                                                                                          |
| `contentTypes`           | the content registry (`registerModuleContentTypes`)            | Host agent must be declared; never replaces another's                                                                                                                                                                |
| `features`               | `featureAvailability()` (GET /api/features), `requireFeature`  | No core feature id; an undeclared feature is not offered                                                                                                                                                             |
| `goals`                  | `listAgentGoals()`; `registerWorkflow` refuses others          | No core goal                                                                                                                                                                                                         |
| `rateRules`              | `listRateRules()`, `getRateRule(id)`                           | No core rule id                                                                                                                                                                                                      |
| `consentFeatures`        | `consentFeatureFallback()` (COPPA gate)                        | A union — modules may name the same feature                                                                                                                                                                          |
| `accountStatusFeatures`  | `restrictedFeatureFallback()` (account-status guard)           | A union                                                                                                                                                                                                              |
| `moderationContentTypes` | `listModerationContentTypes()`; severity reduction if declared | No core kind; an undeclared kind is screened as `generation`                                                                                                                                                         |
| `healthProbes`           | `/api/health` (instrumentation: `createModuleHealthProbes`)    | Unique names                                                                                                                                                                                                         |

Between modules, `registerModules` refuses two modules contributing the same slot, setting,
singleton key, agent, prompt, content type, feature, goal, rule, moderation kind or probe; against
the core, `initProviders()` refuses it (`assertModuleContributions`) — both errors name the owners.

Then list the module's files in `manifest.json` (its `definition`, `entry`, every code, prompt,
eval, route and component path, its tests outside its directories, its kits and kit manifest, and
its migrations), and its kit manifest in `__tests__/contract/modules/<id>.ts`. The manifest test
fails if a file in a module directory is unlisted, a listed path is missing, or the manifest and
the definition disagree.

### The boundary

`import/no-restricted-paths` (`eslint.config.mjs`, zones generated from `manifest.json`):

- the core may import no module file, test or kit;
- a module may import the core, itself and the modules in its `dependsOn`;
- the composition roots `app-modules.ts` and `app-home.tsx` are exempt — composing the app from
  its modules is their purpose, and both are consumer seams.

It sees `@/` aliases, relative paths, `export … from`, `require()` and dynamic `import()`
(`__tests__/module-lint.test.ts`); `__tests__/module-boundary.test.ts` checks the whole tree the same
way, `jest.mock` included. A core test that tests a module is that module's test: list it under
the module's `tests`.

### Migrations

A module's migration is `NNN_<module>_<name>.sql` (the id as written: `050_song-id_lyrics.sql`),
listed in the module's `migrations`. A fresh replay (`scripts/migration-replay.sh`) applies the
core's migrations, then each selected module's in dependency order (`REPLAY_MODULES`, default all).
Core migrations never seed module data. `013_song_id_config.sql` and `015_social_data_model.sql`
predate the convention and keep their names.

## Listing an app's modules

`app-modules.ts` is the app's list — registered by `instrumentation.ts` before the providers, and by
the test setup the same way:

```typescript
export const APP_MODULES: readonly PlatformModule[] = [
  TRANSLATION_MODULE,
  AUDIO_CONVERT_MODULE, // a module follows the modules it depends on
  VOICE_MODULE,
  SONG_ID_MODULE,
  SOCIAL_MODULE,
  GAMES_MODULE,
];
```

An app that uses no module lists none: `APP_MODULES = []`, and the core runs alone
(`platform/modules/__tests__/no-modules.test.ts`). `npm run test:core` (CI runs it) runs every core
test that way — jest.setup registers nothing (`PF_TEST_MODULES=none`) and the modules' tests are
left out (`jest.core.config.cjs`, from the manifest). A core test whose fixtures use a module's
vocabulary declares it in a fixture module (`withModules` in `__tests__/helpers/modules.ts`). `app-home.tsx` renders the app's home inside the
signed-in shell (`app/HomeClient.tsx`). Both files — and `__tests__/app-modules.test.ts` here, which
tests PF's own list — are the consumer's: the sync excludes them
([SETUP_AND_INTEGRATION.md](../../docs/SETUP_AND_INTEGRATION.md) §6).

## Tests

| Test                                               | Proves                                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `platform/modules/__tests__/define.test.ts`        | Every refusal of `definePlatformModule`; completeness and freezing                                             |
| `platform/modules/__tests__/registry.test.ts`      | Registration: order, idempotence (copies included), a different set refused, every shared contribution refused |
| `platform/modules/__tests__/compose.test.ts`       | Core-then-modules composition, collisions named, cached per set                                                |
| `platform/modules/__tests__/contributions.test.ts` | Boot refuses core collisions of every kind; content types; health probes                                       |
| `platform/modules/__tests__/no-modules.test.ts`    | An app with no modules boots and the core works                                                                |
| `platform/modules/__tests__/app-modules.test.ts`   | PF's app presents what it did before the split                                                                 |
| `__tests__/provider-registry-modules.test.ts`      | Module slots are selected, refused, reset and contract-checked like core slots                                 |
| `__tests__/modules/*.module.test.ts`               | Each module's contributions, run with only its dependencies                                                    |
| `__tests__/module-manifest.test.ts`                | The manifest is true both ways and agrees with the definitions and the lint config                             |
| `__tests__/module-lint.test.ts`                    | The lint rule refuses every import form, allows what is declared                                               |
| `__tests__/module-boundary.test.ts`                | Zero boundary crossings in the tree, production and tests                                                      |
| `__tests__/module-migrations.test.ts`              | Migration naming and the replay order                                                                          |
| `npm run test:core`                                | Every core test passes with no module registered                                                               |
