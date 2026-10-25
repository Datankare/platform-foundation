/**
 * @jest-environment node
 */
/**
 * platform/tenancy/__tests__/request-binding.test.ts — the verifiers and the limiter establish
 * the request's tenant, and refuse every way of crossing into another (ADR-053 D2, D3, D6)
 *
 * Each case runs as its own request scope, as tenantRoute runs every handler.
 */

import { NextRequest } from "next/server";
import { registerAuthProvider } from "@/platform/auth/config";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";
import { optionalAuth, requireActor, requireAuth } from "@/platform/auth/middleware";
import { mintGuestToken } from "@/platform/auth/guest-token";
import {
  InMemoryRateLimiter,
  enforceRateLimit,
  resetRateLimiter,
  setRateLimiter,
} from "@/platform/rate-limit";
import {
  currentTenantId,
  peekTenant,
  runRequestScope,
  runWithoutTenant,
} from "@/platform/tenancy/context";
import {
  CachedTenantDirectory,
  InMemoryTenantDirectory,
  setTenantDirectory,
} from "@/platform/tenancy/directory";
import type { AuthProvider } from "@/platform/auth/provider";

jest.mock("@/lib/logger", () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "test-req-id",
}));

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const RULE = { id: "test", maxRequests: 2, windowSeconds: 60 };

let provider: AuthProvider;
let directory: InMemoryTenantDirectory;
const savedEnv = { ...process.env };

function req(
  host: string,
  token?: string,
  extra: Record<string, string> = {}
): NextRequest {
  const headers = new Headers({ host, "x-forwarded-for": "203.0.113.7", ...extra });
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  return new NextRequest(`http://${host}/api/x`, { headers });
}

// Each case is its own request, as tenantRoute makes every handler.
const asRequest = <T>(fn: () => Promise<T>) =>
  runWithoutTenant(() => runRequestScope(fn));

beforeEach(async () => {
  process.env = {
    ...savedEnv,
    TENANCY_MODE: "shared",
    TENANT_ID: "",
    TENANT_HOST_HEADER: "x-forwarded-host",
  };
  provider = createMockAuthProvider();
  registerAuthProvider(provider);
  directory = new InMemoryTenantDirectory({ withDefault: false });
  await directory.createTenant({ id: A, slug: "acme", name: "Acme" });
  await directory.createTenant({ id: B, slug: "beta", name: "Beta" });
  await directory.addDomain(A, "acme.example.com");
  await directory.addDomain(B, "beta.example.com");
  setTenantDirectory(directory);
  resetRateLimiter();
});

afterAll(() => {
  process.env = savedEnv;
});

async function userToken(tenant?: string): Promise<string> {
  const s = await provider.signIn("a@b.c", "x");
  if (tenant) await provider.assignTenant?.(s.userId as string, tenant);
  return s.accessToken as string;
}

describe("shared mode — users", () => {
  it("a user of A on A's address is bound to A for the rest of the request", async () => {
    const token = await userToken(A);
    await asRequest(async () => {
      const r = await requireAuth(req("acme.example.com", token));
      expect(r.tenant).toEqual({ tenantId: A, mode: "shared" });
      expect(currentTenantId()).toBe(A);
    });
  });

  it("a user of A on B's address is refused tenant.mismatch", async () => {
    const token = await userToken(A);
    await asRequest(async () => {
      const r = await requireAuth(req("beta.example.com", token));
      expect(r.error?.status).toBe(403);
      expect((await r.error?.json()).code).toBe("tenant.mismatch");
      expect(peekTenant()).toBeUndefined();
    });
  });

  it("a user without a tenant is refused tenant.missing", async () => {
    const token = await userToken();
    await asRequest(async () => {
      const r = await requireAuth(req("acme.example.com", token));
      expect((await r.error?.json()).code).toBe("tenant.missing");
    });
  });

  it("after the limiter bound the address's tenant, a token for another is refused", async () => {
    const token = await userToken(B);
    await asRequest(async () => {
      expect(await enforceRateLimit(req("acme.example.com"), RULE)).toBeNull();
      const r = await requireAuth(req("acme.example.com", token));
      expect((await r.error?.json()).code).toBe("tenant.mismatch");
      expect(currentTenantId()).toBe(A);
    });
  });

  it("a suspended tenant's users are refused tenant.suspended", async () => {
    const token = await userToken(A);
    await directory.setStatus({
      tenantId: A,
      from: ["active"],
      to: "suspended",
      by: "op",
      reason: "x",
    });
    await asRequest(async () => {
      const r = await requireAuth(req("acme.example.com", token));
      expect(r.error?.status).toBe(403);
      expect((await r.error?.json()).code).toBe("tenant.suspended");
    });
  });

  it("a directory that cannot be read is 503, never access", async () => {
    const token = await userToken(A);
    jest.spyOn(directory, "getTenant").mockRejectedValueOnce(new Error("db down"));
    await asRequest(async () => {
      const r = await requireAuth(req("acme.example.com", token));
      expect(r.error?.status).toBe(503);
      expect((await r.error?.json()).code).toBe("service.unavailable");
    });
  });
});

