/**
 * @jest-environment node
 */
/**
 * platform/tenancy/__tests__/resolve.test.ts — which tenant a request belongs to (ADR-053 D2)
 *
 * Hostile cases first: a caller trying to choose a tenant by header, a token for another tenant
 * on a tenant's own address, a malformed claim, a suspended tenant, an unknown host.
 */

import {
  requestHost,
  resolveAnonymous,
  resolveForIdentity,
  tenantHostHeader,
} from "../resolve";
import { InMemoryTenantDirectory } from "../directory";
import { DEFAULT_TENANT_ID } from "@/platform/providers/environment-contract";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const SINGLE = { TENANCY_MODE: "single", TENANT_ID: A };
const SHARED = { TENANCY_MODE: "shared", TENANT_HOST_HEADER: "x-forwarded-host" };
/** Behind a load balancer that does not set X-Forwarded-Host (AWS ALB). */
const SHARED_HOST = { TENANCY_MODE: "shared", TENANT_HOST_HEADER: "host" };

function req(headers: Record<string, string>) {
  return { headers: new Headers(headers) };
}

async function directory() {
  const d = new InMemoryTenantDirectory({ withDefault: false });
  await d.createTenant({ id: A, slug: "acme", name: "Acme" });
  await d.createTenant({ id: B, slug: "beta", name: "Beta" });
  await d.addDomain(A, "acme.example.com");
  await d.addDomain(B, "beta.example.com");
  return d;
}

describe("requestHost — TENANT_HOST_HEADER=x-forwarded-host (a proxy that sets it)", () => {
  const XFH = "x-forwarded-host" as const;
  it("trusts only the entry our own proxies added to X-Forwarded-Host", () => {
    const r = req({
      host: "edge.internal",
      "x-forwarded-host": "evil.example.com, acme.example.com",
    });
    expect(requestHost(r, 1, XFH)).toBe("acme.example.com");
    expect(requestHost(r, 2, XFH)).toBe("evil.example.com");
  });
  it("uses the Host header when no forwarded host is present", () => {
    expect(requestHost(req({ host: "Acme.Example.com:443" }), 1, XFH)).toBe(
      "acme.example.com"
    );
  });
  it("is null for a malformed host, never a partial match", () => {
    expect(requestHost(req({ host: "127.0.0.1" }), 1, XFH)).toBeNull();
    expect(
      requestHost(req({ "x-forwarded-host": "  ,  ", host: "acme.example.com" }), 1, XFH)
    ).toBe("acme.example.com");
    expect(requestHost(req({}), 1, XFH)).toBeNull();
  });
  it("refuses a header too long to be an address, unparsed", () => {
    const huge = "a.example.com,".repeat(200) + "acme.example.com";
    expect(requestHost(req({ "x-forwarded-host": huge }), 1, XFH)).toBeNull();
    expect(
      requestHost(req({ host: "a".repeat(2000) + ".example.com" }), 1, XFH)
    ).toBeNull();
    expect(
      requestHost(req({ host: `${"a".repeat(63)}.`.repeat(5) + "com" }), 1, XFH)
    ).toBeNull();
  });
});

describe("requestHost — TENANT_HOST_HEADER=host (a proxy that does not set it, e.g. ALB)", () => {
  it("ignores X-Forwarded-Host entirely: a spoofed one never decides the host", () => {
    // Behind ALB the header is whatever the caller sent; `next start` keeps a caller's.
    const spoofed = req({
      host: "acme.example.com",
      "x-forwarded-host": "beta.example.com",
    });
    expect(requestHost(spoofed, 1, "host")).toBe("acme.example.com");
    expect(requestHost(spoofed, 2, "host")).toBe("acme.example.com");
    expect(
      requestHost(req({ "x-forwarded-host": "beta.example.com" }), 1, "host")
    ).toBeNull();
  });
  it("the same spoofed request under x-forwarded-host would be beta's: the setting matters", () => {
    const spoofed = req({
      host: "acme.example.com",
      "x-forwarded-host": "beta.example.com",
    });
    expect(requestHost(spoofed, 1, "x-forwarded-host")).toBe("beta.example.com");
  });
});

