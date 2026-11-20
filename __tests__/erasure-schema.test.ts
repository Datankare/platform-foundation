/**
 * __tests__/erasure-schema.test.ts — the erasure runs only with migration 074's rewrite functions,
 * refuses before it writes, counts no attempt, and never refuses a dry run (platform TASK-229;
 * design 56e-3a §2.3, T8; reviews A-6, B-12, B-13, SB-13)
 *
 * What it refuses: an erasure path that writes, or counts a purge attempt, on a database whose rewrite
 * functions are not 074's
 *
 * A stand-in database answers the gate's question (public.erasure_functions_missing(), or the
 * function missing before 074) and records every other statement, so "refused before anything is
 * written" is asserted on what was sent. The real gate and readiness are driven in
 * __tests__/db/json-bound-readiness.db.test.ts (lines 6 and 8).
 */

let gateRows: string[] = [];
const sent: string[] = [];
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));
jest.mock("@/platform/observability/alert", () => ({ raiseAlert: jest.fn() }));
jest.mock("@/platform/auth/audit", () => ({
  ...jest.requireActual("@/platform/auth/audit"),
  // The soft delete's record of its attempt: run the act, as audited() does once recorded.
  audited: async (_entry: unknown, act: () => Promise<unknown>) => act(),
}));
const stand = {
  query: async (text: string) => {
    if (text.includes("erasure_functions_missing") || text.includes("json_bound_missing"))
      return { rows: [{ missing: gateRows }], rowCount: 1 };
    sent.push(text.replace(/\s+/g, " ").trim().slice(0, 60));
    if (/^\s*select user_id from user_deletions/i.test(text))
      return { rows: [{ user_id: "11111111-1111-4111-8111-111111111111" }], rowCount: 1 };
    return { rows: [{ n: 0 }], rowCount: 1 };
  },
};
jest.mock("@/platform/data", () => ({
  ...jest.requireActual("@/platform/data"),
  hasDatabase: () => true,
  withPlatformTx: async (fn: (tx: unknown) => Promise<unknown>) => fn(stand),
  withTenantTx: async (fn: (tx: unknown) => Promise<unknown>) => fn(stand),
  withOwnerTx: async (_role: string, fn: (tx: unknown) => Promise<unknown>) => fn(stand),
}));

import { raiseAlert } from "@/platform/observability/alert";
import {
  ERASURE_FUNCTIONS_MISSING_SQL,
  ERASURE_SCHEMA_MISSING,
  ErasureSchemaMissing,
  requireErasureFunctions,
  resetErasureSchemaAlert,
} from "@/platform/auth/erasure-schema";
import { eraseUserData } from "@/platform/auth/user-data";
import {
  eraseMentionsInOtherTenants,
  purgeDueErasures,
  softDeleteUser,
} from "@/platform/auth/gdpr-deletion";
import { buildReadinessProbes } from "@/platform/providers/readiness-probes";

const USER = "22222222-2222-4222-8222-222222222222";
const NOT_074 = [
  "public.jsonb_erase_id_text(jsonb,text): not as migration 074 makes it (definition, owner or grants)",
];

beforeEach(() => {
  gateRows = [];
  sent.length = 0;
  resetErasureSchemaAlert();
  (raiseAlert as jest.Mock).mockClear();
});

describe("T8: the gate (requireErasureFunctions)", () => {
  it("asks on every call (never a remembered answer); empty: goes on", async () => {
    await requireErasureFunctions(stand as never);
    gateRows = NOT_074;
    await expect(requireErasureFunctions(stand as never)).rejects.toBeInstanceOf(
      ErasureSchemaMissing
    );
  });

  it("refused in this module's words, naming what is wrong, alerted", async () => {
    gateRows = NOT_074;
    const err = (await requireErasureFunctions(stand as never).catch(
      (e: unknown) => e
    )) as ErasureSchemaMissing;
    expect(err.message).toBe(ERASURE_SCHEMA_MISSING);
    expect(err.missing).toEqual(NOT_074);
    expect(raiseAlert).toHaveBeenCalledWith(
      expect.objectContaining({ name: "gdpr.erasure_schema_missing", count: 1 })
    );
  });

  it("alerted at most once per ten minutes per process", async () => {
    gateRows = NOT_074;
    await expect(requireErasureFunctions(stand as never)).rejects.toThrow();
    await expect(requireErasureFunctions(stand as never)).rejects.toThrow();
    expect(raiseAlert).toHaveBeenCalledTimes(1);
  });

  it("without 074 the question still has an answer: the function itself is named missing", () => {
    expect(ERASURE_FUNCTIONS_MISSING_SQL).toContain(
      "to_regprocedure('public.erasure_functions_missing()') is null"
    );
    expect(ERASURE_FUNCTIONS_MISSING_SQL).toContain("074_json_bound.sql: not applied");
  });
});

describe("T8: every erasure path refuses before it writes (A-6, B-12, B-13)", () => {
  it("the soft delete: refused, nothing written, the result says why", async () => {
    gateRows = NOT_074;
    const r = await softDeleteUser(USER, "admin");
    expect(r.success).toBe(false);
    expect(r.errors.join(" ")).toContain(ERASURE_SCHEMA_MISSING);
    expect(sent.filter((s) => /^(?:update|insert|delete)/i.test(s))).toEqual([]);
  });

  it("the purge: no account tried, no attempt counted (purge_attempts untouched), said refused", async () => {
    gateRows = NOT_074;
    const r = await purgeDueErasures("job");
    expect(r).toEqual({
      due: 0,
      purged: 0,
      failed: 0,
      stuck: 0,
      stopped: false,
      refused: true,
    });
    expect(sent).toEqual([]);
    expect(raiseAlert).toHaveBeenCalledWith(
      expect.objectContaining({ name: "gdpr.erasure_schema_missing" })
    );
  });

  it("the cross-tenant pass: refused, nothing tried (A-6)", async () => {
    gateRows = NOT_074;
    const r = await eraseMentionsInOtherTenants();
    expect(r).toEqual({ due: 0, erased: 0, stopped: false, refused: true });
    expect(sent).toEqual([]);
  });

  it("the purge's statements (eraseUserData): refused before the first one", async () => {
    gateRows = NOT_074;
    await expect(eraseUserData(stand as never, USER)).rejects.toBeInstanceOf(
      ErasureSchemaMissing
    );
    expect(sent).toEqual([]);
  });

  it("(B-12) a dry run writes nothing and is never refused", async () => {
    gateRows = NOT_074;
    const steps = await eraseUserData(stand as never, USER, { dryRun: true });
    expect(steps.length).toBeGreaterThan(0);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((s) => /^select/i.test(s))).toBe(true);
  });
});

describe("T8: readiness carries the bound (SB-17), degraded only", () => {
  it("json-bound is a readiness probe that degrades, never one that takes the instance out", () => {
    const { required, degradedOnly } = buildReadinessProbes({
      AI_PROVIDER: "mock",
      AUTH_PROVIDER: "mock",
    } as never);
    expect(degradedOnly.map((p) => p.name)).toContain("json-bound");
    expect(required.map((p) => p.name)).not.toContain("json-bound");
  });
});
