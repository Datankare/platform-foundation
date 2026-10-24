/**
 * platform/modules/contributions.ts — What boot does with the registered modules (ADR-054 D4)
 *
 * initProviders() (platform/providers/registry.ts) calls these after the environment contract:
 *
 *   assertModuleContributions()   every core list composed once, so a module that reuses a core
 *                                 name is refused at boot, naming both owners
 *   registerModuleContentTypes()  the modules' content types into the content registry (ADR-037)
 *
 * and instrumentation.ts builds the modules' health probes after the providers are live:
 *
 *   createModuleHealthProbes()    one HealthProbe per declared probe, around the live provider
 *
 * The modules' provider slots and agents are installed by the registries that own them
 * (initProviders, registerPlatformAgents). Nothing here names a module.
 *
 * @module platform/modules
 */

import { listPlatformAgentConfigs } from "@/platform/agents/agent-configs";
import { listAgentGoals } from "@/platform/agents/goals";
import { consentFeatureFallback } from "@/platform/auth/coppa-gate";
import { restrictedFeatureFallback } from "@/platform/auth/account-status-guard";
import { getContentType, registerContentType } from "@/platform/content/registry";
import { listFeatureRequirements } from "@/platform/features/availability";
import { listModerationContentTypes } from "@/platform/moderation/content-types";
import type { HealthProbe } from "@/platform/observability/types";
import { listRateRules } from "@/platform/rate-limit/rules";
import { listPrompts } from "@/prompts";
import { ModuleDefinitionError } from "./define";
import { getModules } from "./registry";

/**
 * Compose every extensible core list with the registered modules. Each composition refuses a
 * module entry whose name the core or an earlier module already has (./compose.ts); running them
 * all here makes a collision a boot failure. Provider slots are checked by initProviders itself,
 * which composes them before installing any.
 */
export function assertModuleContributions(): void {
  listPlatformAgentConfigs();
  listPrompts();
  listFeatureRequirements();
  listAgentGoals();
  listRateRules();
  listModerationContentTypes();
  consentFeatureFallback();
  restrictedFeatureFallback();
  assertContentAgentsDeclared();
}

/** A module's content type is hosted by an agent the core or a registered module declares. */
function assertContentAgentsDeclared(): void {
  const agents = new Set(listPlatformAgentConfigs().map((a) => a.id));
  for (const mod of getModules()) {
    for (const contentType of mod.contentTypes) {
      if (!agents.has(contentType.agentId)) {
        throw new ModuleDefinitionError(
          mod.id,
          `content type "${contentType.name}" is hosted by agent "${contentType.agentId}", ` +
            "which neither the core nor a registered module declares"
        );
      }
    }
  }
}

/**
 * Register each module's content types. Idempotent: a type already registered under the same
 * name and host agent — this boot's earlier call, or a bundle-duplicated copy of the same
 * module — is left as it is. A different type under the name is refused: a module never
 * replaces a content type someone else registered.
 */
export function registerModuleContentTypes(): void {
  for (const mod of getModules()) {
    for (const contentType of mod.contentTypes) {
      const existing = getContentType(contentType.name);
      if (existing === undefined) {
        registerContentType(contentType);
        continue;
      }
      if (existing.agentId !== contentType.agentId) {
        throw new ModuleDefinitionError(
          mod.id,
          `content type "${contentType.name}" is already registered with host agent ` +
            `"${existing.agentId}"`
        );
      }
    }
  }
}

/** The registered modules' health probes, built now (after initProviders installed the slots). */
export function createModuleHealthProbes(): HealthProbe[] {
  return getModules().flatMap((m) => m.healthProbes.map((probe) => probe.create()));
}
