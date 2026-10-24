/**
 * platform/providers/registry.ts — Central provider registry
 *
 * Single entry point for initializing all platform providers.
 * Reads provider selection from environment variables.
 * Falls back to mock/memory/noop when env vars are absent.
 *
 * Synchronous — safe to call without await.
 *
 * GenAI Principles:
 *   P1  — All AI through orchestration (provider registered here)
 *   P6  — Resilient: every slot has a working fallback
 *   P7  — Provider-aware: realtime abstraction (Sprint 5)
 *   P9  — Observable: provider selections logged at startup
 *   P10 — No late discovery: the core's slots defined here, a module's in its definition
 *
 * Environment variables (all optional — omit for mock/fallback):
 *   AUTH_PROVIDER      = "cognito" | "mock"      (default: "mock"; "mock" refused in production — ADR-050 D1)
 *   CACHE_PROVIDER     = "upstash" | "memory"    (default outside production: "memory";
 *                                                   required in production — TASK-139)
 *   AI_PROVIDER        = "anthropic" | "mock"    (default: "mock")
 *   ERROR_REPORTER     = "sentry" | "noop"       (default: "noop")
 *   REALTIME_PROVIDER  = "supabase" | "mock"     (default: "mock")
 *   EMBEDDING_PROVIDER     = "openai" | "mock"      (default: "mock")
 *
 * Durable stores — "postgres" (or "supabase", the same store) | "memory" (default: "memory";
 * memory is refused in production unless a local/CI harness opts out, ADR-048 D3, ADR-053 D4):
 *   MODERATION_STORE, STRIKE_STORE, REVIEW_QUEUE_STORE, APP_STATE_STORE,
 *   TRAJECTORY_STORE, BUDGET_STORE, PROPOSAL_STORE, EFFECT_LEDGER, APPROVAL_POLICY_STORE,
 *   GUEST_USAGE_STORE, RATE_LIMIT_STORE (also "upstash", ADR-052)
 *   TENANT_DIRECTORY_STORE = "postgres" | "memory" (shared tenancy requires postgres, ADR-053 D7)
 *
 * Module slots (ADR-054 D4): a registered module declares its own slots — translation:
 * TRANSLATION_PROVIDER; voice: TTS_PROVIDER, STT_PROVIDER; song-id: SONG_ID_PROVIDER; audio-convert:
 * AUDIO_CONVERTER; social: SOCIAL_STORE (durable) — in its definition (ModuleProviderSlot). They
 * are selected, refused and reset exactly as the core's slots are, after the core's, in
 * registration order; the registry names no module.
 *
 * Settings shared by several slots (the database URLs, Cognito ids) are read through the
 * environment contract resolvers, and in production the whole contract is checked before any
 * slot initializes (ADR-050 D1/D2 — see ./environment-contract.ts).
 *
 * @module platform/providers
 */

