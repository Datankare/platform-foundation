/**
 * @jest-environment node
 */
/**
 * __tests__/db/erasure-stack.db.test.ts — no erasure statement can reach the server's stack limit
 * on any stored value, on any architecture (platform TASK-229, migration 074; design 56e-3a §2.4, T5)
 *
 * What it refuses: an erasure or bound operation that fails on a document at the bound's depth
 *
 * Every stored JSON value is at most 128 levels deep (074, every jsonb column, every role). Every
 * JSON operation of today's soft delete, purge, cross-tenant pass and export, and the bound's own
 * walks (the number path, `|| '[]'`), is driven here on documents 128 deep — arrays, objects keyed
 * by an address, alternating — at max_stack_depth = 100kB, the least any Postgres allows
 * (helpers/stack.ts). Measured margins at 100kB: x86-64 3.3x, arm64 3.0x (design §2.4); at the
 * default 2 MB each is ~20x larger. This file is the one whose subject is the architecture: it runs
 * on CI (x86-64) and on the owner's Mac gate (arm64). The without-fix case (review A-10): without
 * the bound a document can be stored deep enough that the same stack stops an operation.
 */

import { Client } from "pg";
import { dbDescribe, DB_ENABLED } from "../helpers/db";
import {
  defineStackProbe,
  OPERATIONS,
  requireSuperuser,
  SHAPES,
  SMALLEST_STACK,
} from "../helpers/stack";

let owner: Client;
if (DB_ENABLED) {
  beforeAll(async () => {
    owner = new Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
    await owner.connect();
    await requireSuperuser(owner);
    await defineStackProbe(owner);
  });
  afterAll(async () => {
    await owner?.end();
  });
}

const ok = async (op: string, depth: number, shape: string): Promise<boolean> => {
  await owner.query("begin");
  try {
    const { rows } = await owner.query<{ ok: boolean }>(
      "select pg_temp.stack_ok($1, $2, $3) as ok",
      [op, depth, shape]
    );
    return rows[0].ok;
  } finally {
    await owner.query("rollback");
  }
};

dbDescribe(
  `T5: every erasure and bound operation at depth 128, at max_stack_depth = ${SMALLEST_STACK}`,
  () => {
    it("the deepest storable value is 128 levels (the bound refuses 129)", async () => {
      const { rows } = await owner.query<{ at: boolean; over: boolean }>(
        `select jsonb_path_exists((repeat('[', 128) || repeat(']', 128))::jsonb, public.json_bound_depth_path()) as at,
              jsonb_path_exists((repeat('[', 129) || repeat(']', 129))::jsonb, public.json_bound_depth_path()) as over`
      );
      expect(rows[0]).toEqual({ at: false, over: true });
    });

    it.each(SHAPES.flatMap((shape) => OPERATIONS.map((op) => [op, shape] as const)))(
      "%s on %s, 128 deep: completes",
      async (op, shape) => {
        expect(await ok(op, 128, shape)).toBe(true);
      }
    );

    it("[without-fix, A-10] without the bound: a document 3 000 deep, as a writer could store before 074, stops reading it back at this stack", async () => {
      expect(await ok("parse", 3000, "arr")).toBe(false);
      expect(await ok("erase-id-text", 3000, "obj")).toBe(false);
    });
  }
);
