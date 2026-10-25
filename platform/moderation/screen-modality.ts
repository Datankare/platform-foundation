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
 * Default classifiers: none is configured, so nothing is cleared (audit X-18). Before: allow-all
 * stubs, so every image and audio item — including the CSAM hard refusal's — passed on a
 * placeholder. Now every axis escalates (withholds) until an app sets real classifiers with
 * setModalityClassifiers; the seam's guarantees (hard-refuse first, independent axes, fail
 * closed) do not depend on them.
 */
const UNCONFIGURED = "no classifier configured";
const unconfiguredAxis =
  (axis: ScreenAxis): AxisClassifier =>
  async () => ({ axis, action: "escalate", reasoning: UNCONFIGURED });

const DEFAULT_CLASSIFIERS: ModalityClassifiers = {
  hardRefuse: async () => false,
  nsfw: unconfiguredAxis("nsfw"),
  realPerson: unconfiguredAxis("real-person"),
  baseline: unconfiguredAxis("baseline"),
};

/** Whether real classifiers have been set (false: every item is withheld). */
export function modalityClassifiersConfigured(): boolean {
  return classifiers !== DEFAULT_CLASSIFIERS;
}

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
    const known: readonly ModerationAction[] = ["allow", "warn", "escalate", "block"];
    // A classifier that answers something other than an action has not cleared the item.
    const action = mostRestrictive(
      axes.map((a) => (known.includes(a?.action) ? a.action : "escalate"))
    );
    return {
      action,
      axes,
      hardRefused: false,
      reasoning: modalityClassifiersConfigured()
        ? `axes: ${axes.map((a) => `${a?.axis}=${a?.action}`).join(", ")}`
        : `withheld: ${UNCONFIGURED}`,
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
