/**
 * platform/ai/provenance.ts — multimodal provenance & synthetic-media detection (ADR-047).
 *
 * One synthetic-media-identity seam, two directions: EMIT a signed, verifiable provenance
 * credential on images we generate (consumed by ADR-045 at commit), and DETECT synthetic
 * origin on inbound media (consumed by ADR-044) as a risk SIGNAL — never a standalone gate.
 * The reference credential is a C2PA-shaped signed manifest; a deployment swaps asymmetric
 * signing / a real watermark in behind the same emit/verify contract.
 *
 * @module platform/ai
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  getProvenanceSigningKey,
  getPreviousProvenanceSigningKey,
} from "@/platform/providers/environment-contract";

export interface ImageBytes {
  readonly mediaType: string;
  readonly data: string;
}

/** A signed, verifiable provenance credential (ADR-047 D1/D4). */
export interface ProvenanceCredential {
  readonly standard: "c2pa";
  readonly issuer: string;
  readonly model: string;
  readonly createdAt: string;
  /** sha256 of the image (its media type and bytes, canonically encoded) — content tamper-evidence. */
  readonly contentHash: string;
  /**
   * Which signing key signed it (review 7 L6): a fingerprint of the key, never the key. A
   * credential verifies under the key ring's key of this id — the current key or the previous
   * one (PROVENANCE_SIGNING_KEY_PREVIOUS), so a key can be rotated without voiding what it
   * signed. Empty when unsigned.
   */
  readonly keyId: string;
  /**
   * HMAC-SHA256 of the manifest under the key `keyId` names — tamper-evidence for the claim.
   * Empty when the deployment has no key: such a credential is unsigned and never verifies.
   */
  readonly signature: string;
}

const ISSUER = "datankare-platform";

/**
 * The image media types a credential is issued and verified for (review 7 L6). Anything else —
 * an SVG (a document that runs script), a made-up type — gets an unsigned credential, which
 * never verifies.
 */
export const PROVENANCE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/**
 * The content hash: SHA-256 of a JSON array (version tag, media type, bytes) — an unambiguous
 * encoding (review 7 L6: `mediaType|data` let "image/png|x" + "y" hash as "image/png" + "x|y").
 */
function contentHash(image: ImageBytes): string {
  return createHash("sha256")
    .update(JSON.stringify(["provenance-content-v2", image.mediaType, image.data]))
    .digest("hex");
}

/** The manifest's fields in a fixed order, in a JSON array: one encoding per manifest. */
function canonical(manifest: Omit<ProvenanceCredential, "signature">): string {
  return JSON.stringify([
    "provenance-manifest-v2",
    manifest.standard,
    manifest.issuer,
    manifest.model,
    manifest.createdAt,
    manifest.contentHash,
    manifest.keyId,
  ]);
}

/** A key's id: a fingerprint (the first 16 hex digits of a hash of it), never the key. */
export function provenanceKeyId(key: string): string {
  return `k-${createHash("sha256").update(`provenance-key-id|${key}`).digest("hex").slice(0, 16)}`;
}

/** The verification key ring: the current key, then the previous one (rotation), by id. */
function keyRing(): ReadonlyMap<string, string> {
  const ring = new Map<string, string>();
  for (const key of [getProvenanceSigningKey(), getPreviousProvenanceSigningKey()]) {
    if (key && !ring.has(provenanceKeyId(key))) ring.set(provenanceKeyId(key), key);
  }
  return ring;
}

/**
 * Keyed signature of the manifest (audit X-18). Before: an unkeyed SHA-256 of the manifest, which
 * anyone could recompute — a forged claim "verified". A deployment can swap C2PA / asymmetric
 * signing in behind this same emit/verify contract.
 */
function sign(manifest: Omit<ProvenanceCredential, "signature">, key: string): string {
  return createHmac("sha256", key).update(canonical(manifest)).digest("hex");
}

/**
 * Emit a provenance credential for a generated image (ADR-047 D1), signed with the current key.
 * Unsigned (and so never verifying) without a key, or for a media type outside
 * PROVENANCE_MEDIA_TYPES.
 */
export function emitProvenance(
  image: ImageBytes,
  meta: { model: string; issuer?: string; createdAt?: string }
): ProvenanceCredential {
  const key = PROVENANCE_MEDIA_TYPES.has(image.mediaType)
    ? getProvenanceSigningKey()
    : undefined;
  const manifest = {
    standard: "c2pa" as const,
    issuer: meta.issuer ?? ISSUER,
    model: meta.model,
    createdAt: meta.createdAt ?? new Date().toISOString(),
    contentHash: contentHash(image),
    keyId: key ? provenanceKeyId(key) : "",
  };
  return { ...manifest, signature: key ? sign(manifest, key) : "" };
}

/**
 * Verify a credential against an image (ADR-047 D4). False if the image was altered (content
 * hash mismatch), the claim was altered (signature mismatch), the credential is unsigned or
 * malformed, its media type is not one credentials are issued for, or no key of the ring has its
 * key id. The comparison is constant-time.
 */
export function verifyProvenance(
  credential: ProvenanceCredential,
  image: ImageBytes
): boolean {
  if (!credential || typeof credential !== "object") return false;
  if (!image || !PROVENANCE_MEDIA_TYPES.has(image.mediaType)) return false;
  const { signature, standard, issuer, model, createdAt, keyId } = credential;
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (
    standard !== "c2pa" ||
    typeof issuer !== "string" ||
    typeof model !== "string" ||
    typeof createdAt !== "string" ||
    typeof keyId !== "string" ||
    typeof credential.contentHash !== "string"
  ) {
    return false;
  }
  const key = keyRing().get(keyId);
  if (!key) return false;
  if (credential.contentHash !== contentHash(image)) return false;
  const expected = Buffer.from(
    sign(
      { standard, issuer, model, createdAt, contentHash: credential.contentHash, keyId },
      key
    ),
    "hex"
  );
  return timingSafeEqual(Buffer.from(signature, "hex"), expected);
}

/** Inbound synthetic-origin signal — probabilistic (ADR-047 D2). */
export interface DetectionSignal {
  readonly synthetic: boolean;
  readonly confidence: number;
  /** True when no detector is configured, and the signal is the fail-closed default. */
  readonly unconfigured?: boolean;
}

export type SyntheticDetector = (content: ImageBytes) => Promise<DetectionSignal>;

/**
 * With no detector configured, every item is treated as possibly synthetic (audit X-18): the
 * signal raises the risk tier, so a generation from reference images is held for a person rather
 * than committed on a placeholder that answered "not synthetic" to everything.
 */
const DEFAULT_DETECTOR: SyntheticDetector = async () => ({
  synthetic: true,
  confidence: 0,
  unconfigured: true,
});
let detector: SyntheticDetector = DEFAULT_DETECTOR;
export function setSyntheticDetector(d: SyntheticDetector): void {
  detector = d;
}
export function resetSyntheticDetector(): void {
  detector = DEFAULT_DETECTOR;
}

/**
 * Classify inbound content for synthetic origin (ADR-047 D2). Returns a risk SIGNAL the caller
 * uses to raise the risk tier / route to the governed path — it is never a standalone gate,
 * because detection is probabilistic and adversarial.
 */
export async function detectSyntheticOrigin(
  content: ImageBytes
): Promise<DetectionSignal> {
  try {
    const signal = await detector(content);
    if (typeof signal?.synthetic !== "boolean") {
      return { synthetic: true, confidence: 0, unconfigured: true };
    }
    return signal;
  } catch {
    // A failed detector says nothing about the content: treat it as possibly synthetic.
    return { synthetic: true, confidence: 0 };
  }
}