import { registerAuthProvider, hasAuthProvider } from "@/platform/auth/config";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";
import { createCognitoAuthProvider } from "@/platform/auth/cognito-provider";
import { resetCache } from "@/platform/cache";
import { PostgresModerationStore, setModerationStore } from "@/platform/moderation/store";
import { PostgresStrikeStore, setStrikeStore } from "@/platform/moderation/strikes";
import {
  PostgresReviewQueueStore,
  setReviewQueueStore,
} from "@/platform/moderation/review-store";
import { logger } from "@/lib/logger";
import {
  createRateLimiter,
  peekRateLimiter,
  RATE_LIMITER_NAMES,
  setRateLimiter,
} from "@/platform/rate-limit/factory";
import { setEmbeddingProvider, createMockEmbeddingProvider } from "@/platform/rag";
import { setTrajectoryStore } from "@/platform/agents/trajectory-store";
import { PostgresTrajectoryStore } from "@/platform/agents/postgres-trajectory-store";
import { BudgetTracker, setBudgetTracker } from "@/platform/agents/budget-tracker";
import { PostgresBudgetStore } from "@/platform/agents/postgres-budget-store";
import { hasDatabase } from "@/platform/data";
import {
  CachedTenantDirectory,
  InMemoryTenantDirectory,
  setTenantDirectory,
} from "@/platform/tenancy/directory";
import { PostgresTenantDirectory } from "@/platform/tenancy/postgres-directory";
import { setProposalStore } from "@/platform/agents/proposal-store";
import { setApprovalPolicyStore } from "@/platform/agents/approval-policy-store";
import { PostgresApprovalPolicyStore } from "@/platform/agents/postgres-approval-policy-store";
import { PostgresProposalStore } from "@/platform/agents/postgres-proposal-store";
import { setEffectLedger } from "@/platform/agents/effect-ledger";
import { PostgresEffectLedger } from "@/platform/agents/postgres-effect-ledger";
import { registerPlatformAgents } from "@/platform/agents/agent-configs";
import { registerAdaptiveReference } from "@/platform/adaptive/bootstrap";
import { registerRagReference } from "@/platform/rag/bootstrap";
import {
  setActivityStateStore,
  PostgresActivityStateStore,
} from "@/platform/app-framework";
import { getSingleton, resetSingleton, setSingleton } from "@/platform/kernel/singleton";
import {
  allowsHarnessSwitches,
  assertEnvironmentContract,
  getAuthProviderSetting,
  getCacheProviderSetting,
  getCognitoSettings,
  getSupabaseUrl,
  getRateLimitStoreSetting,
  getTenantDirectoryStoreSetting,
} from "@/platform/providers/environment-contract";
import {
  PostgresGuestUsageStore,
  setGuestUsageStore,
} from "@/platform/auth/guest-allowance";
import { composeWithModules } from "@/platform/modules/compose";
import { getModules } from "@/platform/modules/registry";
import {
  assertModuleContributions,
  registerModuleContentTypes,
} from "@/platform/modules/contributions";
import type { Contributed, ModuleProviderSlot } from "@/platform/modules/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthProviderType = "cognito" | "mock";
export type CacheProviderType = "upstash" | "memory";
export type AIProviderType = "anthropic" | "mock";
export type ErrorReporterType = "sentry" | "noop";
export type RealtimeProviderType = "supabase" | "mock";
export type ModerationStoreType = "postgres" | "supabase" | "memory";
export type StrikeStoreType = "postgres" | "supabase" | "memory";
export type ReviewQueueStoreType = "postgres" | "supabase" | "memory";
export type EmbeddingProviderType = "openai" | "mock";
export type AppStateStoreType = "postgres" | "supabase" | "memory";
export type TrajectoryStoreType = "postgres" | "supabase" | "memory";
export type BudgetStoreType = "postgres" | "supabase" | "memory";
export type ProposalStoreType = "postgres" | "supabase" | "memory";
export type EffectLedgerType = "postgres" | "supabase" | "memory";
export type ApprovalPolicyStoreType = "postgres" | "supabase" | "memory";
export type GuestUsageStoreType = "postgres" | "supabase" | "memory";
export type RateLimiterStoreType = "postgres" | "supabase" | "upstash" | "memory";

/** The core's slots. */
export interface CoreProviderSelections {
  auth: AuthProviderType;
  cache: CacheProviderType;
  ai: AIProviderType;
  errorReporter: ErrorReporterType;
  realtime: RealtimeProviderType;
  moderationStore: ModerationStoreType;
  strikeStore: StrikeStoreType;
  reviewQueueStore: ReviewQueueStoreType;
  embeddingProvider: EmbeddingProviderType;
  appStateStore: AppStateStoreType;
  trajectoryStore: TrajectoryStoreType;
  budgetStore: BudgetStoreType;
  proposalStore: ProposalStoreType;
  effectLedger: EffectLedgerType;
  approvalPolicyStore: ApprovalPolicyStoreType;
  guestUsageStore: GuestUsageStoreType;
  rateLimiter: RateLimiterStoreType;
}

