/**
 * platform/agents/schema.ts — JSON Schema enforcement for tool contracts (ADR-029 D3)
 *
 * Before this, `Tool.inputSchema` and `outputSchema` were descriptive metadata — the
 * config-handlers header said so outright — and the P6 structured-output claim rested on
 * declarations nothing checked.
 *
 * ajv is pinned exactly rather than by caret range. package*.json is excluded from the
 * Playform sync, so a range lets the two repos resolve different versions independently;
 * that is exactly how the prettier drift in TASK-059 happened, and a validator behaving
 * differently across repos is worse than a formatter doing so.
 *
 * @module platform/agents
 */

import Ajv from "ajv";
import type { ValidateFunction } from "ajv";

/**
 * strict: false because tool schemas are authored for LLM consumption and carry keywords
 * ajv's strict mode rejects (title, examples). allErrors so a failure reports every problem
 * rather than the first — a retry prompt built from one error at a time converges slowly.
 */
const ajv = new Ajv({ allErrors: true, strict: false });

// Compiled validators are cached on the schema object identity. Tool schemas are module
// constants, so this is a hit on every call after the first.
const compiled = new WeakMap<object, ValidateFunction>();

function validatorFor(schema: Record<string, unknown>): ValidateFunction {
  const hit = compiled.get(schema);
  if (hit) return hit;
  const fn = ajv.compile(schema);
  compiled.set(schema, fn);
  return fn;
}

export type SchemaEdge = "input" | "output";

/** Raised when a tool's input or output fails its declared schema. */
export class SchemaValidationError extends Error {
  constructor(
    message: string,
    readonly edge: SchemaEdge,
    readonly toolId: string,
    readonly errors: readonly string[]
  ) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

/**
 * Validate `data` against `schema`. Throws SchemaValidationError on failure.
 *
 * Never coerces. A tool returning output that fails its own schema is a tool that failed,
 * not a tool that succeeded with unusual data (ADR-029 D3).
 */
export function assertValidSchema(
  schema: Record<string, unknown>,
  data: unknown,
  edge: SchemaEdge,
  toolId: string
): void {
  const validate = validatorFor(schema);
  if (validate(data)) return;

  const errors = (validate.errors ?? []).map(
    (e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`
  );
  throw new SchemaValidationError(
    `tool ${toolId}: ${edge} failed its schema — ${errors.join("; ")}`,
    edge,
    toolId,
    errors
  );
}

/** Non-throwing form, for callers deciding whether to retry. */
export function isValidSchema(schema: Record<string, unknown>, data: unknown): boolean {
  return validatorFor(schema)(data) === true;
}
