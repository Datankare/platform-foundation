/**
 * @jest-environment node
 */
/**
 * PostgresTenantDirectory against the replayed database (ADR-053 D2, D7): the request role reads
 * one tenant or one host through the directory functions and nothing else; operators manage
 * tenants and domains on the owner connection.
 */

import { randomUUID } from "node:crypto";
import { PostgresTenantDirectory } from "@/platform/tenancy/postgres-directory";
import { TenantDirectoryConflictError } from "@/platform/tenancy/directory";
import { resolveAnonymous, resolveForIdentity } from "@/platform/tenancy/resolve";
import { withOwnerTx, withPlatformTx, withTenantTx } from "@/platform/data";
import { runWithTenant } from "@/platform/tenancy/context";
import { connectTestDatabase, dbDescribe, disconnectTestDatabase } from "../helpers/db";

const made: string[] = [];
const dir = new PostgresTenantDirectory();
const host = (label: string) => `${label}-${randomUUID().slice(0, 8)}.dir.test.example`;

async function make(name = "Directory Test") {
  const id = randomUUID();
  made.push(id);
  return dir.createTenant({ id, slug: `d-${id.slice(0, 8)}`, name });
}

dbDescribe("PostgresTenantDirectory", () => {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await withOwnerTx("tenant-lifecycle", async (tx) => {
      await tx.query("delete from tenant_domains where tenant_id = any($1::uuid[])", [
        made,
      ]);
      await tx.query("delete from tenants where id = any($1::uuid[])", [made]);
    });
    await disconnectTestDatabase();
  });

  it("creates a tenant, active, and reads it back by id and slug", async () => {
    const t = await make("  Acme   Co ");
    expect(t).toMatchObject({ name: "Acme Co", status: "active" });
    await expect(dir.getTenant(t.id)).resolves.toMatchObject({
      id: t.id,
      status: "active",
    });
    // Its own details inside its own scope (the tenant's own settings page).
    await expect(
      runWithTenant({ tenantId: t.id, mode: "shared" }, () => dir.getTenant(t.id))
    ).resolves.toMatchObject({ id: t.id, slug: t.slug, name: t.name });
    await expect(dir.getTenantBySlug(t.slug)).resolves.toMatchObject({ id: t.id });
    await expect(dir.getTenant(randomUUID())).resolves.toBeNull();
    await expect(dir.getTenant("not-a-uuid")).resolves.toBeNull();
    await expect(dir.getTenantBySlug("Not A Slug")).resolves.toBeNull();
    expect((await dir.listTenants()).some((x) => x.id === t.id)).toBe(true);
  });

  it("refuses duplicates and malformed input with the directory's own errors", async () => {
    const t = await make();
    await expect(
      dir.createTenant({ id: t.id, slug: "other-slug-x", name: "Xx" })
    ).rejects.toMatchObject({
      code: "tenant.exists",
    });
    const id = randomUUID();
    made.push(id);
    await expect(
      dir.createTenant({ id, slug: t.slug, name: "Xx" })
    ).rejects.toBeInstanceOf(TenantDirectoryConflictError);
    await expect(dir.createTenant({ id: "x", slug: "ok", name: "Xx" })).rejects.toThrow(
      /id/
    );
    await expect(dir.createTenant({ id, slug: "-bad", name: "Xx" })).rejects.toThrow(
      /slug/
    );
    await expect(dir.createTenant({ id, slug: "okay", name: "\u0000" })).rejects.toThrow(
      /name/
    );
  });

  it("maps a host to one tenant; only that tenant can unmap it", async () => {
    const a = await make();
    const b = await make();
    const h = host("acme");
    await dir.addDomain(a.id, h);
    await expect(dir.tenantForHost(h)).resolves.toBe(a.id);
    await expect(dir.addDomain(b.id, h)).rejects.toMatchObject({
      code: "tenant.domain_taken",
    });
    await expect(dir.addDomain(randomUUID(), host("ghost"))).rejects.toThrow(
      /Unknown tenant/
    );
    await expect(dir.addDomain(a.id, "UPPER.example.com")).rejects.toThrow(
      /Malformed host/
    );
    expect((await dir.listDomains(a.id)).map((d) => d.host)).toEqual([h]);
    await expect(dir.removeDomain(b.id, h)).resolves.toBe(false);
    await expect(dir.removeDomain(a.id, h)).resolves.toBe(true);
    await expect(dir.tenantForHost(h)).resolves.toBeNull();
    await expect(dir.tenantForHost("Not Normal")).resolves.toBeNull();
  });

  it("changes state only from an expected state, and a deletion sets the purge time", async () => {
    const t = await make();
    const s = await dir.setStatus({
      tenantId: t.id,
      from: ["active"],
      to: "suspended",
      by: "op",
      reason: "billing",
    });
    expect(s).toMatchObject({
      status: "suspended",
      statusChangedBy: "op",
      statusReason: "billing",
    });
    await expect(
      dir.setStatus({
        tenantId: t.id,
        from: ["active"],
        to: "suspended",
        by: "op",
        reason: "again",
      })
    ).resolves.toBeNull();
    const d = await dir.setStatus({
      tenantId: t.id,
      from: ["suspended"],
      to: "deleted",
      by: "op",
      reason: "closed",
    });
    expect(d?.status).toBe("deleted");
    const { rows } = await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query<{ days: number }>(
        "select extract(day from purge_after - now())::int as days from tenants where id = $1",
        [t.id]
      )
    );
    expect(rows[0].days).toBeGreaterThanOrEqual(29);
    const back = await dir.setStatus({
      tenantId: t.id,
      from: ["deleted"],
      to: "active",
      by: "op",
      reason: "restored",
    });
    expect(back?.status).toBe("active");
    await expect(dir.rename(t.id, "Renamed Co")).resolves.toMatchObject({
      name: "Renamed Co",
    });
    await expect(dir.rename(t.id, "")).resolves.toBeNull();
  });

  it("tells the request role any tenant's status, its own details only, and who changed it never", async () => {
    const t = await make("Secret Co");
    const other = await make("Other Co");
    await dir.setStatus({
      tenantId: t.id,
      from: ["active"],
      to: "suspended",
      by: "operator-7",
      reason: "unpaid invoice 4711",
    });
    const ask = (scope: string | null) => {
      const read = () =>
        scope === null
          ? withPlatformTx((tx) =>
              tx.query("select * from public.directory_tenant($1::uuid)", [t.id])
            )
          : withTenantTx((tx) =>
              tx.query("select * from public.directory_tenant($1::uuid)", [t.id])
            );
      return scope === null
        ? read()
        : runWithTenant({ tenantId: scope, mode: "shared" }, read);
    };
    for (const scope of [null, other.id]) {
      const { rows } = await ask(scope);
      // Status, so a request can be refused; nothing else of another tenant.
      expect(rows).toEqual([
        {
          id: t.id,
          status: "suspended",
          slug: null,
          name: null,
          created_at: null,
          updated_at: null,
          status_changed_at: null,
        },
      ]);
    }
    const own = (await ask(t.id)).rows[0];
    expect(own).toMatchObject({ id: t.id, slug: t.slug, name: "Secret Co" });
    // Who suspended it and why are never the request role's to read, not even its own.
    expect(Object.keys(own)).not.toEqual(expect.arrayContaining(["status_changed_by"]));
    expect(JSON.stringify(own)).not.toMatch(/operator-7|4711/);
    // The directory, asked from another tenant, says only what resolution needs.
    const seen = await runWithTenant({ tenantId: other.id, mode: "shared" }, () =>
      dir.getTenant(t.id)
    );
    expect(seen?.status).toBe("suspended");
    expect(seen?.statusReason).toBeUndefined();
    expect(seen?.statusChangedBy).toBeUndefined();
    expect(seen?.name).toBeFalsy();
  });

  it("the request role reads one tenant or host through the functions, never the tables", async () => {
    await expect(
      withPlatformTx((tx) => tx.query("select * from tenants limit 1"))
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withPlatformTx((tx) => tx.query("select * from tenant_domains limit 1"))
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("resolves requests through it: host to tenant, suspended refused", async () => {
    const t = await make();
    const h = host("res");
    await dir.addDomain(t.id, h);
    const env = { TENANCY_MODE: "shared", TENANT_HOST_HEADER: "host" };
    const req = { headers: new Headers({ host: h }) };
    await expect(
      resolveAnonymous(req, { env, directory: dir, hops: 1 })
    ).resolves.toEqual({
      ok: true,
      context: { tenantId: t.id, mode: "shared" },
    });
    await dir.setStatus({
      tenantId: t.id,
      from: ["active"],
      to: "suspended",
      by: "op",
      reason: "x",
    });
    await expect(
      resolveForIdentity(t.id, req, { env, directory: dir, hops: 1 })
    ).resolves.toMatchObject({
      ok: false,
      code: "tenant.suspended",
    });
  });
});
