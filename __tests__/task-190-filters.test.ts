/**
 * __tests__/task-190-filters.test.ts — One check for a search's filters, shared by the command
 * bar's search, the Users list and the confirm panel (TASK-190)
 *
 * The owner's live check of /admin → Users with "show moderators": the results box drew a second
 * table while the Users list still showed everyone. The Users list (GET /api/admin/users) now
 * takes the users filters, checked by the search's own check (app/api/admin/ai/search-filters.ts),
 * so a value one accepts the other accepts, and one refuses the other refuses. Here, against the
 * fake data layer: the parity of the three callers over hostile and valid values; the list's
 * filters as bound parameters of its fixed statements (text escaped, never SQL); its refusals,
 * permission and paging bound; the search's hand-off filters (validated, unescaped) kept out of
 * the recorded step; the step's ignored keys as a count (residual b); the confirm panel showing a
 * refused value as invalid (residual a). The SQL is proved on Postgres in
 * __tests__/db/task-190-users-filters.db.test.ts.
 */

jest.mock("@/platform/data", () => require("./helpers/fake-data").fakeDataModule());
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
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest } from "next/server";
import { fakeData } from "./helpers/fake-data";
import { authAs, ROLE_PERMISSIONS } from "@/__tests__/helpers/test-identities";
import { GET as usersGET } from "@/app/api/admin/users/route";
import {
  handleSearch,
  parseSearchFilters,
  searchParams,
  searchStepRecord,
  SEARCH_FILTERS as HANDLER_FILTERS,
} from "@/app/api/admin/ai/handlers/search";
import {
  checkSearchFilter,
  parseUserListFilters,
  SEARCH_FILTERS,
  USER_LIST_FILTERS,
} from "@/app/api/admin/ai/search-filters";
import { describeSearch, DESCRIBED_FILTERS } from "@/components/admin/search-description";
import { AUDIT_ACTIONS as SERVER_ACTIONS } from "@/platform/auth/audit";
import { AUDIT_ACTIONS } from "@/platform/auth/audit-actions";
import { SEARCHABLE_TABLES } from "@/app/api/admin/ai/tool-permissions";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";

const ALL: VerifiedAdmin = {
  userId: "00000000-0000-4000-8000-0000000000ad",
  sub: "s",
  roleName: "admin",
  permissions: [...new Set(Object.values(SEARCHABLE_TABLES))],
};

const req = (path: string, caller: "super_admin" | "admin" | "moderator" = "admin") =>
  new NextRequest(`http://localhost${path}`, { headers: authAs(caller) });

beforeEach(() => fakeData().reset());

/** The Users list's page statement (the one `from users u` read), and its values. */
const pageRead = () =>
  fakeData().statements.find((s) => /from users u where/.test(s.sql));

