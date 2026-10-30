/**
 * @jest-environment node
 */
/**
 * Operating tenants on Postgres (ADR-053 D7): provision, addresses, suspend and resume,
 * two-operator deletion, restore, purge, export, first administrator — each recorded in the
 * audit log first, in the operator's own tenant.
 */

import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { withOwnerTx, withTenantTx } from "@/platform/data";
import { setTenantDirectory, CachedTenantDirectory } from "@/platform/tenancy/directory";
import { PostgresTenantDirectory } from "@/platform/tenancy/postgres-directory";
import {
  addTenantDomain,
  decideTenantDeletion,
  exportTenantData,
  listTenantOverviews,
  makeTenantAdmin,
  provisionTenant,
  purgeDueTenants,
  removeTenantDomain,
  renameTenant,
  requestTenantDeletion,
  restoreTenant,
  resumeTenant,
  suspendTenant,
  type Operator,
} from "@/platform/tenancy/admin";
import { resolveAnonymous } from "@/platform/tenancy/resolve";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";

const made: string[] = [];
let home: TestTenant; // the operators' own tenant
let op1: Operator;
let op2: Operator;
const slug = () => `lc-${randomUUID().slice(0, 8)}`;
const host = () => `${randomUUID().slice(0, 8)}.lifecycle.test.example`;
const asOp = <T>(fn: () => Promise<T>) => home.run(fn);

async function provision(domains: string[] = []) {
  const r = await asOp(() =>
    provisionTenant(op1, { slug: slug(), name: "Lifecycle Co", domains })
  );
  if (!r.ok) throw new Error(r.message);
  made.push(r.value.id);
  return r.value;
}

/** Each suite below: the database, the operators' own tenant and two operators. */
function lifecycleHooks(): void {
  beforeAll(async () => {
    await connectTestDatabase();
    setTenantDirectory(new CachedTenantDirectory(new PostgresTenantDirectory()));
    home = await createTestTenant();
    op1 = { userId: await home.user("op1") };
    op2 = { userId: await home.user("op2") };
  });

  afterAll(async () => {
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
    made.length = 0;
    await dropTestTenants();
    await disconnectTestDatabase();
  });
}

