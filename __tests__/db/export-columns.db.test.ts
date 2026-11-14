/**
 * @jest-environment node
 */
/**
 * __tests__/db/export-columns.db.test.ts — every column an export could give is classified, and
 * the exports give only the classified columns (TASK-215, audit A-7, A-14)
 *
 * @guard a column a person's or a tenant's export would give, or leave out, that no register classifies
 *
 * Both exports read whole rows: a person's profile was `users` less one column (A-14), a tenant's
 * export every column of every tenant table (A-7). Now each names its columns from a register that
 * says, column by column, whether it is given and why (platform/auth/user-data.ts PROFILE_COLUMNS
 * and TENANT_EXPORT_COLUMNS; an app's own tenant tables in platform/tenancy/app-tenant-export.ts). Here:
 *
 *   - every column of `users` is in PROFILE_COLUMNS, every entry is a column, and the export's
 *     statement (PROFILE_EXPORT_SQL) gives exactly the given ones (and the role by name);
 *   - every column of every tenant table (public.tenant_tables()) is classified — the tenant key by
 *     its one rule — and every entry names a column of a tenant table;
 *   - a column a migration adds is unclassified until someone classifies it (planted, rolled back);
 *   - against Postgres: a person's export holds no identity-provider subject or parent's address,
 *     and a tenant's export holds no network address, job payload, lease or tenant key.
 */

import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
} from "../helpers/db";
import { withOwnerTx, withTenantTx } from "@/platform/data";
import {
  PROFILE_COLUMNS,
  PROFILE_EXPORT_SQL,
  TENANT_EXPORT_COLUMNS,
  TENANT_KEY_COLUMN,
  tenantExportColumns,
} from "@/platform/auth/user-data";
import { writeTenantExport } from "@/platform/tenancy/admin";

import { APP_TENANT_EXPORT } from "@/platform/tenancy/app-tenant-export";

const appTenantExport = (): Readonly<Record<string, string>> => APP_TENANT_EXPORT;

const owner = <R extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  withOwnerTx("tenant-lifecycle", (tx) => tx.query<R>(sql, values));

/** "<table>.<column>" of the given columns that no register classifies. */
export function unclassifiedColumns(
  columns: readonly string[],
  platform: Readonly<Record<string, unknown>>,
  app: Readonly<Record<string, string>>
): string[] {
  return columns
    .filter((c) => !c.endsWith(".tenant_id") && !(c in platform) && !(c in app))
    .sort();
}

