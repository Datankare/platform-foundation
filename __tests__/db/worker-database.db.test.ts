/**
 * @jest-environment node
 */
/**
 * __tests__/db/worker-database.db.test.ts — a database suite runs on its worker's own copy (TASK-218)
 *
 * @not-guard: checks at run time, on the database, what __tests__/db-isolation.test.ts checks in
 * the configuration: that this suite is connected to its jest worker's copy (helpers/db-workers.ts)
 * as app_tenant and as the owner, and that a catalogue row it writes is seen by no other database —
 * neither the one the copies were made from nor another worker's.
 */
import { Client } from "pg";
import { dbDescribe } from "../helpers/db";
import {
  BASE_OWNER_URL_ENV,
  copyDatabase,
  databaseLevel,
  databaseOf,
  withDatabase,
  WORKERS_ENV,
  type WorkerDatabases,
} from "../helpers/db-workers";

dbDescribe("each jest worker has a database of its own (TASK-218)", () => {
  const workers = () => JSON.parse(process.env[WORKERS_ENV] ?? "{}") as WorkerDatabases;
  const mine = () => workers().names[process.env.JEST_WORKER_ID ?? "1"];

  const ask = async (url: string, sql: string, params: unknown[] = []) => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      return (await c.query(sql, params)).rows;
    } finally {
      await c.end();
    }
  };

  it("connects as app_tenant and as the owner to this worker's copy, not the database it copies", async () => {
    expect(mine()).toMatch(/_w\d+_/);
    expect(mine()).not.toBe(workers().base);
    for (const url of [
      process.env.TEST_DATABASE_URL!,
      process.env.TEST_DATABASE_OWNER_URL!,
    ]) {
      expect(databaseOf(url)).toBe(mine());
      const [row] = await ask(url, "select current_database() as db");
      expect(row.db).toBe(mine());
    }
  });

  it("the copy has the database's own owner, privileges and settings (049's TEMPORARY revoked)", async () => {
    const c = new Client({
      connectionString: withDatabase(process.env[BASE_OWNER_URL_ENV]!, "postgres"),
    });
    await c.connect();
    try {
      const base = await databaseLevel(c, workers().base);
      expect(await databaseLevel(c, mine())).toEqual(base);
      expect(
        base.privileges.filter((p) => /^(?:PUBLIC|app_tenant) TEMPORARY/.test(p))
      ).toEqual([]);
    } finally {
      await c.end();
    }
  });

  it("copyDatabase gives a copy its template's owner, privileges and per-database settings, or fails", async () => {
    const c = new Client({
      connectionString: withDatabase(process.env[BASE_OWNER_URL_ENV]!, "postgres"),
    });
    await c.connect();
    const src = `${mine()}_src`;
    const dst = `${mine()}_dst`;
    try {
      await c.query(`create database "${src}" template template0`);
      await c.query(`revoke temporary on database "${src}" from public`);
      await c.query(`grant create on database "${src}" to app_tenant with grant option`);
      await c.query(`alter database "${src}" set search_path to public, extensions`);
      await c.query(
        `alter role app_tenant in database "${src}" set statement_timeout to '5s'`
      );
      await copyDatabase(c, src, dst);
      const got = await databaseLevel(c, dst);
      expect(got).toEqual(await databaseLevel(c, src));
      expect(got.settings).toEqual([
        "(all) search_path=public, extensions",
        "app_tenant statement_timeout=5s",
      ]);
      expect(got.privileges).toEqual(
        expect.arrayContaining(["PUBLIC CONNECT", "app_tenant CREATE WITH GRANT OPTION"])
      );
      expect(got.privileges).not.toContain("PUBLIC TEMPORARY");
    } finally {
      await c.query(`drop database if exists "${dst}" with (force)`);
      await c.query(`drop database if exists "${src}" with (force)`);
      await c.end();
    }
  });

  it("a catalogue row written here is in no other database while the suites run", async () => {
    const key = `isolation.${process.pid}.${Date.now()}`;
    const owner = process.env.TEST_DATABASE_OWNER_URL!;
    await ask(
      owner,
      `insert into platform_config (key, value, default_value, description, category, value_type, permission_tier, tenant_overridable)
       values ($1, '1'::jsonb, '1'::jsonb, 'isolation', 'test', 'number', 'standard', true)`,
      [key]
    );
    try {
      const others = [
        workers().base,
        ...Object.values(workers().names).filter((n) => n !== mine()),
      ];
      for (const db of others) {
        const rows = await ask(
          withDatabase(process.env[BASE_OWNER_URL_ENV]!, db),
          "select 1 from platform_config where key = $1",
          [key]
        );
        expect([db, rows.length]).toEqual([db, 0]);
      }
      expect(
        await ask(owner, "select 1 from platform_config where key = $1", [key])
      ).toHaveLength(1);
    } finally {
      await ask(owner, "delete from platform_config where key = $1", [key]);
    }
  });
});