/**
 * Every slot's selection: the core's, then each registered module's slot (keyed by its slot
 * name, e.g. socialStore) in registration order.
 */
export type ProviderSelections = CoreProviderSelections &
  Readonly<Record<string, string>>;

/**
 * The setting that selects each core slot. Module slots may use neither a core slot's name nor
 * its setting (moduleSlots() refuses both).
 */
const CORE_SLOT_SETTINGS: Readonly<Record<keyof CoreProviderSelections, string>> = {
  auth: "AUTH_PROVIDER",
  cache: "CACHE_PROVIDER",
  ai: "AI_PROVIDER",
  errorReporter: "ERROR_REPORTER",
  realtime: "REALTIME_PROVIDER",
  moderationStore: "MODERATION_STORE",
  strikeStore: "STRIKE_STORE",
  reviewQueueStore: "REVIEW_QUEUE_STORE",
  embeddingProvider: "EMBEDDING_PROVIDER",
  appStateStore: "APP_STATE_STORE",
  trajectoryStore: "TRAJECTORY_STORE",
  budgetStore: "BUDGET_STORE",
  proposalStore: "PROPOSAL_STORE",
  effectLedger: "EFFECT_LEDGER",
  approvalPolicyStore: "APPROVAL_POLICY_STORE",
  guestUsageStore: "GUEST_USAGE_STORE",
  rateLimiter: "RATE_LIMIT_STORE",
};

/**
 * The registered modules' slots with their owners, in registration order. Refuses a module slot
 * that reuses a core slot's name or setting (modules among themselves are checked when they are
 * registered).
 */
function moduleSlots(): readonly Contributed<ModuleProviderSlot>[] {
  composeWithModules(
    "provider slot",
    Object.keys(CORE_SLOT_SETTINGS),
    (name) => name,
    (m) => m.providers.map((s) => s.slot)
  );
  composeWithModules(
    "provider selector setting",
    Object.values(CORE_SLOT_SETTINGS),
    (name) => name,
    (m) => m.providers.map((s) => s.envVar)
  );
  return getModules().flatMap((m) =>
    m.providers.map((value) => ({ moduleId: m.id, value }))
  );
}

// ---------------------------------------------------------------------------
// Read selections from env
// ---------------------------------------------------------------------------

function getCoreSelections(): CoreProviderSelections {
  return {
    auth: (getAuthProviderSetting() as AuthProviderType) ?? "mock",
    cache: (getCacheProviderSetting() as CacheProviderType | undefined) ?? "memory",
    ai: (process.env.AI_PROVIDER as AIProviderType) ?? "mock",
    errorReporter: (process.env.ERROR_REPORTER as ErrorReporterType) ?? "noop",
    realtime: (process.env.REALTIME_PROVIDER as RealtimeProviderType) ?? "mock",
    moderationStore: (process.env.MODERATION_STORE as ModerationStoreType) ?? "memory",
    strikeStore: (process.env.STRIKE_STORE as StrikeStoreType) ?? "memory",
    reviewQueueStore:
      (process.env.REVIEW_QUEUE_STORE as ReviewQueueStoreType) ?? "memory",
    embeddingProvider:
      (process.env.EMBEDDING_PROVIDER as EmbeddingProviderType) ?? "mock",
    appStateStore: (process.env.APP_STATE_STORE as AppStateStoreType) ?? "memory",
    trajectoryStore: (process.env.TRAJECTORY_STORE as TrajectoryStoreType) ?? "memory",
    budgetStore: (process.env.BUDGET_STORE as BudgetStoreType) ?? "memory",
    proposalStore: (process.env.PROPOSAL_STORE as ProposalStoreType) ?? "memory",
    effectLedger: (process.env.EFFECT_LEDGER as EffectLedgerType) ?? "memory",
    approvalPolicyStore:
      (process.env.APPROVAL_POLICY_STORE as ApprovalPolicyStoreType) ?? "memory",
    guestUsageStore: (process.env.GUEST_USAGE_STORE as GuestUsageStoreType) ?? "memory",
    rateLimiter: (getRateLimitStoreSetting() as RateLimiterStoreType) ?? "memory",
  };
}