dbDescribe("tenant lifecycle (ADR-053 D7)", () => {
  lifecycleHooks();

  async function auditTypes(): Promise<string[]> {
    const { rows } = await home.run(() =>
      withTenantTx((tx) =>
        tx.query<{ t: string }>(
          "select details->>'type' as t from audit_log where actor_id = $1 order by created_at",
          [op1.userId]
        )
      )
    );
    return rows.map((r) => r.t);
  }

  it("provisions an active tenant with its addresses, recorded first", async () => {
    const h = host();
    const t = await provision([h, h.toUpperCase()]);
    expect(t).toMatchObject({ status: "active", domains: [h] });
    await expect(
      resolveAnonymous(
        { headers: new Headers({ host: h }) },
        { env: { TENANCY_MODE: "shared", TENANT_HOST_HEADER: "host" }, hops: 1 }
      )
    ).resolves.toMatchObject({ ok: true, context: { tenantId: t.id } });
    expect(await auditTypes()).toContain("tenant_provisioned");
    const list = await asOp(() => listTenantOverviews());
    expect(list.find((x) => x.id === t.id)).toMatchObject({ domains: [h], userCount: 0 });
  });

  it("refuses bad input and taken slugs or addresses", async () => {
    const t = await provision();
    const bad = await asOp(() => provisionTenant(op1, { slug: "Bad Slug", name: "x" }));
    expect(bad).toMatchObject({ ok: false, code: "tenant.invalid" });
    const dupe = await asOp(() =>
      provisionTenant(op1, { slug: t.slug, name: "Again Co" })
    );
    expect(dupe).toMatchObject({ ok: false, code: "tenant.slug_taken" });
    const h = host();
    await asOp(() => addTenantDomain(op1, t.id, h));
    const other = await provision();
    await expect(asOp(() => addTenantDomain(op1, other.id, h))).resolves.toMatchObject({
      ok: false,
      code: "tenant.domain_taken",
    });
    await expect(
      asOp(() => addTenantDomain(op1, other.id, "not a host"))
    ).resolves.toMatchObject({
      ok: false,
      code: "tenant.invalid",
    });
    await expect(asOp(() => removeTenantDomain(op1, other.id, h))).resolves.toMatchObject(
      {
        ok: false,
        code: "tenant.not_found",
      }
    );
    await expect(asOp(() => removeTenantDomain(op1, t.id, h))).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      asOp(() => renameTenant(op1, t.id, "New Name Co"))
    ).resolves.toMatchObject({
      ok: true,
      value: { name: "New Name Co" },
    });
  });

  it("suspends and resumes; refuses suspending the operators' own tenant", async () => {
    const h = host();
    const t = await provision([h]);
    await expect(asOp(() => suspendTenant(op1, home.id, "nope"))).resolves.toMatchObject({
      ok: false,
      code: "tenant.own_tenant",
    });
    await expect(asOp(() => suspendTenant(op1, t.id, "x"))).resolves.toMatchObject({
      code: "tenant.invalid",
    });
    await expect(
      asOp(() => suspendTenant(op1, t.id, "billing hold"))
    ).resolves.toMatchObject({
      ok: true,
      value: { status: "suspended" },
    });
    // This instance's directory cache sees it at once.
    await expect(
      resolveAnonymous(
        { headers: new Headers({ host: h }) },
        { env: { TENANCY_MODE: "shared", TENANT_HOST_HEADER: "host" }, hops: 1 }
      )
    ).resolves.toMatchObject({ ok: false, code: "tenant.suspended" });
    await expect(
      asOp(() => suspendTenant(op1, t.id, "again please"))
    ).resolves.toMatchObject({
      code: "tenant.state_conflict",
    });
    await expect(asOp(() => resumeTenant(op1, t.id, "paid up"))).resolves.toMatchObject({
      ok: true,
      value: { status: "active" },
    });
  });

  it("deletes only with a second operator, then restores before purge", async () => {
    const t = await provision();
    const req = await asOp(() => requestTenantDeletion(op1, t.id, "customer left"));
    expect(req).toMatchObject({ ok: true, value: { status: "pending" } });
    const again = await asOp(() => requestTenantDeletion(op2, t.id, "twice over"));
    expect(again).toMatchObject({ ok: false, code: "tenant.state_conflict" });
    const id = (req as { value: { id: string } }).value.id;
    await expect(
      asOp(() => decideTenantDeletion(op1, id, true, "mine"))
    ).resolves.toMatchObject({
      code: "tenant.self_approval",
    });
    const approved = await asOp(() => decideTenantDeletion(op2, id, true, "agreed"));
    expect(approved).toMatchObject({ ok: true, value: { status: "executed" } });
    const list = await asOp(() => listTenantOverviews());
    expect(list.find((x) => x.id === t.id)).toMatchObject({ status: "deleted" });
    expect(list.find((x) => x.id === t.id)?.purgeAfter).toBeDefined();
    await expect(
      asOp(() => decideTenantDeletion(op2, id, true, "late"))
    ).resolves.toMatchObject({
      code: "tenant.state_conflict",
    });
    await expect(
      asOp(() => restoreTenant(op1, t.id, "came back"))
    ).resolves.toMatchObject({
      ok: true,
      value: { status: "suspended" },
    });
  });

  it("the requester may withdraw; a deletion of the operators' own tenant is refused", async () => {
    const t = await provision();
    const req = await asOp(() => requestTenantDeletion(op1, t.id, "maybe later"));
    const id = (req as { value: { id: string } }).value.id;
    await expect(
      asOp(() => decideTenantDeletion(op1, id, false, "withdrawn"))
    ).resolves.toMatchObject({
      ok: true,
      value: { status: "rejected" },
    });
    await expect(
      asOp(() => requestTenantDeletion(op1, home.id, "no way"))
    ).resolves.toMatchObject({
      code: "tenant.own_tenant",
    });
    await expect(
      asOp(() => decideTenantDeletion(op2, randomUUID(), true, "x"))
    ).resolves.toMatchObject({
      code: "tenant.request_not_found",
    });
  });

  it("exports a tenant's rows from one snapshot, and purges them when due — never another tenant's", async () => {
    const t = await provision();
    const keep = await provision();
    for (const [tenant, n] of [
      [t.id, 3],
      [keep.id, 2],
    ] as const) {
      await withOwnerTx("tenant-lifecycle", async (tx) => {
        for (let i = 0; i < n; i++) {
          const uid = randomUUID();
          await tx.query(
            "insert into users (id, cognito_sub, email, role_id, tenant_id) select $1::uuid, $1::uuid, $2, id, $3::uuid from roles where is_default",
            [uid, `u${i}-${uid.slice(0, 6)}@lc.example`, tenant]
          );
        }
      });
    }
    const chunks: string[] = [];
    const exported = await asOp(() =>
      exportTenantData(op1, t.id, async (c) => void chunks.push(c))
    );
    expect(exported).toMatchObject({ ok: true, value: 3 });
    const lines = chunks
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(4);
    const [head, ...rowLines] = lines;
    expect(head.export).toMatchObject({
      format: 1,
      tenant: { id: t.id, status: "active" },
      domains: expect.any(Array),
    });
    expect(Date.parse(head.export.at)).not.toBeNaN();
    expect(rowLines).toHaveLength(3);
    expect(rowLines.every((l) => l.table === "users" && l.row.tenant_id === t.id)).toBe(
      true
    );

    // Not due yet: nothing purged.
    const req = await asOp(() => requestTenantDeletion(op1, t.id, "closing account"));
    await asOp(() =>
      decideTenantDeletion(op2, (req as { value: { id: string } }).value.id, true, "ok")
    );
    let purged = await asOp(() => purgeDueTenants(op1));
    expect(purged.ok && purged.value.some((p) => p.tenantId === t.id)).toBe(false);
    await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query(
        "update tenants set purge_after = now() - interval '1 minute' where id = $1",
        [t.id]
      )
    );
    purged = await asOp(() => purgeDueTenants(op1));
    expect(purged).toMatchObject({ ok: true });
    expect(
      (purged as unknown as { value: { tenantId: string; rows: number }[] }).value
    ).toContainEqual({
      tenantId: t.id,
      rows: 3,
    });
    const counts = await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query<{ tenant_id: string; n: number }>(
        "select tenant_id, count(*)::int as n from users where tenant_id = any($1::uuid[]) group by tenant_id",
        [[t.id, keep.id]]
      )
    );
    expect(counts.rows).toEqual([{ tenant_id: keep.id, n: 2 }]);
    await expect(
      asOp(() => restoreTenant(op1, t.id, "too late now"))
    ).resolves.toMatchObject({
      code: "tenant.state_conflict",
    });
  });

  it("makes a tenant's own user its administrator, and only its own", async () => {
    const t = await provision();
    const uid = randomUUID();
    await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query(
        "insert into users (id, cognito_sub, email, email_verified, role_id, tenant_id) select $1::uuid, $1::uuid, 'First.Admin@Example.com', true, id, $2::uuid from roles where is_default",
        [uid, t.id]
      )
    );
    await expect(
      asOp(() => makeTenantAdmin(op1, t.id, "first.admin@example.com"))
    ).resolves.toEqual({
      ok: true,
      value: { userId: uid },
    });
    // The same email in another tenant is not this tenant's user.
    const other = await provision();
    await expect(
      asOp(() => makeTenantAdmin(op1, other.id, "first.admin@example.com"))
    ).resolves.toMatchObject({
      code: "tenant.user_not_found",
    });
    await expect(
      asOp(() => makeTenantAdmin(op1, t.id, "not-an-email"))
    ).resolves.toMatchObject({
      code: "tenant.invalid",
    });
    const role = await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query<{ name: string }>(
        "select r.name from users u join roles r on r.id = u.role_id where u.id = $1",
        [uid]
      )
    );
    expect(role.rows[0].name).toBe("admin");
  });
});

