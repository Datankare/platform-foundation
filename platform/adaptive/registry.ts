/**
 * platform/adaptive/registry.ts — the adaptive behavior registry (ADR-036 D1/D3).
 *
 * Backed by the globalThis singleton carrier so it survives Next.js/Turbopack module duplication
 * (the same defect that produced PF v2.1.1 for the agent registry). Registration REFUSES a
 * behavior without a deterministic fallback — adaptive behavior is fail-closed by construction.
 */
import { getSingleton } from "@/platform/kernel/singleton";
import type { AdaptiveBehavior, AnyAdaptiveBehavior } from "./types";

function behaviors(): Map<string, AnyAdaptiveBehavior> {
  return getSingleton(
    "platform.adaptive.registry",
    () => new Map<string, AnyAdaptiveBehavior>()
  );
}

/** Register an adaptive behavior. Throws if it has no fallback (D3) or the name is taken. */
export function registerAdaptiveBehavior<TInput, TDecision>(
  behavior: AdaptiveBehavior<TInput, TDecision>
): void {
  if (typeof behavior.fallback !== "function") {
    throw new Error(
      `Adaptive behavior "${behavior.name}" must supply a deterministic fallback (ADR-036 D3)`
    );
  }
  const reg = behaviors();
  if (reg.has(behavior.name)) {
    throw new Error(`Adaptive behavior already registered: ${behavior.name}`);
  }
  reg.set(behavior.name, behavior as unknown as AnyAdaptiveBehavior);
}

export function getAdaptiveBehavior(name: string): AnyAdaptiveBehavior | undefined {
  return behaviors().get(name);
}

export function hasAdaptiveBehavior(name: string): boolean {
  return behaviors().has(name);
}

export function listAdaptiveBehaviors(): string[] {
  return [...behaviors().keys()];
}

/** Test support: clear the registry. */
export function resetAdaptiveBehaviors(): void {
  behaviors().clear();
}
