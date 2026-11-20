/**
 * @jest-environment node
 */
/**
 * __tests__/rv9-json-limits.test.ts — Stored caller JSON is bounded, with coded errors (review 9 H2)
 *
 * The four places caller-shaped JSON is stored and an erasure later rewrites — app_sessions.state,
 * trajectory steps, proposal payloads, audit details — refuse a document nested more than
 * STORED_JSON_MAX_DEPTH deep or larger than STORED_JSON_MAX_BYTES, before any SQL runs, with
 * request.json_too_deep / request.json_too_large; a route answers that code, not a 500.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));
jest.mock("@/platform/data", () => require("./helpers/fake-data").fakeDataModule());

import { fakeData } from "./helpers/fake-data";
import fc from "fast-check";
import { fuzzParams } from "./helpers/fuzz";
import { validateConfigValue } from "@/platform/auth/platform-config";
import type { EnhancedConfigEntry } from "@/platform/admin/types";
import {
  asStoredKept,
  assertStorableJson,
  databaseTextBound,
  EFFECT_RECEIPT_MAX_IMAGE_BYTES,
  EFFECT_RECEIPT_MAX_TEXT,
  effectReceiptViolation,
  fromStoredKept,
  isJsonLimitError,
  isOmittedMarker,
  JSON_LIMIT_CODES,
  jsonDepth,
  notKeptReason,
  omittedMarker,
  sliceText,
  storableText,
  JsonLimitError,
  JSON_NUMBER_MAX_MAGNITUDE,
  JSON_NUMBER_MIN_MAGNITUDE,
  STORED_JSON_MAX_BYTES,
  STORED_JSON_MAX_DEPTH,
  storableNumber,
  storedJsonViolation,
  withinDatabaseBound,
} from "@/platform/errors/json-limits";
import { internalError } from "@/platform/errors";
import { PostgresProposalStore } from "@/platform/agents/postgres-proposal-store";
import { PostgresTrajectoryStore } from "@/platform/agents/postgres-trajectory-store";
import { PostgresActivityStateStore } from "@/platform/app-framework/postgres-state-store";
import { recordAudit } from "@/platform/auth/audit";

fc.configureGlobal(fuzzParams());

/** An array nested `d` deep around `leaf`, built without recursion. */
function nested(d: number, leaf: unknown = "x"): unknown {
  let v: unknown = leaf;
  for (let i = 0; i < d; i++) v = [v];
  return v;
}

beforeEach(() => fakeData().reset());

describe("the limits", () => {
  it("measures depth without recursion, even 200 000 deep", () => {
    expect(jsonDepth("x")).toBe(0);
    expect(jsonDepth({ a: [1, { b: 2 }] })).toBe(3);
    expect(jsonDepth(nested(200_000))).toBe(200_000);
    // It stops as soon as the limit is passed.
    expect(jsonDepth(nested(200_000), 10)).toBe(11);
  });

  it("allows the limit itself and refuses one more level", () => {
    expect(storedJsonViolation(nested(STORED_JSON_MAX_DEPTH))).toBeNull();
    expect(storedJsonViolation(nested(STORED_JSON_MAX_DEPTH + 1))).toEqual({
      code: "request.json_too_deep",
      max: STORED_JSON_MAX_DEPTH,
    });
  });

  it("refuses a document larger than the size limit (UTF-8 bytes)", () => {
    expect(storedJsonViolation({ a: "x".repeat(STORED_JSON_MAX_BYTES - 20) })).toBeNull();
    expect(storedJsonViolation({ a: "é".repeat(STORED_JSON_MAX_BYTES / 2) })).toEqual({
      code: "request.json_too_large",
      max: STORED_JSON_MAX_BYTES,
    });
  });

  it("throws the coded error, which a route answers with its code", async () => {
    let caught: unknown;
    try {
      assertStorableJson(nested(1000), "x.y");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JsonLimitError);
    expect(isJsonLimitError(caught)).toBe(true);
    const res = internalError(caught);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "request.json_too_deep",
      params: { max: STORED_JSON_MAX_DEPTH },
    });
    const big = internalError(
      new JsonLimitError("request.json_too_large", STORED_JSON_MAX_BYTES, "x")
    );
    expect(big.status).toBe(413);
  });
});