dbDescribe("tenant lifecycle: one account, one outcome (ADR-053 D7)", () => {
  lifecycleHooks();

  async function addUser(
    tenantId: string,
    email: string,
    opts: { verified?: boolean; deleted?: boolean } = {}
  ): Promise<string> {
    const uid = randomUUID();
    await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query(
        `insert into users (id, cognito_sub, email, email_verified, deleted_at, role_id, tenant_id)
         select $1::uuid, $1::uuid, $2, $3, case when $4 then now() end, id, $5::uuid
           from roles where is_default`,
        [uid, email, opts.verified ?? true, opts.deleted ?? false, tenantId]
      )
    );
    return uid;
  }

  async function roleName(uid: string): Promise<string> {
    const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query<{ name: string }>(
        "select r.name from users u join roles r on r.id = u.role_id where u.id = $1",
        [uid]
      )
    );
    return rows[0].name;
  }

  it("never promotes two accounts that share an email: refused, and neither changes", async () => {
    const t = await provision();
    const a = await addUser(t.id, "twin@example.com");
    const b = await addUser(t.id, "TWIN@example.com");
    await expect(
      asOp(() => makeTenantAdmin(op1, t.id, "twin@example.com"))
    ).resolves.toMatchObject({
      ok: false,
      code: "tenant.state_conflict",
      message: expect.stringMatching(/More than one account/),
    });
    expect(await roleName(a)).not.toBe("admin");
    expect(await roleName(b)).not.toBe("admin");
  });

  it("promotes only the live, verified account: a deleted one is ignored, an unverified refused", async () => {
    const t = await provision();
    const gone = await addUser(t.id, "live@example.com", { deleted: true });
    const live = await addUser(t.id, "live@example.com");
    await expect(
      asOp(() => makeTenantAdmin(op1, t.id, "live@example.com"))
    ).resolves.toEqual({ ok: true, value: { userId: live } });
    expect(await roleName(gone)).not.toBe("admin");

    const onlyDeleted = await addUser(t.id, "deleted@example.com", { deleted: true });
    await expect(
      asOp(() => makeTenantAdmin(op1, t.id, "deleted@example.com"))
    ).resolves.toMatchObject({ code: "tenant.user_not_found" });
    expect(await roleName(onlyDeleted)).not.toBe("admin");

    const unverified = await addUser(t.id, "unverified@example.com", { verified: false });
    await expect(
      asOp(() => makeTenantAdmin(op1, t.id, "unverified@example.com"))
    ).resolves.toMatchObject({
      code: "tenant.state_conflict",
      message: expect.stringMatching(/not verified/),
    });
    expect(await roleName(unverified)).not.toBe("admin");
  });

  /** A deleted tenant, due for purge, holding one user. */
  async function deletedWithData(): Promise<{ id: string; user: string }> {
    const t = await provision();
    const user = await addUser(t.id, `held-${randomUUID().slice(0, 6)}@example.com`);
    const req = await asOp(() => requestTenantDeletion(op1, t.id, "race check"));
    const approved = await asOp(() =>
      decideTenantDeletion(op2, (req as { value: { id: string } }).value.id, true, "ok")
    );
    expect(approved).toMatchObject({ ok: true });
    // Its purge_after stays in the future: these tests call tenant_purge themselves, and a due
    // tenant would be purged first by another suite's run of the purge duty in parallel (the
    // purge it then waits on would find nothing to delete and the race would not be tested).
    return { id: t.id, user };
  }

  async function stateOf(id: string) {
    const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query<{ status: string; purged_at: Date | null; users: number }>(
        `select status, purged_at,
                (select count(*)::int from users where tenant_id = $1::uuid) as users
           from tenants where id = $1::uuid`,
        [id]
      )
    );
    return rows[0];
  }

  /** A connection of its own, outside platform/data, to hold a transaction open. */
  async function ownerClient(): Promise<Client> {
    const c = new Client({ connectionString: process.env.TEST_DATABASE_OWNER_URL });
    await c.connect();
    return c;
  }

  it("a restore that waits on a running purge finds the tenant purged: never restored empty", async () => {
    const t = await deletedWithData();
    const purger = await ownerClient();
    try {
      // The purge runs first and holds the tenant's row until it commits.
      await purger.query("begin");
      await purger.query("select * from public.tenant_purge($1::uuid)", [t.id]);
      const restoring = asOp(() => restoreTenant(op1, t.id, "came back"));
      // The restore has read "not purged" and is now waiting on the purge's lock.
      await new Promise((r) => setTimeout(r, 300));
      await purger.query("commit");
      await expect(restoring).resolves.toMatchObject({
        ok: false,
        code: "tenant.state_conflict",
        message: expect.stringMatching(/purged/),
      });
    } finally {
      await purger.end();
    }
    expect(await stateOf(t.id)).toMatchObject({ status: "deleted", users: 0 });
    expect((await stateOf(t.id)).purged_at).not.toBeNull();
  });

  it("a purge that waits on a restore refuses: the restored tenant keeps its data", async () => {
    const t = await deletedWithData();
    const restorer = await ownerClient();
    let purge: Promise<unknown> | undefined;
    const purger = await ownerClient();
    try {
      // A restore in flight: the tenant's row is changed and locked, not yet committed.
      await restorer.query("begin");
      await restorer.query(
        "update tenants set status = 'suspended', purge_after = null where id = $1::uuid and status = 'deleted' and purged_at is null",
        [t.id]
      );
      purge = purger.query("select * from public.tenant_purge($1::uuid)", [t.id]);
      purge.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
      await restorer.query("commit");
      await expect(purge).rejects.toThrow(/is not deleted/);
    } finally {
      await restorer.end();
      await purger.end();
    }
    expect(await stateOf(t.id)).toMatchObject({
      status: "suspended",
      purged_at: null,
      users: 1,
    });
  });

  it("an approval that cannot delete the tenant leaves the request pending (one transaction)", async () => {
    const t = await provision();
    const req = await asOp(() => requestTenantDeletion(op1, t.id, "fault check"));
    const id = (req as { value: { id: string } }).value.id;
    // The tenant's state change fails: its row is held elsewhere, so the change times out.
    const blocker = await ownerClient();
    const timeout = process.env.DATABASE_STATEMENT_TIMEOUT_MS;
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = "1000";
    try {
      await blocker.query("begin");
      await blocker.query("select 1 from tenants where id = $1::uuid for update", [t.id]);
      await expect(
        asOp(() => decideTenantDeletion(op2, id, true, "agreed"))
      ).rejects.toMatchObject({ code: "57014" });
    } finally {
      process.env.DATABASE_STATEMENT_TIMEOUT_MS = timeout;
      await blocker.query("rollback");
      await blocker.end();
    }
    const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query<{ request: string; tenant: string }>(
        `select r.status as request, t.status as tenant
           from tenant_lifecycle_requests r join tenants t on t.id = r.tenant_id
          where r.id = $1::uuid`,
        [id]
      )
    );
    expect(rows[0]).toEqual({ request: "pending", tenant: "active" });
  });
});
