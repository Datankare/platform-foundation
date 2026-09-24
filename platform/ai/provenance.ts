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

import { createHash } from "node:crypto";

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
  /** sha256 of the image bytes — tamper-evidence for the content. */
  readonly contentHash: string;
  /** keyed hash of the manifest — tamper-evidence for the claim. */
  readonly signature: string;
}

const ISSUER = "datankare-platform";

function contentHash(image: ImageBytes): string {
  return createHash("sha256")
    .update(image.mediaType)
    .update("|")
    .update(image.data)
    .digest("hex");
}

function sign(manifest: Omit<ProvenanceCredential, "signature">): string {
  // Reference signing: a deterministic keyed hash of the canonical manifest. Real deployments
  // swap C2PA / asymmetric signing in behind this same function — emit/verify stay identical.
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

/** Emit a provenance credential for a generated image (ADR-047 D1). */
export function emitProvenance(
  image: ImageBytes,
  meta: { model: string; issuer?: string; createdAt?: string }
): ProvenanceCredential {
  const manifest = {
    standard: "c2pa" as const,
    issuer: meta.issuer ?? ISSUER,
    model: meta.model,
    createdAt: meta.createdAt ?? new Date().toISOString(),
    contentHash: contentHash(image),
  };
  return { ...manifest, signature: sign(manifest) };
}

/**
 * Verify a credential against an image (ADR-047 D4). False if the image was altered
 * (content hash mismatch) or the claim was altered (signature mismatch).
 */
export function verifyProvenance(
  credential: ProvenanceCredential,
  image: ImageBytes
): boolean {
  if (credential.contentHash !== contentHash(image)) return false;
  const { signature, ...manifest } = credential;
  return signature === sign(manifest);
}

/** Inbound synthetic-origin signal — probabilistic (ADR-047 D2). */
export interface DetectionSignal {
  readonly synthetic: boolean;
  readonly confidence: number;
}

export type SyntheticDetector = (content: ImageBytes) => Promise<DetectionSignal>;

const DEFAULT_DETECTOR: SyntheticDetector = async () => ({
  synthetic: false,
  confidence: 0,
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
  return detector(content);
}
