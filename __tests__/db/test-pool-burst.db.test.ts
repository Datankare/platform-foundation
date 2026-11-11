/**
 * @jest-environment node
 */
/**
 * The test pool takes a burst larger than itself (TASK-204, N-3): the budget suites put 20-24
 * transactions at once on the test's 4 connections. A queued checkout waits up to the test's own
 * bound (DB_TEST_TIMEOUT_MS), not the deployment's 5 s connect timeout — so under CI load a burst
 * waits its turn instead of failing "timeout exceeded when trying to connect". Forty transactions
 * of 0.6 s each on 4 connections keep the last one waiting about 5.4 s: past the deployment's
 * bound, inside the test's.
 */
import { withOwnerTx } from "@/platform/data";
import {
  connectTestDatabase,
  dbDescribe,
  DB_TEST_TIMEOUT_MS,
  disconnectTestDatabase,
} from "../helpers/db";

dbDescribe("the test pool under a burst", () => {
  beforeAll(connectTestDatabase);
  afterAll(disconnectTestDatabase);

  it("forty concurrent transactions on four connections all complete", async () => {
    expect(DB_TEST_TIMEOUT_MS).toBeGreaterThan(5_000);
    const started = Date.now();
    const done = await Promise.all(
      Array.from({ length: 40 }, () =>
        withOwnerTx("operator", (tx) => tx.query("select pg_sleep(0.6)").then(() => 1))
      )
    );
    expect(done).toHaveLength(40);
    // The burst did wait past the deployment's 5 s connect timeout (the case this covers).
    expect(Date.now() - started).toBeGreaterThan(5_000);
  });
});
