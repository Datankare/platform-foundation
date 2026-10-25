/**
 * platform/errors/json-limits.ts — How deep and how large stored caller JSON may be (review 9 H2)
 *
 * Caller-shaped JSON is stored in four places an erasure later rewrites: app_sessions.state,
 * trajectory steps (agent_trajectories.steps), proposal payloads and audit details. A document
 * nested hundreds deep made the (then recursive) erasure function exceed the stack; one far larger
 * than any real record made it slow. The erasure function no longer recurses and cannot fail on
 * any document (migration 052), and these limits keep what is stored to what a real record needs:
 * a write beyond them is refused with a coded error — request.json_too_deep or
 * request.json_too_large — before anything is stored.
 *
 * The depth walk is iterative (an explicit stack), so checking a hostile document cannot itself
 * exhaust the stack; it measures the depth each value is stored at, a shared sub-object included
 * (review 10 L9), and a lower bound of its size — strings and keys by their length (review 11
 * L-1) — so a document too large is refused without being written out; it is written out to
 * measure exactly only once both are within the limits.
 *
 * @module platform/errors
 */

/** The deepest nesting a stored document may have (an object or array inside another counts 1). */
export const STORED_JSON_MAX_DEPTH = 64;

/** The largest a stored document may be, as UTF-8 JSON text (1 MiB). */
export const STORED_JSON_MAX_BYTES = 1_048_576;

/**
 * The most steps one trajectory (agent_trajectories row) may record (review 10 L10: only each
 * step was bounded, so a run's steps grew without limit — and so did the document an erasure
 * rewrites).
 */
export const TRAJECTORY_MAX_STEPS = 1_000;

/**
 * The most one trajectory's steps may hold, as UTF-8 JSON text (16 MiB). With every step at most
 * STORED_JSON_MAX_BYTES, an erasure rewrites at most this much per trajectory row.
 */
export const TRAJECTORY_MAX_BYTES = 16 * 1_048_576;

export type JsonLimitCode =
  | "request.json_too_deep"
  | "request.json_too_large"
  | "request.trajectory_full"
  | "request.trajectory_chain_full";

/** A document refused at a write boundary; carries its coded error (ADR-051). */
export class JsonLimitError extends Error {
  readonly code: JsonLimitCode;
  readonly params: { readonly max: number };
  constructor(code: JsonLimitCode, max: number, where: string) {
    super(
      code === "request.json_too_deep"
        ? `${where}: the document is nested more than ${max} levels deep`
        : code === "request.trajectory_full"
          ? `${where}: the trajectory holds the most one may (${max} steps, ${TRAJECTORY_MAX_BYTES} bytes); start a new one`
          : code === "request.trajectory_chain_full"
            ? `${where}: the trajectory chain holds the most segments one may (${max}); start a new session or run`
            : `${where}: the document is larger than ${max} bytes`
    );
    this.name = "JsonLimitError";
    this.code = code;
    this.params = { max };
  }
}

/** What measuring a document found: its depth, and the least its JSON text can be. */
interface JsonMeasure {
  /** Nesting depth as stored (a scalar is 0); Infinity for a cycle (it cannot be stored). */
  readonly depth: number;
  /**
   * A lower bound of the UTF-8 bytes JSON.stringify writes (every shared sub-object counted each
   * time it appears): a string's length + 2 (its quotes; each UTF-16 unit is at least one byte),
   * each key's length + 3 (quotes and colon), 1 for any other scalar, a container's brackets and
   * commas (review 11 L-1: a string counted as one value, so 1 200 references to one 1 MB string
   * passed the pre-check and were written out — 1.2 GB, a RangeError).
   */
  readonly bytes: number;
}

/** The least JSON text a scalar can be (an omitted object member is handled by the caller). */
function scalarBytes(v: unknown): number {
  return typeof v === "string" ? v.length + 2 : 1;
}

