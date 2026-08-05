/**
 * @jest-environment node
 */
/**
 * ProposalStore contract — Supabase reference arm (ADR-027).
 *
 * The real store against an in-memory PostgREST fake. The fake applies PATCH only to rows
 * matching EVERY filter, which is what makes the status=eq.proposed guard real: a second
 * decision matches nothing and returns no rows, exactly as Postgres would.
 *
 * Gotcha 66 applies — this proves the store self-consistent, not schema-conformant.
 */

import { runProposalStoreContract } from "./contract/proposal-store-contract";
import { SupabaseProposalStore } from "@/platform/agents/supabase-proposal-store";

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
  global.fetch = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const u = new URL(String(input));
      const table = u.pathname.split("/rest/v1/")[1] ?? "";
      if (table !== "proposals") return resp({}, 404) as unknown as Response;

      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? (JSON.parse(String(init.body)) as Row) : {};

      if (method === "POST") {
        rows.push({ ...body });
        return resp([{ ...body }], 201) as unknown as Response;
      }

      if (method === "PATCH") {
        const matched = applyFilters(rows, u.searchParams);
        for (const row of matched) {
          for (const [k, v] of Object.entries(body)) row[k] = v;
        }
        return resp(matched.map((r) => ({ ...r }))) as unknown as Response;
      }

      let out = applyFilters(rows, u.searchParams);
      if (u.searchParams.get("order") === "created_at.desc") {
        out = [...out].sort((a, b) =>
          String(b.created_at).localeCompare(String(a.created_at))
        );
      }
      const limit = u.searchParams.get("limit");
      if (limit) out = out.slice(0, Number(limit));
      return resp(out.map((r) => ({ ...r }))) as unknown as Response;
    }
  ) as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe("ProposalStore contract — Supabase (PF reference impl)", () => {
  runProposalStoreContract({
    makeStore: () =>
      new SupabaseProposalStore("https://test.supabase.co", "test-service-key"),
  });
});