describe("shared mode — guests", () => {
  it("a guest minted on A works on A and is refused on B", async () => {
    const { token } = await mintGuestToken(undefined, A);
    await asRequest(async () => {
      const r = await requireActor(req("acme.example.com", token), { allowGuests: true });
      expect(r.actor?.tenantId).toBe(A);
    });
    await asRequest(async () => {
      const r = await requireActor(req("beta.example.com", token), { allowGuests: true });
      expect((await r.error?.json()).code).toBe("tenant.mismatch");
    });
  });

  it("a guest token minted inside a request is for that request's tenant", async () => {
    await asRequest(async () => {
      expect(await enforceRateLimit(req("beta.example.com"), RULE)).toBeNull();
      const { token } = await mintGuestToken();
      const r = await requireActor(req("beta.example.com", token), { allowGuests: true });
      expect(r.actor?.tenantId).toBe(B);
    });
  });

  it("minting with no tenant in shared mode throws — a guest is never tenantless", async () => {
    await asRequest(async () => {
      await expect(mintGuestToken()).rejects.toThrow(/No tenant/);
    });
  });
});

describe("shared mode — anonymous requests and limits", () => {
  it("an unknown address is refused before any work", async () => {
    await asRequest(async () => {
      const res = await enforceRateLimit(req("unknown.example.com"), RULE);
      expect(res?.status).toBe(404);
      expect((await res?.json()).code).toBe("tenant.unknown_host");
    });
  });

  it("5,000 distinct unknown hosts: refused with no directory query, no count, no state", async () => {
    const cached = new CachedTenantDirectory(directory);
    setTenantDirectory(cached);
    const perHost = jest.spyOn(directory, "tenantForHost");
    const listHosts = jest.spyOn(directory, "listHosts");
    const getTenant = jest.spyOn(directory, "getTenant");
    const limiter = new InMemoryRateLimiter({ cleanupIntervalMs: 0 });
    const check = jest.spyOn(limiter, "check");
    setRateLimiter(limiter);
    for (let i = 0; i < 5000; i++) {
      await asRequest(async () => {
        const res = await enforceRateLimit(req(`p${i}.attacker.example`), RULE);
        expect(res?.status).toBe(404);
      });
    }
    expect(perHost).not.toHaveBeenCalled();
    expect(getTenant).not.toHaveBeenCalled();
    expect(listHosts).toHaveBeenCalledTimes(1); // the one snapshot read
    expect(check).not.toHaveBeenCalled(); // the refusal is not counted anywhere
    const held = cached as unknown as {
      byId: Map<string, unknown>;
      snapshot?: { hosts: ReadonlyMap<string, string> };
    };
    expect(held.byId.size).toBe(0);
    expect(held.snapshot?.hosts.size).toBe(2);
    // A known address still works, and is counted in its tenant.
    await asRequest(async () =>
      expect(await enforceRateLimit(req("acme.example.com"), RULE)).toBeNull()
    );
    expect(check).toHaveBeenCalledWith(`t:${A}:ip:203.0.113.7`, RULE);
    // 5 000 requests: 3.6 s at four workers on two cores, near jest's default 5 s (review 14
    // M-1 measured 5.9 s with three CPU burners on two cores).
  }, 30_000);

  it("addresses that cannot be read (no snapshot yet) are 503, never a tenant", async () => {
    setTenantDirectory(new CachedTenantDirectory(directory));
    jest.spyOn(directory, "listHosts").mockRejectedValue(new Error("db down"));
    await asRequest(async () => {
      const res = await enforceRateLimit(req("acme.example.com"), RULE);
      expect(res?.status).toBe(503);
      expect((await res?.json()).code).toBe("service.unavailable");
    });
  });

  it("with TENANT_HOST_HEADER=host, a spoofed X-Forwarded-Host does not pick the tenant", async () => {
    process.env.TENANT_HOST_HEADER = "host";
    await asRequest(async () => {
      expect(
        await enforceRateLimit(
          req("acme.example.com", undefined, { "x-forwarded-host": "beta.example.com" }),
          RULE
        )
      ).toBeNull();
      expect(currentTenantId()).toBe(A);
    });
    process.env.TENANT_HOST_HEADER = "x-forwarded-host";
    await asRequest(async () => {
      // The same request read the other way is beta's — which is why the setting is declared.
      await enforceRateLimit(
        req("acme.example.com", undefined, { "x-forwarded-host": "beta.example.com" }),
        RULE
      );
      expect(currentTenantId()).toBe(B);
    });
  });

  it("without TENANT_HOST_HEADER a shared deployment cannot tell the address: 503", async () => {
    delete process.env.TENANT_HOST_HEADER;
    await asRequest(async () => {
      const res = await enforceRateLimit(req("acme.example.com"), RULE);
      expect(res?.status).toBe(503);
      expect(peekTenant()).toBeUndefined();
    });
  });

  it("one tenant's traffic never uses another's allowance (same address, same rule)", async () => {
    for (let i = 0; i < 2; i++) {
      await asRequest(async () =>
        expect(await enforceRateLimit(req("acme.example.com"), RULE)).toBeNull()
      );
    }
    await asRequest(async () =>
      expect((await enforceRateLimit(req("acme.example.com"), RULE))?.status).toBe(429)
    );
    await asRequest(async () =>
      expect(await enforceRateLimit(req("beta.example.com"), RULE)).toBeNull()
    );
  });

  it("optionalAuth treats another tenant's token as no token, keeping the address's tenant", async () => {
    const token = await userToken(B);
    await asRequest(async () => {
      const r = await optionalAuth(req("acme.example.com", token));
      expect(r.user).toBeNull();
      expect(r.tenant).toEqual({ tenantId: A, mode: "shared" });
    });
    await asRequest(async () => {
      const r = await optionalAuth(req("unknown.example.com"));
      expect(r.tenant).toBeNull();
    });
  });
});

