/**
 * @jest-environment node
 */
/**
 * Erasure keeps every value and every type; the email-hash scheme constraint has no NULL hole
 * (review 10 L7, L8, L12)
 *
 * The reviewer's proofs (review10/__tests__/r10/sql/deep2.sql, r10-sql1.sql case 3):
 *   L7  a document too deep to read back was kept as a JSON string — an array or object became a
 *       string. Now it is redacted to its own type (depth 16 340, at the default stack).
 *   L8  {"ann@x.com":"p","<id>":"q"}: replacing the key collided with the existing one and one
 *       value was lost. Now every replaced key is numbered when a collision would occur: no loss.
 *   L12 user_deletions_email_hash_scheme_known passed a key id with no scheme (CHECK passes on
 *       NULL). Now refused.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { randomUUID } from "node:crypto";
import { withOwnerTx, withTenantTx } from "@/platform/data";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  DB_ENABLED,
  type TestTenant,
} from "../helpers/db";

let t: TestTenant;
if (DB_ENABLED) {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });
  beforeEach(async () => {
    t = await createTestTenant();
  });
}
const owner = <R>(text: string, values: unknown[] = []) =>
  withOwnerTx(
    "tenant-lifecycle",
    async (tx) => (await tx.query(text, values)).rows as R[]
  );
const replace = async (doc: unknown, target: string, replacement = "U1") =>
  (
    await owner<{ r: unknown }>(
      "select public.jsonb_replace_text_value($1::jsonb, $2::text, $3::text) as r",
      [JSON.stringify(doc), target, replacement]
    )
  )[0].r;

dbDescribe("r10 L7: never a change of type", () => {
  it("depth 16 340 at the default stack: an array stays an array, the address gone", async () => {
    const [row] = await withOwnerTx("tenant-lifecycle", async (tx) => {
      await tx.query(
        "create temp table r10_deep on commit drop as select (repeat('[', 16340) || '\"ann@x.com\"' || repeat(']', 16340))::jsonb as d"
      );
      return (
        await tx.query(
          `select jsonb_typeof(r) as kind, position('ann@x.com' in r::text) as at
             from (select public.jsonb_replace_text_value(d, 'ann@x.com', 'U1') as r from r10_deep) x`
        )
      ).rows;
    });
    expect(row).toEqual({ kind: "array", at: 0 });
  });
});

dbDescribe("r10 L8: a replaced key never loses a value", () => {
  it("the reviewer's case: the existing key keeps its value, the replaced one is numbered", async () => {
    expect(await replace({ "ann@x.com": "p", U1: "q" }, "ann@x.com")).toEqual({
      U1: "q",
      "U1#1": "p",
    });
  });

  it("two spellings of the address in one object: both values kept", async () => {
    expect(
      await replace(
        { "Ann@x.com": 1, "ann@x.com": 2, b: { "ANN@X.COM": ["ann@x.com"] } },
        "ann@x.com"
      )
    ).toEqual({ b: { "U1#1": ["U1"] }, "U1#2": 1, "U1#3": 2 });
  });

  it("a key on the full path (no @) collides the same way and is numbered the same way", async () => {
    expect(await replace({ true: 1, U1: 2 }, "true")).toEqual({ U1: 2, "U1#1": 1 });
  });

  it("an object already holding the numbered key: the replaced key carries the document's digest", async () => {
    const out = (await replace(
      { "ann@x.com": "p", U1: "q", "U1#1": "r" },
      "ann@x.com"
    )) as Record<string, unknown>;
    expect(out.U1).toBe("q");
    expect(out["U1#1"]).toBe("r");
    const extra = Object.keys(out).filter((k) => /^U1#1-[0-9a-f]{12}$/.test(k));
    expect(extra).toHaveLength(1);
    expect(out[extra[0]]).toBe("p");
  });

  it("no collision: replaced keys are not numbered", async () => {
    expect(
      await replace({ "ann@x.com": "p", other: { "ann@x.com": 1 } }, "ann@x.com")
    ).toEqual({ U1: "p", other: { U1: 1 } });
  });
});

dbDescribe("r10 L12: a key id never stands without its scheme", () => {
  const insert = (key: string | null, scheme: string | null) =>
    t.run(() =>
      withTenantTx((tx) =>
        tx.query(
          `insert into user_deletions (user_id, requested_by, email_hash, email_hash_key, email_hash_scheme)
           values ($1::uuid, 'r10', $2, $3, $4)`,
          [randomUUID(), "a".repeat(64), key, scheme]
        )
      )
    );

  it("the hostile row (a key id, no scheme) is refused", async () => {
    await expect(insert("b".repeat(16), null)).rejects.toThrow(
      /user_deletions_email_hash_scheme_known/
    );
  });

  it.each([
    ["b".repeat(16), "sha256"],
    [null, "unknown"],
  ])("key %p with scheme %p is refused", async (key, scheme) => {
    await expect(insert(key, scheme)).rejects.toThrow(
      /user_deletions_email_hash_scheme_known/
    );
  });

  it.each([
    ["b".repeat(16), "hmac-of-sha256"],
    [null, "sha256"],
    [null, "hmac"],
    [null, null],
  ])("key %p with scheme %p is accepted", async (key, scheme) => {
    await expect(insert(key, scheme)).resolves.toBeDefined();
  });
});
