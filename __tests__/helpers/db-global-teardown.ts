/**
 * __tests__/helpers/db-global-teardown.ts — jest globalTeardown: the run's per-worker databases
 * dropped (TASK-218; helpers/db-workers.ts) — by the process that made them, and by no other
 * (TASK-219): a jest run started inside a test inherits the map, and its teardown dropping it
 * removed every copy of the live run (CI run 43722156950). A run killed before this leaves its
 * copies behind; scripts/test-db.sh drops its own run's with its database, and the next run on the
 * same database drops a killed run's (db-global-setup.ts, TASK-223).
 *
 * TASK-223: after dropping them, the teardown checks that none of the run's copies — nor a
 * scratch database a test named after one — is still there, and fails the run if one is: a run
 * that leaves a copy behind is a failed run, said with the names, never a silent leftover.
 */
import { Client } from "pg";
import {
  quoteIdent,
  remainingCopies,
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
  let left: string[];
  try {
    for (const name of Object.values(workers.names))
      await c.query(`drop database if exists ${quoteIdent(name)} with (force)`);
    left = await remainingCopies(c, Object.values(workers.names));
  } finally {
    await c.end();
  }
  if (left.length > 0)
    throw new Error(
      `this test run's per-worker databases are not all gone after its teardown: ${left.join(", ")} — a copy (or a test's scratch database beside one) was left behind (TASK-223)`
    );
  delete process.env[WORKERS_ENV];
}
