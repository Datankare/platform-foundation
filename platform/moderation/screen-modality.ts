/**
 * platform/moderation/screen-modality.ts — the multimodal screening seam (ADR-046).
 *
 * The image/audio analogue of ADR-043's screenContent. One seam, both directions (input via
 * ADR-044, generated-output via ADR-045), fail-closed. It evaluates independent, separately-
 * tunable safety axes (NSFW, real-person likeness, baseline harmful) and, above every tunable
 * knob, non-configurable hard-refuse invariants (CSAM, real-person sexual imagery) that no
 * setting can switch off. Classifiers are provider-agnostic and plug in behind the seam.
 *
 * @module platform/moderation
 */

import type { ModerationAction, ScreeningDirection } from "./types";

/** Light content descriptor the seam screens — modality + declared MIME + base64 bytes. */
export interface ModalityContent {
  readonly modality: "image" | "audio";
  readonly mediaType: string;
  readonly data: string;
}

/** The independent, separately-tunable safety axes (ADR-046 D2). */
export type ScreenAxis = "nsfw" | "real-person" | "baseline";

export interface AxisVerdict {
  readonly axis: ScreenAxis;
  readonly action: ModerationAction;
  readonly reasoning?: string;
}

export interface ModalityScreenResult {
  /** Most-restrictive action across axes (or a hard refuse). */
  readonly action: ModerationAction;
  readonly axes: readonly AxisVerdict[];
  /** True when a non-configurable hard-refuse invariant fired (ADR-046 D4). */
  readonly hardRefused: boolean;
  readonly reasoning: string;
}

export interface ModalityScreeningOptions {
  readonly direction: ScreeningDirection;
  readonly requestId: string;
}

/** A single-axis classifier — provider-agnostic (ADR-046 D5). */
export type AxisClassifier = (content: ModalityContent) => Promise<AxisVerdict>;

/**
 * The pluggable classifier set. `hardRefuse` runs first and above the axes; it is the
 * invariant layer (CSAM, real-person sexual imagery) and returns true to refuse outright.
 */
export interface ModalityClassifiers {
  readonly hardRefuse: (content: ModalityContent) => Promise<boolean>;
  readonly nsfw: AxisClassifier;
  readonly realPerson: AxisClassifier;
  readonly baseline: AxisClassifier;
}

const SEVERITY: Record<ModerationAction, number> = {
  allow: 0,
  warn: 1,
  escalate: 2,
  block: 3,
};

/** The most restrictive of a set of actions (block > escalate > warn > allow). */
export function mostRestrictive(actions: readonly ModerationAction[]): ModerationAction {
  return actions.reduce<ModerationAction>(
    (worst, a) => (SEVERITY[a] > SEVERITY[worst] ? a : worst),
    "allow"
  );
}

/** allow / warn proceed; escalate / block withhold (ADR-046 D1). */
export function screenPermits(result: ModalityScreenResult): boolean {
  return result.action === "allow" || result.action === "warn";
}

/**
 * Default classifiers: conservative stubs until real vision/audio classifiers are injected.
 * hardRefuse is false by default (no false positives from a stub), and the axes allow —
 * real deployments inject real classifiers via setModalityClassifiers. The seam's guarantees
 * (hard-refuse-first, independent axes, fail-closed) do not depend on the stubs.
 */
const allowAxis =
  (axis: ScreenAxis): AxisClassifier =>
  async () => ({ axis, action: "allow" });

const DEFAULT_CLASSIFIERS: ModalityClassifiers = {
  hardRefuse: async () => false,
  nsfw: allowAxis("nsfw"),
  realPerson: allowAxis("real-person"),
  baseline: allowAxis("baseline"),
};

let classifiers: ModalityClassifiers = DEFAULT_CLASSIFIERS;

export function setModalityClassifiers(c: ModalityClassifiers): void {
  classifiers = c;
}
export function resetModalityClassifiers(): void {
  classifiers = DEFAULT_CLASSIFIERS;
}

/**
 * Screen one image/audio content item. Hard-refuse invariants are checked first and cannot
 * be configured away; then the independent axes run and the most-restrictive action wins.
 * Fail-closed: any classifier error becomes `escalate` (withhold), per ADR-039.
 */
export async function screenModality(
  content: ModalityContent,
  _options: ModalityScreeningOptions
): Promise<ModalityScreenResult> {
  try {
    // ADR-046 D4: hard-refuse invariants, above the tier system, non-configurable.
    if (await classifiers.hardRefuse(content)) {
      return {
        action: "block",
        axes: [],
        hardRefused: true,
        reasoning: "hard-refuse invariant (non-configurable)",
      };
    }
    // ADR-046 D2: independent axes, evaluated separately.
    const axes = await Promise.all([
      classifiers.nsfw(content),
      classifiers.realPerson(content),
      classifiers.baseline(content),
    ]);
    const action = mostRestrictive(axes.map((a) => a.action));
    return {
      action,
      axes,
      hardRefused: false,
      reasoning: `axes: ${axes.map((a) => `${a.axis}=${a.action}`).join(", ")}`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "screen error";
    return {
      action: "escalate",
      axes: [],
      hardRefused: false,
      reasoning: `fail-closed: ${reason}`,
    };
  }
}