/** A module slot's selection: its setting, or its default when unset (as the core's slots). */
function moduleSelection(slot: ModuleProviderSlot): string {
  return process.env[slot.envVar] ?? slot.defaultValue;
}

/** The core's selections, then each registered module slot's under its slot name. */
function getProviderSelections(): ProviderSelections {
  const selections: Record<string, string> = { ...getCoreSelections() };
  for (const { value: slot } of moduleSlots()) {
    selections[slot.slot] = moduleSelection(slot);
  }
  return selections as ProviderSelections;
}

// ---------------------------------------------------------------------------
// Individual provider init (synchronous)
// ---------------------------------------------------------------------------

function initAuthProvider(type: AuthProviderType): void {
  if (hasAuthProvider()) return;

  if (type === "cognito") {
    // ADR-050 D2: one resolver for the Cognito ids. In production the contract has already
    // refused a missing pool/client, so the mock fallback below is reachable only outside it.
    const { region, userPoolId, clientId } = getCognitoSettings();

    if (!userPoolId || !clientId) {
      logger.warn(
        "AUTH_PROVIDER=cognito but NEXT_PUBLIC_COGNITO_USER_POOL_ID or NEXT_PUBLIC_COGNITO_CLIENT_ID missing — falling back to mock"
      );
      registerAuthProvider(createMockAuthProvider({}));
      return;
    }

    registerAuthProvider(createCognitoAuthProvider({ region, userPoolId, clientId }));
    return;
  }

  registerAuthProvider(createMockAuthProvider({}));
}

function initCacheProvider(type: CacheProviderType): void {
  if (type === "upstash") {
    const url = process.env.UPSTASH_REDIS_REST_URL ?? "";
    const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? "";

    // Fail closed (TASK-139): never a silent fallback to a per-instance cache.
    if (!url || !token) {
      throw new Error(
        "CACHE_PROVIDER=upstash but UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN is not set"
      );
    }
  }
  // The cache singleton is built from the same selection on first use.
  resetCache();
}

function initAIProvider(type: AIProviderType): void {
  if (type === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    if (!apiKey) {
      logger.warn(
        "AI_PROVIDER=anthropic but ANTHROPIC_API_KEY missing — AI calls will fail"
      );
    }
    return;
  }
}

function initErrorReporter(type: ErrorReporterType): void {
  if (type === "sentry") {
    const dsn = process.env.SENTRY_DSN ?? "";
    if (!dsn) {
      logger.warn("ERROR_REPORTER=sentry but SENTRY_DSN missing — falling back to noop");
    }
    return;
  }
}

function initRealtimeProvider(type: RealtimeProviderType): void {
  if (type === "supabase") {
    const url = getSupabaseUrl() ?? "";
    if (!url) {
      logger.warn(
        "REALTIME_PROVIDER=supabase but SUPABASE_URL missing — falling back to mock"
      );
    }
    return;
  }
}

function initModerationStore(type: ModerationStoreType): void {
  if (isDurableStore(type)) {
    requireDatabase("MODERATION_STORE", type, "in-memory moderation decisions");
    setModerationStore(new PostgresModerationStore());
    return;
  }
  // The moderation audit trail is what appeals and overturns are judged from (audit X-21).
  requireDurableStoreInProduction("MODERATION_STORE", "moderation decisions");
}

function initStrikeStore(type: StrikeStoreType): void {
  if (isDurableStore(type)) {
    requireDatabase("STRIKE_STORE", type, "in-memory strikes");
    setStrikeStore(new PostgresStrikeStore());
    return;
  }
  // Per-instance strikes never reach the ban threshold across instances (audit X-3).
  requireDurableStoreInProduction("STRIKE_STORE", "strikes");
}

