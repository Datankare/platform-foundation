/**
 * platform/modules/types.ts — The shape of an optional product module (ADR-054 D4)
 *
 * A module is everything one product feature adds to the core: its provider slots, agents,
 * prompts and evals, content types, feature requirements, workflow goals, rate rules, the
 * consent, account-status and moderation vocabulary it names, and its health probes. The core
 * never names any of these; it keeps one list per kind and the modules an app registers at boot
 * (platform/modules/registry.ts) add to it. Adding a product feature means adding a module, never
 * editing a core list (ADR-054 §4).
 *
 * A module is declared with definePlatformModule (./define.ts), which validates and freezes it.
 * Its files — code, prompts, tests, kits, migrations, routes, components — are listed in
 * platform/modules/manifest.json, which the lint boundary and (Sprint 7S) the consumer sync read.
 *
 * Type-only imports: this file is a leaf, so the core registries that read modules can import it
 * without a cycle.
 *
 * @module platform/modules
 */

import type { AgentConfig } from "@/platform/agents/types";
import type { AnyContentType } from "@/platform/content/types";
import type { HealthProbe } from "@/platform/observability/types";
import type { RateLimitRule } from "@/platform/rate-limit/types";
import type { EnvSource } from "@/platform/providers/environment-contract";
import type { PromptConfig } from "@/prompts/types";
import type { EvalSuite } from "@/prompts/evals/types";

/** A module id: lower-case words joined by hyphens, e.g. "song-id". */
export type ModuleId = string;

/**
 * What the provider registry hands a module slot's init. The module logs through `warn` rather
 * than its own logger, so the record carries the registry's route and a test that replaces the
 * registry's logger sees the module's warnings too.
 */
export interface ProviderSlotContext {
  /** The settings the selection was read from. */
  readonly env: EnvSource;
  /** Log a configuration warning (a selection that will fail at first use, for instance). */
  readonly warn: (message: string) => void;
}

/**
 * A durable store slot (ADR-048 D3, ADR-053 D4): a durable selection without DATABASE_URL is
 * refused, never a fall back to memory, and production refuses any other selection unless a
 * local or CI harness opts out (E2E_IN_MEMORY_STORES). The environment contract adds the slot's
 * selector to the settings that require DATABASE_URL.
 */
export interface DurableSlot {
  /** The selections that are the durable store, e.g. ["postgres", "supabase"]. */
  readonly selections: readonly string[];
  /** What production would lose on memory, for the refusal: "groups and memberships". */
  readonly noun: string;
  /** What a durable selection without a database must not become: "an in-memory social store". */
  readonly fallback: string;
}

/**
 * One provider slot a module adds to the registry (platform/providers/registry.ts). Declared the
 * way the core declares its slots: a selector setting, the accepted selections, the default when
 * unset, what init installs and which singletons it writes, and whether production requires a
 * durable store.
 */
export interface ModuleProviderSlot {
  /** The slot's key in ProviderSelections and the conformance manifest, e.g. "socialStore". */
  readonly slot: string;
  /** The selector setting, e.g. "SOCIAL_STORE". */
  readonly envVar: string;
  /** The selections the slot implements; another value is logged and treated as given. */
  readonly values: readonly string[];
  /** The selection when the setting is unset. */
  readonly defaultValue: string;
  /** Present for a durable store: see DurableSlot. */
  readonly durable?: DurableSlot;
  /** Every singleton init writes, so resetProviders() clears it (ADR-032). */
  readonly singletonKeys: readonly string[];
  /** Install the slot's provider for `selection`. Synchronous, like the core's slots. */
  readonly init: (selection: string, context: ProviderSlotContext) => void;
}

/** Whether an optional feature can be offered (ADR-050 D3). Only booleans leave the server. */
export interface FeatureStatus {
  readonly available: boolean;
  /** Offered, but showing sample data — the UI labels it. */
  readonly preview?: boolean;
}