describe("the host header is declared, never inferred", () => {
  it("reads TENANT_HOST_HEADER; unset, it throws (shared mode then answers 503)", () => {
    expect(tenantHostHeader({ TENANT_HOST_HEADER: "host" })).toBe("host");
    expect(() => tenantHostHeader({})).toThrow(/TENANT_HOST_HEADER is not set/);
  });

  it("shared mode without it refuses to resolve an address", async () => {
    const d = await directory();
    await expect(
      resolveAnonymous(req({ host: "acme.example.com" }), {
        env: { TENANCY_MODE: "shared" },
        directory: d,
        hops: 1,
      })
    ).rejects.toThrow(/TENANT_HOST_HEADER/);
  });

  it("single mode never reads it", async () => {
    const d = await directory();
    await expect(
      resolveAnonymous(req({ host: "beta.example.com" }), { env: SINGLE, directory: d })
    ).resolves.toMatchObject({ ok: true, context: { tenantId: A } });
  });

  it("with host: a spoofed X-Forwarded-Host selects no tenant, anonymous or signed in", async () => {
    const d = await directory();
    const spoofed = req({
      host: "acme.example.com",
      "x-forwarded-host": "beta.example.com",
    });
    await expect(
      resolveAnonymous(spoofed, { env: SHARED_HOST, directory: d, hops: 1 })
    ).resolves.toEqual({ ok: true, context: { tenantId: A, mode: "shared" } });
    await expect(
      resolveForIdentity(B, spoofed, { env: SHARED_HOST, directory: d, hops: 1 })
    ).resolves.toMatchObject({ ok: false, code: "tenant.mismatch" });
    await expect(
      resolveForIdentity(A, spoofed, { env: SHARED_HOST, directory: d, hops: 1 })
    ).resolves.toMatchObject({ ok: true, context: { tenantId: A } });
  });
});

describe("single mode", () => {
  it("anonymous requests are the one tenant, whatever the host", async () => {
    const d = await directory();
    for (const host of ["beta.example.com", "unknown.example.com", "127.0.0.1"]) {
      const r = await resolveAnonymous(req({ host }), { env: SINGLE, directory: d });
      expect(r).toEqual({ ok: true, context: { tenantId: A, mode: "single" } });
    }
  });

  it("an identity without a tenant is the one tenant; one naming another is refused", async () => {
    const d = await directory();
    expect(
      await resolveForIdentity(undefined, undefined, { env: SINGLE, directory: d })
    ).toEqual({
      ok: true,
      context: { tenantId: A, mode: "single" },
    });
    expect(
      await resolveForIdentity(A, undefined, { env: SINGLE, directory: d })
    ).toMatchObject({
      ok: true,
    });
    expect(
      await resolveForIdentity(B, undefined, { env: SINGLE, directory: d })
    ).toMatchObject({
      ok: false,
      code: "tenant.mismatch",
    });
  });

  it("refuses a malformed claim rather than reading it as no tenant", async () => {
    const d = await directory();
    for (const claim of [
      "",
      "acme",
      "AAAAAAAA-1111-4111-8111-111111111111",
      `${A} `,
      "00000000-0000-0000-0000-000000000000",
    ]) {
      expect(
        await resolveForIdentity(claim, undefined, { env: SINGLE, directory: d })
      ).toMatchObject({
        ok: false,
        code: "tenant.missing",
      });
    }
  });

  it("a suspended single tenant refuses everyone", async () => {
    const d = await directory();
    await d.setStatus({
      tenantId: A,
      from: ["active"],
      to: "suspended",
      by: "op",
      reason: "x",
    });
    expect(await resolveAnonymous(req({}), { env: SINGLE, directory: d })).toMatchObject({
      ok: false,
      code: "tenant.suspended",
    });
    expect(
      await resolveForIdentity(A, undefined, { env: SINGLE, directory: d })
    ).toMatchObject({
      ok: false,
      code: "tenant.suspended",
    });
  });

  it("a directory without the single tenant does not lock it out (fresh database)", async () => {
    const empty = new InMemoryTenantDirectory({ withDefault: false });
    expect(
      await resolveAnonymous(req({}), {
        env: { TENANCY_MODE: "single" },
        directory: empty,
      })
    ).toEqual({ ok: true, context: { tenantId: DEFAULT_TENANT_ID, mode: "single" } });
  });
});