describe("each write boundary refuses before storing anything", () => {
  const deep = nested(STORED_JSON_MAX_DEPTH + 5);
  const refused = expect.objectContaining({ code: "request.json_too_deep" });

  it("proposals.payload", async () => {
    await expect(
      new PostgresProposalStore().create({
        operationId: "op",
        sessionId: "s",
        trajectoryId: "t",
        label: "l",
        actor: { actorType: "agent", actorId: "a", agentRole: "r" },
        effects: ["stateWrite"],
        effectiveRisk: "restricted",
        payload: { deep },
      })
    ).rejects.toEqual(refused);
    expect(fakeData().statements).toEqual([]);
  });

  it("agent_trajectories.steps", async () => {
    await expect(
      new PostgresTrajectoryStore().addStep("00000000-0000-4000-8000-000000000001", {
        stepIndex: 0,
        action: "a",
        input: { deep },
        output: {},
        cost: 0,
        durationMs: 0,
        timestamp: new Date().toISOString(),
        boundary: "commitment",
      })
    ).rejects.toEqual(refused);
    expect(fakeData().statements).toEqual([]);
  });

  it("app_sessions.state — create, commit and reduceCommit", async () => {
    const store = new PostgresActivityStateStore<unknown>();
    await expect(store.create("s1", { deep })).rejects.toEqual(refused);
    await expect(store.commit("s1", 1, { deep }, "p")).rejects.toEqual(refused);
    expect(fakeData().statements).toEqual([]);
    fakeData().answer = (sql) =>
      /for update/.test(sql) ? [{ state: {}, version: 1, produced_by: null }] : undefined;
    await expect(store.reduceCommit("s1", () => ({ deep }), "p")).rejects.toEqual(
      refused
    );
    expect(fakeData().statements.some((s) => /update app_sessions/.test(s.sql))).toBe(
      false
    );
  });

  it("audit_log.details", async () => {
    await expect(
      recordAudit({ action: "admin_action", details: { deep } })
    ).rejects.toEqual(refused);
    expect(fakeData().statements).toEqual([]);
  });

  it("a document within the limits is stored as before", async () => {
    await recordAudit({ action: "admin_action", details: { ok: nested(10) } });
    expect(fakeData().audit).toHaveLength(1);
  });
});

// ───────────────────────── the number range (platform TASK-229, ADR-058) ─────────────────────────

/**
 * A number as PostgreSQL's jsonb prints it: in full, never with an exponent (numeric_out). The
 * text JSON.stringify writes ("1e-18", "1.5e+20") is expanded to the plain decimal.
 */
function pgNumber(text: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!m) throw new Error(`not a number: ${text}`);
  const [, sign, int, frac = "", exp = "0"] = m;
  const e = Number(exp);
  const digits = int + frac;
  const point = int.length + e;
  const plain =
    point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? digits + "0".repeat(point - digits.length)
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [i, f] = plain.split(".");
  const whole = i.replace(/^0+(?=\d)/, "");
  return sign + (f === undefined ? whole : `${whole}.${f}`);
}

/** A value as jsonb prints it: ", " and ": " between members, numbers in full. */
function pgPrint(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(pgPrint).join(", ")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${JSON.stringify(k)}: ${pgPrint(x)}`)
      .join(", ")}}`;
  if (typeof v === "number") return pgNumber(JSON.stringify(v));
  return JSON.stringify(v);
}

