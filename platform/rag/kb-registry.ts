/**
 * platform/rag/kb-registry.ts — the knowledge-base registry (ADR-042 D1).
 *
 * The governed control-plane surface for knowledge bases: a KB is registered with a
 * declared isolation level and boundary, and is refused fail-closed if the active
 * embedding store cannot structurally enforce the declared level (ADR-042 D4 — never a
 * silent downgrade). globalThis-anchored (ADR-032), mirroring the content/adaptive
 * registries.
 *
 * @module platform/rag
 */
import { getSingleton } from "@/platform/kernel/singleton";
import type { KnowledgeBase, KnowledgeBaseConfig } from "./types";
import { getEmbeddingStore } from "./index";

const REGISTRY_KEY = "platform.rag.kbRegistry";

function registry(): Map<string, KnowledgeBase> {
  return getSingleton(REGISTRY_KEY, () => new Map<string, KnowledgeBase>());
}

/**
 * Register a knowledge base. Fails closed if the id is already taken, or if the active
 * embedding store does not support the declared isolation level (ADR-042 D4).
 */
export function registerKnowledgeBase(config: KnowledgeBaseConfig): KnowledgeBase {
  if (!config.id) throw new Error("knowledge base requires a non-empty id");
  const reg = registry();
  if (reg.has(config.id)) {
    throw new Error(`knowledge base already registered: ${config.id}`);
  }
  const supported = getEmbeddingStore().supportedLevels();
  if (!supported.includes(config.isolationLevel)) {
    throw new Error(
      `embedding store does not support isolation level "${config.isolationLevel}" ` +
        `(supported: ${supported.join(", ") || "none"}); registration refused for "${config.id}"`
    );
  }
  const kb: KnowledgeBase = { ...config, boundary: [...config.boundary] };
  reg.set(kb.id, kb);
  return kb;
}

export function getKnowledgeBase(id: string): KnowledgeBase | undefined {
  return registry().get(id);
}

export function hasKnowledgeBase(id: string): boolean {
  return registry().has(id);
}

export function listKnowledgeBases(): string[] {
  return [...registry().keys()];
}

export function resetKnowledgeBases(): void {
  registry().clear();
}