function initReviewQueueStore(type: ReviewQueueStoreType): void {
  if (isDurableStore(type)) {
    requireDatabase("REVIEW_QUEUE_STORE", type, "an in-memory review queue");
    setReviewQueueStore(new PostgresReviewQueueStore());
    return;
  }
  // A per-instance queue loses escalations, ban reviews and appeals (audit X-3).
  requireDurableStoreInProduction("REVIEW_QUEUE_STORE", "the human review queue");
}

function initAppStateStore(type: AppStateStoreType): void {
  if (isDurableStore(type)) {
    // ADR-049 D1: activity sessions are user state; asking for a durable store and not getting
    // one is a misconfiguration (it used to fall back to memory with a warning).
    requireDatabase("APP_STATE_STORE", type, "in-memory activity sessions");
    setActivityStateStore(new PostgresActivityStateStore());
    return;
  }

  // type is "memory" (explicit or defaulted). ADR-049 D1: activity sessions are user state;
  // a production deployment must persist them.
  requireDurableStoreInProduction("APP_STATE_STORE", "activity sessions");
}

/**
 * ADR-053 D4: a durable store is the Postgres one, reached through platform/data. "postgres" and
 * "supabase" both select it — on a Supabase project the store is the same Postgres store, so a
 * deployment that already says "supabase" needs no change.
 */
export function isDurableStore(type: string | undefined): boolean {
  return type === "postgres" || type === "supabase";
}

/** A durable store with no database is a misconfiguration, never a fall back to memory. */
function requireDatabase(envVar: string, type: string, fallback: string): void {
  if (!hasDatabase()) {
    throw new Error(
      `${envVar}=${type} but DATABASE_URL is not set. Refusing to fall back to ${fallback} (ADR-053 D4).`
    );
  }
}

/**
 * ADR-048 D3: the durable agent stores are required in production. Rather than flip the global
 * default (which breaks the in-memory test/local path), refuse to boot the runtime on an
 * in-memory budget/trajectory store in a production context — the same fail-closed stance a
 * durable store takes without DATABASE_URL (requireDatabase). Tests and local (NODE_ENV !== "production") keep
 * the in-memory default.
 */
function requireDurableStoreInProduction(envVar: string, noun: string): void {
  if (process.env.NODE_ENV !== "production") return;

  // A production BUILD run under an E2E harness (Playwright starts the app with `next start`,
  // which forces NODE_ENV=production) is not a deployment: no database is provisioned for the
  // test, so it legitimately runs on in-memory stores. The harness opts out explicitly via
  // E2E_IN_MEMORY_STORES=true, honoured only where DEPLOYMENT_HOST marks the run as local or CI
  // (TASK-140) — a deployment, or a run that forgets the marker, still fails closed. The opt-out is
  // logged so an accidental production use is visible rather than silent.
  if (process.env.E2E_IN_MEMORY_STORES === "true" && allowsHarnessSwitches()) {
    logger.warn(
      `${envVar} is "memory" in a production build — permitted by E2E_IN_MEMORY_STORES ` +
        `(test harness only; never set on a deployment)`,
      { route: "platform/providers/registry" }
    );
    return;
  }

  throw new Error(
    `${envVar} is unset or "memory" in production. Refusing to boot on ` +
      `in-memory ${noun} (ADR-048 D3, ADR-049 D1) — set ${envVar}=postgres with DATABASE_URL (ADR-053 D4).`
  );
}

function initTrajectoryStore(type: TrajectoryStoreType): void {
  if (isDurableStore(type)) {
    // Fail closed (TASK-062): asking for a durable store and not getting it is a
    // misconfiguration, not a degraded mode — P18 durability would be asserted, not true.
    requireDatabase("TRAJECTORY_STORE", type, "in-memory trajectories");
    setTrajectoryStore(new PostgresTrajectoryStore());
    return;
  }

  // type is "memory" (explicit or defaulted).
  requireDurableStoreInProduction("TRAJECTORY_STORE", "trajectories");
}