describe("single mode", () => {
  beforeEach(() => {
    process.env.TENANCY_MODE = "single";
    process.env.TENANT_ID = A;
  });

  it("a user without a tenant attribute is the deployment's tenant on any address", async () => {
    const token = await userToken();
    await asRequest(async () => {
      const r = await requireAuth(req("anything.example.com", token));
      expect(r.tenant).toEqual({ tenantId: A, mode: "single" });
    });
  });

  it("a user assigned to another tenant cannot use this deployment", async () => {
    const token = await userToken(B);
    await asRequest(async () => {
      const r = await requireAuth(req("acme.example.com", token));
      expect((await r.error?.json()).code).toBe("tenant.mismatch");
    });
  });

  it("a guest token of another deployment's tenant is refused", async () => {
    const { token } = await mintGuestToken(undefined, B);
    await asRequest(async () => {
      const r = await requireActor(req("acme.example.com", token), { allowGuests: true });
      expect((await r.error?.json()).code).toBe("tenant.mismatch");
    });
  });
});

describe("requests do not share a tenant", () => {
  it("concurrent requests of different tenants each keep their own", async () => {
    const tokenA = await userToken(A);
    // The mock has one user, so B's requests are anonymous ones on B's address.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        asRequest(async () => {
          if (i % 2 === 0) {
            const r = await requireAuth(req("acme.example.com", tokenA));
            await new Promise((r2) => setTimeout(r2, (i * 3) % 7));
            return [A, r.tenant?.tenantId, currentTenantId()];
          }
          await enforceRateLimit(req("beta.example.com"), { ...RULE, maxRequests: 100 });
          await new Promise((r2) => setTimeout(r2, (i * 5) % 7));
          return [B, currentTenantId(), currentTenantId()];
        })
      )
    );
    for (const [want, got, later] of results) {
      expect(got).toBe(want);
      expect(later).toBe(want);
    }
    expect(peekTenant()).toBeUndefined();
  });
});
