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

/**
 * One live-lane case (ADR-038 §1, TASK-204 N-43): an input the prompt's builder takes, sent to the
 * real model, and an assertion over the parsed answer. Assertions are about meaning a correct
 * model gives every time (a plainly safe text is safe; a speech description is speech), never a
 * grade by another model (D2).
 */
export interface LiveCase<Output, Input> {
  readonly id: string;
  readonly input: Input;
  readonly assert: (out: Output) => boolean;
}

/** How the live lane calls the model for a suite's prompt: as production calls it. */
export interface LiveLane<Output, Input> {
  /** The prompt's registered config (its name, tier, max tokens, temperature). */
  readonly config: {
    readonly name: string;
    readonly tier: "fast" | "standard";
    readonly maxTokens: number;
    readonly temperature?: number;
  };
  /** The prompt's own builder: its text is the one user message, as production sends it. */
  readonly build: (input: Input) => string;
  readonly cases: readonly LiveCase<Output, Input>[];
}

export interface EvalSuite<Output, Input = unknown> {
  /** Registry name — must be a registered prompt (listPrompts: the core's or a module's). */
  readonly prompt: string;
  /** Source file (relative to repo root) — the meta-test parses it to cross-check `coverage`. */
  readonly source: string;
  /** The prompt's exported parser; the deterministic lane runs each fixture through it. */
  readonly parse: (raw: string) => Output;
  readonly coverage: EvalCoverage;
  readonly cases: readonly EvalCase<Output>[];
  /** The live lane's cases (`npm run eval:live`); every suite has them (the meta-test). */
  readonly live: LiveLane<Output, Input>;
}

/** Erase a suite's output type for heterogeneous storage; parse+assert stay internally
 *  consistent, so the cast is safe. */
export function defineSuite<O, I>(s: EvalSuite<O, I>): EvalSuite<unknown> {
  return s as unknown as EvalSuite<unknown>;
}
