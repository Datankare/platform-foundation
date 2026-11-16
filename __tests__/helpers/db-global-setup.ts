/**
 * __tests__/helpers/db-global-setup.ts — jest globalSetup: one database per worker (TASK-218)
 *
 * Before any worker starts: with a database configured (TEST_DATABASE_URL and
 * TEST_DATABASE_OWNER_URL), a copy of it for each worker this run may start, made as the owner
 * from the maintenance database `postgres` (a session on the copied database itself would block
 * the copy). The names go to the workers in TEST_DATABASE_WORKERS (they inherit this process's
 * environment); helpers/db-workers.ts says why, how a copy keeps the database's own privileges, and
 * why a run started inside another makes its own (TASK-219). Without a database configured: nothing.
 *
 * TASK-223: first, the copies a killed run on this host left of the same database are dropped
 * (`reclaimKilledCopies`: marked, their owner no longer running, nobody connected — a live run's
 * are never touched), and each copy made here is marked with this run and this process
 * (`markCopy`), so the teardown can check they are gone and a later run can tell whose they are.
 */
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import {
  copyDatabase,
  databaseOf,
  leaveEnclosingRun,
  markCopy,
  quoteIdent,
  reclaimKilledCopies,
  withDatabase,
  workerDatabaseName,
  WORKERS_ENV,
  type WorkerDatabases,
} from "./db-workers";

export default async function globalSetup(globalConfig: {
  maxWorkers: number;
}): Promise<void> {
  // A run started inside another (a test's own jest run) is a run of its own: it starts from the
  // database the enclosing run copied, and makes copies of its own (TASK-219).
  leaveEnclosingRun();
  const url = process.env.TEST_DATABASE_URL;
  const owner = process.env.TEST_DATABASE_OWNER_URL;
  if (!url || !owner || process.env[WORKERS_ENV]) return;
  const base = databaseOf(owner);
  if (databaseOf(url) !== base)
    throw new Error(
      "TEST_DATABASE_URL and TEST_DATABASE_OWNER_URL name different databases"
    );
  const run = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  const count = Math.max(1, globalConfig.maxWorkers);
  const names: Record<string, string> = {};
  const c = new Client({ connectionString: withDatabase(owner, "postgres") });
  await c.connect();
  try {
    const reclaimed = await reclaimKilledCopies(c, base);
    if (reclaimed.length > 0)
      console.warn(
        `[db-global-setup] dropped ${reclaimed.length} database(s) a killed test run left of ${base}: ${reclaimed.join(", ")}`
      );
    for (let w = 1; w <= count; w++) {
      const name = workerDatabaseName(base, w, run);
      await copyDatabase(c, base, name);
      names[String(w)] = name;
      await markCopy(c, name, run);
    }
  } catch (e) {
    for (const name of Object.values(names))
      await c
        .query(`drop database if exists ${quoteIdent(name)} with (force)`)
        .catch(() => {});
    throw new Error(
      `could not copy ${base} for the test workers (a session still connected to it blocks the copy): ${(e as Error).message}`
    );
  } finally {
    await c.end();
  }
  const workers: WorkerDatabases = {
    base,
    names,
    owner: process.pid,
    baseUrl: url,
    baseOwnerUrl: owner,
  };
  process.env[WORKERS_ENV] = JSON.stringify(workers);
}