/**
 * `v` as JSON.stringify writes it at `key` (review 12 L2): what its toJSON returns, when it has one
 * — measured as that value, recursively (its members' own toJSON included), never as one byte —
 * and a boxed primitive as its primitive. Before, a toJSON value counted as a one-byte scalar, so
 * a value whose toJSON returned 20 references to a 1 MB string passed the pre-check and was then
 * written out in full. JSON.stringify calls toJSON once per value, as this does.
 */
function serialised(v: unknown, key: string): unknown {
  let out = v;
  if (
    out !== null &&
    typeof out === "object" &&
    typeof (out as { toJSON?: unknown }).toJSON === "function"
  ) {
    out = (out as { toJSON: (k: string) => unknown }).toJSON(key);
  }
  if (out instanceof Number) return Number(out);
  if (out instanceof String) return String(out);
  if (out instanceof Boolean) return out.valueOf();
  return out;
}

/** Whether JSON.stringify omits `v` as an object member (undefined, a function, a symbol). */
function omitted(v: unknown): boolean {
  return v === undefined || typeof v === "function" || typeof v === "symbol";
}

/**
 * Measure `value` without recursion and without a visited set (review 10 L9).
 *
 * The depth is a property of each object (its height), not of the path it was met on, so it is
 * computed bottom-up and remembered per object: a sub-object shared by two parents has the same
 * height wherever it appears, and JSON.stringify writes it — at full depth — under each. (The
 * earlier visited set skipped a shared sub-object the second time it was met, so one met shallow
 * first hid the depth it is stored at.) Remembering heights keeps the walk linear in the distinct
 * objects, however often they are shared. A cycle is found with the ancestor path (an object
 * that contains itself), never with a visited set. The walk stops once the depth passes
 * `stopDepth` or the byte bound passes `stopBytes`.
 */
function measureJson(raw: unknown, stopDepth: number, stopBytes: number): JsonMeasure {
  const value = serialised(raw, "");
  if (value === null || typeof value !== "object") {
    return { depth: 0, bytes: scalarBytes(value) };
  }
  const memo = new Map<object, JsonMeasure>();
  const onPath = new Set<object>();
  interface Frame {
    readonly v: object;
    /** [key length + 3, or 0 for an array element; the value] */
    readonly kids: [number, unknown][];
    i: number;
    height: number;
    bytes: number;
  }
  const open = (v: object): Frame => {
    onPath.add(v);
    // Each member as it is written (its toJSON applied first, as JSON.stringify does — an
    // omitted result drops an object member; an array writes it as null, one byte or more).
    const kids: [number, unknown][] = Array.isArray(v)
      ? v.map((x, i) => [0, serialised(x, String(i))])
      : Object.entries(v as Record<string, unknown>)
          .map(([k, x]): [string, unknown] => [k, serialised(x, k)])
          .filter(([, x]) => !omitted(x))
          .map(([k, x]) => [k.length + 3, x]);
    // Brackets, and a comma between each two members.
    return { v, kids, i: 0, height: 1, bytes: 2 + Math.max(0, kids.length - 1) };
  };
  const stack: Frame[] = [open(value)];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.i < top.kids.length) {
      const [keyBytes, child] = top.kids[top.i++];
      top.bytes += keyBytes;
      if (child === null || typeof child !== "object") {
        top.bytes += scalarBytes(child);
        if (top.bytes > stopBytes) return { depth: top.height, bytes: top.bytes };
        continue;
      }
      // An ancestor met again: the document contains itself and cannot be stored.
      if (onPath.has(child)) return { depth: Number.POSITIVE_INFINITY, bytes: top.bytes };
      const known = memo.get(child);
      if (known) {
        top.height = Math.max(top.height, known.depth + 1);
        top.bytes += known.bytes;
        if (top.bytes > stopBytes) return { depth: top.height, bytes: top.bytes };
        continue;
      }
      // The depth so far on this path: past the limit, no need to go further.
      if (stack.length + 1 > stopDepth)
        return { depth: stack.length + 1, bytes: top.bytes };
      stack.push(open(child));
      continue;
    }
    stack.pop();
    onPath.delete(top.v);
    const done = { depth: top.height, bytes: top.bytes };
    memo.set(top.v, done);
    if (done.depth > stopDepth || done.bytes > stopBytes) return done;
    const parent = stack[stack.length - 1];
    if (!parent) return done;
    parent.height = Math.max(parent.height, done.depth + 1);
    parent.bytes += done.bytes;
    if (parent.bytes > stopBytes) return { depth: parent.height, bytes: parent.bytes };
  }
  /* istanbul ignore next -- the root frame always returns above */
  return { depth: 0, bytes: 1 };
}