describe("TASK-229: every stored number is 0 or 1e-18 <= |n| < 1e21", () => {
  it.each([
    [0, true],
    [-0, true],
    [1e-18, true],
    [-1e-18, true],
    [9.99e-19, false],
    [5e-324, false],
    [1e20, true],
    [9.99e20, true],
    [1e21, false],
    [-1e21, false],
    [Number.MAX_VALUE, false],
    [Number.MAX_SAFE_INTEGER, true],
    [NaN, true], // written as null
    [Infinity, true], // written as null
  ])("%p storable: %p", (n, ok) => {
    expect(storableNumber(n)).toBe(ok);
    const v = storedJsonViolation({ a: [1, { n }] });
    expect(v === null).toBe(ok);
    if (!ok) {
      expect(v).toEqual({
        code: "request.json_number_out_of_range",
        min: JSON_NUMBER_MIN_MAGNITUDE,
        max: JSON_NUMBER_MAX_MAGNITUDE,
      });
    }
  });

  it("a lone number, a number inside a shared sub-object, and a toJSON value are all read", () => {
    expect(storedJsonViolation(1e-30)?.code).toBe("request.json_number_out_of_range");
    const shared = { p: 1e25 };
    expect(storedJsonViolation({ a: shared, b: shared })?.code).toBe(
      "request.json_number_out_of_range"
    );
    expect(storedJsonViolation({ toJSON: () => ({ p: 1e-30 }) })?.code).toBe(
      "request.json_number_out_of_range"
    );
    expect(storedJsonViolation({ s: "1e-30" })).toBeNull();
  });

  it("refused with the coded error a route answers 422 with (min and max)", async () => {
    let caught: unknown;
    try {
      assertStorableJson({ wei: 1e25 }, "proposals.payload");
    } catch (err) {
      caught = err;
    }
    expect(isJsonLimitError(caught)).toBe(true);
    expect((caught as JsonLimitError).params).toEqual({ min: "1e-18", max: "1e21" });
    const res = internalError(caught);
    expect(res.status).toBe(422);
    expect((await res.json()).message).toContain("between 1e-18 and 1e21");
  });

  it("withinDatabaseBound is the same check (a writer with no limit of its own)", () => {
    expect(withinDatabaseBound({ p: 1e-30 })?.code).toBe(
      "request.json_number_out_of_range"
    );
    expect(withinDatabaseBound({ p: 0.5 })).toBeNull();
  });

  it("[self-test] pgPrint prints numbers as jsonb does", () => {
    expect(pgPrint([1e-18, 1.5e20, -2.5e-7, 0, 123])).toBe(
      "[0.000000000000000001, 150000000000000000000, -0.00000025, 0, 123]"
    );
    expect(pgPrint({ a: [1, "x"] })).toBe('{"a": [1, "x"]}');
  });

  it("property (FC_SEED): every in-range document prints at most 4 x its compact JSON, + 2", () => {
    const inRange = fc
      .oneof(
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        fc.constantFrom(1e-18, -1e-18, 9.999999999999999e20, 1e20, 1.5e-7, 0, -0)
      )
      .filter(storableNumber);
    const doc = fc.letrec((tie) => ({
      value: fc.oneof(
        { depthSize: "small" },
        inRange,
        fc.string(),
        fc.boolean(),
        fc.constant(null),
        fc.array(tie("value"), { maxLength: 5 }),
        fc.dictionary(fc.string({ maxLength: 4 }), tie("value"), { maxKeys: 4 })
      ),
    })).value;
    fc.assert(
      fc.property(doc, (v) => {
        if (storedJsonViolation(v) !== null) return true;
        const compact = JSON.stringify(v);
        return pgPrint(JSON.parse(compact)).length <= 4 * compact.length + 2;
      })
    );
  });

  it("[without-fix] out of range the ratio is unbounded: 5e-324 prints 326 characters from 6", () => {
    const compact = JSON.stringify([5e-324]);
    expect(pgPrint([5e-324]).length).toBeGreaterThan(40 * compact.length);
  });
});

describe("TASK-229: a config value the database would refuse is refused by the validator", () => {
  const numberEntry = {
    key: "k",
    value: 1,
    defaultValue: 1,
    valueType: "number",
    minValue: null,
    maxValue: null,
    allowedValues: null,
  } as unknown as EnhancedConfigEntry;

  it.each([
    ["a number below 1e-18", 1e-20],
    ["a number at 1e21 or more", 1e25],
  ])("%s: 'cannot be stored', never the database's error", (_l, v) => {
    const r = validateConfigValue(numberEntry, v);
    expect(r.valid).toBe(false);
    // Its own reason, worded by the catalogue (code review B-25: it answered "not_serializable").
    expect(r.refusal).toEqual({ reason: "number_out_of_range" });
  });

  it("a number in range is accepted", () => {
    expect(validateConfigValue(numberEntry, 0.25).valid).toBe(true);
  });
});

describe("code review B-6: ordinary arithmetic on small amounts leaves numbers under 1e-18", () => {
  it("the residue of (a + b) - a - b on sub-cent amounts is refused like any number out of range — round before storing", () => {
    // The reviewer's example: 0.00832 + 0.001586, less both, is 6.5e-19 in IEEE 754 doubles.
    const residue = 0.00832 + 0.001586 - 0.00832 - 0.001586;
    expect(residue).not.toBe(0);
    expect(Math.abs(residue)).toBeLessThan(JSON_NUMBER_MIN_MAGNITUDE);
    expect(storedJsonViolation({ remainingUsd: residue })?.code).toBe(
      "request.json_number_out_of_range"
    );
    // What a writer of computed amounts does: round to the precision it means.
    const rounded = Math.round(residue * 1e9) / 1e9;
    expect(storedJsonViolation({ remainingUsd: rounded })).toBeNull();
    expect(
      storedJsonViolation({ total: Math.round((0.00832 + 0.001586) * 1e9) / 1e9 })
    ).toBeNull();
  });
});