/** An optional feature and what it needs (platform/features, GET /api/features). */
export interface FeatureRequirement {
  /** The feature id, e.g. "music_identification". */
  readonly id: string;
  /** The settings it needs, in words, for operators. */
  readonly needs: string;
  /** Computed from the same settings the providers read. */
  readonly check: (env: EnvSource) => FeatureStatus;
}

/**
 * A content type the moderation pipeline screens (platform/moderation). Unknown types are
 * treated as generation, so a type is registered by the module that produces that content.
 */
export interface ModerationContentTypeDefinition {
  /** The ScreeningContext.contentType value, e.g. "translation". */
  readonly name: string;
  /**
   * The user is processing existing content rather than creating it, so severity may be reduced
   * by the governed `moderation.<name>_severity_reduction` setting (fail-closed to none).
   */
  readonly severityReduction: boolean;
}

/** A health probe a module adds to /api/health, built after the providers are installed. */
export interface ModuleHealthProbe {
  /** The probe's name; unique across the app (HealthRegistry refuses duplicates). */
  readonly name: string;
  /** Build the probe around the live provider (called once, at boot, after initProviders). */
  readonly create: () => HealthProbe;
}

/** What a module declares. Every list is optional; definePlatformModule fills in []. */
export interface PlatformModuleInput {
  readonly id: ModuleId;
  /** Modules this one imports. Declared, minimal; the lint boundary allows exactly these. */
  readonly dependsOn?: readonly ModuleId[];
  readonly providers?: readonly ModuleProviderSlot[];
  /** Agents registered at boot with the core's (registerPlatformAgents). */
  readonly agents?: readonly AgentConfig[];
  /** Prompt configs added to the prompt registry, keyed by name (ADR-015). */
  readonly prompts?: readonly PromptConfig[];
  /** Eval suites for this module's prompts (ADR-038). */
  readonly evals?: readonly EvalSuite<unknown>[];
  /** Content types registered at boot (ADR-037). */
  readonly contentTypes?: readonly AnyContentType[];
  readonly features?: readonly FeatureRequirement[];
  /** Workflow goals this module implements (AgentGoal); registerWorkflow refuses others. */
  readonly goals?: readonly string[];
  /** Rate limit rules this module's routes enforce. */
  readonly rateRules?: readonly RateLimitRule[];
  /** Features COPPA-enforced users are refused when the governed list cannot be read. */
  readonly consentFeatures?: readonly string[];
  /** Features restricted accounts are refused when the governed list cannot be read. */
  readonly accountStatusFeatures?: readonly string[];
  readonly moderationContentTypes?: readonly ModerationContentTypeDefinition[];
  readonly healthProbes?: readonly ModuleHealthProbe[];
  /**
   * The module's conformance kits, by path. Metadata only: production code never imports a test,
   * so the kits are composed by the conformance-coverage test from manifest.json.
   */
  readonly kits?: readonly string[];
}

/** A validated, frozen module: every list present. */
export interface PlatformModule {
  readonly id: ModuleId;
  readonly dependsOn: readonly ModuleId[];
  readonly providers: readonly ModuleProviderSlot[];
  readonly agents: readonly AgentConfig[];
  readonly prompts: readonly PromptConfig[];
  readonly evals: readonly EvalSuite<unknown>[];
  readonly contentTypes: readonly AnyContentType[];
  readonly features: readonly FeatureRequirement[];
  readonly goals: readonly string[];
  readonly rateRules: readonly RateLimitRule[];
  readonly consentFeatures: readonly string[];
  readonly accountStatusFeatures: readonly string[];
  readonly moderationContentTypes: readonly ModerationContentTypeDefinition[];
  readonly healthProbes: readonly ModuleHealthProbe[];
  readonly kits: readonly string[];
}

/** A contribution with the module that made it, so a collision names its source. */
export interface Contributed<T> {
  readonly moduleId: ModuleId;
  readonly value: T;
}
