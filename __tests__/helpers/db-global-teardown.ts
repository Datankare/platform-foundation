/**
 * __tests__/helpers/db-global-teardown.ts — jest globalTeardown: the per-worker databases dropped
 * (TASK-218; helpers/db-workers.ts). A run killed before this leaves them behind; scripts/test-db.sh
 * drops its own run's with its database.
 */
import { Client } from "pg";
import {
  quoteIdent,
  withDatabase,
  WORKERS_ENV,
  type WorkerDatabases,
} from "./db-workers";

export default async function globalTeardown(): Promise<void> {
  const raw = process.env[WORKERS_ENV];
  const owner =
    process.env.TEST_DATABASE_BASE_OWNER_URL ?? process.env.TEST_DATABASE_OWNER_URL;
  if (!raw || !owner) return;
  const { names } = JSON.parse(raw) as WorkerDatabases;
  const c = new Client({ connectionString: withDatabase(owner, "postgres") });
  await c.connect();
  try {
    for (const name of Object.values(names))
      await c.query(`drop database if exists ${quoteIdent(name)} with (force)`);
  } finally {
    await c.end();
  }
  delete process.env[WORKERS_ENV];
}
