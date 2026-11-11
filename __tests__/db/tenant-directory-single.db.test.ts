/**
 * @jest-environment node
 */
/**
 * A dedicated deployment's operator console keeps one tenant directory (TASK-206, N-103).
 *
 * A dedicated deployment (TENANCY_MODE=single) left TENANT_DIRECTORY_STORE unset and so ran on the
 * in-memory directory, while the tenant lifecycle is SQL on the owner connection (ADR-053 D7). An
 * operator's new tenant, rename or address lived only in the process that made it; removing an
 * address just added read `tenant_domains` and answered 404, and a deletion read `tenants` and did
 * not find the tenant (found by TASK-204's e2e admin-routes journey). Boot now keeps the directory
 * in Postgres whenever the deployment has a database (getTenantDirectoryStore), so every read and
 * write below meets the same rows. Each step is the operator's, in the order the console offers it,
 * through the directory boot chose — never one this test sets.
 */

import { randomUUID } from "node:crypto";
import { ROLE_PERMISSIONS } from "../helpers/test-identities";
import { withOwnerTx } from "@/platform/data";
import { getTenantDirectoryStore } from "@/platform/providers/environment-contract";
import { initTenantDirectory } from "@/platform/providers/registry";
import { getTenantDirectory } from "@/platform/tenancy/directory";
import { PostgresTenantDirectory } from "@/platform/tenancy/postgres-directory";
import { runWithTenant } from "@/platform/tenancy/context";
import {
  addTenantDomain,
  decideTenantDeletion,
  listTenantOverviews,
  provisionTenant,
  removeTenantDomain,
  renameTenant,
  requestTenantDeletion,
  type Operator,
} from "@/platform/tenancy/admin";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";

const made: string[] = [];
let home: TestTenant;
let op1: Operator;
let op2: Operator;
const host = () => `${randomUUID().slice(0, 8)}.single.test.example`;
/** The operator acting in a dedicated deployment: its one tenant, in single mode. */
const asOperator = <T>(fn: () => Promise<T>) =>
  runWithTenant({ tenantId: home.id, mode: "single" }, fn);
const SAVED = process.env.TENANT_DIRECTORY_STORE;

dbDescribe("a dedicated deployment's operator console (TASK-206, N-103)", () => {
  beforeAll(async () => {
    await connectTestDatabase();
    // As a dedicated deployment is configured (docs/TENANCY_OPERATIONS.md section 2): the store unset.
    delete process.env.TENANT_DIRECTORY_STORE;
    initTenantDirectory(getTenantDirectoryStore());
    home = await createTestTenant();
    const op1Id = await home.user("op1", "super_admin");
    op1 = {
      userId: op1Id,
      admin: {
        userId: op1Id,
        sub: `sub-${op1Id}`,
        roleName: "super_admin",
        permissions: ROLE_PERMISSIONS.super_admin,
      },
    };
    op2 = { userId: await home.user("op2", "super_admin") };
  });

  afterAll(async () => {
    if (SAVED === undefined) delete process.env.TENANT_DIRECTORY_STORE;
    else process.env.TENANT_DIRECTORY_STORE = SAVED;
    await withOwnerTx("tenant-lifecycle", async (tx) => {
      for (const id of made) {
        await tx.query(
          "update tenants set status = 'deleted', purge_after = now() where id = $1 and status <> 'deleted'",
          [id]
        );
        await tx.query("select * from public.tenant_purge($1::uuid)", [id]);
        await tx.query("delete from tenant_lifecycle_requests where tenant_id = $1", [
          id,
        ]);
        await tx.query("delete from tenants where id = $1", [id]);
      }
    });
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  it("boot keeps the directory in the database the lifecycle reads", () => {
    expect(getTenantDirectoryStore()).toBe("postgres");
    expect((getTenantDirectory() as unknown as { inner: unknown }).inner).toBeInstanceOf(
      PostgresTenantDirectory
    );
  });

  it("an address just added is removed; a rename and a new tenant are what every instance reads", async () => {
    const first = host();
    const made1 = await asOperator(() =>
      provisionTenant(op1, {
        slug: `sg-${randomUUID().slice(0, 8)}`,
        name: "Single Co",
        domains: [first],
      })
    );
    expect(made1).toMatchObject({ ok: true });
    const id = (made1 as { value: { id: string } }).value.id;
    made.push(id);

    const second = host();
    await expect(
      asOperator(() => addTenantDomain(op1, id, second))
    ).resolves.toMatchObject({ ok: true, value: { host: second } });
    // It was 404 (tenant.not_found): the address was in this process only.
    await expect(asOperator(() => removeTenantDomain(op1, id, second))).resolves.toEqual({
      ok: true,
      value: true,
    });
    await expect(
      asOperator(() => renameTenant(op1, id, "Single Co, renamed"))
    ).resolves.toMatchObject({ ok: true, value: { name: "Single Co, renamed" } });

    // The database — what another instance, and the lifecycle's SQL, read — holds the same.
    const rows = await withOwnerTx("tenant-lifecycle", async (tx) => ({
      tenant: (
        await tx.query<{ name: string; status: string }>(
          "select name, status from tenants where id = $1::uuid",
          [id]
        )
      ).rows,
      hosts: (
        await tx.query<{ host: string }>(
          "select host from tenant_domains where tenant_id = $1::uuid order by host",
          [id]
        )
      ).rows.map((r) => r.host),
    }));
    expect(rows).toEqual({
      tenant: [{ name: "Single Co, renamed", status: "active" }],
      hosts: [first],
    });
    const listed = await asOperator(() => listTenantOverviews());
    expect(listed.find((t) => t.id === id)).toMatchObject({
      name: "Single Co, renamed",
      domains: [first],
    });
  });

  it("a tenant just provisioned is deleted with a second operator", async () => {
    const made2 = await asOperator(() =>
      provisionTenant(op1, {
        slug: `sg-${randomUUID().slice(0, 8)}`,
        name: "Leaving Co",
        domains: [host()],
      })
    );
    expect(made2).toMatchObject({ ok: true });
    const id = (made2 as { value: { id: string } }).value.id;
    made.push(id);
    // It was tenant.not_found: the request read `tenants`, where the new tenant was not.
    const asked = await asOperator(() => requestTenantDeletion(op1, id, "customer left"));
    expect(asked).toMatchObject({ ok: true, value: { status: "pending" } });
    const requestId = (asked as { value: { id: string } }).value.id;
    await expect(
      asOperator(() => decideTenantDeletion(op2, requestId, true, "agreed"))
    ).resolves.toMatchObject({ ok: true, value: { status: "executed" } });
    // Another instance's directory, nothing cached, reads it deleted.
    await expect(new PostgresTenantDirectory().getTenant(id)).resolves.toMatchObject({
      status: "deleted",
    });
  });
});
