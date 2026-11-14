/**
 * platform/auth/record-hash.ts — the keyed hash a record keeps instead of a value (TASK-215,
 * audit A-6)
 *
 * Two records kept a value's unkeyed SHA-256 so that it could be matched without being stored: a
 * moderation decision its screened text (content_safety_audit.input_hash) and a re-link record the
 * identity subjects it changed (audit_log details, platform/auth/identity-relink.ts subjectHint).
 * An unkeyed hash of a short text — a message, a name — is confirmed by hashing a guess, by anyone
 * who can read the record; it was even kept after the account was erased. Now each is an
 * HMAC-SHA256 under RECORD_HASH_KEY, which only the server holds:
 *
 *   hmac-sha256:<key id>:<hex>
 *
 * The key id (16 hex, derived from the key, never the key) says which key made it, so the key can
 * rotate as the erasure key does: RECORD_HASH_KEY_PREVIOUS still matches what the previous key
 * made (recordHashCandidates), and nothing new is hashed with it. Each use has its own purpose,
 * mixed into the HMAC, so a hash made for one use never matches another's.
 *
 * What happens to the hashes (decided in TASK-215, docs/MIGRATION_v5_to_v6.md):
 *   - the unkeyed ones written before are cleared by migration 072 — they cannot be rehashed
 *     without the text, and no reader matches on them;
 *   - an erased account's decisions lose theirs at erasure (platform/auth/user-data.ts
 *     moderationDecisions): a hash kept after erasure, even keyed, would let whoever holds the key
 *     confirm a guess of what the erased person wrote;
 *   - removing RECORD_HASH_KEY_PREVIOUS ends the matching of what the old key made: those hashes
 *     then match nothing, which is a deletion in effect.
 *
 * Outside a deployment (local, tests, a CI harness on the mock auth provider) a fixed development
 * key is used, so runs agree; a deployment with a real auth provider must set the key (the
 * environment contract requires it, and recordHash refuses there without it).
 *
 * @module platform/auth
 */

import { createHmac } from "node:crypto";
import {
  TEST_DOUBLE_AUTH_PROVIDERS,
  getAuthProviderSetting,
  getPreviousRecordHashKey,
  getRecordHashKey,
  isProductionContext,
} from "@/platform/providers/environment-contract";

/** What a hash is for: mixed into the HMAC, so one use's hash never matches another's. */
export type RecordHashPurpose = "screened-text" | "relink-subject";

const DEVELOPMENT_KEY =
  "platform-foundation development record-hash key (not for production)";

/** The form every record hash has; anything else is not one (a legacy unkeyed hash). */
export const RECORD_HASH = /^hmac-sha256:[0-9a-f]{16}:[0-9a-f]{64}$/;

/** A key's id: derived from it (never the key), so a hash says which key of the ring made it. */
export function recordKeyId(key: string): string {
  return createHmac("sha256", key)
    .update("record-hash key id")
    .digest("hex")
    .slice(0, 16);
}

/** The current key, or the development key outside a deployment. */
function currentKey(): string {
  const key = getRecordHashKey();
  if (
    !key &&
    isProductionContext() &&
    !TEST_DOUBLE_AUTH_PROVIDERS.has(getAuthProviderSetting() ?? "mock")
  ) {
    throw new Error("RECORD_HASH_KEY is not set — refusing to keep an unkeyed hash");
  }
  return key ?? DEVELOPMENT_KEY;
}

function hashUnder(key: string, purpose: RecordHashPurpose, value: string): string {
  const mac = createHmac("sha256", key).update(`${purpose}\u0000${value}`).digest("hex");
  return `hmac-sha256:${recordKeyId(key)}:${mac}`;
}

/** `value` as a record keeps it: HMAC-SHA256 under the current key, for `purpose`. */
export function recordHash(purpose: RecordHashPurpose, value: string): string {
  return hashUnder(currentKey(), purpose, value);
}

/**
 * Every form `value` may be kept in: under the current key and, while it is set, the previous one
 * — what a reader matches a record by.
 */
export function recordHashCandidates(
  purpose: RecordHashPurpose,
  value: string
): string[] {
  const keys = [currentKey(), getPreviousRecordHashKey()].filter(
    (k): k is string => typeof k === "string" && k.length > 0
  );
  return [...new Set(keys.map((k) => hashUnder(k, purpose, value)))];
}
