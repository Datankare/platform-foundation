/**
 * __tests__/task-189-search.test.ts — The command bar's search shows only allowlisted columns and
 * reads its filters (TASK-189)
 *
 * Found in a live check: every search statement was `select to_jsonb(t) … from <table> t` — every
 * column of every row (a user's date of birth, identity-provider subject, real name, ban reason,
 * parental consent address), shown as one JSON text and recorded in the action's step — and the
 * required `query` was never read, so "users who signed in this week" listed every user.
 *
 * Here: no statement reads a whole row; each selects exactly its allowlist; a row carrying a
 * sensitive column never puts it in the result; each filter is a bound parameter of a fixed
 * statement, validated first; hostile and malformed values are refused before any statement; the
 * permission per table is unchanged. Review round 1: the step records ids and counts only, the
 * admin's text as its length; a database error is logged, never returned; matches are counted.
 * The panel's table: task-189-search-panel.test.tsx. The SQL is
 * proved against Postgres in __tests__/db/task-189-search.db.test.ts.
 */

jest.mock("@/platform/data", () => require("./helpers/fake-data").fakeDataModule());

import { fakeData } from "./helpers/fake-data";
import {
  handleSearch,
  parseSearchFilters,
  searchParams,
  SEARCH_COLUMNS,
  SEARCH_FILTERS,
  SEARCH_SQL,
  SEARCH_USERS_BY_SIGN_IN_SQL,
  searchStepRecord,
  type SearchableTable,
} from "@/app/api/admin/ai/handlers/search";
import { SEARCHABLE_TABLES } from "@/app/api/admin/ai/tool-permissions";
import { SHARED_TOOLS } from "@/app/api/admin/ai/tool-schemas";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";

const TABLES = Object.keys(SEARCHABLE_TABLES) as SearchableTable[];

/** Every users column the Users screen does not show — none may ever be in a search result. */
const USERS_SENSITIVE = [
  "cognito_sub",
  "guest_token",
  "real_name",
  "date_of_birth",
  "age_verified",
  "age_verified_at",
  "parental_consent_status",
  "parental_consent_email",
  "ban_reason",
  "banned_at",
  "status_changed_by",
  "status_changed_at",
  "coppa_enforcement_active",
  "tenant_id",
  "avatar_url",
  "timezone",
  "mfa_enabled",
  "deleted_at",
  "account_status",
  "restricted_until",
  "suspended_until",
  "role_id",
];

/** A users row as `to_jsonb(t)` read it: every column, with telling values. */
const WHOLE_USER = {
  id: "00000000-0000-4000-8000-0000000000a1",
  email: "a@x.test",
  display_name: "Alice",
  role: "free",
  status: "active",
  status_until: null,
  email_verified: true,
  created_at: new Date("2026-01-02T00:00:00Z"),
  last_sign_in_at: null,
  cognito_sub: "SUB-SECRET",
  guest_token: "GUEST-SECRET",
  real_name: "REAL-NAME-SECRET",
  date_of_birth: "2012-03-04",
  parental_consent_email: "PARENT@SECRET.test",
  ban_reason: "BAN-SECRET",
  status_changed_by: "CHANGED-BY-SECRET",
  tenant_id: "TENANT-SECRET",
};

const ALL: VerifiedAdmin = {
  userId: "00000000-0000-4000-8000-0000000000ad",
  sub: "s",
  roleName: "admin",
  permissions: [...new Set(Object.values(SEARCHABLE_TABLES))],
};

beforeEach(() => fakeData().reset());

/** SQL as the fake data layer logs it: whitespace collapsed. */
const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

/** A select list's items, split at the top-level commas only. */
function selectList(sql: string): string[] {
  const body = sql.slice(sql.indexOf("select") + 6);
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (depth === 0 && /^\s+from\s/i.test(body.slice(i, i + 6))) break;
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      items.push(current);
      current = "";
    } else current += ch;
  }
  items.push(current);
  return items.map((item) => {
    const named = item.trim().split(/\s+as\s+/);
    return named[named.length - 1].split(".").pop()!.trim();
  });
}

