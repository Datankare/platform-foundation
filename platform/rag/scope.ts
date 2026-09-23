/**
 * platform/rag/scope.ts — the isolation scope (ADR-042 D3).
 *
 * A `Scope` is the named-dimensions isolation key for a store operation. This module
 * derives a stable partition key from a scope and validates a scope against a KB's
 * declared boundary — fail-closed: a declared dimension absent from the scope is an
 * error, never a silently wider query.
 *
 * @module platform/rag
 */
import type { Scope } from "./types";

/**
 * A stable, collision-free partition key for a scope: the knowledge base plus its
 * boundary dimensions in sorted order. Stores that isolate structurally key on this.
 */
export function scopeKey(scope: Scope): string {
  const dims = Object.keys(scope.dimensions)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(scope.dimensions[k])}`)
    .join("&");
  return `${encodeURIComponent(scope.knowledgeBaseId)}::${dims}`;
}

/**
 * Assert a scope carries every dimension the KB's boundary requires (ADR-042 D3).
 * Throws {@link ScopeError} if any declared dimension is missing or empty — the caller
 * must treat this as fail-closed (no query issued, nothing returned).
 */
export function assertScope(boundary: readonly string[], scope: Scope): void {
  for (const dim of boundary) {
    const v = scope.dimensions[dim];
    if (v === undefined || v === "") {
      throw new ScopeError(
        `scope missing required boundary dimension "${dim}" for knowledge base "${scope.knowledgeBaseId}"`
      );
    }
  }
}

/** Raised when a scope does not satisfy a knowledge base's declared boundary. */
export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}