/** The keys a `jsonb_build_object(…)` statement gives: each quoted name before a value. */
export function builtKeys(sql: string): string[] {
  const body = sql.slice(
    sql.indexOf("jsonb_build_object(") + "jsonb_build_object(".length
  );
  return [...body.matchAll(/'([a-z_]+)',\s*(?:u\.|\(select)/g)].map((m) => m[1]).sort();
}

const TENANT_COLUMNS_SQL = `select c.table_name || '.' || c.column_name as c
   from information_schema.columns c
   join public.tenant_tables() t on t.table_name = c.table_name
  where c.table_schema = 'public'
  order by 1`;

dbDescribe("export columns: every column classified (TASK-215, A-7, A-14)", () => {
  let tenantColumns: string[];
  let userColumns: string[];

  beforeAll(async () => {
    await connectTestDatabase();
    tenantColumns = (await owner<{ c: string }>(TENANT_COLUMNS_SQL)).rows.map((r) => r.c);
    userColumns = (
      await owner<{ c: string }>(
        "select column_name as c from information_schema.columns where table_schema = 'public' and table_name = 'users' order by 1"
      )
    ).rows.map((r) => r.c);
  });

  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  it("every column of users is in PROFILE_COLUMNS, and every entry is a column", () => {
    expect(userColumns.length).toBeGreaterThan(30);
    expect(userColumns.filter((c) => !(c in PROFILE_COLUMNS))).toEqual([]);
    expect(Object.keys(PROFILE_COLUMNS).filter((c) => !userColumns.includes(c))).toEqual(
      []
    );
  });

  it("the profile statement gives exactly the given columns, and the role by name", () => {
    const given = Object.entries(PROFILE_COLUMNS)
      .filter(([, v]) => v.exported)
      .map(([c]) => c);
    expect(builtKeys(PROFILE_EXPORT_SQL)).toEqual([...given, "role"].sort());
    for (const never of [
      "cognito_sub",
      "parental_consent_email",
      "status_changed_by",
      "tenant_id",
    ])
      expect([never, PROFILE_COLUMNS[never]?.exported]).toEqual([never, false]);
  });

  it("every column of every tenant table is classified, and every entry names one", () => {
    expect(tenantColumns.length).toBeGreaterThan(300);
    const app = appTenantExport();
    expect(unclassifiedColumns(tenantColumns, TENANT_EXPORT_COLUMNS, app)).toEqual([]);
    const present = new Set(tenantColumns);
    expect(
      [...Object.keys(TENANT_EXPORT_COLUMNS), ...Object.keys(app)].filter(
        (c) => !present.has(c)
      )
    ).toEqual([]);
    expect(Object.keys(app).filter((c) => c in TENANT_EXPORT_COLUMNS)).toEqual([]);
    // An app's entry says which and why: "exported: <why>" or "not exported: <why>".
    expect(
      Object.entries(app).filter(
        ([, d]) => !/^(?:exported|not exported): \S.{8,}/.test(d)
      )
    ).toEqual([]);
    expect(TENANT_KEY_COLUMN.exported).toBe(false);
  });

  it("[self-test] a column a migration adds is unclassified until it is classified", async () => {
    // Planted in a transaction that is rolled back: no other test sees the column.
    const client = new Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
    await client.connect();
    let planted: string[];
    try {
      await client.query("begin");
      await client.query("alter table public.users add column planted_secret text");
      await client.query("alter table public.audit_log add column planted_note text");
      planted = (await client.query<{ c: string }>(TENANT_COLUMNS_SQL)).rows.map(
        (r) => r.c
      );
    } finally {
      await client.query("rollback");
      await client.end();
    }
    expect(
      unclassifiedColumns(planted, TENANT_EXPORT_COLUMNS, appTenantExport())
    ).toEqual(["audit_log.planted_note", "users.planted_secret"]);
    expect(
      unclassifiedColumns(["users.planted_secret"], TENANT_EXPORT_COLUMNS, {
        "users.planted_secret": "not exported: a planted column, classified",
      })
    ).toEqual([]);
    expect(tenantExportColumns("planted_table")).toBeUndefined();
  });

  it("[self-test] the profile statement's keys are read from it", () => {
    expect(
      builtKeys("select jsonb_build_object('id', u.id, 'role', (select 1)) as r")
    ).toEqual(["id", "role"]);
  });

  it("a person's export gives no identity-provider subject, parent's address or tenant key", async () => {
    const t = await createTestTenant();
    const id = await t.user("profile");
    await owner(
      "update users set parental_consent_email = 'parent@example.test', status_changed_by = $2 where id = $1::uuid",
      [id, randomUUID()]
    );
    const { rows } = await t.run(() =>
      withTenantTx((tx) =>
        tx.query<{ r: Record<string, unknown> }>(PROFILE_EXPORT_SQL, [id])
      )
    );
    expect(rows).toHaveLength(1);
    const keys = Object.keys(rows[0].r).sort();
    expect(keys).toEqual(builtKeys(PROFILE_EXPORT_SQL));
    expect(JSON.stringify(rows[0].r)).not.toContain("parent@example.test");
    expect(rows[0].r.role).toEqual(expect.any(String));
  });

  it("a tenant's export gives only the classified columns: no address, payload, lease or tenant key", async () => {
    const t = await createTestTenant();
    const user = await t.user("exported");
    await owner(
      "insert into audit_log (action, actor_id, details, ip_address, user_agent, tenant_id) values ('login_success', $1::uuid, '{}', '203.0.113.77', 'planted-agent', $2::uuid)",
      [user, t.id]
    );
    await owner(
      "insert into jobs (tenant_id, kind, payload, idempotency_key, status, lease_token, locked_by, locked_until) values ($1::uuid, 'planted.kind', '{\"secret\":\"planted-payload\"}', $2, 'running', gen_random_uuid(), 'planted-host', now() + interval '1 minute')",
      [t.id, `planted-${randomUUID()}`]
    );
    let text = "";
    await writeTenantExport(t.id, async (c) => {
      text += c;
    });
    const lines = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { table?: string; row?: Record<string, unknown> });
    for (const planted of [
      "203.0.113.77",
      "planted-agent",
      "planted-payload",
      "planted-host",
    ])
      expect([planted, text.includes(planted)]).toEqual([planted, false]);
    const app = appTenantExport();
    for (const l of lines.slice(1)) {
      const allowed = new Set(tenantExportColumns(l.table as string, app));
      const extra = Object.keys(l.row ?? {}).filter((k) => !allowed.has(k));
      expect([l.table, extra]).toEqual([l.table, []]);
    }
    expect(lines.some((l) => l.table === "audit_log")).toBe(true);
    expect(lines.some((l) => l.table === "jobs")).toBe(true);
    expect(lines.some((l) => l.table === "rate_limit_events")).toBe(false);
  });
});