const STATEMENTS: [string, string, SearchableTable][] = [
  ...TABLES.map((t): [string, string, SearchableTable] => [t, SEARCH_SQL[t], t]),
  ["users by sign-in", SEARCH_USERS_BY_SIGN_IN_SQL, "users"],
];

describe("TASK-189: no whole-row select", () => {
  it.each(STATEMENTS)(
    "%s selects named columns, never the whole row",
    (_n, sql, table) => {
      // `count(*) over ()` is the match count (round 1), the one `*` allowed.
      expect(sql.replace(/count\(\*\) over \(\)/g, "")).not.toMatch(
        /to_jsonb|row_to_json|to_json\s*\(|json_agg|\*/i
      );
      // The outermost select list is exactly the allowlist, in order, then the match count.
      const names = selectList(norm(sql));
      expect(names).toEqual([...SEARCH_COLUMNS[table], "total"]);
    }
  );

  it("every searchable table has columns, filters and a statement", () => {
    for (const table of TABLES) {
      expect(SEARCH_COLUMNS[table].length).toBeGreaterThan(0);
      expect(SEARCH_FILTERS[table]).toBeDefined();
      expect(SEARCH_SQL[table]).toMatch(/limit 20$/);
    }
  });

  it("users never shows a column the Users screen does not", () => {
    for (const c of USERS_SENSITIVE) expect(SEARCH_COLUMNS.users).not.toContain(c);
  });

  it("audit_log never shows details, the IP address or the user agent", () => {
    for (const c of ["details", "ip_address", "user_agent"]) {
      expect(SEARCH_COLUMNS.audit_log).not.toContain(c);
      expect(SEARCH_SQL.audit_log).not.toMatch(new RegExp(`\\b${c}\\b`));
    }
  });

  it("role_permissions, entitlement_groups and platform_config leave out who changed them", () => {
    expect(SEARCH_SQL.role_permissions).not.toMatch(/granted_by/);
    expect(SEARCH_SQL.entitlement_groups).not.toMatch(/created_by/);
    expect(SEARCH_SQL.platform_config).not.toMatch(/updated_by/);
    expect(SEARCH_SQL.platform_config).toMatch(/c\.category <> 'retired'/);
  });

  it("a row carrying sensitive columns puts none of them in the result or the step", async () => {
    fakeData().answer = () => [WHOLE_USER];
    const res = await handleSearch({ table: "users" }, ALL);
    expect(res.success).toBe(true);
    expect(res.table?.columns).toEqual(SEARCH_COLUMNS.users);
    const recorded = JSON.stringify(res);
    expect(recorded).not.toMatch(/SECRET|2012-03-04|cognito_sub|date_of_birth/i);
    expect(res.table?.rows).toEqual([
      [
        WHOLE_USER.id,
        "a@x.test",
        "Alice",
        "free",
        "active",
        null,
        true,
        "2026-01-02T00:00:00.000Z",
        null,
      ],
    ]);
  });
});

describe("TASK-189: each filter is a bound parameter", () => {
  const run = async (input: Record<string, unknown>) => {
    fakeData().reset();
    fakeData().answer = () => [];
    const res = await handleSearch(input, ALL);
    return { res, st: fakeData().statements };
  };

  it("no filter: every filter off", async () => {
    const { res, st } = await run({ table: "users" });
    expect(res).toMatchObject({ success: true, result: "No rows of users match." });
    expect(st[0].values).toEqual(["", null, null, null, null]);
  });

  it("users: text, role, status, signed in and created within days", async () => {
    const { st } = await run({
      table: "users",
      text: "  Ali  ",
      role: "moderator",
      status: "deleted",
      signed_in_within_days: 7,
      created_within_days: 30,
    });
    // Signed in within a period: most recent sign-in first (round 1).
    expect(st[0].sql).toBe(norm(SEARCH_USERS_BY_SIGN_IN_SQL));
    expect(st[0].sql).toMatch(
      /order by s\.last_sign_in_at desc nulls last, s\.id limit 20$/
    );
    expect(st[0].values).toEqual(["Ali", "moderator", "deleted", 7, 30]);
  });

  it("users without a sign-in period: newest account first", async () => {
    const { st } = await run({ table: "users", created_within_days: 30 });
    expect(st[0].sql).toBe(norm(SEARCH_SQL.users));
  });

  it("role: any name or display name up to 64 characters, trimmed (round 1)", async () => {
    const { st } = await run({ table: "users", role: "  Support Lead " });
    expect(st[0].values[1]).toBe("Support Lead");
    expect(st[0].sql).toMatch(
      /lower\(s\.role\) = lower\(\$2::text\) or lower\(s\.role_display_name\) = lower\(\$2::text\)/
    );
    const quoted = await run({ table: "users", role: "x'; drop" });
    expect(quoted.st[0].values[1]).toBe("x'; drop");
  });

  it("a null for any key is absent, even one the table does not take (round 1)", async () => {
    const { res, st } = await run({
      table: "roles",
      text: null,
      status: null,
      role: null,
    });
    expect(res.success).toBe(true);
    expect(st[0].values).toEqual([""]);
  });

  it("text escapes the LIKE metacharacters and drops control characters (likeTerm)", async () => {
    const { st } = await run({ table: "users", text: "john_doe%\\\u0000" });
    expect(st[0].values[0]).toBe("john\\_doe\\%\\\\");
  });

  it("text of 100 characters is taken whole; 101 is refused, never cut (round 1)", async () => {
    const { st } = await run({ table: "roles", text: "a".repeat(100) });
    expect(st[0].values).toEqual(["a".repeat(100)]);
    const over = await run({ table: "roles", text: "a".repeat(101) });
    expect(over.res).toMatchObject({
      code: "request.invalid_value",
      params: { field: "text" },
    });
    expect(over.st).toEqual([]);
  });

  it.each([
    "'; drop table users; --",
    "%' or 1=1 --",
    "') union select cognito_sub from users --",
  ])(
    "an injection attempt %p is a bound value, the statement unchanged",
    async (text) => {
      const { st } = await run({ table: "users", text });
      expect(st[0].sql).toBe(norm(SEARCH_SQL.users));
      expect(String(st[0].values[0])).toBe(text.replace(/[\\%_]/g, (c) => "\\" + c));
    }
  );

  it("audit_log: action, actor, target, within days", async () => {
    const actor = "00000000-0000-4000-8000-0000000000AA";
    const { st } = await run({
      table: "audit_log",
      action: "role_changed",
      actor_id: actor,
      target_id: "00000000-0000-4000-8000-0000000000bb",
      within_days: 7,
    });
    expect(st[0].sql).toBe(norm(SEARCH_SQL.audit_log));
    expect(st[0].values).toEqual([
      ["role_changed"],
      actor.toLowerCase(),
      "00000000-0000-4000-8000-0000000000bb",
      7,
    ]);
  });

  it("audit_log text: the action names that contain it, as the Audit log page", () => {
    const parsed = parseSearchFilters("audit_log", { text: "ROLE_ch" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(searchParams("audit_log", parsed.filters)[0]).toEqual(["role_changed"]);
    const none = parseSearchFilters("audit_log", { text: "%" });
    if (!none.ok) throw new Error("refused");
    expect(searchParams("audit_log", none.filters)[0]).toEqual([]);
  });

  it("audit_log text and action together: both must hold", () => {
    const p = parseSearchFilters("audit_log", {
      text: "entitlement",
      action: "role_changed",
    });
    if (!p.ok) throw new Error("refused");
    expect(searchParams("audit_log", p.filters)[0]).toEqual([]);
  });

  it("platform_config: text and category", async () => {
    const { st } = await run({ table: "platform_config", text: "ai.", category: "ai" });
    expect(st[0].values).toEqual(["ai.", "ai"]);
  });

  it("the old `query` is read as text when no text is given", async () => {
    const { st } = await run({ table: "users", query: "alice" });
    expect(st[0].values[0]).toBe("alice");
    // Both given is refused (round 2), so no statement runs.
    const both = await run({ table: "users", query: "alice", text: "bob" });
    expect(both.st).toHaveLength(0);
  });

  it("an empty text is no filter", async () => {
    const { st } = await run({ table: "roles", text: "   " });
    expect(st[0].values).toEqual([""]);
  });
});

describe("TASK-189: malformed and hostile filters are refused before any statement", () => {
  it.each<[Record<string, unknown>, string]>([
    [{ table: "users", role: 7 }, "role"],
    [{ table: "users", role: "a".repeat(65) }, "role"],
    [{ table: "users", role: "mod\u0000erator" }, "role"],
    [{ table: "users", role: "   " }, "role"],
    [{ table: "users", query: "q".repeat(101) }, "query"],
    [{ table: "users", status: "superuser" }, "status"],
    [{ table: "users", signed_in_within_days: 0 }, "signed_in_within_days"],
    [{ table: "users", signed_in_within_days: 3651 }, "signed_in_within_days"],
    [{ table: "users", created_within_days: 1.5 }, "created_within_days"],
    [{ table: "users", created_within_days: "7" }, "created_within_days"],
    [{ table: "users", text: { $ne: 1 } }, "text"],
    [{ table: "users", text: ["a"] }, "text"],
    [{ table: "users", query: 5 }, "query"],
    [{ table: "audit_log", action: "drop_everything" }, "action"],
    [{ table: "audit_log", actor_id: "not-a-uuid" }, "actor_id"],
    [{ table: "audit_log", target_id: "1 or 1=1" }, "target_id"],
    [{ table: "audit_log", within_days: -1 }, "within_days"],
    [{ table: "platform_config", category: "a b" }, "category"],
    // A filter the table does not take is refused, never ignored.
    [{ table: "roles", status: "active" }, "filters"],
    [{ table: "audit_log", role: "free" }, "filters"],
    [{ table: "users", limit: 1000 }, "filters"],
    [{ table: "users", order: "cognito_sub" }, "filters"],
    [{ table: "users", columns: ["date_of_birth"] }, "filters"],
  ])("%p is refused (field %s)", async (input, field) => {
    const res = await handleSearch(input, ALL);
    expect(res).toMatchObject({
      success: false,
      code: "request.invalid_value",
      params: { field },
    });
    expect(fakeData().statements).toEqual([]);
  });

  it("every table takes text, so the old query means the same everywhere", () => {
    for (const table of TABLES) expect(SEARCH_FILTERS[table]).toContain("text");
  });
});

describe("TASK-189: the permission per table is unchanged", () => {
  it.each(TABLES)("%s requires its page's permission", async (table) => {
    const without: VerifiedAdmin = {
      ...ALL,
      permissions: ALL.permissions.filter((p) => p !== SEARCHABLE_TABLES[table]),
    };
    const res = await handleSearch({ table, text: "a" }, without);
    expect(res).toMatchObject({
      success: false,
      code: "auth.permission_denied",
      params: { permission: SEARCHABLE_TABLES[table] },
    });
    expect(fakeData().statements).toEqual([]);
  });

  it("the permission is checked before the filters (a bad filter tells nothing)", async () => {
    const res = await handleSearch(
      { table: "audit_log", action: "nope" },
      {
        ...ALL,
        permissions: [],
      }
    );
    expect(res.code).toBe("auth.permission_denied");
  });
});

describe("TASK-189: the tool's schema", () => {
  const search = SHARED_TOOLS.find((t) => t.name === "search")!;
  const schema = search.input_schema as {
    properties: Record<string, { enum?: string[] }>;
    required: string[];
    additionalProperties: boolean;
  };

  it("requires only the table, from the allowlist, and no free-text query", () => {
    expect(schema.required).toEqual(["table"]);
    expect(schema.properties.table.enum).toEqual(TABLES);
    expect(schema.properties.query).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
  });

  it("offers exactly the filters some table takes", () => {
    const offered = Object.keys(schema.properties).filter((k) => k !== "table");
    const taken = [...new Set(TABLES.flatMap((t) => SEARCH_FILTERS[t]))];
    expect(offered.sort()).toEqual(taken.sort());
  });
});

describe("TASK-189 round 1: what the step records", () => {
  const ROWS = [
    { ...WHOLE_USER, total: 3 },
    {
      ...WHOLE_USER,
      id: "00000000-0000-4000-8000-0000000000a2",
      email: "bee@x.test",
      display_name: "Beatrice",
      total: 3,
    },
  ];

  it("the step keeps ids and counts; the admin's text only as its length", () => {
    const result = {
      success: true,
      result: "Showing 2 of 3 matching rows of users.",
      table: {
        table: "users",
        columns: [...SEARCH_COLUMNS.users],
        rows: [
          [ROWS[0].id, "a@x.test", "Alice", "free", "active", null, true, "t", null],
          [ROWS[1].id, "bee@x.test", "Beatrice", "free", "active", null, true, "t", null],
        ],
        matched: 3,
      },
    };
    const step = searchStepRecord(result, {
      table: "users",
      text: "Beatrice Smith",
      role: "free",
      signed_in_within_days: 7,
      status: null,
    });
    const text = JSON.stringify(step);
    expect(text).not.toMatch(/a@x\.test|bee@x\.test|Alice|Beatrice|alice|Smith|"free"/);
    expect(step).toEqual({
      success: true,
      result: "Showing 2 of 3 matching rows of users.",
      filters: {
        table: "users",
        text: "[redacted: 14 chars]",
        role: "[redacted: 4 chars]",
        signed_in_within_days: 7,
      },
      table: {
        table: "users",
        columns: [...SEARCH_COLUMNS.users],
        ids: [ROWS[0].id, ROWS[1].id],
        shown: 2,
        matched: 3,
      },
    });
  });

  it("through the governed runtime: the step stored has no address, name or text; the admin gets the table", async () => {
    const { runCommandBarAction } = await import("@/app/api/admin/ai/command-bar");
    const { getTrajectoryStore } = await import("@/platform/agents/trajectory-store");
    fakeData().answer = (sql) => (/from users u/.test(sql) ? ROWS : undefined);
    const store = getTrajectoryStore();
    const id = (
      await store.create({ kind: "agent", id: "command-bar" }, "command-bar", "platform")
    ).trajectory.trajectoryId;
    const outcome = await runCommandBarAction({
      tool: "search",
      input: { table: "users", text: "Beatrice" },
      admin: ALL,
      trajectoryId: id,
      stepIndex: 0,
    });
    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") return;
    // The admin's screen: the whole allowlisted table.
    expect(outcome.result.table?.rows[1]).toContain("bee@x.test");
    expect(outcome.result.result).toBe("Showing 2 of 3 matching rows of users.");
    // The record: none of it.
    const stored = JSON.stringify(await store.getById(id));
    expect(stored).toContain(ROWS[1].id);
    expect(stored).toContain("[redacted: 8 chars]");
    expect(stored).not.toMatch(/a@x\.test|bee@x\.test|Alice|Beatrice/);
  });
});

describe("TASK-189 round 2: the step records an allowlist, never a value it was not asked to keep", () => {
  const refused = { success: false, error: "email must be one of: text, role." };

  it("a refused search records the table and the key names only", () => {
    const step = searchStepRecord(refused, {
      table: "users",
      email: "kid@example.com",
      display_name: "Kid Person",
      role: "Secret Club",
      text: "hunter2",
      extra: { nested: "kid@example.com", n: 42 },
      "kid@example.com": "x",
    });
    const text = JSON.stringify(step);
    expect(text).not.toMatch(/kid@example|Kid Person|Secret Club|hunter2|nested|42/);
    expect(step).toEqual({
      success: false,
      error: "email must be one of: text, role.",
      filters: { table: "users" },
      ignored_keys: ["email", "display_name", "role", "text", "extra", "[redacted key]"],
    });
  });

  it("an unknown table is recorded by key name only", () => {
    const step = searchStepRecord(refused, { table: "users_secret_kid@example.com" });
    expect(JSON.stringify(step)).not.toMatch(/kid@example/);
    expect(step).toMatchObject({ filters: {}, ignored_keys: ["table"] });
  });

  it("a search that ran records only its validated filters, the free-text ones as their length", () => {
    const ok = { success: true, result: "No rows of users match." };
    const step = searchStepRecord(ok, {
      table: "users",
      role: "Support Lead",
      status: "active",
      created_within_days: 30,
      signed_in_within_days: "7; drop",
      email: "kid@example.com",
    });
    expect(JSON.stringify(step)).not.toMatch(/kid@example|Support Lead|drop/);
    expect(step).toEqual({
      ...ok,
      filters: {
        table: "users",
        role: "[redacted: 12 chars]",
        status: "active",
        created_within_days: 30,
      },
      ignored_keys: ["signed_in_within_days", "email"],
    });
  });

  it("through the governed runtime: a refused search leaves no value in the stored trajectory", async () => {
    const { runCommandBarAction } = await import("@/app/api/admin/ai/command-bar");
    const { getTrajectoryStore } = await import("@/platform/agents/trajectory-store");
    const store = getTrajectoryStore();
    const id = (
      await store.create({ kind: "agent", id: "command-bar" }, "command-bar", "platform")
    ).trajectory.trajectoryId;
    const outcome = await runCommandBarAction({
      tool: "search",
      input: {
        table: "users",
        email: "kid@example.com",
        display_name: "Kid Person",
        role: "Secret Club",
        extra: { nested: "kid@example.com" },
      },
      admin: ALL,
      trajectoryId: id,
      stepIndex: 0,
    });
    expect(outcome.kind).toBe("ran");
    const stored = JSON.stringify(await store.getById(id));
    expect(stored).toContain("ignored_keys");
    expect(stored).not.toMatch(/kid@example|Kid Person|Secret Club|nested/);
  });

  it("text and query together are refused, neither dropped", async () => {
    const res = await handleSearch({ table: "users", text: "a", query: "b" }, ALL);
    expect(res.success).toBe(false);
    expect(res).toMatchObject({
      code: "request.invalid_value",
      params: { field: "query", allowed: "give one of text or query, not both" },
    });
  });
});

describe("TASK-189 round 1: a database error is logged, never returned", () => {
  it("the admin gets a plain failure; the database's message goes to the log", async () => {
    const { logger } = await import("@/lib/logger");
    const spy = jest.spyOn(logger, "error").mockImplementation(() => undefined);
    fakeData().answer = () => {
      throw new Error('relation "users" column "secret_col" does not exist');
    };
    const res = await handleSearch({ table: "users" }, ALL);
    expect(res.success).toBe(false);
    expect(res.error).toBe(
      "The search could not be run: the database is unavailable or refused it. Nothing was changed."
    );
    expect(JSON.stringify(res)).not.toMatch(/secret_col|relation/);
    expect(spy).toHaveBeenCalledWith(
      "Admin command search failed",
      expect.objectContaining({
        table: "users",
        error: expect.stringMatching(/secret_col/),
      })
    );
    spy.mockRestore();
  });
});

describe("TASK-189 round 1: the summary reports matches, not only what is shown", () => {
  const user = (n: number, total: number) => ({ ...WHOLE_USER, id: `u${n}`, total });

  it("every match shown", async () => {
    fakeData().answer = () => [user(1, 2), user(2, 2)];
    expect((await handleSearch({ table: "users" }, ALL)).result).toBe("2 rows of users.");
    fakeData().answer = () => [user(1, 1)];
    expect((await handleSearch({ table: "users" }, ALL)).result).toBe("1 row of users.");
  });

  it("capped at 20: Showing 20 of N", async () => {
    fakeData().answer = () => Array.from({ length: 20 }, (_, i) => user(i, 57));
    const res = await handleSearch({ table: "users" }, ALL);
    expect(res.result).toBe("Showing 20 of 57 matching rows of users.");
    expect(res.table?.matched).toBe(57);
  });

  it('platform_config values are JSON: true, 5 and "true" stay apart (round 1)', async () => {
    fakeData().answer = () => [
      { key: "a", value: true, total: 3 },
      { key: "b", value: 5, total: 3 },
      { key: "c", value: "true", total: 3 },
    ];
    const res = await handleSearch({ table: "platform_config" }, ALL);
    const at = SEARCH_COLUMNS.platform_config.indexOf("value");
    expect(res.table?.rows.map((r) => r[at])).toEqual(["true", "5", '"true"']);
    // As JSON text, never a boolean the panel would show as yes/no.
    expect(res.table?.rows.some((r) => typeof r[at] === "boolean")).toBe(false);
  });
});
