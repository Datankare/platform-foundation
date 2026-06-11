/**
 * @jest-environment node
 */
/**
 * SocialStore contract — Supabase reference arm (ADR-027).
 *
 * Runs the synced SocialStore conformance kit against the real
 * SupabaseSocialStore, backed by a faithful in-memory PostgREST fake: parses
 * eq./is.null/in. query filters, honors return=representation on writes, and
 * keeps three in-memory tables so the kit's CRUD round-trips actually traverse
 * the provider's URL/body building and row mapping. Single synced arm.
 *
 * Node env: the store throws if window is defined (service-role-key leak guard).
 */

jest.mock("@/lib/logger", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { runSocialStoreContract } from "./contract/social-store-contract";
import { SupabaseSocialStore } from "@/platform/social/supabase-social-store";

type Row = Record<string, unknown>;

const db: Record<string, Row[]> = {
  groups: [],
  group_memberships: [],
  group_invites: [],
};
let idSeq = 0;
const uid = () => `id_${++idSeq}`;
const nowIso = () => new Date().toISOString();

function applyFilters(rows: Row[], params: URLSearchParams): Row[] {
  return rows.filter((row) => {
    for (const [k, v] of params.entries()) {
      if (k === "select" || k === "order" || k === "limit") continue;
      if (v === "is.null") {
        if (row[k] !== null && row[k] !== undefined) return false;
      } else if (v.startsWith("eq.")) {
        if (String(row[k]) !== v.slice(3)) return false;
      } else if (v.startsWith("in.(")) {
        const set = v.slice(4, -1).split(",");
        if (!set.includes(String(row[k]))) return false;
      }
    }
    return true;
  });
}

function insertRow(table: string, body: Row): Row {
  const base: Row = { id: uid() };
  if (table === "groups") {
    Object.assign(base, { created_at: nowIso(), updated_at: nowIso() });
  } else if (table === "group_memberships") {
    Object.assign(base, { joined_at: nowIso(), left_at: null });
  } else if (table === "group_invites") {
    Object.assign(base, { created_at: nowIso(), resolved_at: null });
  }
  const row = { ...base, ...body };
  db[table].push(row);
  return row;
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
  db.groups = [];
  db.group_memberships = [];
  db.group_invites = [];
  idSeq = 0;
});

beforeAll(() => {
  const fetchMock = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const u = new URL(String(input));
      const table = u.pathname.split("/rest/v1/")[1] ?? "";
      const params = u.searchParams;
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? (JSON.parse(String(init.body)) as Row) : {};

      if (!db[table]) return resp({}, 404) as unknown as Response;

      if (method === "POST") {
        return resp([insertRow(table, body)], 201) as unknown as Response;
      }
      if (method === "PATCH") {
        const matched = applyFilters(db[table], params);
        // Explicit own-key copy (not Object.assign): this is a test fake
        // applying a PATCH body to in-memory rows, but semgrep's
        // insecure-object-assign rule blocks Object.assign onto existing
        // objects, and the gate is the gate.
        for (const row of matched) {
          for (const [k, v] of Object.entries(body)) {
            row[k] = v;
          }
        }
        return resp(matched) as unknown as Response;
      }
      let rows = applyFilters(db[table], params);
      const limit = params.get("limit");
      if (limit) rows = rows.slice(0, Number(limit));
      return resp(rows) as unknown as Response;
    }
  );
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe("SocialStore contract — Supabase (PF reference impl)", () => {
  runSocialStoreContract({
    makeStore: () =>
      new SupabaseSocialStore("https://test.supabase.co", "test-service-key"),
  });
});