describe("code reviews B-12, B-30: text and numbers JSON or jsonb cannot hold are refused, coded", () => {
  it.each([
    ["U+0000 in a string", { s: "a\u0000b" }],
    ["half of a surrogate pair (a text cut inside an emoji)", { s: "ok \ud83d" }],
    ["a low surrogate with no high one before it", ["\udc00x"]],
    ["U+0000 in a key", { ["k\u0000"]: 1 }],
    ["a lone surrogate in a key, deep down", { a: [{ ["\ud83d"]: true }] }],
    ["a BigInt (JSON.stringify would throw a bare TypeError)", { n: BigInt(5) }],
    ["a lone string", "\ud800"],
  ])("%s: request.json_value_not_storable", (_label, value) => {
    expect(storedJsonViolation(value)).toEqual({
      code: "request.json_value_not_storable",
      max: 0,
    });
    expect(withinDatabaseBound(value)?.code).toBe("request.json_value_not_storable");
  });

  it("whole pairs, and every other text, are stored as before", () => {
    expect(storedJsonViolation({ s: "ok 😀", "k😀": "\u0001\u007f￿" })).toBeNull();
    expect(storableText("😀")).toBe(true);
    expect(storableText("\ud83d")).toBe(false);
  });

  it("the refusal is a coded 422 with no params, worded by the catalogue; its stored reason carries the code alone", async () => {
    let caught: unknown;
    try {
      assertStorableJson({ s: "\u0000" }, "audit_log.details");
    } catch (err) {
      caught = err;
    }
    expect(isJsonLimitError(caught)).toBe(true);
    expect((caught as JsonLimitError).params).toEqual({});
    const res = internalError(caught);
    expect(res.status).toBe(422);
    expect((await res.json()).message).toContain("cannot be stored");
    expect(notKeptReason({ code: "request.json_value_not_storable", max: 0 })).toEqual({
      code: "request.json_value_not_storable",
    });
  });

  it("sliceText never cuts a pair in half (a plain slice does)", () => {
    const text = "ab😀cd";
    expect(storableText(text.slice(0, 3))).toBe(false);
    expect(sliceText(text, 3)).toBe("ab");
    expect(sliceText(text, 4)).toBe("ab😀");
    expect(sliceText(text, 99)).toBe(text);
  });
});

describe("a 'not kept' reason is itself storable (the range's limit, 1e21, is outside the range)", () => {
  it("[guard] the number range's reason carries its code alone; depth and size carry their limit", () => {
    const range = notKeptReason({
      code: "request.json_number_out_of_range",
      max: JSON_NUMBER_MAX_MAGNITUDE,
      min: JSON_NUMBER_MIN_MAGNITUDE,
    });
    expect(range).toEqual({ code: "request.json_number_out_of_range" });
    expect(storedJsonViolation({ outputNotRecorded: range })).toBeNull();
    expect(
      storedJsonViolation(
        omittedMarker({ code: "request.json_number_out_of_range", max: 1e21 })
      )
    ).toBeNull();
    expect(
      notKeptReason({ code: "request.json_too_large", max: STORED_JSON_MAX_BYTES })
    ).toEqual({
      code: "request.json_too_large",
      max: STORED_JSON_MAX_BYTES,
    });
  });
});

