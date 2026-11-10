/**
 * @jest-environment node
 */
/**
 * __tests__/db/config-value-schema.db.test.ts — every setting's value fits the schema the routes
 * read a configuration value with (N-31, TASK-203)
 *
 * @guard a setting whose value a route body's schema would refuse
 *
 * The routes that take a setting's value (PATCH /api/admin/config, the operator's tenant settings,
 * the config assistant's update_config and request_approval) read it against CONFIG_VALUE_SCHEMA
 * (platform/admin/input-keys.ts) — no node of a body is left open. A setting seeded with a value of
 * another shape (a new kind of list of records) would be refused on its way back in: this reads
 * every value and default the migrations seeded, and every value stored in this database, and fails
 * on one the schema refuses — and on an agent record whose fields the schema does not name.
 */

import { connectTestDatabase, dbDescribe, disconnectTestDatabase } from "../helpers/db";
import { withOwnerTx } from "@/platform/data";
import { CONFIG_VALUE_SCHEMA, unknownInputKey } from "@/platform/admin/input-keys";

dbDescribe("every setting's value fits CONFIG_VALUE_SCHEMA (N-31)", () => {
  beforeAll(connectTestDatabase);
  afterAll(disconnectTestDatabase);

  it("every value and default of platform_config, and every tenant's own value", async () => {
    const rows = (
      await withOwnerTx("operator", (tx) =>
        tx.query<{ key: string; value: unknown }>(
          `select key, value from platform_config
           union all select key, default_value from platform_config where default_value is not null
           union all select key, value from tenant_config_overrides`
        )
      )
    ).rows;
    expect(rows.length).toBeGreaterThan(50);
    const refused = rows
      .map((r) => ({ key: r.key, at: unknownInputKey(CONFIG_VALUE_SCHEMA, r.value) }))
      .filter((r) => r.at !== null);
    expect(refused).toEqual([]);
  });

  it("[self-test] a value of another shape is refused, naming where", () => {
    expect(
      unknownInputKey(CONFIG_VALUE_SCHEMA, [["agent:x", { owner: "o", note: "x" }]])
    ).toEqual({
      field: "[0][1].note",
      allowed: ["owner", "scopes", "status", "maxTokenTtl", "displayName"],
    });
    expect(unknownInputKey(CONFIG_VALUE_SCHEMA, { a: 1 })).toMatchObject({ field: "a" });
    expect(unknownInputKey(CONFIG_VALUE_SCHEMA, [["cap", ["f1", "f2"]]])).toBeNull();
    expect(unknownInputKey(CONFIG_VALUE_SCHEMA, 5)).toBeNull();
  });
});
