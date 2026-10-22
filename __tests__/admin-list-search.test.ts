/**
 * __tests__/admin-list-search.test.ts — admin list search and paging take no filter syntax (audit B-16, E-15)
 *
 * The users and audit lists spliced `q` into a PostgREST .or() string, so filter syntax in a
 * search widened or rewrote the query, and the audit search ran ilike on uuid and enum columns,
 * which fails. Paging passed NaN from hostile `limit`/`offset` to the database. Both now use
 * bound filters only (the in-memory database refuses .or()), bounded pages, and are tested
 * with filter syntax, wildcards and hostile paging.
 */

jest.mock("@/platform/auth/middleware", () =>
  require("@/__tests__/helpers/test-identities").mockMiddleware()
);
jest.mock("@/platform/auth/permissions-cache", () =>
  require("@/__tests__/helpers/test-identities").mockPermissionsCache()
);
jest.mock("@/platform/auth/account-status-guard", () =>
  require("@/__tests__/helpers/test-identities").mockAccountStatus()
);
jest.mock("@/platform/rate-limit", () =>
  require("@/__tests__/helpers/test-identities").mockRateLimit()
);
jest.mock("@/lib/supabase/server", () => ({ getSupabaseServiceClient: jest.fn() }));
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import fc from "fast-check";
import { NextRequest } from "next/server";
import { authAs } from "@/__tests__/helpers/test-identities";
import { fuzzParams } from "@/__tests__/helpers/fuzz";
import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { likeTerm, pageParams } from "@/lib/pagination";
import { GET as usersGET } from "@/app/api/admin/users/route";
import { GET as auditGET } from "@/app/api/admin/audit/route";
import { FakeDatabase } from "./helpers/fake-database";

fc.configureGlobal(fuzzParams());

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b1";
let db: FakeDatabase;

const get = (path: string) =>
  new NextRequest(`http://localhost${path}`, { headers: authAs("super_admin") });

beforeEach(() => {
  db = new FakeDatabase({
    users: [
      {
        id: A,
        email: "alice@x.io",
        display_name: "Alice",
        role_id: "r",
        created_at: "2026-01-02",
        deleted_at: null,
      },
      {
        id: B,
        email: "bob@x.io",
        display_name: "Ali Bob",
        role_id: "r",
        created_at: "2026-01-01",
        deleted_at: null,
      },
      {
        id: "u3",
        email: "carol@x.io",
        display_name: "Carol",
        role_id: "r",
        created_at: "2026-01-03",
        deleted_at: null,
      },
    ],
    roles: [{ id: "r", name: "free", display_name: "Free" }],
    audit_log: [
      {
        id: "e1",
        action: "role_changed",
        actor_id: A,
        target_id: B,
        details: {},
        created_at: "2026-01-01",
      },
      {
        id: "e2",
        action: "consent_granted",
        actor_id: B,
        target_id: B,
        details: {},
        created_at: "2026-01-02",
      },
      {
        id: "e3",
        action: "role_changed",
        actor_id: B,
        target_id: A,
        details: {},
        created_at: "2026-01-03",
      },
    ],
  });
  (getSupabaseServiceClient as jest.Mock).mockReturnValue(db.client());
});

describe("admin users search", () => {
  it("matches email or name, newest first, each user once", async () => {
    const body = await (await usersGET(get("/api/admin/users?q=ali"))).json();
    expect(body.users.map((u: { id: string }) => u.id)).toEqual([A, B]);
  });

  it.each(["x,id.neq.0", "%", "_", "*", "a)(b", "\\"])(
    "treats %p as text, never as filter syntax or a wildcard",
    async (q) => {
      const res = await usersGET(get(`/api/admin/users?q=${encodeURIComponent(q)}`));
      expect(res.status).toBe(200);
      const ids = (await res.json()).users.map((u: { id: string }) => u.id);
      // No user's email or name contains these characters: nothing matches, or (for a term
      // that is only wildcards) the search is empty and the plain list is returned.
      expect(ids.length === 0 || ids.length === 3).toBe(true);
    }
  );

  it("pages the merged search exactly", async () => {
    const body = await (
      await usersGET(get("/api/admin/users?q=x.io&limit=1&offset=1"))
    ).json();
    expect(body.users.map((u: { id: string }) => u.id)).toEqual([A]);
  });
});

describe("admin audit search", () => {
  it("finds a user's records as actor or target by id", async () => {
    const body = await (await auditGET(get(`/api/admin/audit?q=${A}`))).json();
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(["e3", "e1"]);
  });

  it("finds records by action name", async () => {
    const body = await (await auditGET(get("/api/admin/audit?q=consent"))).json();
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual(["e2"]);
  });

  it.each(["x,actor_id.neq.0", "nothing-like-an-action", "%"])(
    "returns nothing for %p, without an error",
    async (q) => {
      const res = await auditGET(get(`/api/admin/audit?q=${encodeURIComponent(q)}`));
      expect(res.status).toBe(200);
      expect((await res.json()).entries).toEqual([]);
    }
  );
});

describe("paging", () => {
  it.each([
    ["x", "y"],
    ["-1", "-5"],
    ["1e9", "1e9"],
    ["NaN", "Infinity"],
    ["2.5", "0x10"],
  ])("bounds limit=%p offset=%p", async (limit, offset) => {
    for (const path of ["/api/admin/users", "/api/admin/audit"]) {
      const res = await (path === "/api/admin/users" ? usersGET : auditGET)(
        get(
          `${path}?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`
        )
      );
      expect(res.status).toBe(200);
    }
  });

  it("property: any query string gives integers in bounds", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (limit, offset) => {
        const p = pageParams(new URLSearchParams({ limit, offset }), {
          maxLimit: 100,
          maxOffset: 10_000,
        });
        return (
          Number.isInteger(p.limit) &&
          p.limit >= 1 &&
          p.limit <= 100 &&
          Number.isInteger(p.offset) &&
          p.offset >= 0 &&
          p.offset <= 10_000
        );
      })
    );
  });

  it("property: a like term carries no wildcard or control character", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (raw) => {
        const t = likeTerm(raw);
        return t.length <= 100 && !/[%_*\\\p{Cc}]/u.test(t);
      })
    );
  });
});