describe("shared mode", () => {
  it("anonymous requests take the tenant of their host", async () => {
    const d = await directory();
    expect(
      await resolveAnonymous(req({ host: "beta.example.com" }), {
        env: SHARED,
        directory: d,
        hops: 1,
      })
    ).toEqual({ ok: true, context: { tenantId: B, mode: "shared" } });
  });

  it("an unknown or malformed host is refused", async () => {
    const d = await directory();
    for (const host of ["unknown.example.com", "127.0.0.1", ""]) {
      expect(
        await resolveAnonymous(req(host ? { host } : {}), {
          env: SHARED,
          directory: d,
          hops: 1,
        })
      ).toMatchObject({ ok: false, code: "tenant.unknown_host" });
    }
  });

  it("an identity must carry its tenant", async () => {
    const d = await directory();
    expect(
      await resolveForIdentity(undefined, req({ host: "acme.example.com" }), {
        env: SHARED,
        directory: d,
        hops: 1,
      })
    ).toMatchObject({ ok: false, code: "tenant.missing" });
  });

  it("a token for tenant B is refused on tenant A's address", async () => {
    const d = await directory();
    expect(
      await resolveForIdentity(B, req({ host: "acme.example.com" }), {
        env: SHARED,
        directory: d,
        hops: 1,
      })
    ).toMatchObject({ ok: false, code: "tenant.mismatch" });
  });

  it("a forged forwarded host cannot select a tenant for an identity", async () => {
    const d = await directory();
    // The caller prepends tenant B's host; our proxy appended A's. A's token on A: accepted.
    const r = req({ "x-forwarded-host": "beta.example.com, acme.example.com" });
    expect(
      await resolveForIdentity(A, r, { env: SHARED, directory: d, hops: 1 })
    ).toMatchObject({
      ok: true,
      context: { tenantId: A },
    });
    // B's token through the same request is refused: the trusted host is A's.
    expect(
      await resolveForIdentity(B, r, { env: SHARED, directory: d, hops: 1 })
    ).toMatchObject({
      ok: false,
      code: "tenant.mismatch",
    });
  });

  it("an identity on an unmapped host keeps its own tenant", async () => {
    const d = await directory();
    expect(
      await resolveForIdentity(B, req({ host: "app.example.com" }), {
        env: SHARED,
        directory: d,
        hops: 1,
      })
    ).toEqual({ ok: true, context: { tenantId: B, mode: "shared" } });
  });

  it("an identity of a tenant that does not exist, or is not active, is refused", async () => {
    const d = await directory();
    const C = "33333333-3333-4333-8333-333333333333";
    expect(
      await resolveForIdentity(C, undefined, { env: SHARED, directory: d })
    ).toMatchObject({
      ok: false,
      code: "tenant.missing",
    });
    await d.setStatus({
      tenantId: B,
      from: ["active"],
      to: "deleted",
      by: "op",
      reason: "x",
    });
    expect(
      await resolveForIdentity(B, undefined, { env: SHARED, directory: d })
    ).toMatchObject({
      ok: false,
      code: "tenant.suspended",
    });
    expect(
      await resolveAnonymous(req({ host: "beta.example.com" }), {
        env: SHARED,
        directory: d,
        hops: 1,
      })
    ).toMatchObject({ ok: false, code: "tenant.suspended" });
  });

  it("a directory that fails is an error, never a tenant", async () => {
    const d = await directory();
    jest.spyOn(d, "tenantForHost").mockRejectedValue(new Error("db down"));
    await expect(
      resolveAnonymous(req({ host: "acme.example.com" }), {
        env: SHARED,
        directory: d,
        hops: 1,
      })
    ).rejects.toThrow("db down");
  });

  it("returns frozen contexts", async () => {
    const d = await directory();
    const r = await resolveAnonymous(req({ host: "acme.example.com" }), {
      env: SHARED,
      directory: d,
      hops: 1,
    });
    expect(r.ok && Object.isFrozen(r.context)).toBe(true);
  });
});
