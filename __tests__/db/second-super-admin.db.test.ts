/**
 * @jest-environment node
 */
/**
 * __tests__/db/second-super-admin.db.test.ts — the documented second-super-admin bootstrap runs
 * as written, against the real schema, and refuses what it says it refuses (N-85, TASK-203)
 * @not-guard: runs the documented owner SQL against a database; reads the document to execute it
 *
 * The SQL an owner runs by hand is read from docs/TENANCY_OPERATIONS.md ("The second super admin")
 * and its check query too, so the document cannot drift from the schema (earlier owner SQL named
 * `last_sign_in_at` — the column is `last_login_at` — and other shapes the migrations never made).
 * Each case runs the block in a transaction that is rolled back, in a tenant of its own (the
 * block's `default` replaced by that tenant's slug, and its placeholder address by the case's):
 * nothing is left behind.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";
import { withOwnerTx, type Tx } from "@/platform/data";

const DOC = readFileSync(join(__dirname, "../../docs/TENANCY_OPERATIONS.md"), "utf8");
const SECTION = DOC.slice(DOC.indexOf("### The second super admin"));
const blocks = [...SECTION.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
const PROCEDURE = blocks[0];
const CHECK = blocks[1];
const PLACEHOLDER = "REPLACE-WITH-THE-SECOND-ADDRESS@example.com";

class Rollback extends Error {}

/** Run `fn` in an owner transaction that is always rolled back; its value, or what it threw. */
async function rolledBack<T>(fn: (tx: Tx) => Promise<T>): Promise<T | Error> {
  let out: T | Error = new Error("not run");
  try {
    await withOwnerTx("tenant-lifecycle", async (tx) => {
      try {
        out = await fn(tx);
      } catch (err) {
        out = err as Error;
      }
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return out;
}

/** The procedure for `address` in tenant `slug`, without its own begin/commit (the test's tx). */
function procedure(address: string | null, slug: string): string {
  const body = PROCEDURE.replace(/^begin;\n/m, "").replace(/^commit;\n?/m, "");
  return body
    .replace(`v_tenant constant text := 'default'`, `v_tenant constant text := '${slug}'`)
    .replace(address === null ? "\u0000" : PLACEHOLDER, address ?? "");
}

dbDescribe("the second super admin, as TENANCY_OPERATIONS documents it (N-85)", () => {
  let t: TestTenant;
  let slug: string;

  beforeAll(async () => {
    await connectTestDatabase();
    t = await createTestTenant();
    slug = (
      await withOwnerTx("tenant-lifecycle", (tx) =>
        tx.query<{ slug: string }>("select slug from tenants where id = $1", [t.id])
      )
    ).rows[0].slug;
  });

  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  it("the document holds the procedure and its check", () => {
    expect(PROCEDURE).toContain("'role_bootstrap'");
    expect(PROCEDURE).toContain("'TENANCY_OPERATIONS: the second super admin'");
    expect(CHECK).toContain("last_login_at");
  });

  /** In `tx`: an account in the test tenant with `role`, address `email`; its id. */
  const account = async (tx: Tx, email: string, role: string) => {
    const id = randomUUID();
    await tx.query(
      `insert into users (id, cognito_sub, email, role_id, tenant_id)
       select $1::uuid, $1::text, $2, r.id, $3::uuid from roles r where r.name = $4`,
      [id, email, t.id, role]
    );
    return id;
  };

  it("makes the account the second super_admin, records it, and the check reads it back", async () => {
    const r = await rolledBack(async (tx) => {
      await account(tx, "owner@example.com", "super_admin");
      const second = await account(tx, "Second.Owner@example.org", "admin");
      await tx.query(procedure("  second.owner@EXAMPLE.org ", slug));
      const roles = await tx.query<{ name: string }>(
        "select r.name from users u join roles r on r.id = u.role_id where u.id = $1::uuid",
        [second]
      );
      const audit = await tx.query<{
        details: Record<string, string>;
        target_id: string;
      }>(
        `select details, target_id from audit_log
          where tenant_id = $1::uuid and details->>'type' = 'role_bootstrap'`,
        [t.id]
      );
      // The document's check, as written (it reads every tenant: the test's rows are among them).
      const [supers, records] = await Promise.all(
        CHECK.split(/;\s*\n/)
          .map((q) => q.trim())
          .filter((q) => q.length > 0)
          .map((q) => tx.query<Record<string, unknown>>(q))
      );
      return { second, roles: roles.rows, audit: audit.rows, supers, records };
    });
    if (r instanceof Error) throw r;
    expect(r.roles).toEqual([{ name: "super_admin" }]);
    expect(r.audit).toEqual([
      {
        target_id: r.second,
        details: {
          type: "role_bootstrap",
          role: "super_admin",
          from_role: "admin",
          procedure: "TENANCY_OPERATIONS: the second super admin",
        },
      },
    ]);
    expect(r.supers.rows.some((x) => x.email === "Second.Owner@example.org")).toBe(true);
    expect(r.records.rows.some((x) => x.target_id === r.second)).toBe(true);
  });

  const refused = async (setup: (tx: Tx) => Promise<void>, address: string | null) => {
    const r = await rolledBack(async (tx) => {
      await setup(tx);
      await tx.query(procedure(address, slug));
      return "ran";
    });
    return r instanceof Error ? r.message : r;
  };

  it("refuses the placeholder address left in place", async () => {
    expect(
      await refused(async (tx) => {
        await account(tx, "owner@example.com", "super_admin");
      }, null)
    ).toMatch(/replace the address/);
  });

  it("refuses an address no account has, or two accounts have", async () => {
    expect(
      await refused(async (tx) => {
        await account(tx, "owner@example.com", "super_admin");
      }, "nobody@example.org")
    ).toMatch(/0 accounts/);
    expect(
      await refused(async (tx) => {
        await account(tx, "owner@example.com", "super_admin");
        await account(tx, "twice@example.org", "admin");
        await account(tx, "TWICE@example.org", "moderator");
      }, "twice@example.org")
    ).toMatch(/2 accounts/);
  });

  it("refuses a deleted account", async () => {
    expect(
      await refused(async (tx) => {
        await account(tx, "owner@example.com", "super_admin");
        const gone = await account(tx, "gone@example.org", "admin");
        await tx.query("update users set deleted_at = now() where id = $1::uuid", [gone]);
      }, "gone@example.org")
    ).toMatch(/0 accounts/);
  });

  it("refuses an account that is already a super_admin", async () => {
    expect(
      await refused(async (tx) => {
        await account(tx, "owner@example.com", "super_admin");
      }, "owner@example.com")
    ).toMatch(/already a super_admin/);
  });

  it("refuses the mailbox of an existing super_admin under a +tag", async () => {
    expect(
      await refused(async (tx) => {
        await account(tx, "owner@example.com", "super_admin");
        await account(tx, "Owner+second@example.com", "admin");
      }, "owner+second@example.com")
    ).toMatch(/mailbox of an existing super_admin/);
  });

  it("refuses when the tenant has no super_admin, or already two", async () => {
    expect(
      await refused(async (tx) => {
        await account(tx, "first@example.org", "admin");
      }, "first@example.org")
    ).toMatch(/has 0 super_admins/);
    expect(
      await refused(async (tx) => {
        await account(tx, "a@example.com", "super_admin");
        await account(tx, "b@example.com", "super_admin");
        await account(tx, "third@example.org", "admin");
      }, "third@example.org")
    ).toMatch(/has 2 super_admins/);
  });
});