function initBudgetStore(type: BudgetStoreType): void {
  if (isDurableStore(type)) {
    // Fail closed, as slot #15 does. Degrading to an in-process counter is precisely
    // the TASK-063 condition: maxCostPerDay never accumulates across instances, so the
    // cap is unenforced and nothing says so. An unbounded-spend exposure is not a
    // degraded mode.
    requireDatabase("BUDGET_STORE", type, "in-process budget accumulation");
    setBudgetTracker(new BudgetTracker(new PostgresBudgetStore()));
    return;
  }

  // type is "memory" (explicit or defaulted).
  requireDurableStoreInProduction("BUDGET_STORE", "budget accumulation");
}

function initApprovalPolicyStore(type: ApprovalPolicyStoreType): void {
  if (isDurableStore(type)) {
    // Fail closed: a per-instance policy lets an action held on one instance run on another.
    requireDatabase("APPROVAL_POLICY_STORE", type, "an in-memory approval policy");
    setApprovalPolicyStore(new PostgresApprovalPolicyStore());
    return;
  }

  // type is "memory" (explicit or defaulted): refused in production (audit X-21).
  requireDurableStoreInProduction("APPROVAL_POLICY_STORE", "the approval policy");
}

function initGuestUsageStore(type: GuestUsageStoreType): void {
  if (isDurableStore(type)) {
    // Fail closed. An in-memory guest counter resets on every instance and restart, so the
    // guest allowance (ADR-050 D4) would not bind — unbounded paid calls with nothing saying so.
    requireDatabase("GUEST_USAGE_STORE", type, "an in-memory guest allowance");
    setGuestUsageStore(new PostgresGuestUsageStore());
    return;
  }

  // type is "memory" (explicit or defaulted).
  requireDurableStoreInProduction("GUEST_USAGE_STORE", "the guest allowance");
}

function initRateLimiter(type: RateLimiterStoreType): void {
  // ADR-052 D3: a per-instance counter does not hold across serverless instances, so a limit
  // set on it is not a limit. Production refuses it, as it refuses in-memory stores.
  if (type === "memory") {
    requireDurableStoreInProduction("RATE_LIMIT_STORE", "rate limiting");
  }
  // Idempotent: a limiter of the selected store already installed (one created by a request
  // that arrived first) keeps its counts.
  if (peekRateLimiter()?.name === RATE_LIMITER_NAMES[type]) return;
  // A shared store with missing credentials throws inside createRateLimiter rather than
  // falling back to memory.
  setRateLimiter(createRateLimiter({ provider: type }));
}

function initProposalStore(type: ProposalStoreType): void {
  if (isDurableStore(type)) {
    // Fail closed: an in-memory proposal store means a held action disappears on restart —
    // the approval never arrives and nothing says so.
    requireDatabase("PROPOSAL_STORE", type, "in-memory proposals");
    setProposalStore(new PostgresProposalStore());
    return;
  }

  // type is "memory" (explicit or defaulted): refused in production (audit X-21).
  requireDurableStoreInProduction("PROPOSAL_STORE", "proposals (held actions)");
}

function initEffectLedger(type: EffectLedgerType): void {
  if (isDurableStore(type)) {
    // Fail closed. An in-memory effect ledger means a retry after restart finds no entry
    // and re-fires an external effect that may already have succeeded — the at-least-once
    // violation ADR-031 D7 exists to prevent.
    requireDatabase("EFFECT_LEDGER", type, "an in-memory effect ledger");
    setEffectLedger(new PostgresEffectLedger());
    return;
  }

  // type is "memory" (explicit or defaulted): refused in production (audit X-21).
  requireDurableStoreInProduction("EFFECT_LEDGER", "the effect ledger");
}

