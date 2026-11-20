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
 * Numbers (platform TASK-229, ADR-058): a stored number is 0 or 1e-18 <= |n| < 1e21 — outside
 * that range JavaScript writes it with an exponent, and PostgreSQL's jsonb prints it in full (a
 * few bytes sent, up to hundreds of characters printed), which is what every erasure path reads.
 * Inside it a number prints at most 4 x as long as JSON.stringify writes it, so every document
 * the application may store (1 MiB of compact JSON) prints at most 4 MiB. Refused with
 * request.json_number_out_of_range, as the database's bound refuses it (migration 074: every
 * jsonb column, 128 levels, the same number range, 8 MiB of printed text — DATABASE_JSON_*).
 *
 * Text and numbers JSON or jsonb cannot hold (code review B-12, B-30): a string or key holding
 * U+0000 or half of a surrogate pair is written by JSON.stringify ("\u0000", "\ud83d") and
 * refused by jsonb (22P05 for U+0000, 22P02 for the surrogate) — after the work, where the work
 * came first; a BigInt makes
 * JSON.stringify throw. Both are refused here with request.json_value_not_storable.
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

/**
 * The database's bound on every stored JSON value (migration 074, ADR-058, docs/JSON_BOUND.md) —
 * documentation constants: __tests__/db/json-bound.db.test.ts reads json_bound_depth_path(),
 * json_bound_limit() and json_bound_number_path() and requires these to equal them.
 */
export const DATABASE_JSON_MAX_DEPTH = 128;
/** The most a stored JSON value may print as text (8 MiB), as the database measures it. */
export const DATABASE_JSON_MAX_TEXT = 8 * 1_048_576;
/** The smallest non-zero magnitude a stored number may have (below it: refused). */
export const JSON_NUMBER_MIN_MAGNITUDE = 1e-18;
/** A stored number's magnitude must be below this (at or above it: refused). */
export const JSON_NUMBER_MAX_MAGNITUDE = 1e21;

/** Whether `n` may be stored: 0, or JSON_NUMBER_MIN_MAGNITUDE <= |n| < JSON_NUMBER_MAX_MAGNITUDE. */
export function storableNumber(n: number): boolean {
  // NaN and the infinities are written as null by JSON.stringify: nothing to print.
  if (!Number.isFinite(n) || n === 0) return true;
  const a = Math.abs(n);
  return a >= JSON_NUMBER_MIN_MAGNITUDE && a < JSON_NUMBER_MAX_MAGNITUDE;
}

/**
 * The most an effect's receipt may print as text in the database (6 MiB; code review B-1). A
 * receipt is what an external call returned — a generated image as base64, the largest — and it
 * is kept so a held effect can be delivered after approval without calling again. The effect
 * ledger is not rewritten by any erasure (it is keyed by operation, platform/auth/user-data.ts),
 * so a receipt needs no room to grow and may come close to the database's 8 MiB; it is measured
 * as an upper bound of what PostgreSQL prints (databaseTextBound), never as compact JSON alone.
 * An image as base64 prints as it is sent: the largest image a held generation can keep is
 * EFFECT_RECEIPT_MAX_IMAGE_BYTES (about 4.4 MiB of image data).
 */
export const EFFECT_RECEIPT_MAX_TEXT = 6 * 1_048_576;
/** The largest image (bytes, before base64) whose receipt is certainly kept: 3/4 of the limit, less 64 KiB for its envelope. */
export const EFFECT_RECEIPT_MAX_IMAGE_BYTES =
  Math.floor((EFFECT_RECEIPT_MAX_TEXT * 3) / 4) - 65_536;

/** Every code a stored-JSON refusal carries. */
export const JSON_LIMIT_CODES = [
  "request.json_too_deep",
  "request.json_too_large",
  "request.json_number_out_of_range",
  "request.json_value_not_storable",
  "request.trajectory_full",
  "request.trajectory_chain_full",
] as const;
export type JsonLimitCode = (typeof JSON_LIMIT_CODES)[number];

/**
 * A string jsonb refuses: it holds U+0000, or a UTF-16 surrogate without its pair (a text cut
 * inside an emoji). JSON.stringify writes both as escapes; PostgreSQL answers 22P05 and 22P02.
 */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Whether `text` can be stored in a jsonb string or key: no U+0000, no surrogate without its pair. */
