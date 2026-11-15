/**
 * __tests__/helpers/db-global-teardown.ts — jest globalTeardown: the run's per-worker databases
 * dropped (TASK-218; helpers/db-workers.ts) — by the process that made them, and by no other
 * (TASK-219): a jest run started inside a test inherits the map, and its teardown dropping it
 * removed every copy of the live run (CI run 43722156950). A run killed before this leaves its
 * copies behind; scripts/test-db.sh drops its own run's with its database.
 */
import { Client } from "pg";
import {
  quoteIdent,
  roleInRun,
  runDatabases,
  withDatabase,
  WORKERS_ENV,
} from "./db-workers";

export default async function globalTeardown(): Promise<void> {
  const workers = runDatabases();
  if (workers === null || roleInRun(workers) !== "owner") return;
  const c = new Client({
    connectionString: withDatabase(workers.baseOwnerUrl, "postgres"),
  });
  await c.connect();
  try {
    for (const name of Object.values(workers.names))
      await c.query(`drop database if exists ${quoteIdent(name)} with (force)`);
  } finally {
    await c.end();
  }
  delete process.env[WORKERS_ENV];
}
