/**
 * @jest-environment node
 */
/**
 * BudgetStore contract — Supabase reference arm (ADR-027).
 *
 * Runs the BudgetStore conformance kit against the real SupabaseBudgetStore, backed by an
 * in-memory PostgREST fake that also implements the agent_budget_consume RPC. The fake's
 * RPC handler does the addition in one synchronous step, exactly as the Postgres function
 * does — so a store that implemented increment as read-then-write would interleave across
 * its awaits and fail the concurrency arm. That is what makes the atomicity contract
 * testable rather than merely documented.
 *
 * Modelled on supabase-trajectory-store-contract.test.ts.
 */

import { runBudgetStoreContract } from "./contract/budget-store-contract";
import { SupabaseBudgetStore } from "@/platform/agents/supabase-budget-store";

type Row = Record<string, unknown>;

let rows: Row[] = [];

function keyOf(r: Row): string {
  return [r.agent_id, r.scope_type, r.scope_id ?? "", r.period].join("\u0000");
}

function applyFilters(all: Row[], params: URLSearchParams): Row[] {
  return all.filter((row) => {
    for (const [k, v] of params.entries()) {
      if (k === "select" || k === "order" || k === "limit") continue;
      if (v === "is.null") {
        if (row[k] !== null && row[k] !== undefined) return false;
      } else if (v === "not.is.null") {
        if (row[k] === null || row[k] === undefined) return false;
      } else if (v.startsWith("eq.")) {
        if (String(row[k]) !== v.slice(3)) return false;
      }
    }
    return true;
  });
}

function resp(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const originalFetch = global.fetch;

beforeEach(() => {
  rows = [];
});

beforeAll(() => {
  const fetchMock = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const u = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? (JSON.parse(String(init.body)) as Row) : {};

      // ── the RPC: upsert-and-return, atomic in one synchronous pass ──
      if (u.pathname.endsWith("/rest/v1/rpc/agent_budget_consume")) {
        const candidate: Row = {
          agent_id: body.p_agent_id,
          scope_type: body.p_scope_type,
          scope_id: body.p_scope_id ?? null,
          period: body.p_period,
        };
        const k = keyOf(candidate);
        const existing = rows.find((r) => keyOf(r) === k);
        const dUsd = Number(body.p_delta_usd ?? 0);
        const dSteps = Number(body.p_delta_steps ?? 0);
        if (existing) {
          existing.used_usd = Number(existing.used_usd) + dUsd;
          existing.used_steps = Number(existing.used_steps) + dSteps;
          return resp([
            { used_usd: existing.used_usd, used_steps: existing.used_steps },
          ]) as unknown as Response;
        }
        const created: Row = { ...candidate, used_usd: dUsd, used_steps: dSteps };
        rows.push(created);
        return resp([
          { used_usd: created.used_usd, used_steps: created.used_steps },
        ]) as unknown as Response;
      }

      const table = u.pathname.split("/rest/v1/")[1] ?? "";
      if (table !== "agent_budgets") return resp({}, 404) as unknown as Response;

      if (method === "DELETE") {
        const matched = applyFilters(rows, u.searchParams);
        rows = rows.filter((r) => !matched.includes(r));
        return resp([]) as unknown as Response;
      }

      const out = applyFilters(rows, u.searchParams).map((r) => ({
        used_usd: r.used_usd,
        used_steps: r.used_steps,
      }));
      return resp(out) as unknown as Response;
    }
  );
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe("BudgetStore contract — Supabase (PF reference impl)", () => {
  runBudgetStoreContract({
    makeStore: () =>
      new SupabaseBudgetStore("https://test.supabase.co", "test-service-key"),
  });
});