export function storableText(text: string): boolean {
  return !text.includes("\u0000") && !LONE_SURROGATE.test(text);
}

/**
 * `text` cut to at most `max` UTF-16 units without cutting a surrogate pair in half (a plain
 * slice can end on a high surrogate, which jsonb refuses: code review B-12).
 */
export function sliceText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text[max - 1] ?? "") ? max - 1 : max;
  return text.slice(0, end);
}

/** The number range's two bounds as every message, param and catalogue entry words them. */
const NUMBER_RANGE_WORDS = { min: "1e-18", max: "1e21" } as const;

/** A document refused at a write boundary; carries its coded error (ADR-051). */
export class JsonLimitError extends Error {
  readonly code: JsonLimitCode;
  /**
   * The refusal's values, as the response's params carry them: the limit for depth and size; for
   * the number range its two bounds written as the catalogue words them ("1e-18", "1e21": a number
   * format would print 1e-18 as 0); none for a value that cannot be stored at all.
   */
  readonly params:
    | { readonly max: number }
    | { readonly min: string; readonly max: string }
    | Record<string, never>;
  constructor(code: JsonLimitCode, max: number, where: string) {
    super(
      code === "request.json_too_deep"
        ? `${where}: the document is nested more than ${max} levels deep`
        : code === "request.json_number_out_of_range"
          ? // The bounds as the params and the catalogue word them (code review B-29: a number
            // printed here read "1e+21").
            `${where}: the document holds a number other than 0 or ${NUMBER_RANGE_WORDS.min} <= |n| < ${NUMBER_RANGE_WORDS.max}`
          : code === "request.json_value_not_storable"
            ? `${where}: the document holds a value that cannot be stored (U+0000 or an unpaired surrogate in a text, or a BigInt)`
            : code === "request.trajectory_full"
              ? `${where}: the trajectory holds the most one may (${max} steps, ${TRAJECTORY_MAX_BYTES} bytes); start a new one`
              : code === "request.trajectory_chain_full"
                ? `${where}: the trajectory chain holds the most segments one may (${max}); start a new session or run`
                : `${where}: the document is larger than ${max} bytes`
    );
    this.name = "JsonLimitError";
    this.code = code;
    this.params =
      code === "request.json_number_out_of_range"
        ? { ...NUMBER_RANGE_WORDS }
        : code === "request.json_value_not_storable"
          ? {}
          : { max };
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
  /** True when a number other than 0 or 1e-18 <= |n| < 1e21 was met (the walk stops there). */
  readonly badNumber?: true;
  /** True when a text jsonb refuses, or a BigInt, was met (the walk stops there). */
  readonly badValue?: true;
}

/** Whether a scalar is one jsonb or JSON cannot hold: an unstorable text, or a BigInt. */
function unstorableScalar(v: unknown): boolean {
  return typeof v === "bigint" || (typeof v === "string" && !storableText(v));
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
    if (unstorableScalar(value)) return { depth: 0, bytes: 1, badValue: true };
    return typeof value === "number" && !storableNumber(value)
      ? { depth: 0, bytes: scalarBytes(value), badNumber: true }
      : { depth: 0, bytes: scalarBytes(value) };
  }
  let badKey = false;
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
          .map(([k, x]) => {
            if (!storableText(k)) badKey = true;
            return [k.length + 3, x];
          });
    // Brackets, and a comma between each two members.
    return { v, kids, i: 0, height: 1, bytes: 2 + Math.max(0, kids.length - 1) };
  };
  const stack: Frame[] = [open(value)];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (badKey) return { depth: stack.length, bytes: top.bytes, badValue: true };
    if (top.i < top.kids.length) {
      const [keyBytes, child] = top.kids[top.i++];
      top.bytes += keyBytes;
      if (child === null || typeof child !== "object") {
        if (unstorableScalar(child)) {
          return { depth: stack.length, bytes: top.bytes, badValue: true };
        }
        top.bytes += scalarBytes(child);
        if (typeof child === "number" && !storableNumber(child)) {
          return { depth: stack.length, bytes: top.bytes, badNumber: true };
        }
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

/** A coded refusal: the code, its limit and (for the number range) its lower bound. */
export interface JsonViolation {
  readonly code: JsonLimitCode;
  readonly max: number;
  readonly min?: number;
}

/**
 * The coded refusal for storing `value`, or null when it is within the limits: its depth, its
 * size, and every number 0 or 1e-18 <= |n| < 1e21 (TASK-229).
 */
export function storedJsonViolation(
  value: unknown,
  limits: { readonly maxDepth?: number; readonly maxBytes?: number } = {}
): JsonViolation | null {
  const maxDepth = limits.maxDepth ?? STORED_JSON_MAX_DEPTH;
  const maxBytes = limits.maxBytes ?? STORED_JSON_MAX_BYTES;
  // The least its text can be: a document whose lower bound passes the byte limit is too large
  // without being written out (a small graph of shared sub-objects or strings can expand to more
  // text than memory holds; review 10 L9, review 11 L-1). Within it, the text is at most a few
  // times the bound (escapes), so writing it out to measure exactly is bounded too.
  const measured = measureJson(value, maxDepth, maxBytes);
  if (measured.badValue) {
    return { code: "request.json_value_not_storable", max: 0 };
  }
  if (measured.badNumber) {
    return {
      code: "request.json_number_out_of_range",
      max: JSON_NUMBER_MAX_MAGNITUDE,
      min: JSON_NUMBER_MIN_MAGNITUDE,
    };
  }
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

/**
 * An upper bound of the bytes PostgreSQL prints for `value` as jsonb text, for a value already
 * measured (no cycle, depth and numbers within the limits, no unstorable text): what
 * JSON.stringify writes, plus the space jsonb prints after every "," and ":" (", " and ": "), with
 * every number counted at four times its length (the most a number in range grows: 1e-18 prints
 * 0.000000000000000001). A string prints as JSON.stringify writes it. Walked without recursion;
 * stops once past `stopAt`.
 */
export function databaseTextBound(
  raw: unknown,
  stopAt = Number.POSITIVE_INFINITY
): number {
  const scalar = (v: unknown): number =>
    typeof v === "string"
      ? Buffer.byteLength(JSON.stringify(v), "utf8")
      : typeof v === "number" && Number.isFinite(v)
        ? 4 * String(v).length
        : 5;
  let total = 0;
  const todo: unknown[] = [serialised(raw, "")];
  while (todo.length > 0 && total <= stopAt) {
    const v = todo.pop();
    if (v === null || typeof v !== "object") {
      total += scalar(v);
      continue;
    }
    if (Array.isArray(v)) {
      total += 2 + 2 * Math.max(0, v.length - 1);
      for (let i = 0; i < v.length; i++) todo.push(serialised(v[i], String(i)));
      continue;
    }
    let members = 0;
    for (const [k, x0] of Object.entries(v as Record<string, unknown>)) {
      const x = serialised(x0, k);
      if (omitted(x)) continue;
      members++;
      total += Buffer.byteLength(JSON.stringify(k), "utf8") + 2;
      todo.push(x);
    }
    total += 2 + 2 * Math.max(0, members - 1);
  }
  return total;
}

/**
 * The coded refusal for keeping `receipt` as an effect's receipt, or null when it can be kept
 * (code review B-1): nested at most STORED_JSON_MAX_DEPTH levels, every number in range, every
 * text storable, and printing at most EFFECT_RECEIPT_MAX_TEXT bytes in the database — within the
 * database's own bound (DATABASE_JSON_MAX_TEXT), which no erasure can push a receipt past.
 */
export function effectReceiptViolation(receipt: unknown): JsonViolation | null {
  const shape = storedJsonViolation(receipt, { maxBytes: EFFECT_RECEIPT_MAX_TEXT });
  if (shape) return shape;
  return databaseTextBound(receipt, EFFECT_RECEIPT_MAX_TEXT) > EFFECT_RECEIPT_MAX_TEXT
    ? { code: "request.json_too_large", max: EFFECT_RECEIPT_MAX_TEXT }
    : null;
}

/** Throw the coded JsonLimitError when `value` may not be stored (`where` names the column). */
export function assertStorableJson(value: unknown, where: string): void {
  const violation = storedJsonViolation(value);
  if (violation) throw jsonLimitError(violation, where);
}

/** The JsonLimitError a violation is thrown as (`where` names the column or field). */
export function jsonLimitError(violation: JsonViolation, where: string): JsonLimitError {
  return new JsonLimitError(violation.code, violation.max, where);
}

/**
 * Whether `value` is within what the database stores for a writer with no limit of its own:
 * depth <= 128 is implied by the stricter application limits checked here — depth 64, the number
 * range and STORED_JSON_MAX_BYTES of compact JSON (which prints at most 4 MiB, within the
 * database's 8 MiB). The violation, or null.
 */
export function withinDatabaseBound(value: unknown): JsonViolation | null {
  return storedJsonViolation(value);
}

/**
 * Throw the coded JsonLimitError when `value` is over what the database stores (TASK-229: a
 * writer with no limit of its own refuses before the database would, with a coded error rather
 * than the database's check_violation).
 */
export function assertWithinDatabaseBound(value: unknown, where: string): void {
  const violation = withinDatabaseBound(value);
  if (violation) throw jsonLimitError(violation, where);
}

/**
 * What is stored in place of a value the platform could not keep, where the work it records has
 * already happened (an effect's receipt, a classifier's output — TASK-229, review TA-a-4): the
 * refusal's code and limit, never any of the value. Readers map it to an explicit "not kept"
 * (`resultKept: false`, `classifierOutputNotKept`) and never return it as the value.
 */
export interface OmittedMarker {
  readonly _omitted: NotKeptReason;
}

/**
 * Why a value was not kept, as it can itself be stored: the refusal's code and, for depth and
 * size, its limit. The number range's limits are not stored — 1e21 is itself outside the range
 * the database stores — the code names them (request.json_number_out_of_range).
 */
export interface NotKeptReason {
  readonly code: JsonLimitCode;
  readonly max?: number;
}

/** The storable reason for a value refused with `violation` (see NotKeptReason). */
export function notKeptReason(violation: JsonViolation): NotKeptReason {
  return violation.code === "request.json_number_out_of_range" ||
    violation.code === "request.json_value_not_storable"
    ? { code: violation.code }
    : { code: violation.code, max: violation.max };
}

/** The marker stored for a value refused with `violation`. */
export function omittedMarker(violation: JsonViolation): OmittedMarker {
  return { _omitted: notKeptReason(violation) };
}

/**
 * Whether `x` is a stored "not kept" marker: exactly the one key `_omitted`, holding one of the
 * stored-JSON refusal codes (JSON_LIMIT_CODES) and at most its limit. Any other text in `code` is
 * not a marker (code review B-11: {"_omitted": {"code": "provider says so"}} read as "not kept").
 * A real value that does have this exact shape is stored wrapped (asStoredKept), so what a reader
 * finds in this shape was written by the platform.
 */
export function isOmittedMarker(x: unknown): x is OmittedMarker {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
  const keys = Object.keys(x);
  if (keys.length !== 1 || keys[0] !== "_omitted") return false;
  const inner = (x as { _omitted?: unknown })._omitted;
  if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return false;
  const innerKeys = Object.keys(inner);
  return (
    (JSON_LIMIT_CODES as readonly unknown[]).includes(
      (inner as { code?: unknown }).code
    ) &&
    innerKeys.every((k) => k === "code" || k === "max") &&
    ["number", "undefined"].includes(typeof (inner as { max?: unknown }).max)
  );
}

/** Whether `x` is the wrapper asStoredKept puts round a value (exactly the one key `_kept`). */
function isKeptWrapper(x: unknown): x is { _kept: unknown } {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
  const keys = Object.keys(x);
  return keys.length === 1 && keys[0] === "_kept";
}

/**
 * `value` as it is stored where a "not kept" marker may stand in its place (an effect's receipt,
 * a classifier's output): itself — unless it has the marker's own shape, or this wrapper's, when
 * it is stored as {"_kept": value} so a reader never takes a real value for the platform's
 * marker (code review B-11: a provider or a tool's author chooses what a receipt holds).
 */
export function asStoredKept<T>(value: T): T | { _kept: T } {
  return isOmittedMarker(value) || isKeptWrapper(value) ? { _kept: value } : value;
}

/** What asStoredKept stored, read back: the value itself. */
export function fromStoredKept(stored: unknown): unknown {
  return isKeptWrapper(stored) ? stored._kept : stored;
}

/** Whether `err` is a stored-JSON refusal (also across bundled module copies). */
export function isJsonLimitError(err: unknown): err is JsonLimitError {
  return (
    err instanceof JsonLimitError ||
    (err instanceof Error &&
      err.name === "JsonLimitError" &&
      (JSON_LIMIT_CODES as readonly unknown[]).includes((err as { code?: unknown }).code))
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
