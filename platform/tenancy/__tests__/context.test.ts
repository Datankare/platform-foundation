/**
 * platform/tenancy/__tests__/context.test.ts — one tenant per request, never none (ADR-053 D3)
 *
 * Hostile cases: concurrent requests for different tenants interleaving across awaits, a request
 * trying to switch tenant, malformed ids, and work that runs with no tenant at all.
 */

import {
  DEFAULT_TENANT_ID,
  TenantContextError,
  currentTenant,
  currentTenantId,
  enterTenant,
  isTenantId,
  hasTenantScope,
  peekTenant,
  runRequestScope,
  runWithTenant,
  runWithoutTenant,
} from "@/platform/tenancy/context";
import { tenantRoute } from "@/platform/tenancy/route";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
// Varying, deterministic delays so the interleaving differs between the concurrent tasks.
let turn = 0;
const tick = () => new Promise((r) => setTimeout(r, (turn++ * 7) % 5));

describe("tenant context", () => {
  it("fails closed with no tenant", () => {
    runWithoutTenant(() => {
      expect(() => currentTenant()).toThrow(TenantContextError);
      expect(() => currentTenantId()).toThrow(/No tenant context/);
      expect(peekTenant()).toBeUndefined();
    });
  });

  it("keeps each concurrent request's tenant across awaits", async () => {
    const seen: string[] = [];
    const request = (t: string) =>
      runWithoutTenant(() =>
        runWithTenant({ tenantId: t, mode: "shared" }, async () => {
          for (let i = 0; i < 20; i++) {
            await tick();
            seen.push(`${t}:${currentTenantId()}`);
          }
        })
      );
    await Promise.all([request(A), request(B), request(A), request(B)]);
    expect(seen.every((s) => s.split(":")[0] === s.split(":")[1])).toBe(true);
    expect(seen).toHaveLength(80);
  });

  it("a helper the handler awaits fills the request's scope for the handler", async () => {
    // The shape of every route: the verifier is an awaited helper. Its tenant must be visible to
    // the handler after the await — the reason the scope is a cell, not enterWith.
    const verify = async () => {
      await tick();
      return enterTenant({ tenantId: A, mode: "shared" });
    };
    const handler = tenantRoute(async () => {
      expect(peekTenant()).toBeUndefined();
      await verify();
      await tick();
      return currentTenantId();
    });
    await expect(runWithoutTenant(handler)).resolves.toBe(A);
  });

  it("a request's tenant is set once and never changes", async () => {
    await runWithoutTenant(() =>
      runRequestScope(async () => {
        enterTenant({ tenantId: A, mode: "shared" });
        await tick();
        expect(enterTenant({ tenantId: A, mode: "shared" })).toEqual({
          tenantId: A,
          mode: "shared",
        });
        expect(() => enterTenant({ tenantId: B, mode: "shared" })).toThrow(
          /cannot change tenant/
        );
        expect(() => enterTenant({ tenantId: A, mode: "single" })).toThrow(
          /cannot change tenant/
        );
        expect(currentTenantId()).toBe(A);
      })
    );
  });

  it("a job's tenant cannot be changed either", () => {
    runWithTenant({ tenantId: A, mode: "shared" }, () => {
      expect(() => enterTenant({ tenantId: B, mode: "shared" })).toThrow(/cannot change/);
    });
  });

  it("outside any scope, enterTenant stores nothing — tenant data stays unreadable", () => {
    runWithoutTenant(() => {
      expect(hasTenantScope()).toBe(false);
      expect(enterTenant({ tenantId: A, mode: "shared" })).toEqual({
        tenantId: A,
        mode: "shared",
      });
      expect(peekTenant()).toBeUndefined();
      expect(() => currentTenant()).toThrow(TenantContextError);
    });
  });

  it("concurrent requests through tenantRoute never see each other's tenant", async () => {
    const handler = tenantRoute(async (t: string, delay: number) => {
      await new Promise((r) => setTimeout(r, delay));
      enterTenant({ tenantId: t, mode: "shared" });
      const seen: string[] = [];
      for (let i = 0; i < 5; i++) {
        await tick();
        seen.push(currentTenantId());
      }
      return seen;
    });
    const runs = await runWithoutTenant(() =>
      Promise.all(Array.from({ length: 30 }, (_, i) => handler(i % 2 ? A : B, i % 4)))
    );
    runs.forEach((seen, i) => expect(new Set(seen)).toEqual(new Set([i % 2 ? A : B])));
  });

  it("tenantRoute passes arguments and results through, and keeps the handler's name", async () => {
    async function POST(a: number, b: number) {
      return a + b;
    }
    const wrapped = tenantRoute(POST);
    expect(wrapped.name).toBe("POST");
    await expect(wrapped(2, 3)).resolves.toBe(5);
    const failing = tenantRoute(async () => {
      throw new Error("boom");
    });
    await expect(failing()).rejects.toThrow("boom");
  });

  it.each([
    ["", "single"],
    ["default", "single"],
    [A.toUpperCase().replace(/1/g, "A"), "single"],
    [A, "multi"],
  ])("refuses a malformed context (%p, %p)", (tenantId, mode) => {
    expect(() => runWithTenant({ tenantId, mode } as never, () => undefined)).toThrow(
      TenantContextError
    );
  });

  it("the context cannot be mutated by the code that reads it", () => {
    runWithTenant({ tenantId: A, mode: "shared" }, () => {
      const ctx = currentTenant() as { tenantId: string };
      expect(() => {
        ctx.tenantId = B;
      }).toThrow(TypeError);
      expect(currentTenantId()).toBe(A);
    });
  });

  it("the default tenant id is a valid tenant id", () => {
    expect(isTenantId(DEFAULT_TENANT_ID)).toBe(true);
  });
});