describe("TASK-190: one list of filters and one check, three callers", () => {
  it("the handler, the panel and the list read the same lists (no copies)", () => {
    expect(HANDLER_FILTERS).toBe(SEARCH_FILTERS);
    expect(DESCRIBED_FILTERS).toBe(SEARCH_FILTERS);
    expect(USER_LIST_FILTERS).toEqual(SEARCH_FILTERS.users);
    expect(SERVER_ACTIONS).toBe(AUDIT_ACTIONS);
  });

  /**
   * [filter, value as the planner sends it, accepted]. A query parameter is text, so the list
   * reads a day count from its digits; "7x" or "-1" stay text and are refused by both.
   */
  const CASES: [string, unknown, boolean][] = [
    ["role", "Moderator", true],
    ["role", "  Support Lead ", true],
    ["role", "a".repeat(64), true],
    ["role", "a".repeat(65), false],
    ["role", "mod\u0007erator", false],
    ["role", "x'; drop table users; --", true],
    ["status", "active", true],
    ["status", "deleted", true],
    ["status", "Active", false],
    ["status", "nope", false],
    ["status", "active' or '1'='1", false],
    ["signed_in_within_days", 1, true],
    ["signed_in_within_days", 3650, true],
    ["signed_in_within_days", 0, false],
    ["signed_in_within_days", 3651, false],
    ["signed_in_within_days", "7x", false],
    ["signed_in_within_days", "-1", false],
    ["created_within_days", 30, true],
    ["created_within_days", 2.5, false],
    ["created_within_days", "1e3", false],
    ["text", "a".repeat(100), true],
    ["text", "a".repeat(101), false],
    ["text", "john_doe", true],
    ["text", "100%", true],
    ["text", "\\", true],
  ];

  it.each(CASES)(
    "%s = %p: accepted %p by the search and by the list",
    async (name, raw, ok) => {
      // The search.
      const search = parseSearchFilters("users", { table: "users", [name]: raw });
      expect(search.ok).toBe(ok);
      // The list, given the value as a query parameter.
      fakeData().answer = () => [];
      const res = await usersGET(
        req(`/api/admin/users?${new URLSearchParams({ [name]: String(raw) })}`)
      );
      expect(res.status).toBe(ok ? 200 : 400);
      if (!ok) {
        const body = await res.json();
        expect(body.code).toBe("request.invalid_value");
        expect(body.params?.field ?? body.message).toBeDefined();
        expect(pageRead()).toBeUndefined();
      }
      // The confirm panel: a refused value is never shown as given.
      const described = describeSearch({ table: "users", [name]: raw });
      if (ok) expect(described).not.toMatch(/invalid value/);
      else expect(described).toMatch(new RegExp(`${name} \\(an invalid value`));
    }
  );

  it("both refuse with the same field and the same allowed values", async () => {
    for (const [name, raw] of [
      ["role", "a".repeat(65)],
      ["status", "nope"],
      ["created_within_days", "0"],
      ["text", "a".repeat(101)],
    ] as const) {
      const search = parseSearchFilters("users", {
        [name]: name === "created_within_days" ? 0 : raw,
      });
      expect(search.ok).toBe(false);
      const res = await usersGET(
        req(`/api/admin/users?${new URLSearchParams({ [name]: raw })}`)
      );
      const body = await res.json();
      if (search.ok) continue;
      expect(body.params).toEqual(search.result.params);
    }
  });
});

