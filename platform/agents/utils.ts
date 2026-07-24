/**
 * platform/agents/utils.ts — Shared agent utilities
 *
 * Functions used across multiple agents (Guardian, Sentinel, etc.)
 * to avoid duplication (sustainability gate A5).
 *
 * SECURITY (P4): IDs generated here are used as session identifiers, audit/idempotency
 * keys, and trajectory identifiers — all security-relevant. They are generated with
 * `globalThis.crypto.getRandomValues` (Web Crypto), available in Node 18+, the Edge
 * runtime, and jsdom. There is deliberately NO Math.random() fallback: a silent
 * downgrade to non-cryptographic randomness is the vulnerability, so we fail closed.
 *
 * Using `globalThis.crypto` rather than `node:crypto` keeps this module runtime-agnostic
 * — importing node:crypto here would pull it into the Edge bundle (cf. the ACRCloud
 * Edge-runtime issue).
 *
 * @module platform/agents
 */

/** Bytes of entropy for the default short ID (correlation/tracing scale). */
const DEFAULT_ID_BYTES = 8;

/** Bytes of entropy for identifiers that gate access or must be unguessable. */
export const SECURE_ID_BYTES = 16;

function randomHex(bytes: number): string {
  const webcrypto = globalThis.crypto;
  if (typeof webcrypto?.getRandomValues !== "function") {
    // Fail closed (P4) — never degrade to Math.random() for identifiers that are
    // used as session keys or audit references.
    throw new Error(
      "platform/agents: secure random source unavailable (globalThis.crypto.getRandomValues). " +
        "Refusing to generate identifiers with non-cryptographic randomness."
    );
  }
  const buf = new Uint8Array(bytes);
  webcrypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a random ID for agent instances, trajectories, and steps.
 *
 * Cryptographically secure (64 bits by default). Use `generateSecureId()` for
 * identifiers that gate access to state — sessions, guest accounts — where 128 bits
 * is the right floor.
 */
export function generateId(): string {
  return randomHex(DEFAULT_ID_BYTES);
}

/**
 * Generate a 128-bit cryptographically secure ID.
 *
 * For identifiers that are security boundaries: session IDs, guest user IDs,
 * operation/idempotency keys. Unguessable by construction.
 */
export function generateSecureId(): string {
  return randomHex(SECURE_ID_BYTES);
}