/**
 * ADR-053 D2/D7: where tenants and their domains are kept. Every request reads it (host →
 * tenant, tenant → state), so reads are cached per instance (CachedTenantDirectory, 30 s): a
 * suspension reaches every instance within that time.
 */
function initTenantDirectory(type: string | undefined): void {
  if (type === "postgres") {
    requireDatabase("TENANT_DIRECTORY_STORE", type, "an in-memory tenant directory");
    setTenantDirectory(new CachedTenantDirectory(new PostgresTenantDirectory()));
    return;
  }
  setTenantDirectory(new CachedTenantDirectory(new InMemoryTenantDirectory()));
}

function initEmbeddingProvider(type: EmbeddingProviderType): void {
  if (type === "openai") {
    const apiKey = process.env.OPENAI_API_KEY ?? "";
    if (!apiKey) {
      logger.warn(
        "EMBEDDING_PROVIDER=openai but OPENAI_API_KEY missing — falling back to mock"
      );
      setEmbeddingProvider(createMockEmbeddingProvider());
      return;
    }
    // Real OpenAI provider will be registered here in a future sprint
    setEmbeddingProvider(createMockEmbeddingProvider());
    return;
  }

  setEmbeddingProvider(createMockEmbeddingProvider());
}

/**
 * A registered module's slot (ADR-054 D4), held to the core's rules: a durable selection without
 * a database is refused (requireDatabase), any other selection of a durable slot is refused in
 * production (requireDurableStoreInProduction), and only then does the module install its
 * provider. A selection outside the slot's declared values is logged and passed on as given —
 * the core's slots treat an unrecognised value the same way (as their non-durable default).
 */
function initModuleSlot(slot: ModuleProviderSlot, selection: string): void {
  if (!slot.values.includes(selection)) {
    logger.warn(
      `${slot.envVar}="${selection}" is not one of ${slot.values.join(", ")} — passed to the slot as given`,
      { route: "platform/providers/registry" }
    );
  }
  if (slot.durable) {
    if (slot.durable.selections.includes(selection)) {
      requireDatabase(slot.envVar, selection, slot.durable.fallback);
    } else {
      requireDurableStoreInProduction(slot.envVar, slot.durable.noun);
    }
  }
  slot.init(selection, {
    env: process.env,
    warn: (message) => logger.warn(message),
  });
}

// ---------------------------------------------------------------------------
// Central init
// ---------------------------------------------------------------------------

/** ADR-032: the flag is duplicated per bundle entry like any other module binding. */
const INITIALIZED_KEY = "platform.providers.initialized";
function readInitialized(): boolean {
  return getSingleton<boolean>(INITIALIZED_KEY, () => false);
}
function writeInitialized(next: boolean): void {
  setSingleton<boolean>(INITIALIZED_KEY, next);
}
/**
 * Initialize all platform providers from environment.
 * Safe to call multiple times — skips if already initialized.
 */
export function initProviders(): ProviderSelections {
  if (readInitialized()) return getProviderSelections();

  // ADR-050 D1/D2: in production, refuse to boot on a test-double auth provider or a missing,
  // mis-shaped or duplicated setting — before any slot initializes. No-op outside production.
  assertEnvironmentContract();
  // ADR-054 D4: a registered module that reuses a core name (a prompt, goal, rule, feature,
  // agent, slot …) is refused here, at boot, rather than by the first request that reads it.
  assertModuleContributions();

  const core = getCoreSelections();
  initCoreSlots(core);
  for (const { value: slot } of moduleSlots()) {
    initModuleSlot(slot, moduleSelection(slot));
  }

  // ADR-036 step 4 / ADR-039: register platform agents (the core's and the registered modules')
  // and the adaptive reference on the boot path (makes real the invariant jest.setup mirrors).
  // Registration needs no store, so it runs after the provider slots are live. Every registrar
  // is idempotent.
  registerPlatformAgents();
  registerAdaptiveReference();
  registerModuleContentTypes();
  registerRagReference();

  writeInitialized(true);
  const selections = getProviderSelections();
  logger.info("Platform providers initialized", { ...selections });

  return selections;
}

