/**
 * @jest-environment node
 */
/**
 * PostgresHealthProbe against the replayed database: `select 1` as the request role in a
 * platform transaction (no tenant) answers healthy, and an unreachable database is unhealthy.
 */

import { Pool } from "pg";
import { PostgresHealthProbe } from "@/platform/observability/health";
import { setDataPoolFactory } from "@/platform/data";
import { poolConfig } from "@/platform/data/pool";
import { runWithoutTenant } from "@/platform/tenancy/context";
import { connectTestDatabase, dbDescribe, disconnectTestDatabase } from "../helpers/db";

dbDescribe("PostgresHealthProbe", () => {
  beforeAll(connectTestDatabase);
  afterAll(disconnectTestDatabase);

  it("is healthy with no tenant", async () => {
    const r = await runWithoutTenant(() => new PostgresHealthProbe().check());
    expect(r).toMatchObject({ name: "database", status: "healthy", detail: "OK" });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("is unhealthy when the database cannot be reached", async () => {
    await setDataPoolFactory(
      (role) =>
        new Pool({
          ...poolConfig(role),
          connectionString: "postgresql://nobody:x@127.0.0.1:1/none",
          connectionTimeoutMillis: 500,
        })
    );
    try {
      const r = await new PostgresHealthProbe().check(2000);
      expect(r).toMatchObject({ name: "database", status: "unhealthy" });
    } finally {
      await connectTestDatabase();
    }
  });
});