/**
 * The nesting depth of `value` as JSON.stringify would store it (a scalar is 0), walked without
 * recursion; stops past `stopAt`. A cycle is infinitely deep.
 */
export function jsonDepth(value: unknown, stopAt = Number.POSITIVE_INFINITY): number {
  return measureJson(value, stopAt, Number.POSITIVE_INFINITY).depth;
}

/** The coded refusal for storing `value`, or null when it is within both limits. */
export function storedJsonViolation(
  value: unknown,
  limits: { readonly maxDepth?: number; readonly maxBytes?: number } = {}
): { readonly code: JsonLimitCode; readonly max: number } | null {
  const maxDepth = limits.maxDepth ?? STORED_JSON_MAX_DEPTH;
  const maxBytes = limits.maxBytes ?? STORED_JSON_MAX_BYTES;
  // The least its text can be: a document whose lower bound passes the byte limit is too large
  // without being written out (a small graph of shared sub-objects or strings can expand to more
  // text than memory holds; review 10 L9, review 11 L-1). Within it, the text is at most a few
  // times the bound (escapes), so writing it out to measure exactly is bounded too.
  const measured = measureJson(value, maxDepth, maxBytes);
  if (measured.depth > maxDepth) {
    return { code: "request.json_too_deep", max: maxDepth };
  }
  if (measured.bytes > maxBytes) {
    return { code: "request.json_too_large", max: maxBytes };
  }
  const text = JSON.stringify(value);
  if (text !== undefined && Buffer.byteLength(text, "utf8") > maxBytes) {
    return { code: "request.json_too_large", max: maxBytes };
  }
  return null;
}

/** Throw the coded JsonLimitError when `value` may not be stored (`where` names the column). */
export function assertStorableJson(value: unknown, where: string): void {
  const violation = storedJsonViolation(value);
  if (violation) throw new JsonLimitError(violation.code, violation.max, where);
}

/** Whether `err` is a stored-JSON refusal (also across bundled module copies). */
export function isJsonLimitError(err: unknown): err is JsonLimitError {
  return (
    err instanceof JsonLimitError ||
    (err instanceof Error &&
      err.name === "JsonLimitError" &&
      ((err as { code?: unknown }).code === "request.json_too_deep" ||
        (err as { code?: unknown }).code === "request.json_too_large" ||
        (err as { code?: unknown }).code === "request.trajectory_full" ||
        (err as { code?: unknown }).code === "request.trajectory_chain_full"))
  );
}

/** The UTF-8 size of `value` as JSON text (0 for undefined). */
export function jsonBytes(value: unknown): number {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : Buffer.byteLength(text, "utf8");
}

/**
 * Whether a trajectory holding `steps` steps in `bytes` bytes has room for one more step of the
 * largest storable size (a step and its envelope: STORED_JSON_MAX_BYTES and a comma).
 */
export function trajectoryHasRoom(steps: number, bytes: number): boolean {
  return (
    steps < TRAJECTORY_MAX_STEPS &&
    bytes + STORED_JSON_MAX_BYTES + 1 <= TRAJECTORY_MAX_BYTES
  );
}

/** The coded refusal for a full trajectory (`where` names it). */
export function trajectoryFull(where: string): JsonLimitError {
  return new JsonLimitError("request.trajectory_full", TRAJECTORY_MAX_STEPS, where);
}

/** The coded refusal for a chain at its segment cap (review 12 M2; `max` segments). */
export function trajectoryChainFull(where: string, max: number): JsonLimitError {
  return new JsonLimitError("request.trajectory_chain_full", max, where);
}