/** The core's slots, in dependency order (the cache before anything that caches, …). */
function initCoreSlots(selections: CoreProviderSelections): void {
  initAuthProvider(selections.auth);
  initCacheProvider(selections.cache);
  initAIProvider(selections.ai);
  initErrorReporter(selections.errorReporter);
  initRealtimeProvider(selections.realtime);
  initModerationStore(selections.moderationStore);
  initStrikeStore(selections.strikeStore);
  initReviewQueueStore(selections.reviewQueueStore);
  initAppStateStore(selections.appStateStore);
  initTrajectoryStore(selections.trajectoryStore);
  initBudgetStore(selections.budgetStore);
  initProposalStore(selections.proposalStore);
  initApprovalPolicyStore(selections.approvalPolicyStore);
  initGuestUsageStore(selections.guestUsageStore);
  initRateLimiter(selections.rateLimiter);
  initEffectLedger(selections.effectLedger);
  initTenantDirectory(getTenantDirectoryStoreSetting());
  initEmbeddingProvider(selections.embeddingProvider);
}

/**
 * Get current provider selections (for health/diagnostics).
 */
export function getActiveProviders(): ProviderSelections {
  return getProviderSelections();
}

/**
 * Reset (testing only).
 */
export function resetProviders(): void {
  writeInitialized(false);
  // Clearing the flag is not clearing the providers. Until ADR-032 this function set the
  // flag alone and tests appeared to work, because jest.resetModules() was doing the real
  // clearing — a module-scope binding vanished with the module. The registry outlives module
  // re-import by design, so a reset that does not clear leaves the previous run's providers
  // registered and the next test inherits them.
  for (const key of providerSingletonKeys()) {
    resetSingleton(key);
  }
}

/**
 * Every singleton the core's slots write. Listed explicitly rather than derived: a slot missing
 * from here is a slot resetProviders() silently fails to clear, and an explicit list can be
 * checked against the registry's own selections by a test. A module's slots declare their own
 * (ModuleProviderSlot.singletonKeys); providerSingletonKeys() is the whole set.
 */
export const CORE_PROVIDER_SINGLETON_KEYS: readonly string[] = [
  "platform.auth.provider",
  "platform.cache.provider",
  "platform.cache.aiCache",
  "platform.ai.orchestrator",
  "platform.rateLimit.limiter",
  "platform.moderation.store",
  "platform.moderation.guardian",
  "platform.moderation.sentinel",
  "platform.moderation.strikeStore",
  "platform.moderation.reviewQueueStore",
  "platform.agents.trajectoryStore",
  "platform.agents.budgetTracker",
  "platform.agents.proposalStore",
  "platform.agents.approvalPolicyStore",
  "platform.auth.guestUsageStore",
  "platform.agents.effectLedger",
  "platform.appFramework.stateStore",
  "platform.rag.embeddingStore",
  "platform.rag.embeddingProvider",
  "platform.rag.userContextStore",
  "platform.tenancy.directory",
];

/** Every singleton resetProviders() clears: the core's, then each registered module slot's. */
export function providerSingletonKeys(): readonly string[] {
  const moduleKeys = moduleSlots().flatMap(({ value }) => value.singletonKeys);
  const all = [...CORE_PROVIDER_SINGLETON_KEYS, ...moduleKeys];
  const shared = moduleKeys.filter((k) => CORE_PROVIDER_SINGLETON_KEYS.includes(k));
  if (shared.length > 0) {
    throw new Error(
      `Module provider slots declare core singleton keys: ${shared.join(", ")} (ADR-054)`
    );
  }
  return all;
}
