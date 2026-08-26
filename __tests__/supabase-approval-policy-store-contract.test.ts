/**
 * @jest-environment node
 */
/**
 * ApprovalPolicyStore contract — Supabase reference arm (ADR-027 + Sprint 3c A3).
 *
 * The real SupabaseApprovalPolicyStore against an in-memory PostgREST fake. The fake enforces
 * the UNIQUE(version) constraint — a POST whose version already exists returns 409 — so the
 * kit's concurrency arm exercises the real retry path, not a mock that always succeeds.
 *
 * Gotcha 66 applies: this proves the store self-consistent against PostgREST semantics, not
 * schema-conformant against the live database.
 */

import { runApprovalPolicyStoreContract } from "./contract/approval-policy-contract";
import { SupabaseApprovalPolicyStore } from "@/platform/agents/supabase-approval-policy-store";

type Row = Record<string, unknown>;

let rows: Row[] = [];

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
      if (table !== "agent_approval_policy") return resp({}, 404) as unknown as Response;

      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "POST") {
        const body = init?.body ? (JSON.parse(String(init.body)) as Row) : {};
        // UNIQUE(version): reject a duplicate with 409, as Postgres would.
        if (rows.some((r) => r.version === body.version)) {
          return resp(
            { message: "duplicate key value violates unique constraint" },
            409
          ) as unknown as Response;
        }
        rows.push({ ...body });
        return resp([{ ...body }], 201) as unknown as Response;
      }

      // GET: support order=version.desc and limit + select.
      let out = [...rows];
      if (u.searchParams.get("order") === "version.desc") {
        out.sort((a, b) => Number(b.version) - Number(a.version));
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

describe("ApprovalPolicyStore contract — Supabase (PF reference impl)", () => {
  runApprovalPolicyStoreContract({
    makeStore: () =>
      new SupabaseApprovalPolicyStore("https://test.supabase.co", "test-service-key"),
  });
});
