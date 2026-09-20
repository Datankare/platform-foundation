/**
 * platform/content/registry.ts — the content-type registry (ADR-037 D1/D3).
 *
 * Backed by the globalThis singleton carrier so it survives Next.js/Turbopack module duplication
 * (the same defect that produced PF v2.1.1 for the agent registry). Registration REFUSES a content
 * type without a static-template fallback — content generation is fail-closed by construction
 * (ADR-037 D3 / P11).
 */
import { getSingleton } from "@/platform/kernel/singleton";
import type { ContentType, AnyContentType } from "./types";

const REGISTRY_KEY = "platform.content.registry";

function types(): Map<string, AnyContentType> {
  return getSingleton(REGISTRY_KEY, () => new Map<string, AnyContentType>());
}

/** Register a content type. Throws if it has no static-template fallback (D3) or the name is taken. */
export function registerContentType<TInput, TContent>(
  contentType: ContentType<TInput, TContent>
): void {
  if (typeof contentType.renderFallback !== "function") {
    throw new Error(
      `Content type "${contentType.name}" must supply a static-template fallback (ADR-037 D3)`
    );
  }
  const reg = types();
  if (reg.has(contentType.name)) {
    throw new Error(`Content type already registered: ${contentType.name}`);
  }
  reg.set(contentType.name, contentType as unknown as AnyContentType);
}

export function getContentType(name: string): AnyContentType | undefined {
  return types().get(name);
}

export function hasContentType(name: string): boolean {
  return types().has(name);
}

export function listContentTypes(): string[] {
  return [...types().keys()];
}

/** Test support: clear the registry. */
export function resetContentTypes(): void {
  types().clear();
}
