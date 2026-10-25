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
import {
  assertStorableJson,
  isJsonLimitError,
  jsonDepth,
  JsonLimitError,
  STORED_JSON_MAX_BYTES,
  STORED_JSON_MAX_DEPTH,
  storedJsonViolation,
} from "@/platform/errors/json-limits";
import { internalError } from "@/platform/errors";
import { PostgresProposalStore } from "@/platform/agents/postgres-proposal-store";
import { PostgresTrajectoryStore } from "@/platform/agents/postgres-trajectory-store";
import { PostgresActivityStateStore } from "@/platform/app-framework/postgres-state-store";
import { recordAudit } from "@/platform/auth/audit";

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
