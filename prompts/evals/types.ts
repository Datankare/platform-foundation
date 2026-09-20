/**
 * prompts/evals/types.ts — ADR-038 prompt-eval harness types.
 *
 * A suite pairs a registered prompt's own exported parser (and optional builder) with a set of
 * cases. Each case carries a recorded raw model output (`fixture`) that the deterministic lane
 * parses through the prompt's parser, plus coverage `tags` the meta-test enforces. `coverage`
 * declares the enum members that must each be exercised; the meta-test cross-checks that
 * declaration against the prompt source so it cannot fall behind the contract.
 */

/** A coverage tag, e.g. "enum:SafetyCategory:violence", "failclosed:parse-error",
 *  "boundary:confidence-max", "adversarial:injection". */
export type EvalTag = string;

export interface EvalCase<Output> {
  readonly id: string;
  readonly tags: readonly EvalTag[];
  /** Recorded raw model output — the deterministic lane parses this. */
  readonly fixture: string;
  /** Input for the live lane's builder. Optional; the deterministic lane ignores it. */
  readonly input?: unknown;
  /** Assertion over the parsed output. */
  readonly assert: (out: Output) => boolean;
}

/** Declared coverage a suite must satisfy. `enums` maps an exported string-union type name to
 *  the members that must each have a passing, tagged case; the meta-test verifies this list
 *  equals the union's members in the prompt source. */
export interface EvalCoverage {
  readonly enums: Readonly<Record<string, readonly string[]>>;
}

export interface EvalSuite<Output> {
  /** Registry name — must be in PROMPT_REGISTRY. */
  readonly prompt: string;
  /** Source file (relative to repo root) — the meta-test parses it to cross-check `coverage`. */
  readonly source: string;
  /** The prompt's exported parser; the deterministic lane runs each fixture through it. */
  readonly parse: (raw: string) => Output;
  readonly coverage: EvalCoverage;
  readonly cases: readonly EvalCase<Output>[];
}