describe("code review B-29: the number range is worded one way everywhere", () => {
  it("the error's message says 1e21 as its params and the catalogue do (it printed 1e+21)", () => {
    let caught: unknown;
    try {
      assertStorableJson({ a: 1e25 }, "x");
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toBe(
      "x: the document holds a number other than 0 or 1e-18 <= |n| < 1e21"
    );
    expect((caught as Error).message).not.toContain("e+");
  });
});

describe("code review B-11: only the platform's own marker reads as 'not kept'", () => {
  it("the marker holds one of the stored-JSON refusal codes and at most its limit; anything else is a value", () => {
    for (const code of JSON_LIMIT_CODES)
      expect(isOmittedMarker({ _omitted: { code } })).toBe(true);
    expect(
      isOmittedMarker(omittedMarker({ code: "request.json_too_large", max: 5 }))
    ).toBe(true);
    expect(isOmittedMarker({ _omitted: { code: "provider says so" } })).toBe(false);
    expect(
      isOmittedMarker({ _omitted: { code: "request.json_too_large", note: "x" } })
    ).toBe(false);
    expect(
      isOmittedMarker({ _omitted: { code: "request.json_too_large", max: "5" } })
    ).toBe(false);
    expect(
      isOmittedMarker({ _omitted: { code: "request.json_too_large" }, more: 1 })
    ).toBe(false);
    expect(isOmittedMarker({ _omitted: ["request.json_too_large"] })).toBe(false);
  });

  it("a real value of the marker's shape, or of the wrapper's, is stored wrapped and read back whole", () => {
    const marker = { _omitted: { code: "request.json_too_deep", max: 64 } };
    for (const v of [marker, { _kept: 1 }, { _kept: marker }, { _kept: { _kept: 2 } }]) {
      const stored = asStoredKept(v);
      expect(stored).toEqual({ _kept: v });
      expect(isOmittedMarker(stored)).toBe(false);
      expect(fromStoredKept(JSON.parse(JSON.stringify(stored)))).toEqual(v);
    }
    // Every other value is stored as it is.
    for (const v of [
      { id: 1 },
      [1],
      "x",
      null,
      { _omitted: { code: "other" } },
      { _kept: 1, b: 2 },
    ]) {
      expect(asStoredKept(v)).toBe(v);
      expect(fromStoredKept(v)).toBe(v);
    }
  });
});

describe("code review B-1: an effect's receipt is kept up to 6 MiB as the database prints it", () => {
  it("a 2 MB image as base64 is kept; one over the limit is not; the largest image stated is kept", () => {
    const image = (bytes: number) => ({
      mediaType: "image/png",
      data: Buffer.alloc(bytes, 9).toString("base64"),
    });
    expect(effectReceiptViolation(image(2 * 1_048_576))).toBeNull();
    // The other documents' limit (1 MiB of compact JSON) refuses it — the receipt has its own.
    expect(storedJsonViolation(image(2 * 1_048_576))?.code).toBe(
      "request.json_too_large"
    );
    expect(effectReceiptViolation(image(EFFECT_RECEIPT_MAX_IMAGE_BYTES))).toBeNull();
    expect(effectReceiptViolation(image(EFFECT_RECEIPT_MAX_TEXT))).toEqual({
      code: "request.json_too_large",
      max: EFFECT_RECEIPT_MAX_TEXT,
    });
    expect(EFFECT_RECEIPT_MAX_TEXT).toBeLessThan(8 * 1_048_576);
  });

  it("the limit is on what the database prints: numbers at the range's edge are counted at four times their length", () => {
    // 400 000 x 1e-18 is 2.4 MB of compact JSON and prints 8.8 MB in the database.
    const numbers = Array.from({ length: 400_000 }, () => 1e-18);
    expect(JSON.stringify(numbers).length).toBeLessThan(EFFECT_RECEIPT_MAX_TEXT);
    expect(pgPrint(numbers).length).toBeGreaterThan(8 * 1_048_576);
    expect(effectReceiptViolation(numbers)?.code).toBe("request.json_too_large");
  });

  it("depth, the number range and unstorable text refuse a receipt as they do any document", () => {
    expect(effectReceiptViolation(nested(STORED_JSON_MAX_DEPTH + 1))?.code).toBe(
      "request.json_too_deep"
    );
    expect(effectReceiptViolation({ p: 1e-30 })?.code).toBe(
      "request.json_number_out_of_range"
    );
    expect(effectReceiptViolation({ s: "\u0000" })?.code).toBe(
      "request.json_value_not_storable"
    );
  });

  it("property (FC_SEED): databaseTextBound is never under what jsonb prints, for every storable document", () => {
    const inRange = fc
      .oneof(
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        fc.constantFrom(1e-18, -1e-18, 9.999999999999999e20, 1e20, 1.5e-7, 0, -0)
      )
      .filter(storableNumber);
    const text = fc.oneof(
      fc.string(),
      fc.constantFrom('"', "\\", "\n", "\u0001", "é", "😀", ",:")
    );
    const doc = fc.letrec((tie) => ({
      value: fc.oneof(
        { depthSize: "small" },
        inRange,
        text,
        fc.boolean(),
        fc.constant(null),
        fc.array(tie("value"), { maxLength: 5 }),
        fc.dictionary(text, tie("value"), { maxKeys: 4 })
      ),
    })).value;
    fc.assert(
      fc.property(doc, (v) => {
        if (storedJsonViolation(v) !== null) return true;
        const printed = Buffer.byteLength(pgPrint(JSON.parse(JSON.stringify(v))), "utf8");
        return databaseTextBound(v) >= printed;
      })
    );
  });
});
