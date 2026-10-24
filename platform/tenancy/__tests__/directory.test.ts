/**
 * @jest-environment node
 */
/**
 * platform/tenancy/__tests__/directory.test.ts — the tenant directory and host normalisation
 */

import {
  CachedTenantDirectory,
  InMemoryTenantDirectory,
  TenantDirectoryConflictError,
  isTenantSlug,
  normaliseHost,
  validateTenantName,
} from "../directory";
import { DEFAULT_TENANT_ID } from "@/platform/providers/environment-contract";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("normaliseHost", () => {
  it.each([
    ["Acme.Example.COM", "acme.example.com"],
    ["acme.example.com:443", "acme.example.com"],
    ["acme.example.com.", "acme.example.com"],
    ["  acme.example.com  ", "acme.example.com"],
    ["localhost:3000", "localhost"],
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
  ])("normalises %p to %p", (raw, out) => {
    expect(normaliseHost(raw)).toBe(out);
  });

  it.each([
    [null],
    [undefined],
    [""],
    ["   "],
    ["example"],
    ["127.0.0.1"],
    ["127.0.0.1:80"],
    ["[::1]:3000"],
    ["acme..example.com"],
    ["-acme.example.com"],
    ["acme-.example.com"],
    ["acme.example.com:"],
    ["acme.example.com:http"],
    ["acme.example.com:123456"],
    ["acme example.com"],
    ["acme.example.com/path"],
    ["user@acme.example.com"],
    ["acme_corp.example.com"],
    ["ａｃｍｅ.example.com"],
    ["a".repeat(64) + ".example.com"],
    [("a".repeat(60) + ".").repeat(5) + "com"],
  ])("refuses %p", (raw) => {
    expect(normaliseHost(raw as string | null | undefined)).toBeNull();
  });
});

describe("slugs and names", () => {
  it.each(["acme", "a", "acme-2", "a1", "x".repeat(40)])("accepts slug %p", (s) => {
    expect(isTenantSlug(s)).toBe(true);
  });
  it.each(["", "Acme", "-acme", "acme-", "ac_me", "x".repeat(41), "ac me", 7])(
    "refuses slug %p",
    (s) => {
      expect(isTenantSlug(s)).toBe(false);
    }
  );
  it("trims and collapses names, refusing control characters and odd lengths", () => {
    expect(validateTenantName("  Acme   Corp ")).toBe("Acme Corp");
    expect(validateTenantName("A")).toBeNull();
    expect(validateTenantName("x".repeat(101))).toBeNull();
    expect(validateTenantName("Acme\u0000")).toBeNull();
    expect(validateTenantName("Acme\u0085Corp")).toBeNull();
    expect(validateTenantName(5)).toBeNull();
    expect(validateTenantName("Ünïcödé Ltd")).toBe("Ünïcödé Ltd");
  });
});