describe("TASK-190: the Users list takes the users filters as bound parameters", () => {
  it("each filter is a value of the fixed statement, never SQL text", async () => {
    fakeData().answer = () => [];
    const res = await usersGET(
      req(
        "/api/admin/users?" +
          new URLSearchParams({
            role: " moderator' or 1=1 -- ",
            status: "restricted",
            signed_in_within_days: "7",
            created_within_days: "30",
            text: "john_doe%",
          })
      )
    );
    expect(res.status).toBe(200);
    const read = pageRead()!;
    expect(read.values.slice(3)).toEqual([
      "john\\_doe\\%",
      "moderator' or 1=1 --",
      "restricted",
      7,
      30,
    ]);
    expect(read.sql).not.toMatch(/john|moderator'|1=1/);
    // The statement is the same text whatever the values: only the bound values differ.
    fakeData().reset();
    fakeData().answer = () => [];
    await usersGET(req("/api/admin/users?role=x&status=banned&text=y"));
    expect(pageRead()!.sql).toBe(read.sql);
    expect(read.sql).toMatch(/lower\(r\.name\) = lower\(\$5::text\)/);
    expect(read.sql).toMatch(/lower\(r\.display_name\) = lower\(\$5::text\)/);
  });

  it("no filter: every one null (text ''), the statement unchanged in shape", async () => {
    fakeData().answer = () => [];
    await usersGET(req("/api/admin/users"));
    expect(pageRead()!.values.slice(3)).toEqual(["", null, null, null, null]);
  });

  it("the search box and a text filter both apply", async () => {
    fakeData().answer = () => [];
    await usersGET(req("/api/admin/users?q=ann&text=example"));
    const read = pageRead()!;
    expect(read.values[0]).toBe("ann");
    expect(read.values[3]).toBe("example");
  });

  it("an empty parameter is absent; a repeated one is refused", async () => {
    fakeData().answer = () => [];
    expect((await usersGET(req("/api/admin/users?role=&status="))).status).toBe(200);
    expect(pageRead()!.values.slice(4, 6)).toEqual([null, null]);
    fakeData().reset();
    const twice = await usersGET(req("/api/admin/users?role=a&role=b"));
    expect(twice.status).toBe(400);
    expect((await twice.json()).code).toBe("request.invalid_value");
    expect(pageRead()).toBeUndefined();
  });

  it("a filtered list pages as far as a search does (offset 900)", async () => {
    fakeData().answer = () => [];
    await usersGET(req("/api/admin/users?status=active&offset=5000"));
    expect(pageRead()!.values[2]).toBe(900);
    fakeData().reset();
    fakeData().answer = () => [];
    await usersGET(req("/api/admin/users?offset=5000"));
    expect(pageRead()!.values[2]).toBe(5000);
  });

  it("every sort keeps the filters", async () => {
    for (const [sort, dir] of [
      ["created", "desc"],
      ["created", "asc"],
      ["last_sign_in", "desc"],
      ["last_sign_in", "asc"],
    ]) {
      fakeData().reset();
      fakeData().answer = () => [];
      await usersGET(req(`/api/admin/users?sort=${sort}&dir=${dir}&status=banned`));
      expect(pageRead()!.values[5]).toBe("banned");
    }
  });

  it("without admin_manage_users the filters are never read", async () => {
    expect(ROLE_PERMISSIONS.moderator).not.toContain("admin_manage_users");
    const res = await usersGET(req("/api/admin/users?role=admin", "moderator"));
    expect(res.status).toBe(403);
    expect(pageRead()).toBeUndefined();
  });
});

describe("TASK-190: the search hands its validated filters to the screen, not to the step", () => {
  it("table.filters: as validated — trimmed, the text unescaped; bound escaped", async () => {
    fakeData().answer = () => [];
    const res = await handleSearch(
      {
        table: "users",
        role: "  Moderator ",
        text: " john_doe ",
        signed_in_within_days: 7,
        status: null,
      },
      ALL
    );
    expect(res.success).toBe(true);
    expect(res.table?.filters).toEqual({
      role: "Moderator",
      text: "john_doe",
      signed_in_within_days: 7,
    });
    const values = fakeData().statements[0]!.values;
    expect(values[0]).toBe("john\\_doe");
    expect(values[1]).toBe("Moderator");
    // The recorded step never holds them.
    const step = JSON.stringify(
      searchStepRecord(res, { table: "users", role: "Moderator" })
    );
    expect(step).not.toMatch(/Moderator|john/);
    expect(step).not.toMatch(/"filters":\{[^}]*"text"/);
  });

  it("searchParams escapes what parseSearchFilters validated, for every table", () => {
    const parsed = parseSearchFilters("roles", { text: "50%_off\\" });
    expect(parsed.ok && parsed.filters.text).toBe("50%_off\\");
    if (!parsed.ok) return;
    expect(searchParams("roles", parsed.filters)).toEqual(["50\\%\\_off\\\\"]);
  });
});

describe("TASK-190 residual (b): the step records how many keys were ignored, never their names", () => {
  it("an identifier-shaped unknown key (jane_doe) is not recorded", () => {
    const ok = { success: true, result: "No rows of users match." };
    const step = searchStepRecord(ok, {
      table: "users",
      jane_doe: "x",
      kid_smith_2014: 1,
      status: "active",
    });
    const text = JSON.stringify(step);
    expect(text).not.toMatch(/jane_doe|kid_smith/);
    expect(step).toEqual({
      ...ok,
      filters: { table: "users", status: "active" },
      ignored_key_count: 2,
    });
  });

  it("no ignored key: no count", () => {
    const step = searchStepRecord({ success: true }, { table: "roles", text: "x" });
    expect(step).not.toHaveProperty("ignored_key_count");
    expect(step).not.toHaveProperty("ignored_keys");
  });

  it("a refused search counts every key but the table", () => {
    const step = searchStepRecord(
      { success: false, error: "x" },
      { table: "users", jane_doe: 1, role: "Moderator", text: "t" }
    );
    expect(step).toMatchObject({ filters: { table: "users" }, ignored_key_count: 3 });
    expect(JSON.stringify(step)).not.toMatch(/jane_doe|Moderator/);
  });
});

describe("TASK-190 residual (a): the confirm panel shows a value the server will refuse as invalid", () => {
  it.each([
    [{ table: "users", status: "superuser" }, "status"],
    [{ table: "audit_log", actor_id: "not-a-uuid" }, "actor_id"],
    [{ table: "audit_log", target_id: "12345" }, "target_id"],
    [{ table: "audit_log", action: "drop_everything" }, "action"],
    [{ table: "users", text: "a".repeat(101) }, "text"],
    [{ table: "users", query: "a".repeat(101) }, "query"],
    [{ table: "users", role: "r".repeat(65) }, "role"],
    [{ table: "platform_config", category: "bad category!" }, "category"],
  ])("%p → %s named as invalid, its value never shown", (input, name) => {
    const text = describeSearch(input);
    expect(text).toContain(`${name} (an invalid value: the search will be refused)`);
    const value = Object.values(input)[1] as string;
    expect(text).not.toContain(value);
  });

  it("a valid value is shown as the server will use it (trimmed)", () => {
    expect(
      describeSearch({ table: "users", role: "  Moderator ", status: "banned" })
    ).toBe("Search users where role is Moderator, status is banned");
    expect(
      describeSearch({
        table: "audit_log",
        actor_id: "00000000-0000-4000-8000-0000000000AA",
        action: "role_changed",
      })
    ).toBe(
      "Search audit_log where actor is 00000000-0000-4000-8000-0000000000aa, action is role_changed"
    );
  });

  it("a text of spaces only is no filter, to the server and to the panel", () => {
    expect(describeSearch({ table: "users", text: "   " })).toBe("Search users");
    const parsed = parseSearchFilters("users", { text: "   " });
    expect(parsed.ok && parsed.filters).toEqual({});
  });

  it("the panel and the server agree on every filter of every table", () => {
    const samples: unknown[] = [
      "x",
      "",
      " ",
      7,
      0,
      "active",
      "role_changed",
      "00000000-0000-4000-8000-0000000000aa",
      "a".repeat(101),
      { a: 1 },
      ["x"],
      true,
    ];
    for (const table of Object.keys(SEARCH_FILTERS) as (keyof typeof SEARCH_FILTERS)[]) {
      for (const name of SEARCH_FILTERS[table]) {
        for (const raw of samples) {
          if (raw === "") continue; // the panel shows nothing for an empty string
          const server = parseSearchFilters(table, { [name]: raw });
          const panel = describeSearch({ table, [name]: raw });
          expect([table, name, raw, panel.includes("invalid value")]).toEqual([
            table,
            name,
            raw,
            !server.ok,
          ]);
        }
      }
    }
  });

  it("checkSearchFilter: none for null and undefined", () => {
    expect(checkSearchFilter("role", null)).toEqual({ ok: true, value: null });
    expect(checkSearchFilter("status", undefined)).toEqual({ ok: true, value: null });
  });

  it("parseUserListFilters reads only the users filters", () => {
    const parsed = parseUserListFilters(
      new URLSearchParams({ action: "role_changed", actor_id: "x", status: "active" })
    );
    expect(parsed).toEqual({ ok: true, filters: { status: "active" } });
  });
});
