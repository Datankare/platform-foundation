/**
 * @jest-environment node
 */
/**
 * TrajectoryStore contract — Supabase reference arm (ADR-027).
 *
 * Runs the TrajectoryStore conformance kit against the real SupabaseTrajectoryStore,
 * backed by an in-memory PostgREST fake: parses eq. filters, honours
 * return=representation, and applies PATCH only to rows matching every filter — which
 * is what makes the version CAS real rather than simulated. The store's URL building,
 * filter construction, row mapping and retry loop all execute.
 *
 * Modelled on supabase-social-store-contract.test.ts.
 */

import { runTrajectoryStoreContract } from "./contract/trajectory-store-contract";
import { SupabaseTrajectoryStore } from "@/platform/agents/supabase-trajectory-store";

type Row = Record<string, unknown>;

let rows: Row[] = [];

function applyFilters(all: Row[], params: URLSearchParams): Row[] {
  return all.filter((row) => {
    for (const [k, v] of params.entries()) {
      if (k === "select" || k === "order" || k === "limit") continue;
      if (v.startsWith("eq.")) {
        if (String(row[k]) !== v.slice(3)) return false;
      } else if (v === "is.null") {
        if (row[k] !== null && row[k] !== undefined) return false;
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
      const table = u.pathname.split("/rest/v1/")[1] ?? "";
      if (table !== "agent_trajectories") return resp({}, 404) as unknown as Response;

      const params = u.searchParams;
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? (JSON.parse(String(init.body)) as Row) : {};

      if (method === "POST") {
        rows.push({ ...body });
        return resp([{ ...body }], 201) as unknown as Response;
      }

      if (method === "PATCH") {
        // The CAS lives here: the version filter is one of the params, so a stale
        // version simply matches nothing and the store sees zero rows returned.
        const matched = applyFilters(rows, params);
        for (const row of matched) {
          for (const [k, v] of Object.entries(body)) {
            row[k] = v;
          }
        }
        return resp(matched.map((r) => ({ ...r }))) as unknown as Response;
      }

      let out = applyFilters(rows, params);
      const order = params.get("order");
      if (order === "created_at.desc") {
        out = [...out].sort((a, b) =>
          String(b.created_at).localeCompare(String(a.created_at))
        );
      }
      const limit = params.get("limit");
      if (limit) out = out.slice(0, Number(limit));
      return resp(out.map((r) => ({ ...r }))) as unknown as Response;
    }
  );
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe("TrajectoryStore contract — Supabase (PF reference impl)", () => {
  runTrajectoryStoreContract({
    makeStore: () =>
      new SupabaseTrajectoryStore("https://test.supabase.co", "test-service-key"),
  });
});