describe("InMemoryTenantDirectory", () => {
  it("starts with the default tenant serving localhost", async () => {
    const d = new InMemoryTenantDirectory();
    expect((await d.getTenant(DEFAULT_TENANT_ID))?.status).toBe("active");
    expect(await d.tenantForHost("localhost")).toBe(DEFAULT_TENANT_ID);
    expect(
      await new InMemoryTenantDirectory({ withDefault: false }).listTenants()
    ).toEqual([]);
  });

  it("creates tenants with unique ids and slugs", async () => {
    const d = new InMemoryTenantDirectory();
    const t = await d.createTenant({ id: A, slug: "acme", name: " Acme " });
    expect(t).toMatchObject({ id: A, slug: "acme", name: "Acme", status: "active" });
    await expect(d.createTenant({ id: A, slug: "other", name: "Other" })).rejects.toThrow(
      TenantDirectoryConflictError
    );
    await expect(
      d.createTenant({ id: B, slug: "acme", name: "Other" })
    ).rejects.toMatchObject({ code: "tenant.slug_taken" });
    await expect(d.createTenant({ id: "nope", slug: "x", name: "Xx" })).rejects.toThrow(
      /id/
    );
    await expect(d.createTenant({ id: B, slug: "Bad", name: "Xx" })).rejects.toThrow(
      /slug/
    );
    await expect(d.createTenant({ id: B, slug: "ok", name: "" })).rejects.toThrow(/name/);
  });

  it("maps a host to one tenant only, and only normalised hosts", async () => {
    const d = new InMemoryTenantDirectory();
    await d.createTenant({ id: A, slug: "acme", name: "Acme" });
    await d.createTenant({ id: B, slug: "beta", name: "Beta" });
    await d.addDomain(A, "acme.example.com");
    await expect(d.addDomain(B, "acme.example.com")).rejects.toMatchObject({
      code: "tenant.domain_taken",
    });
    await expect(d.addDomain(A, "ACME.example.com")).rejects.toThrow(/Malformed host/);
    await expect(d.addDomain(B, "127.0.0.1")).rejects.toThrow(/Malformed host/);
    await expect(
      d.addDomain("33333333-3333-4333-8333-333333333333", "x.example.com")
    ).rejects.toThrow(/Unknown tenant/);
    expect(await d.tenantForHost("acme.example.com")).toBe(A);
    // Removing needs the owning tenant: B cannot unmap A's host.
    expect(await d.removeDomain(B, "acme.example.com")).toBe(false);
    expect(await d.removeDomain(A, "acme.example.com")).toBe(true);
    expect(await d.tenantForHost("acme.example.com")).toBeNull();
  });

  it("changes status only from an expected state (compare-and-set)", async () => {
    const d = new InMemoryTenantDirectory();
    await d.createTenant({ id: A, slug: "acme", name: "Acme" });
    const s = await d.setStatus({
      tenantId: A,
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
    expect(
      await d.setStatus({
        tenantId: A,
        from: ["active"],
        to: "suspended",
        by: "op",
        reason: "x",
      })
    ).toBeNull();
    expect(
      await d.setStatus({
        tenantId: B,
        from: ["active"],
        to: "suspended",
        by: "op",
        reason: "x",
      })
    ).toBeNull();
  });
});

/** A promise and its resolver, to hold a read open while something else happens. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Peek at the cache's private state, to prove what it holds. */
const internals = (d: CachedTenantDirectory) =>
  d as unknown as {
    byId: Map<string, unknown>;
    snapshot?: { hosts: ReadonlyMap<string, string> };
  };

async function seeded() {
  const inner = new InMemoryTenantDirectory({ withDefault: false });
  await inner.createTenant({ id: A, slug: "acme", name: "Acme" });
  await inner.createTenant({ id: B, slug: "beta", name: "Beta" });
  await inner.addDomain(A, "acme.example.com");
  await inner.addDomain(B, "beta.example.com");
  return inner;
}

describe("CachedTenantDirectory — tenants", () => {
  it("serves repeat reads from cache until it expires, and clears on any write", async () => {
    const inner = new InMemoryTenantDirectory();
    const spy = jest.spyOn(inner, "getTenant");
    let now = 0;
    const d = new CachedTenantDirectory(inner, { ttlMs: 1000, now: () => now });
    await d.getTenant(DEFAULT_TENANT_ID);
    await d.getTenant(DEFAULT_TENANT_ID);
    expect(spy).toHaveBeenCalledTimes(1);
    now = 1000;
    await d.getTenant(DEFAULT_TENANT_ID);
    expect(spy).toHaveBeenCalledTimes(2);
    await d.setStatus({
      tenantId: DEFAULT_TENANT_ID,
      from: ["active"],
      to: "suspended",
      by: "op",
      reason: "test",
    });
    expect((await d.getTenant(DEFAULT_TENANT_ID))?.status).toBe("suspended");
  });

  it("a read that started before a write never re-caches the old state", async () => {
    const inner = await seeded();
    const d = new CachedTenantDirectory(inner, { ttlMs: 60_000 });
    const before = await inner.getTenant(A);
    const held = deferred<Awaited<ReturnType<typeof inner.getTenant>>>();
    const spy = jest.spyOn(inner, "getTenant").mockReturnValueOnce(held.promise);

    const slow = d.getTenant(A); // reads "active", and is held
    await d.setStatus({
      tenantId: A,
      from: ["active"],
      to: "suspended",
      by: "op",
      reason: "x",
    });
    held.resolve(before); // the old answer arrives after the write
    expect((await slow)?.status).toBe("active"); // that caller saw what was true when it asked
    // …but it was not stored: the next read asks again and sees the suspension.
    expect((await d.getTenant(A))?.status).toBe("suspended");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("a read that started during a write (before it committed) is not stored either", async () => {
    const inner = await seeded();
    const d = new CachedTenantDirectory(inner, { ttlMs: 60_000 });
    const write = deferred<void>();
    const realSet = inner.setStatus.bind(inner);
    jest.spyOn(inner, "setStatus").mockImplementationOnce(async (input) => {
      await write.promise;
      return realSet(input);
    });
    const pending = d.setStatus({
      tenantId: A,
      from: ["active"],
      to: "suspended",
      by: "op",
      reason: "x",
    });
    expect((await d.getTenant(A))?.status).toBe("active"); // read while the write is open
    write.resolve();
    await pending;
    expect((await d.getTenant(A))?.status).toBe("suspended");
  });
});

describe("CachedTenantDirectory — hosts come from a snapshot of every address", () => {
  it("5,000 distinct unknown hosts: no lookups, one snapshot read, no per-host entries", async () => {
    const inner = await seeded();
    const perHost = jest.spyOn(inner, "tenantForHost");
    const list = jest.spyOn(inner, "listHosts");
    const d = new CachedTenantDirectory(inner);
    for (let i = 0; i < 5000; i++) {
      expect(await d.tenantForHost(`probe-${i}.attacker.example`)).toBeNull();
    }
    expect(perHost).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);
    expect(internals(d).snapshot?.hosts.size).toBe(2);
    expect(internals(d).byId.size).toBe(0);
  });

  it("known hosts resolve; a malformed one is no tenant without any read", async () => {
    const inner = await seeded();
    const list = jest.spyOn(inner, "listHosts");
    const d = new CachedTenantDirectory(inner);
    for (const bad of [
      "Acme.Example.com",
      "acme.example.com.",
      "127.0.0.1",
      "",
      "a b.com",
    ]) {
      expect(await d.tenantForHost(bad)).toBeNull();
    }
    expect(list).not.toHaveBeenCalled();
    expect(await d.tenantForHost("acme.example.com")).toBe(A);
    expect(await d.tenantForHost("beta.example.com")).toBe(B);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("refreshes once per cache time, one read at a time", async () => {
    const inner = await seeded();
    const rows = await inner.listHosts();
    const held = deferred<typeof rows>();
    const list = jest.spyOn(inner, "listHosts").mockReturnValueOnce(held.promise);
    let now = 0;
    const d = new CachedTenantDirectory(inner, { ttlMs: 30_000, now: () => now });
    const lookups = Array.from({ length: 100 }, (_, i) =>
      d.tenantForHost(i % 2 ? "acme.example.com" : `x${i}.example.com`)
    );
    held.resolve(rows);
    const answers = await Promise.all(lookups);
    expect(answers.filter((a) => a === A)).toHaveLength(50);
    expect(answers.filter((a) => a === null)).toHaveLength(50);
    expect(list).toHaveBeenCalledTimes(1); // 100 concurrent lookups, one read
    list.mockClear();
    now = 29_999;
    await d.tenantForHost("acme.example.com");
    expect(list).not.toHaveBeenCalled();
    now = 30_000;
    await d.tenantForHost("acme.example.com");
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("an address added or removed on this instance takes effect at once", async () => {
    const inner = await seeded();
    const d = new CachedTenantDirectory(inner, { ttlMs: 60_000 });
    expect(await d.tenantForHost("new.example.com")).toBeNull();
    await d.addDomain(A, "new.example.com");
    expect(await d.tenantForHost("new.example.com")).toBe(A);
    await d.removeDomain(B, "beta.example.com");
    expect(await d.tenantForHost("beta.example.com")).toBeNull();
    // Provisioning: a new tenant and its address.
    const C = "33333333-3333-4333-8333-333333333333";
    await d.createTenant({ id: C, slug: "gamma", name: "Gamma" });
    await d.addDomain(C, "gamma.example.com");
    expect(await d.tenantForHost("gamma.example.com")).toBe(C);
  });

  it("a refresh that started before an address was added does not hide it", async () => {
    const inner = await seeded();
    const old = await inner.listHosts();
    const held = deferred<typeof old>();
    jest.spyOn(inner, "listHosts").mockReturnValueOnce(held.promise);
    const d = new CachedTenantDirectory(inner, { ttlMs: 60_000 });
    const early = d.tenantForHost("acme.example.com"); // starts a refresh, held
    await d.addDomain(A, "new.example.com");
    expect(await d.tenantForHost("new.example.com")).toBe(A); // a new read, not the held one
    held.resolve(old); // the old list arrives last
    expect(await early).toBe(A);
    expect(await d.tenantForHost("new.example.com")).toBe(A); // and it did not replace the new
  });

  it("a failed refresh serves the last snapshot for the grace, then fails closed", async () => {
    const inner = await seeded();
    let now = 0;
    const d = new CachedTenantDirectory(inner, {
      ttlMs: 30_000,
      hostGraceMs: 60_000,
      hostRetryMs: 5_000,
      now: () => now,
    });
    expect(await d.tenantForHost("acme.example.com")).toBe(A);
    const list = jest.spyOn(inner, "listHosts").mockRejectedValue(new Error("db down"));

    now = 30_000; // stale: the refresh fails, the last snapshot answers
    expect(await d.tenantForHost("acme.example.com")).toBe(A);
    expect(await d.tenantForHost("nowhere.example.com")).toBeNull();
    expect(list).toHaveBeenCalledTimes(1); // and the next attempt waits: no query per request
    now = 34_999;
    expect(await d.tenantForHost("acme.example.com")).toBe(A);
    expect(list).toHaveBeenCalledTimes(1);
    now = 35_000;
    expect(await d.tenantForHost("acme.example.com")).toBe(A);
    expect(list).toHaveBeenCalledTimes(2);

    now = 90_000; // past ttl + grace since the snapshot was read: no more guessing
    await expect(d.tenantForHost("acme.example.com")).rejects.toThrow("db down");
    await expect(d.tenantForHost("acme.example.com")).rejects.toThrow(/unavailable/);

    list.mockRestore(); // the database is back
    now = 95_000;
    expect(await d.tenantForHost("acme.example.com")).toBe(A);
  });

  it("with no snapshot ever read, a failed refresh fails closed", async () => {
    const inner = await seeded();
    jest.spyOn(inner, "listHosts").mockRejectedValue(new Error("db down"));
    const d = new CachedTenantDirectory(inner);
    await expect(d.tenantForHost("acme.example.com")).rejects.toThrow("db down");
    await expect(d.tenantForHost("unknown.example.com")).rejects.toThrow();
  });
});
